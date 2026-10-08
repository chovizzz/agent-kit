import * as path from 'node:path';
import { createIoContext } from '../../src/io/paths.js';
import { mkdtemp } from '../../src/io/safe-fs.js';
import type { IoContext } from '../../src/io/paths.js';

export const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

/** 以真实 process.env / 仓库根建 ctx(KIT_TMP、KIT_WRITE_ROOTS 等由调用环境决定)。 */
export function baseCtx(): IoContext {
  return createIoContext({ cwd: REPO_ROOT });
}

/** 唯一临时目录:KIT_TMP 下,未设置则落在 <repo>/.state/test-tmp(gitignored)。 */
export async function makeTempDir(prefix: string): Promise<{ ctx: IoContext; dir: string }> {
  const ctx = baseCtx();
  const parent = ctx.tmpDir ?? path.join(ctx.stateDir, 'test-tmp');
  const dir = await mkdtemp(ctx, parent, prefix);
  return { ctx, dir };
}

/** 在 dir 内另建只允许写 dir/<sub> 的 ctx,用来演练「根外写入」。 */
export function narrowCtx(dir: string, sub: string): IoContext {
  return createIoContext({
    cwd: REPO_ROOT,
    env: { KIT_TMP: dir, KIT_WRITE_ROOTS: path.join(dir, sub), PATH: '/usr/bin:/bin' },
  });
}

export function wideCtx(dir: string): IoContext {
  return createIoContext({ cwd: REPO_ROOT, env: { KIT_TMP: dir, PATH: '/usr/bin:/bin' } });
}
