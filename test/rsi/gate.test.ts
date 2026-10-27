/**
 * R20-A2 B2:双闸(docs/contracts.md §20.4 R20-4.8、§20.5 R20-5.1;a2-plan v2 §1、§2)。
 * lockGate(要不要拿 rsi/lock)与 privacyGate(judge 含干跑 / promote 的即时闸)分开测;全部对着真实配置文件与真实目录,
 * 并断言两个闸函数本身零写入、不建目录。B2 是库级保证:命令是否按序调用是 B3 的接线与顺序测试。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRsiConfig, type RsiConfig, type RsiConfigOn } from '../../src/rsi/config.js';
import { lockGate, privacyGate, relateResolved, type Resolved } from '../../src/rsi/gate.js';
import { exists, lstat, readBytes, readDir } from '../../src/io/read-fs.js';
import { chmod, mkdirp, remove, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import { makeRsiFx, rsiToml, writeCfg, type RsiFx } from './rsi-fixture.js';

async function treeOf(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readDir(path.join(root, rel));
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isSymbolicLink) out.push(`${r} -> link`);
    else if (e.isDirectory) {
      out.push(`${r}/ ${((await lstat(path.join(root, r))).mode & 0o777).toString(8)}`);
      out.push(...(await treeOf(root, r)));
    } else {
      out.push(
        `${r} ${createHash('sha256')
          .update(await readBytes(path.join(root, r)))
          .digest('hex')
          .slice(0, 12)}`,
      );
    }
  }
  return out;
}

const on = async (f: RsiFx, extra = ''): Promise<RsiConfigOn> => {
  await writeCfg(f, rsiToml(f, extra));
  const c = await loadRsiConfig({ home: f.home });
  if (c.status !== 'on') throw new Error(`off(${c.reason})`);
  return c;
};

/** 五种「配置不可用」失败状态 + 其它 cfg_*:各自造出真实配置文件,返回加载结果 */
async function brokenConfigs(): Promise<[string, RsiConfig][]> {
  const out: [string, RsiConfig][] = [];
  const make = async (name: string, prep: (f: RsiFx) => Promise<void>): Promise<void> => {
    const f = await makeRsiFx(`gate-${name}-`);
    await prep(f);
    out.push([name, await loadRsiConfig({ home: f.home })]);
  };
  await make('cfg_schema', (f) => writeCfg(f, '[rsi]\nenabled = true\nagents = ["kimi"]\n'));
  await make('cfg_unreadable', async (f) => {
    await writeCfg(f, rsiToml(f));
    await chmod(f.fx, f.cfgFile, 0o000);
  });
  await make('repo_invalid', (f) => writeCfg(f, rsiToml(f, '', { repo: 'relative' })));
  await make('overlay_invalid', (f) => writeCfg(f, rsiToml(f, 'overlay = "relative.toml"\n')));
  await make('exclude_invalid', (f) => writeCfg(f, rsiToml(f, 'exclude_dirs = ["relative"]\n')));
  return out;
}

describe('privacyGate:无 [rsi] / 未启用 = legacyAllowed;[rsi] 存在但配置不可用 = deny', () => {
  it('absent / no_section / disabled → legacyAllowed(兼容现有手动流程)', async () => {
    const f = await makeRsiFx('pg-legacy-');
    expect(privacyGate(await loadRsiConfig({ home: f.home }))).toEqual({ kind: 'legacyAllowed' });
    await writeCfg(f, '[update]\nauto_install = true\n');
    expect(privacyGate(await loadRsiConfig({ home: f.home }))).toEqual({ kind: 'legacyAllowed' });
    await writeCfg(f, '[rsi]\nenabled = false\n');
    expect(privacyGate(await loadRsiConfig({ home: f.home }))).toEqual({ kind: 'legacyAllowed' });
  });

  it('on 且无 block → enforce', async () => {
    const f = await makeRsiFx('pg-enforce-');
    expect(privacyGate(await on(f))).toEqual({ kind: 'enforce' });
  });

  // 五种 cfg 失败状态 × judge 干跑 / judge 真跑 / promote:三个调用点共用同一个闸函数(命令接线在 B3b / B3c),
  // 这里对每个调用点各验一遍,钉死「同一个配置结果对每个入口都 fail-closed(退出 3),不会被当成 legacy 放行」
  const SITES = ['judge 干跑', 'judge 真跑', 'promote'] as const;
  for (const site of SITES) {
    it(`${site}:五种配置失败各自 deny(RSI_FAIL_CLOSED reason=<原因码>,退出 3)`, async () => {
      const broken = await brokenConfigs();
      if (process.getuid?.() === 0) broken.splice(1, 1); // root 读得了 0000
      expect(broken.map(([n]) => n)).toEqual(
        process.getuid?.() === 0
          ? ['cfg_schema', 'repo_invalid', 'overlay_invalid', 'exclude_invalid']
          : ['cfg_schema', 'cfg_unreadable', 'repo_invalid', 'overlay_invalid', 'exclude_invalid'],
      );
      for (const [name, cfg] of broken) {
        expect(privacyGate(cfg), `${site}:${name}`).toEqual({
          kind: 'deny',
          code: 'RSI_FAIL_CLOSED',
          reason: name,
          exit: 3,
        });
      }
    });
  }

  it('其余 cfg_*(文件层失败与 cfg_parse)读不到 [rsi] 段,无法证明没有 → 同样 deny(取舍见 gate.ts 注释)', async () => {
    const f = await makeRsiFx('pg-cfgfile-');
    await writeCfg(f, rsiToml(f), 0o664);
    expect(privacyGate(await loadRsiConfig({ home: f.home }))).toMatchObject({
      kind: 'deny',
      reason: 'cfg_perm',
    });
    await writeCfg(f, 'not = = toml');
    expect(privacyGate(await loadRsiConfig({ home: f.home }))).toMatchObject({
      kind: 'deny',
      reason: 'cfg_parse',
    });
  });

  it('与锁闸互不替代:配置 off 时 lockGate=off,privacyGate 仍可能 deny(cfg_schema / repo_invalid)', async () => {
    for (const [name, cfg] of await brokenConfigs()) {
      if (cfg.status !== 'off') continue; // overlay / exclude 是 on + block
      expect(await lockGate(cfg, { stateDir: '/nonexistent/anything' }), name).toEqual({
        kind: 'off',
      });
      expect(privacyGate(cfg).kind, name).toBe('deny');
    }
  });
});

describe('lockGate:配置', () => {
  it('配置 off(任何原因)→ off,且不碰文件系统(stateDir 解析不了也是 off)', async () => {
    for (const reason of [
      'absent',
      'no_section',
      'cfg_perm',
      'cfg_schema',
      'disabled',
      'repo_invalid',
    ] as const) {
      expect(
        await lockGate({ status: 'off', reason }, { stateDir: '/definitely/not/there' }),
        reason,
      ).toEqual({ kind: 'off' });
    }
  });

  it('配置 off 时平台不支持也是 off(D8:现有命令把闸门当 off);on 时平台不支持 → refuse(退出 3 state_dir_unsafe)', async () => {
    const f = await makeRsiFx('lg-platform-');
    const cfg = await on(f);
    const opts = { platformSupported: false };
    expect(
      await lockGate({ status: 'off', reason: 'disabled' }, { stateDir: f.dir }, opts),
    ).toEqual({ kind: 'off' });
    expect(await lockGate(cfg, { stateDir: path.join(f.repo, '.state') }, opts)).toEqual({
      kind: 'refuse',
      code: 'RSI_FAIL_CLOSED',
      reason: 'state_dir_unsafe',
      exit: 3,
    });
    expect((await lockGate(cfg, { stateDir: path.join(f.repo, '.state') })).kind).toBe('lock');
  });

  it('on + block(overlay_invalid / exclude_invalid)不改变锁判断:相同照样 lock', async () => {
    const f = await makeRsiFx('lg-block-');
    const cfg = await on(f, 'exclude_dirs = ["relative"]\n');
    expect(cfg.block).toBe('exclude_invalid');
    expect((await lockGate(cfg, { stateDir: path.join(f.repo, '.state') })).kind).toBe('lock');
  });
});

describe('lockGate:D1 状态目录关系(不建目录的路径解析)', () => {
  it('相同:两棵树都不存在 / 都存在 / 经符号链接指向 → lock;不建任何目录', async () => {
    const f = await makeRsiFx('lg-same-');
    const cfg = await on(f);
    const before = await treeOf(f.dir);
    expect(await lockGate(cfg, { stateDir: path.join(f.repo, '.state') })).toEqual({
      kind: 'lock',
    });
    expect(await exists(path.join(f.repo, '.state'))).toBe(false);
    expect(await treeOf(f.dir)).toEqual(before); // 零写入、不建目录
    await mkdirp(f.fx, path.join(f.repo, '.state'), 0o700);
    expect((await lockGate(cfg, { stateDir: path.join(f.repo, '.state') })).kind).toBe('lock');
    // 同一目录的另一种写法:经符号链接
    await symlink(f.fx, f.repo, path.join(f.dir, 'repo-alias'));
    expect((await lockGate(cfg, { stateDir: path.join(f.dir, 'repo-alias', '.state') })).kind).toBe(
      'lock',
    );
    // stateDir 本身是指向 rsi 树的符号链接
    await remove(f.fx, path.join(f.dir, 'repo-alias'));
    await symlink(f.fx, path.join(f.repo, '.state'), path.join(f.dir, 'state-alias'));
    expect((await lockGate(cfg, { stateDir: path.join(f.dir, 'state-alias') })).kind).toBe('lock');
  });

  it('独立:另一个仓库的 .state(不存在 / 存在)→ off(现有命令不拿锁,行为不变);零写入', async () => {
    const f = await makeRsiFx('lg-indep-');
    const cfg = await on(f);
    const other = path.join(f.dir, 'other');
    await mkdirp(f.fx, other, 0o755);
    const before = await treeOf(f.dir);
    expect(await lockGate(cfg, { stateDir: path.join(other, '.state') })).toEqual({ kind: 'off' });
    expect(await treeOf(f.dir)).toEqual(before);
    await mkdirp(f.fx, path.join(other, '.state'), 0o700);
    await mkdirp(f.fx, path.join(f.repo, '.state'), 0o700);
    expect((await lockGate(cfg, { stateDir: path.join(other, '.state') })).kind).toBe('off');
  });

  it('按路径组件边界判祖先:兄弟目录 .state-old 与 .state 是独立的(不是字符串前缀)', async () => {
    const f = await makeRsiFx('lg-boundary-');
    const cfg = await on(f);
    expect((await lockGate(cfg, { stateDir: path.join(f.repo, '.state-old') })).kind).toBe('off');
    expect((await lockGate(cfg, { stateDir: path.join(f.repo, '.state2', 'x') })).kind).toBe('off');
  });

  it('父子重叠 → refuse(状态树是 rsi 树的上级或下级;含两边都不存在、含经链接的重叠)', async () => {
    const f = await makeRsiFx('lg-nested-');
    const cfg = await on(f);
    const refuse = { kind: 'refuse', code: 'RSI_FAIL_CLOSED', reason: 'state_dir_unsafe', exit: 3 };
    // 现有命令的状态目录是 rsi 树的子目录 / 上级(含仓库根本身)
    expect(await lockGate(cfg, { stateDir: path.join(f.repo, '.state', 'sub') })).toEqual(refuse);
    expect(await lockGate(cfg, { stateDir: f.repo })).toEqual(refuse);
    expect(await lockGate(cfg, { stateDir: f.dir })).toEqual(refuse);
    // 存在的目录 + 经符号链接写法的子目录
    await mkdirp(f.fx, path.join(f.repo, '.state', 'sub'), 0o700);
    await symlink(f.fx, path.join(f.repo, '.state'), path.join(f.dir, 'alias'));
    expect(await lockGate(cfg, { stateDir: path.join(f.dir, 'alias', 'sub') })).toEqual(refuse);
  });

  it('无法证明 → refuse:悬空符号链接 / 符号链接循环 / 中间组件是文件 / 末端是文件', async () => {
    const f = await makeRsiFx('lg-unprovable-');
    const cfg = await on(f);
    const refuse = { kind: 'refuse', code: 'RSI_FAIL_CLOSED', reason: 'state_dir_unsafe', exit: 3 };
    // 悬空链接(不能当成「不存在的后缀」向上回退后判独立)
    await symlink(f.fx, path.join(f.dir, 'nothing-here'), path.join(f.dir, 'dangling'));
    expect(await lockGate(cfg, { stateDir: path.join(f.dir, 'dangling') })).toEqual(refuse);
    expect(await lockGate(cfg, { stateDir: path.join(f.dir, 'dangling', 'x') })).toEqual(refuse);
    // 循环(自指的符号链接:safe-fs 造不出两个互指的,自指的可以)
    await symlink(f.fx, path.join(f.dir, 'selfloop'), path.join(f.dir, 'selfloop'));
    expect(await lockGate(cfg, { stateDir: path.join(f.dir, 'selfloop', 'x') })).toEqual(refuse);
    expect(await lockGate(cfg, { stateDir: path.join(f.dir, 'selfloop') })).toEqual(refuse);
    // 中间组件是普通文件(ENOTDIR)与末端是普通文件
    await writeFile(f.fx, path.join(f.dir, 'afile'), 'x', { mode: 0o600 });
    expect(await lockGate(cfg, { stateDir: path.join(f.dir, 'afile', 'x') })).toEqual(refuse);
    expect(await lockGate(cfg, { stateDir: path.join(f.dir, 'afile') })).toEqual(refuse);
    // rsi 树一侧无法解析同样 refuse
    await symlink(f.fx, path.join(f.dir, 'nothing-2'), path.join(f.repo, '.state'));
    expect(await lockGate(cfg, { stateDir: path.join(f.dir, 'elsewhere', '.state') })).toEqual(
      refuse,
    );
  });

  it('仅忽略大小写后相同 / 重叠,又没有 (dev, ino) 证明 → refuse(保守;不用大小写折叠来证明「相同」)', async () => {
    const f = await makeRsiFx('lg-case-');
    const cfg = await on(f);
    const refuse = { kind: 'refuse', code: 'RSI_FAIL_CLOSED', reason: 'state_dir_unsafe', exit: 3 };
    expect(await lockGate(cfg, { stateDir: path.join(f.repo, '.STATE') })).toEqual(refuse);
    expect(await lockGate(cfg, { stateDir: path.join(f.repo, '.State', 'x') })).toEqual(refuse);
  });

  it('解析不稳定 → refuse:两次解析之间路径被换(符号链接改指向),身份信息不一致', async () => {
    const f = await makeRsiFx('lg-unstable-');
    const cfg = await on(f);
    const a = path.join(f.dir, 'a');
    const b = path.join(f.dir, 'b');
    await mkdirp(f.fx, a, 0o755);
    await mkdirp(f.fx, b, 0o755);
    const link = path.join(f.dir, 'link');
    await symlink(f.fx, a, link);
    // 对照:不换时是稳定的独立目录
    expect((await lockGate(cfg, { stateDir: path.join(link, '.state') })).kind).toBe('off');
    // 变异演练:第一次解析之后把 link 改指 b(两个目录路径不同)
    let swapped = false;
    const r = await lockGate(
      cfg,
      { stateDir: path.join(link, '.state') },
      {
        hooks: {
          betweenResolves: async () => {
            if (swapped) return;
            swapped = true;
            await remove(f.fx, link);
            await symlink(f.fx, b, link);
          },
        },
      },
    );
    expect(r).toEqual({
      kind: 'refuse',
      code: 'RSI_FAIL_CLOSED',
      reason: 'state_dir_unsafe',
      exit: 3,
    });
  });

  it('解析不稳定:同一字符串结果但祖先 inode 变了(目录被删后重建)→ refuse(不是只比最终字符串)', async () => {
    const f = await makeRsiFx('lg-inode-');
    const cfg = await on(f);
    const d = path.join(f.dir, 'swapme');
    await mkdirp(f.fx, d, 0o755);
    let swapped = false;
    const r = await lockGate(
      cfg,
      { stateDir: path.join(d, '.state') },
      {
        hooks: {
          betweenResolves: async () => {
            if (swapped) return;
            swapped = true;
            // 旧目录改名保留(它的 inode 仍被占用),再在原路径新建:字符串结果不变、祖先 inode 必然不同
            await rename(f.fx, d, `${d}-old`);
            await mkdirp(f.fx, d, 0o755);
          },
        },
      },
    );
    expect(r.kind).toBe('refuse');
  });

  it('拒绝 / 放行路径都零写入:前后目录快照一致,不建 rsi/、不建锁(变异:闸函数里 mkdir → 红)', async () => {
    const f = await makeRsiFx('lg-nowrite-');
    const cfg = await on(f);
    const before = await treeOf(f.dir);
    for (const stateDir of [
      path.join(f.repo, '.state'),
      path.join(f.dir, 'other', '.state'),
      f.repo,
      path.join(f.dir, 'dangling-not-created', 'x'),
    ]) {
      await lockGate(cfg, { stateDir });
    }
    expect(await treeOf(f.dir)).toEqual(before);
    expect(await exists(path.join(f.repo, '.state'))).toBe(false);
  });
});

describe('relateResolved:共同已存在前缀(同一实体、不同路径写法)只比较余下片段', () => {
  const r = (real: string, ids: string[], rest: string[], selfId?: string): Resolved => ({
    real,
    ids,
    selfId,
    rest,
  });
  // 模拟 bind mount / 大小写不敏感卷 / firmlink:`/real/repo` 与 `/alias/repo` 是同一实体(id 1:10),realpath 仍保留两种写法
  const A = r('/real/repo/.state', ['1:10', '1:2', '1:1'], ['.state']);
  const B = r('/alias/repo/.state', ['1:10', '1:7', '1:1'], ['.state']);

  it('余下片段逐段相等 → 同一棵尚不存在的树(lock);不能因为路径字符串不同就判独立(变异:只比字符串 → 红)', () => {
    expect(relateResolved(A, B)).toBe('same');
  });

  it('同实体前缀下的父子 / 忽略大小写后相同或重叠 → 无法证明(refuse);兄弟 → 独立', () => {
    const child = (real: string, rest: string[]): Resolved => ({ ...B, real, rest });
    expect(relateResolved(A, child('/alias/repo/.state/x', ['.state', 'x']))).toBe('unprovable');
    expect(relateResolved(r('/real/repo/.state/x', ['1:10', '1:2'], ['.state', 'x']), B)).toBe(
      'unprovable',
    );
    expect(relateResolved(A, child('/alias/repo/.STATE', ['.STATE']))).toBe('unprovable');
    expect(relateResolved(A, child('/alias/repo/.State/y', ['.State', 'y']))).toBe('unprovable');
    expect(relateResolved(A, child('/alias/repo/.other', ['.other']))).toBe('independent');
    expect(relateResolved(A, child('/alias/repo/.state-old', ['.state-old']))).toBe('independent');
  });

  it('一方已存在且恰是另一方前缀链上的一级(经别名写法)→ 重叠;都已存在且 (dev, ino) 相同 → 相同', () => {
    expect(relateResolved(r('/alias/repo', ['1:10', '1:7', '1:1'], [], '1:10'), B)).toBe(
      'unprovable',
    );
    expect(relateResolved(r('/a', ['1:5'], [], '1:5'), r('/b', ['1:5'], [], '1:5'))).toBe('same');
  });

  it('前缀不是同一实体 → 按字符串关系判:不同分叉独立、字符串祖先 / 仅大小写不同保守拒绝', () => {
    expect(relateResolved(A, r('/other/.state', ['1:20', '1:1'], ['.state']))).toBe('independent');
    expect(relateResolved(A, r('/real/repo/.state/sub', ['1:30', '1:1'], ['sub']))).toBe(
      'unprovable',
    );
    expect(relateResolved(A, r('/REAL/repo/.state', ['1:40', '1:1'], ['.state']))).toBe(
      'unprovable',
    );
  });
});
