import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBytes, readDir } from '../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { verifyProvenance } from '../../src/update/provenance.js';
import { homeSnapshot } from '../signals/helpers.js';
import {
  FIXED_NOW,
  SAN,
  baseInput,
  freezeClock,
  loadAtt,
  newTempDir,
  seedTufCache,
} from './fixtures/provenance-helpers.js';
import type { Json } from './fixtures/provenance-helpers.js';
import type { IoContext } from '../../src/io/paths.js';

/** dir 下所有文件 -> sha256(相对路径排序),用来断言「没有新增 / 改动任何文件」 */
async function tree(dir: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readDir(path.join(dir, rel))) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory) {
      out[`${r}/`] = 'dir';
      Object.assign(out, await tree(dir, r));
    } else
      out[r] = createHash('sha256')
        .update(await readBytes(path.join(dir, r)))
        .digest('hex');
  }
  return out;
}

describe('TUF 缓存 / 写盘范围 / 代理与离线(真实 sigstore 验证器,全程不联网)', () => {
  let att: Json;
  let ctx: IoContext;
  let dir: string;
  let fakeHome: string;
  let tmp: string;
  let seeded: string;
  let blocker: string;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    freezeClock();
    att = await loadAtt();
    ({ ctx, dir } = await newTempDir('prov-tuf-'));
    fakeHome = path.join(dir, 'home');
    tmp = path.join(dir, 'tmp');
    await mkdirp(ctx, fakeHome);
    await mkdirp(ctx, tmp);
    // 所有经 safe-fs 的写入都在 stubEnv 之前做完(safe-fs 的根校验读 HOME)
    seeded = await seedTufCache(ctx, dir);
    blocker = path.join(dir, 'blocker');
    await writeFile(ctx, blocker, 'x');
    // os.tmpdir() 读 TMPDIR,HOME 决定 os.homedir():都指进 KIT_TMP,sigstore / tuf-js 若写它们就会被抓到
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('TMPDIR', tmp);
    fetchSpy = vi.fn(async () => {
      throw new Error('network is forbidden in tests');
    });
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('forceCache 离线验签:不联网,真实 HOME / 假 HOME / TMPDIR / 缓存目录都没有任何新增或改动', async () => {
    const cachePath = seeded;
    const realHomeBefore = await homeSnapshot();
    const cacheBefore = await tree(cachePath);
    expect(Object.keys(cacheBefore).length).toBeGreaterThan(4);

    const r = await verifyProvenance(baseInput(att, cachePath));
    expect(r).toMatchObject({ ok: true, subjectAlternativeName: SAN });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await tree(cachePath)).toEqual(cacheBefore);
    expect(await tree(fakeHome)).toEqual({});
    expect(await tree(tmp)).toEqual({});
    expect(await homeSnapshot()).toBe(realHomeBefore);
  });

  it('TUF 不可达(空缓存 + 联网刷新失败)→ tuf_unreachable,fail-closed;写盘只限 tufCachePath,tmpdir / HOME 无残留', async () => {
    const cachePath = path.join(dir, 'empty-cache');
    const realHomeBefore = await homeSnapshot();
    const dirBefore = await tree(dir);
    const r = await verifyProvenance(
      baseInput(att, cachePath, { tuf: { cachePath, forceCache: false, retries: 0 } }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tuf_unreachable');
    expect(fetchSpy).toHaveBeenCalled();
    // sigstore 只在 tufCachePath 里播种了 root.json 等,别处没有
    const written = await tree(dir);
    const fresh = Object.keys(written).filter((f) => !(f in dirBefore));
    expect(fresh.length).toBeGreaterThan(0);
    for (const f of fresh) expect(f.startsWith('empty-cache/')).toBe(true);
    expect(await tree(fakeHome)).toEqual({});
    expect(await tree(tmp)).toEqual({});
    expect(await homeSnapshot()).toBe(realHomeBefore);
  });

  it('有缓存但联网刷新失败:默认拒绝(tuf_unreachable);显式 fallbackToCache 才用仍有效的缓存', async () => {
    const cachePath = seeded;
    const refuse = await verifyProvenance(
      baseInput(att, cachePath, { tuf: { cachePath, forceCache: false, retries: 0 } }),
    );
    expect(refuse.reason).toBe('tuf_unreachable');

    const calls = fetchSpy.mock.calls.length;
    const allow = await verifyProvenance(
      baseInput(att, cachePath, {
        tuf: { cachePath, forceCache: false, retries: 0, fallbackToCache: true },
      }),
    );
    expect(allow).toMatchObject({ ok: true });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(calls); // 先真的尝试过联网
  });

  it('缓存的 TUF 元数据过期:forceCache 也会尝试联网续期(实测),离线时 → tuf_unreachable,不放行;回到有效期内又能过', async () => {
    const cachePath = seeded;
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z')); // timestamp.json 已过期、root.json 未过期
    const r = await verifyProvenance(
      baseInput(att, cachePath, { tuf: { cachePath, forceCache: true, retries: 0 } }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tuf_unreachable');
    expect(fetchSpy).toHaveBeenCalled();
    vi.setSystemTime(new Date(FIXED_NOW));
    fetchSpy.mockClear();
    expect((await verifyProvenance(baseInput(att, cachePath))).ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('缓存目录不可写(指向一个文件)→ tuf_unreachable,不放行', async () => {
    const r = await verifyProvenance(
      baseInput(att, path.join(blocker, 'sub'), {
        tuf: { cachePath: path.join(blocker, 'sub'), retries: 0 },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tuf_unreachable');
  });
});
