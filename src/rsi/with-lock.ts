/**
 * 锁接线(契约 R20-5.1、D1;v2 §2、§3):按 `lockGate` 决定拿不拿 `rsi/lock`。给 B3b 的 reflect / judge / gc 与以后的写入方共用。
 *
 *  - `off`:不拿锁,`fn(null)`,**不建 `rsi/`、不写任何东西**(现有命令行为逐字节不变);
 *  - `lock`:`withRsiLock` 拿锁 → `fn(handle)` → 一定释放(`fn` 抛错也释放);拿不到 → `RsiLockError`(`locked` / `locked_over_ttl` → `RSI_NOT_RUN`,退出 4)原样上抛;
 *  - `refuse`:抛 `RsiFailClosedError('state_dir_unsafe')`(退出 3),不调用 `fn`、不碰任何文件。
 *
 * `lockGate == off` **不是**放行 judge / promote:隐私闸 `privacyGate` 另判(见 `gate.ts`),调用方先过它。
 * 本函数不恢复快照、不做即时闸:拿到句柄后由调用方在锁内按 `types.ts` 头注释的顺序继续。
 */
import type { IoContext } from '../io/paths.js';
import type { RsiConfig } from './config.js';
import { lockGate, type LockGateOptions } from './gate.js';
import { withRsiLock, type RsiLockDeps, type RsiLockHandle } from './lock.js';
import { RsiFailClosedError } from './types.js';

export interface RsiGatedCtx {
  readonly io: IoContext;
  readonly config: RsiConfig;
}

export interface WithRsiLockIfGatedOptions {
  /** 透传给 `lockGate`(测试缝 / 平台能力覆盖) */
  gate?: LockGateOptions;
  /** 透传给 `withRsiLock`(时钟、pid、存活判据等) */
  lock?: RsiLockDeps;
}

export async function withRsiLockIfGated<T>(
  ctx: RsiGatedCtx,
  fn: (lock: RsiLockHandle | null) => Promise<T>,
  opts: WithRsiLockIfGatedOptions = {},
): Promise<T> {
  const gate = await lockGate(ctx.config, ctx.io, opts.gate);
  switch (gate.kind) {
    case 'off':
      return fn(null);
    case 'lock':
      return withRsiLock(ctx.io, (lock) => fn(lock), opts.lock);
    case 'refuse':
      throw new RsiFailClosedError(gate.reason);
  }
}
