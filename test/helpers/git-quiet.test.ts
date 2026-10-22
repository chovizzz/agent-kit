import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { GIT_NO_AUTO_ARGS, GIT_NO_AUTO_CONFIG } from './git-quiet.js';
import { makeTestRepo, type TestRepo } from './make-repo.js';
import { newWork } from '../judge/helpers.js';
import { commitAll, git as acceptGit, makeFx } from '../accept/helpers.js';
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

/** 不带任何 -c、不继承用户全局配置,只读仓库级配置 */
function readCfg(dir: string, home: string, key: string): string {
  const r = spawnSync('git', ['-C', dir, 'config', '--local', '--get', key], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  return r.stdout.trim();
}

function expectQuiet(dir: string, home: string): void {
  expect(GIT_NO_AUTO_CONFIG.length).toBe(2); // 正向对照:键表没被清空
  expect(readCfg(dir, home, 'maintenance.auto')).toBe('false');
  expect(readCfg(dir, home, 'gc.auto')).toBe('0');
}

describe('临时 git 仓库关闭后台维护', () => {
  it('共享参数恰为 maintenance.auto=false / gc.auto=0', () => {
    expect([...GIT_NO_AUTO_ARGS]).toEqual(['-c', 'maintenance.auto=false', '-c', 'gc.auto=0']);
  });

  it('makeTestRepo:仓库级配置存在,提交后无 maintenance.lock / gc.pid', async () => {
    const repo: TestRepo = await makeTestRepo('quiet-');
    cleanups.push(() => repo.dispose());
    await repo.commit({ 'a.txt': 'x\n' });
    expectQuiet(repo.dir, repo.gitEnv.HOME as string);
    const r = spawnSync(
      'find',
      [path.join(repo.dir, '.git'), '-name', '*.lock', '-o', '-name', 'gc.pid'],
      {
        encoding: 'utf8',
      },
    );
    expect(r.stdout.trim()).toBe('');
  });

  it('judge newWork 的仓库', async () => {
    const w = await newWork('quiet-judge-');
    expectQuiet(w.repo, w.dir);
  });

  it('accept commitAll 的仓库', async () => {
    const fx = await makeFx('quiet-accept-');
    await commitAll(fx);
    expectQuiet(fx.root, path.join(fx.dir, 'githome'));
    expect(acceptGit(fx.root, path.join(fx.dir, 'githome'), ['status', '-s']).status).toBe(0);
  });

  it('ops/accept/lib 的 lc-world / a17 建仓同样带上', async () => {
    const lc = (await import(path.join(REPO_ROOT, 'ops/accept/lib/lc-world.mjs'))) as {
      initRepo(dir: string, home: string): void;
    };
    const os = await import('node:os');
    const fs = await import('node:fs');
    const base = fs.mkdtempSync(path.join(process.env.KIT_TMP ?? os.tmpdir(), 'quiet-lc-'));
    try {
      const dir = path.join(base, 'repo');
      const home = path.join(base, 'home');
      lc.initRepo(dir, home);
      expectQuiet(dir, home);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
    const a17 = fs.readFileSync(path.join(REPO_ROOT, 'ops/accept/lib/a17.mjs'), 'utf8');
    expect(a17).toContain("'maintenance.auto=false'");
    expect(a17).toContain("['config', 'gc.auto', '0']");
  });
});
