/* eslint-disable no-restricted-imports -- B17:验收脚本(ops/)的黑盒测试必须起子进程跑 node;
   test/ 下的 child_process 限制属 eslint.config.js 的共享热点,待主代理为 test/ops/** 加 override 后可去掉本行。 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { IoContext } from '../../src/io/paths.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, REPO_ROOT, wideCtx } from '../helpers/tmp.js';

export const OPS = path.join(REPO_ROOT, 'ops');
export const MAIN = path.join(OPS, 'lib', 'main.mjs');
export const NO_NET = path.join(OPS, 'guards', 'no-net.cjs');

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 起 node 子进程。env 是完整白名单:没有 HOME,并且 KIT_OPS_NO_REAL_HOME=1 ——
 * 万一漏传 --home,工具会拒绝读取真实 HOME,而不是悄悄去快照它。
 */
export function runNode(
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd = REPO_ROOT,
): Run {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      KIT_OPS_NO_REAL_HOME: '1',
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function runMain(args: string[], extraEnv: Record<string, string> = {}): Run {
  return runNode([MAIN, ...args], extraEnv);
}

export interface Fixture {
  ctx: IoContext;
  dir: string;
  /** 合成的"真实 HOME"(受管路径快照读它) */
  home: string;
  /** 合成的仓库(放 ops/*.txt、adapters/**) */
  repo: string;
  out: string;
  put(rel: string, text: string): Promise<string>;
  remove(rel: string): Promise<void>;
  link(rel: string, target: string): Promise<void>;
  repoPut(rel: string, text: string): Promise<string>;
}

export async function makeFixture(managed: string, volatile: string): Promise<Fixture> {
  const { dir } = await makeTempDir('ops-fx-');
  const ctx = wideCtx(dir);
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  const out = path.join(dir, 'out');
  await safe.mkdirp(ctx, home);
  await safe.mkdirp(ctx, path.join(repo, 'ops'));
  await safe.writeFile(ctx, path.join(repo, 'ops', 'managed-paths.txt'), managed);
  await safe.writeFile(ctx, path.join(repo, 'ops', 'volatile-paths.txt'), volatile);
  const put = async (base: string, rel: string, text: string): Promise<string> => {
    const f = path.join(base, rel);
    await safe.mkdirp(ctx, path.dirname(f));
    await safe.writeFile(ctx, f, text);
    return f;
  };
  return {
    ctx,
    dir,
    home,
    repo,
    out,
    put: (rel, text) => put(home, rel, text),
    repoPut: (rel, text) => put(repo, rel, text),
    remove: (rel) => safe.remove(ctx, path.join(home, rel)),
    link: async (rel, target) => {
      await safe.mkdirp(ctx, path.dirname(path.join(home, rel)));
      await safe.symlink(ctx, target, path.join(home, rel));
    },
  };
}
