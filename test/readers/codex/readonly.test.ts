/**
 * Codex reader 只读(plan M-5):在 fs 层记录对会话源目录的每一次调用及其 flags。
 * 单独成文件,因为 vi.mock 对整个测试文件生效。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '../../../src/contracts/reader.js';
import { stat } from '../../../src/io/read-fs.js';
import { writeFile } from '../../../src/io/safe-fs.js';
import { setOpenObserver } from '../../../src/signals/open-readonly.js';
import { newWork } from '../../signals/helpers.js';
import { LineBuilder, specFixture, writeRollout } from './build.js';
import { readRef, reader } from './helpers.js';

interface Call {
  api: string;
  path: string;
  flags: string;
}

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const READ_OPENERS = ['createReadStream', 'open', 'openSync', 'readFile', 'readFileSync'];
  const OTHER_APIS = [
    'createWriteStream',
    'writeFile',
    'writeFileSync',
    'appendFile',
    'appendFileSync',
    'unlink',
    'unlinkSync',
    'rename',
    'renameSync',
    'rm',
    'rmSync',
    'rmdir',
    'truncate',
    'truncateSync',
    'utimes',
    'utimesSync',
    'chmod',
    'chmodSync',
    'mkdir',
    'mkdirSync',
    'copyFile',
    'copyFileSync',
    'symlink',
    'symlinkSync',
    'link',
    'linkSync',
    'mkdtemp',
  ];
  function flagsOf(api: string, args: unknown[]): string {
    const a1 = args[1];
    if (api === 'createReadStream' || api === 'readFile' || api === 'readFileSync') {
      const o = a1 as { flags?: string; flag?: string } | string | undefined;
      if (typeof o === 'object' && o !== null) return o.flags ?? o.flag ?? 'r';
      return 'r';
    }
    if (api === 'open' || api === 'openSync') return typeof a1 === 'string' ? a1 : 'r';
    return `WRITE-API:${api}`;
  }
  function wrap(actual: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...actual };
    for (const api of [...READ_OPENERS, ...OTHER_APIS]) {
      const orig = actual[api];
      if (typeof orig !== 'function') continue;
      out[api] = (...args: unknown[]) => {
        const p = args[0];
        if (typeof p === 'string') calls.push({ api, path: p, flags: flagsOf(api, args) });
        return (orig as (...a: unknown[]) => unknown)(...args);
      };
    }
    return out;
  }
  return { calls, READ_OPENERS, OTHER_APIS, wrap };
});
const rec = { calls: h.calls };
const READ_OPENERS = h.READ_OPENERS;
const OTHER_APIS = h.OTHER_APIS;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped = h.wrap(actual);
  return { ...wrapped, default: wrapped };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped = h.wrap(actual);
  return { ...wrapped, default: wrapped };
});

const READ_FLAGS = new Set(['r', 'rs']);
const under = (dir: string) => (c: Call) =>
  c.path === dir || c.path.startsWith(`${dir}${path.sep}`);

describe('Codex reader 只读(fs 层 flags 记录)', () => {
  it('discover + read 期间对源目录的所有 fs 调用都是只读打开(flags=r),没有任何写类 API;侧链文件同样只读', async () => {
    const w = await newWork('cx-ro-');
    const main = await writeRollout(w.io, w.sessions, specFixture(), { id: 'ro' });
    const side = await writeRollout(
      w.io,
      w.sessions,
      new LineBuilder().meta({ source: { subagent: 1 } }),
      { id: 'ro-side', baseMs: Date.UTC(2026, 9, 2) },
    );
    rec.calls.length = 0;
    const seen: string[] = [];
    const prev = setOpenObserver((e) => seen.push(`${e.flags}:${e.purpose}`));
    try {
      const refs = await reader.discover(w.sessions);
      expect(refs.map((r) => r.path)).toEqual([main]);
      const r = await readRef(refs[0] as SessionRef);
      expect(r.counts.user_messages).toBe(1);
    } finally {
      setOpenObserver(prev);
    }
    const onSource = rec.calls.filter(under(w.sessions));
    // 3 次 = discover 的首行判定 + 基类预扫(找第一个有效时间戳)+ 主读;实现形状变了就改这里
    // 正向前提:真读了会话文件、也探了侧链文件首行(否则「没有写调用」是空话)
    expect(onSource.filter((c) => c.path === main && c.api === 'createReadStream').length).toBe(3); // discover 首行 + 预扫 + 主读
    expect(onSource.filter((c) => c.path === side && c.api === 'createReadStream').length).toBe(1);
    for (const c of onSource) {
      expect(
        READ_OPENERS.includes(c.api) || c.api === 'createReadStream',
        `${c.api} ${c.path}`,
      ).toBe(true);
      expect(READ_FLAGS.has(c.flags), `${c.api} flags=${c.flags}`).toBe(true);
    }
    expect(onSource.filter((c) => OTHER_APIS.includes(c.api))).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith('O_RDONLY:'))).toBe(true);
  });

  it('检测器自检:对源目录做一次写,同一套断言能抓到(证明上面不是空断言)', async () => {
    const w = await newWork('cx-ro-self-');
    await writeRollout(w.io, w.sessions, new LineBuilder().meta(), { id: 'ro2' });
    rec.calls.length = 0;
    await writeFile(w.io, path.join(w.sessions, 'planted.txt'), 'x');
    const bad = rec.calls.filter(under(w.sessions)).filter((c) => OTHER_APIS.includes(c.api));
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]?.flags.startsWith('WRITE-API:')).toBe(true);
  });

  it('只读到的字节数不变:读前后会话文件 mtime 与大小相同', async () => {
    const w = await newWork('cx-ro-stat-');
    const f = await writeRollout(w.io, w.sessions, specFixture(), { id: 'ro3' });
    const before = await stat(f);
    const refs = await reader.discover(f);
    await readRef(refs[0] as SessionRef);
    const after = await stat(f);
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
  });
});
