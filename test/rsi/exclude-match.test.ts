/**
 * R20-A2 B4a:排除匹配只有一份实现(R20-4.4 / B3c-11)。
 * 判据:空索引也加载 exclude_dirs;大小写折叠;符号链接别名;祖先 (dev,ino) 命中;exclude_names 取 canonical 后 basename;
 * attribution 与采集策略对同一路径结论相同。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attribute, type AttributionProbe } from '../../src/rsi/attribution.js';
import { createRsiCollectPolicy } from '../../src/rsi/l0/collect-policy.js';
import { createExcludeMatcher } from '../../src/rsi/exclude-match.js';
import type { RsiConfigOn } from '../../src/rsi/config.js';
import { mkdirp, symlink } from '../../src/io/safe-fs.js';
import { makeL0Fx } from './l0-fixture.js';
import { indexOf, key } from './ro-fixture.js';

const cfg = (f: { config: RsiConfigOn }, over: Partial<RsiConfigOn>): RsiConfigOn => ({
  ...f.config,
  ...over,
});

describe('createExcludeMatcher', () => {
  it('exclude_dirs:相等 / 其下命中;同前缀兄弟(proj-evil)不命中;大小写折叠命中(不存在的路径)', async () => {
    const f = await makeL0Fx('xm-dirs-');
    const ex = path.join(f.dir, 'work', 'Client');
    const m = await createExcludeMatcher(cfg(f, { excludeDirs: [ex] }));
    expect(await m.matchesRoot(ex)).toBe(true);
    expect(await m.matchesRoot(path.join(ex, 'app'))).toBe(true);
    expect(await m.matchesRoot(`${ex}-evil`)).toBe(false);
    expect(await m.matchesRoot(path.join(f.dir, 'work', 'client', 'APP'))).toBe(true);
    expect(await m.matchesRoot(path.join(f.dir, 'work', 'other'))).toBe(false);
  });

  it('符号链接别名:排除写的是链接路径,根写真实路径(反之亦然)都命中', async () => {
    const f = await makeL0Fx('xm-link-');
    const real = path.join(f.dir, 'work', 'real');
    const alias = path.join(f.dir, 'work', 'alias');
    await mkdirp(f.fx, real, 0o755);
    await symlink(f.fx, real, alias);
    const viaAlias = await createExcludeMatcher(cfg(f, { excludeDirs: [alias] }));
    expect(await viaAlias.matchesRoot(path.join(real, 'sub'))).toBe(true);
    const viaReal = await createExcludeMatcher(cfg(f, { excludeDirs: [real] }));
    expect(await viaReal.matchesRoot(path.join(alias, 'sub'))).toBe(true);
  });

  it('exclude_names:取 canonical 之后的 basename(链接名 ok -> node_modules 命中,原始 basename 不算)', async () => {
    const f = await makeL0Fx('xm-names-');
    const real = path.join(f.dir, 'work', 'node_modules');
    const alias = path.join(f.dir, 'work', 'ok');
    await mkdirp(f.fx, real, 0o755);
    await symlink(f.fx, real, alias);
    const m = await createExcludeMatcher(cfg(f, { excludeNames: ['Node_Modules'] }));
    expect(await m.matchesRoot(alias)).toBe(true);
    expect(await m.matchesRoot(path.join(f.dir, 'work', 'plain'))).toBe(false);
  });

  it('相对路径的排除项不参与目录比较(不抛错、不误命中)', async () => {
    const f = await makeL0Fx('xm-rel-');
    const m = await createExcludeMatcher(cfg(f, { excludeDirs: ['relative/dir'] }));
    expect(await m.matchesRoot(path.join(f.dir, 'relative', 'dir'))).toBe(false);
  });

  it('祖先 (dev,ino) 命中:探测说某个祖先与排除目录同一 inode → 命中;对照:inode 不同 → 不命中', async () => {
    const f = await makeL0Fx('xm-ino-');
    const ex = path.join(f.dir, 'work', 'excluded');
    const other = path.join(f.dir, 'work', 'elsewhere');
    await mkdirp(f.fx, ex, 0o755);
    await mkdirp(f.fx, path.join(other, 'deep'), 0o755);
    const mk = (same: boolean): AttributionProbe => ({
      exists: async () => true,
      realpath: async (p) => p,
      devIno: async (p) => {
        if (p === ex) return { dev: 1, ino: 100 };
        if (p === other) return same ? { dev: 1, ino: 100 } : { dev: 1, ino: 200 };
        return { dev: 9, ino: p.length + 1000 };
      },
    });
    const root = path.join(other, 'deep');
    expect(
      await (await createExcludeMatcher(cfg(f, { excludeDirs: [ex] }), mk(true))).matchesRoot(root),
    ).toBe(true);
    expect(
      await (
        await createExcludeMatcher(cfg(f, { excludeDirs: [ex] }), mk(false))
      ).matchesRoot(root),
    ).toBe(false);
  });

  it('NFD / NFC 别名:探测把两种写法映射到同一 inode(APFS 行为)→ 命中;对照:不同 inode → 不命中', async () => {
    const f = await makeL0Fx('xm-nfd-');
    const nfc = path.join(f.dir, 'work', 'café');
    const nfd = path.join(f.dir, 'work', 'café');
    const mk = (same: boolean): AttributionProbe => ({
      exists: async () => true,
      realpath: async (p) => p,
      devIno: async (p) =>
        p === nfc || p === nfd
          ? { dev: 1, ino: same ? 5 : p === nfc ? 5 : 6 }
          : { dev: 9, ino: p.length + 1000 },
    });
    expect(
      await (await createExcludeMatcher(cfg(f, { excludeDirs: [nfc] }), mk(true))).matchesRoot(nfd),
    ).toBe(true);
    expect(
      await (
        await createExcludeMatcher(cfg(f, { excludeDirs: [nfc] }), mk(false))
      ).matchesRoot(nfd),
    ).toBe(false);
  });
});

describe('采集策略(空索引也生效;自我排除先于用户排除)', () => {
  it('索引为空 + 配置 exclude_dirs:被排除目录下的 cwd → excluded;未排除的 → process(projectRoot = canonical)', async () => {
    const f = await makeL0Fx('cp-empty-');
    const ex = path.join(f.dir, 'work', 'customer');
    const okDir = path.join(f.dir, 'work', 'mine');
    await mkdirp(f.fx, ex, 0o755);
    await mkdirp(f.fx, okDir, 0o755);
    const p = await createRsiCollectPolicy(cfg(f, { excludeDirs: [ex] }), f.io.stateDir);
    expect(await p.decide(path.join(ex, 'app'))).toEqual({ action: 'skip', reason: 'excluded' });
    expect(await p.decide(okDir)).toEqual({ action: 'process', projectRoot: okDir });
  });

  it('cwd 为 null / 空 / 相对路径 → unknown_project;状态目录内 → self_state(先于 excluded)', async () => {
    const f = await makeL0Fx('cp-misc-');
    const p = await createRsiCollectPolicy(cfg(f, { excludeDirs: [f.io.stateDir] }), f.io.stateDir);
    for (const c of [null, '', 'rel/path']) {
      expect(await p.decide(c)).toEqual({ action: 'skip', reason: 'unknown_project' });
    }
    expect(await p.decide(path.join(f.io.stateDir, 'reflect', 'cwd'))).toEqual({
      action: 'skip',
      reason: 'self_state',
    });
  });

  it('采集策略与 attribution 对同一路径结论相同(同一份匹配实现)', async () => {
    const f = await makeL0Fx('cp-same-');
    const ex = path.join(f.dir, 'work', 'Ex');
    const real = path.join(f.dir, 'work', 'node_modules');
    const alias = path.join(f.dir, 'work', 'ok');
    await mkdirp(f.fx, ex, 0o755);
    await mkdirp(f.fx, real, 0o755);
    await symlink(f.fx, real, alias);
    const config = cfg(f, { excludeDirs: [ex], excludeNames: ['node_modules'] });
    const roots = [
      path.join(ex, 'a'),
      path.join(f.dir, 'work', 'ex', 'b'),
      alias,
      path.join(f.dir, 'work', 'free'),
    ];
    const policy = await createRsiCollectPolicy(config, f.io.stateDir);
    const entries = roots.map((r, i) => ({ key: key(i + 1), path: r, dev: 1, ino: 1 }));
    const att = await attribute({
      config,
      indexStatus: 'ok',
      index: indexOf(entries),
      counts: { salt_fp: 'aaaaaaaa' + 'aaaa' },
    });
    for (const [i, r] of roots.entries()) {
      const d = await policy.decide(r);
      expect(att.classify(key(i + 1)) === 'X', r).toBe(
        d.action === 'skip' && d.reason === 'excluded',
      );
    }
    // 正向前提:四个路径里确有命中的与未命中的
    expect(roots.filter((_, i) => att.classify(key(i + 1)) === 'X').length).toBe(3);
  });
});
