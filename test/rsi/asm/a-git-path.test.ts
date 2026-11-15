/**
 * 装配块 A 段:`resolveGitPath`(固定候选绝对路径,只读探测;解析不到 = null = 保持未装配)。
 * 每条拒绝原因一个负向用例,各带「同一探针下合规候选被接受」的正向对照;不读 PATH、无环境覆盖。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GIT_PATH_CANDIDATES,
  acceptableGit,
  canonicalGit,
  resolveGitPath,
  type GitPathProbe,
} from '../../../src/rsi/auto/git-path.js';

const ME = 501;
const good = { isFile: true, isDirectory: false, mode: 0o100755, uid: 0 };
const goodDir = { isFile: false, isDirectory: true, mode: 0o040755, uid: 0 };
const DIRS = ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/opt/x', '/opt/real'];

function probeOf(
  table: Record<string, Partial<typeof good> | 'throw'>,
  real: Record<string, string> = {},
  dirs: Record<string, Partial<typeof goodDir>> = {},
): GitPathProbe & { stats: string[] } {
  const stats: string[] = [];
  return {
    uid: ME,
    stats,
    async stat(p) {
      stats.push(p);
      if (DIRS.includes(p)) return { ...goodDir, ...dirs[p] };
      const t = table[p];
      if (t === undefined || t === 'throw') throw Object.assign(new Error('x'), { code: 'ENOENT' });
      return { ...good, ...t };
    },
    async realpath(p) {
      return real[p] ?? p;
    },
  };
}

describe('resolveGitPath', () => {
  it('候选清单固定为绝对路径且冻结;合规候选被接受(正向对照),按序取第一个', async () => {
    expect(GIT_PATH_CANDIDATES.every((c) => c.startsWith('/') && c.endsWith('/git'))).toBe(true);
    expect(Object.isFrozen(GIT_PATH_CANDIDATES)).toBe(true);
    const probe = probeOf({ '/usr/bin/git': {}, '/opt/homebrew/bin/git': {} });
    expect(await resolveGitPath({ probe })).toBe('/usr/bin/git');
    // 第一个候选不合规 → 跳过(不是报错),取下一个
    const p2 = probeOf({ '/usr/bin/git': { mode: 0o100666 }, '/opt/homebrew/bin/git': {} });
    expect(await resolveGitPath({ probe: p2 })).toBe('/opt/homebrew/bin/git');
  });

  it('拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在', async () => {
    const c = '/usr/bin/git';
    expect(await acceptableGit(c, probeOf({ [c]: {} }))).toBe(true);
    for (const [why, over] of [
      ['不可执行', { mode: 0o100644 }],
      ['组可写', { mode: 0o100775 }],
      ['其他人可写', { mode: 0o100757 }],
      ['属主是别人', { uid: 7777 }],
      ['不是普通文件', { isFile: false }],
    ] as const) {
      expect(await acceptableGit(c, probeOf({ [c]: over })), why).toBe(false);
    }
    expect(await acceptableGit(c, probeOf({ [c]: 'throw' })), '不存在').toBe(false);
    // 当前用户属主可接受(对照:uid 等于探针的当前 uid)
    expect(await acceptableGit(c, probeOf({ [c]: { uid: ME } }))).toBe(true);
  });

  it('realpath 之后文件名不是 git → 拒绝(makeGitReadonly 的断言);相对路径 / 文件名不是 git 的候选 → 拒绝', async () => {
    const c = '/usr/bin/git';
    expect(await acceptableGit(c, probeOf({ '/opt/x/git': {} }, { [c]: '/opt/x/git' }))).toBe(true);
    expect(
      await acceptableGit(c, probeOf({ '/opt/x/not-git': {} }, { [c]: '/opt/x/not-git' })),
    ).toBe(false);
    expect(await acceptableGit('git', probeOf({ git: {} }))).toBe(false);
    expect(await acceptableGit('/usr/bin/gitx', probeOf({ '/usr/bin/gitx': {} }))).toBe(false);
  });

  it('全部解析不到 → null(保持未装配);只探测固定候选(不查 PATH:合规的 git 放在别处也不影响结果)', async () => {
    const probe = probeOf({ '/somewhere/else/git': {} });
    expect(await resolveGitPath({ probe })).toBeNull();
    expect(probe.stats.length).toBeGreaterThan(0);
    expect(probe.stats.every((p) => GIT_PATH_CANDIDATES.includes(p))).toBe(true);
  });

  it('候选是符号链接:检查的是链接目标(规范路径)并返回规范路径,不返回候选名;目标不合规则拒绝(变异:检查 / 返回候选原路径 → 红)', async () => {
    const c = '/usr/bin/git';
    const linked = probeOf({ '/opt/real/git': {} }, { [c]: '/opt/real/git' });
    expect(await canonicalGit(c, linked)).toBe('/opt/real/git');
    expect(await resolveGitPath({ probe: linked, candidates: [c] })).toBe('/opt/real/git');
    // 候选名本身的元数据合规、链接目标不合规:必须拒绝(只检查候选名会放过)
    const bad = probeOf({ [c]: {}, '/opt/real/git': { mode: 0o100777 } }, { [c]: '/opt/real/git' });
    expect(await canonicalGit(c, bad)).toBeNull();
    // 无链接的对照:返回值就是候选本身
    expect(await canonicalGit(c, probeOf({ [c]: {} }))).toBe(c);
  });

  it('父目录可被组 / 其他人写、属主不可信、不是目录 → 拒绝;文件自身合规的对照被接受(变异:去掉父目录检查 → 红)', async () => {
    const c = '/usr/bin/git';
    expect(await canonicalGit(c, probeOf({ [c]: {} }))).toBe(c);
    for (const [why, dir] of [
      ['组可写', { mode: 0o040775 }],
      ['其他人可写', { mode: 0o040757 }],
      ['属主是别人', { uid: 7777 }],
      ['不是目录', { isDirectory: false }],
    ] as const) {
      expect(await canonicalGit(c, probeOf({ [c]: {} }, {}, { '/usr/bin': dir })), why).toBeNull();
    }
    // 父目录属主是当前用户且 0755:可接受(对照)
    expect(await canonicalGit(c, probeOf({ [c]: {} }, {}, { '/usr/bin': { uid: ME } }))).toBe(c);
    // 链接目标所在目录可写 → 拒绝,即便候选所在目录合规
    const p = probeOf(
      { '/opt/real/git': {} },
      { [c]: '/opt/real/git' },
      { '/opt/real': { mode: 0o040777 } },
    );
    expect(await canonicalGit(c, p)).toBeNull();
  });

  it('import 本身不读盘:探针只在调用 resolveGitPath 时被使用', async () => {
    const probe = probeOf({ '/usr/bin/git': {} });
    const spy = vi.spyOn(probe, 'stat');
    expect(spy).not.toHaveBeenCalled();
    await resolveGitPath({ probe });
    expect(spy).toHaveBeenCalled();
  });
});
