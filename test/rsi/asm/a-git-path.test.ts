/**
 * 装配块 A 段:`resolveGitPath`(固定候选绝对路径,只读探测;解析不到 = null = 保持未装配)。
 * 每条拒绝原因一个负向用例,各带「同一探针下合规候选被接受」的正向对照;不读 PATH、无环境覆盖。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GIT_PATH_CANDIDATES,
  acceptableGit,
  resolveGitPath,
  type GitPathProbe,
} from '../../../src/rsi/auto/git-path.js';

const ME = 501;
const good = { isFile: true, mode: 0o100755, uid: 0 };

function probeOf(
  table: Record<string, Partial<typeof good> | 'throw'>,
  real: Record<string, string> = {},
): GitPathProbe & { stats: string[] } {
  const stats: string[] = [];
  return {
    uid: ME,
    stats,
    async stat(p) {
      stats.push(p);
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
    expect(await acceptableGit(c, probeOf({ [c]: {} }, { [c]: '/opt/x/git' }))).toBe(true);
    expect(await acceptableGit(c, probeOf({ [c]: {} }, { [c]: '/opt/x/not-git' }))).toBe(false);
    expect(await acceptableGit('git', probeOf({ git: {} }))).toBe(false);
    expect(await acceptableGit('/usr/bin/gitx', probeOf({ '/usr/bin/gitx': {} }))).toBe(false);
  });

  it('全部解析不到 → null(保持未装配);只探测固定候选(不查 PATH:合规的 git 放在别处也不影响结果)', async () => {
    const probe = probeOf({ '/somewhere/else/git': {} });
    expect(await resolveGitPath({ probe })).toBeNull();
    expect(probe.stats.length).toBeGreaterThan(0);
    expect(probe.stats.every((p) => GIT_PATH_CANDIDATES.includes(p))).toBe(true);
  });

  it('import 本身不读盘:探针只在调用 resolveGitPath 时被使用', async () => {
    const probe = probeOf({ '/usr/bin/git': {} });
    const spy = vi.spyOn(probe, 'stat');
    expect(spy).not.toHaveBeenCalled();
    await resolveGitPath({ probe });
    expect(spy).toHaveBeenCalled();
  });
});
