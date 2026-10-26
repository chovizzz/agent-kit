import * as path from 'node:path';
import { createIoContext } from '../../src/io/paths.js';
import { realpath } from '../../src/io/read-fs.js';
import { mkdtemp } from '../../src/io/safe-fs.js';
import type { IoContext, WriteAudit } from '../../src/io/paths.js';

export const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

/** 以真实 process.env / 仓库根建 ctx(KIT_TMP、KIT_WRITE_ROOTS 等由调用环境决定)。 */
export function baseCtx(writeAudit?: WriteAudit): IoContext {
  return createIoContext({ cwd: REPO_ROOT, ...(writeAudit ? { writeAudit } : {}) });
}

/** 唯一临时目录:KIT_TMP 下,未设置则落在 <repo>/.state/test-tmp(gitignored)。 */
export async function makeTempDir(prefix: string): Promise<{ ctx: IoContext; dir: string }> {
  const ctx = baseCtx();
  const parent = ctx.tmpDir ?? path.join(ctx.stateDir, 'test-tmp');
  const made = await mkdtemp(ctx, parent, prefix);
  // macOS 的 mktemp 目录在 /var(指向 /private/var 的符号链接)下;返回真实路径,
  // 避免测试与按 realpath 工作的产品代码(walkFiles / 排除清单)比较路径字符串时因写法不同而失败。
  const dir = await realpath(made);
  return { ctx, dir };
}

/** 在 dir 内另建只允许写 dir/<sub> 的 ctx,用来演练「根外写入」。 */
export function narrowCtx(dir: string, sub: string, writeAudit?: WriteAudit): IoContext {
  return createIoContext({
    cwd: REPO_ROOT,
    ...(writeAudit ? { writeAudit } : {}),
    env: { KIT_TMP: dir, KIT_WRITE_ROOTS: path.join(dir, sub), PATH: '/usr/bin:/bin' },
  });
}

export function wideCtx(dir: string, writeAudit?: WriteAudit): IoContext {
  return createIoContext({
    cwd: REPO_ROOT,
    env: { KIT_TMP: dir, PATH: '/usr/bin:/bin' },
    ...(writeAudit ? { writeAudit } : {}),
  });
}
