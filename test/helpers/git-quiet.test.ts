import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runSync } from '../../src/io/exec.js';
import { readText } from '../../src/io/read-fs.js';
import type { IoContext } from '../../src/io/paths.js';
import { GIT_NO_AUTO_ARGS, GIT_NO_AUTO_CONFIG } from './git-quiet.js';
import { makeTestRepo, type TestRepo } from './make-repo.js';
import { newWork } from '../judge/helpers.js';
import { callLib, commitAll, makeFx } from '../accept/helpers.js';
import { REPO_ROOT } from './tmp.js';

/**
 * CI 偶发红的根因:临时仓库里 git 提交后 detach 的 `maintenance run --auto` 会短暂创建
 * .git/objects/maintenance.lock,遍历 .git 的快照 lstat 到它、随后它被删 → ENOENT。
 * 来源在源头消除:每个测试建的临时仓库都带 maintenance.auto=false / gc.auto=0。
 * 竞态本身不可确定性复现,这里直接断言「配置存在且生效」。
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

/** 只读仓库级配置:不带任何 -c,不继承全局/系统配置 */
function readCfg(ctx: IoContext, dir: string, home: string, key: string): string {
  const r = runSync(ctx, 'git', ['-C', dir, 'config', '--local', '--get', key], {
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: home },
  });
  return r.stdout.trim();
}

function expectQuiet(ctx: IoContext, dir: string, home: string): void {
  expect(GIT_NO_AUTO_CONFIG.length).toBe(2); // 正向对照:键表没被清空
  expect(readCfg(ctx, dir, home, 'maintenance.auto')).toBe('false');
  expect(readCfg(ctx, dir, home, 'gc.auto')).toBe('0');
}

describe('临时 git 仓库关闭后台维护', () => {
  it('共享参数恰为 maintenance.auto=false / gc.auto=0', () => {
    expect([...GIT_NO_AUTO_ARGS]).toEqual(['-c', 'maintenance.auto=false', '-c', 'gc.auto=0']);
  });

  it('makeTestRepo:仓库级配置存在(提交之后仍在)', async () => {
    const repo: TestRepo = await makeTestRepo('quiet-');
    cleanups.push(() => repo.dispose());
    await repo.commit({ 'a.txt': 'x\n' });
    expectQuiet(repo.io, repo.dir, repo.gitEnv.HOME as string);
  });

  it('judge newWork 的仓库', async () => {
    const w = await newWork('quiet-judge-');
    expectQuiet(w.io, w.repo, w.dir);
  });

  it('accept commitAll 的仓库', async () => {
    const fx = await makeFx('quiet-accept-');
    await commitAll(fx);
    expectQuiet(fx.ctx, fx.root, path.join(fx.dir, 'githome'));
  });

  it('ops/accept/lib/lc-world.mjs 的 initRepo 真建仓(子进程)后配置存在', async () => {
    const fx = await makeFx('quiet-lc-');
    const dir = path.join(fx.dir, 'lc-repo');
    const home = path.join(fx.dir, 'lc-home');
    callLib('lc-world.mjs', 'initRepo', [[dir, home]]);
    expectQuiet(fx.ctx, dir, home);
  });

  it('ops/accept/lib/a17.mjs 的建仓入口带上(源码级,该入口无法单独调用)', async () => {
    const src = await readText(path.join(REPO_ROOT, 'ops/accept/lib/a17.mjs'));
    expect(src).toContain("'maintenance.auto=false'");
    expect(src).toContain("'gc.auto=0'");
    expect(src).toMatch(/\['config', 'maintenance\.auto', 'false'\]/);
    expect(src).toMatch(/\['config', 'gc\.auto', '0'\]/);
  });
});
