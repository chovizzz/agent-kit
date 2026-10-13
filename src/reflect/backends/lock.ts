/**
 * 跨进程互斥:`runLlm` 的 cwd 是固定目录,两个 agent-kit 进程(reflect 与 judge,或两个 reflect)同时跑时,
 * 一方收尾清空 cwd 会删掉另一方的子进程刚写的文件。进程内用 Promise 链串行(gate.ts),跨进程用这把锁。
 * 原子创建只能借 safe-fs 里 `EEXIST` 语义明确的 `symlink`(safe-fs 没有 O_EXCL 写):锁 = `<state>/reflect/llm.lock`
 * 这条指向 cwd 目录的符号链接,过期判断用链接自身的 mtime。拿不到锁**不排队等**,直接报 busy。
 */
import * as path from 'node:path';
import type { IoContext } from '../../io/paths.js';
import { llmCwd } from '../../io/llm-exec.js';
import { lstat } from '../../io/read-fs.js';
import { mkdirp, remove, symlink } from '../../io/safe-fs.js';

export const LOCK_STALE_MS = 15 * 60_000;

export function lockPath(ctx: IoContext): string {
  return path.join(ctx.stateDir, 'reflect', 'llm.lock');
}

export type LockOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'busy' }
  | { readonly status: 'failed' };

async function tryAcquire(ctx: IoContext): Promise<'got' | 'exists' | 'failed'> {
  try {
    await symlink(ctx, llmCwd(ctx), lockPath(ctx));
    return 'got';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed';
  }
}

export async function withLlmLock<T>(
  ctx: IoContext,
  staleMs: number,
  fn: () => Promise<T>,
): Promise<LockOutcome<T>> {
  try {
    await mkdirp(ctx, path.join(ctx.stateDir, 'reflect'), 0o700);
    // 链接指向的目录必须真实存在(悬空链接会被 safe-fs 拒绝);它和 runLlm 的 cwd 是同一个空目录
    await mkdirp(ctx, llmCwd(ctx), 0o700);
  } catch {
    return { status: 'failed' };
  }
  let got = await tryAcquire(ctx);
  if (got === 'exists') {
    try {
      const st = await lstat(lockPath(ctx));
      const age = Date.now() - st.mtimeMs;
      // age 为很大的负数 = 时钟回拨/伪造的未来 mtime:同样视为过期,否则永远 busy
      if (age >= staleMs || age < -60_000) {
        await remove(ctx, lockPath(ctx));
        got = await tryAcquire(ctx);
      }
    } catch {
      return { status: 'failed' };
    }
  }
  if (got === 'exists') return { status: 'busy' };
  if (got === 'failed') return { status: 'failed' };
  try {
    return { status: 'ok', value: await fn() };
  } finally {
    try {
      await remove(ctx, lockPath(ctx));
    } catch {
      // 留下的锁会在 staleMs 后被视为过期
    }
  }
}
