/**
 * reflect `--run-llm` 与 judge `--run-llm` 的 rsi 锁内步骤(契约 §20.5 R20-5.6、R20-4.5、R20-4.7;R20-A2 B5d,方案 §8)。两个命令共用,不放进 `reflect.ts`(judge 已经 import 它的接线辅助)。
 *
 * - {@link serviceCtxOf}:拿到锁句柄时(闸门判 lock)config 必为 on,用命令的 `ctx.io` 构造服务层上下文;不是 on 一律 fail-closed `internal`。
 * - {@link enterWriterLock}:锁内、业务之前:`recoverUnderLock`(未完成的提交按当前文件重建清单)→ `resumeTaintWith`(补完上一次中断的 taint;journal 不合规 / 读不出会在这里抛 fail-closed)。
 * - {@link settleStaged}:暂存区写完之后、同一把锁内:`refreshStagedUnderLock`(counts 在且盐相符 → 只写 `staged`;缺失 / 盐不符 → 写四段;盐缺失 → 不写)
 *   → 写了 counts 就调一次不带日志行的 `commitUnderLockWith`(拍板 Q-L:`RSI_TRIGGERS` 里没有 reflect / judge,不改冻结枚举)。
 *   `staged[].tainted` **只取 `TAINTED` 文件事实**(`stagedProjection` 的口径),不掺「证据属 X」的推导。
 *
 * 失败路径:全部抛 `RsiLockError` / `RsiFailClosedError` / `RsiSnapshotError`,由命令按各自的 `rsiLockFailure` 映射成 `RSI_FAIL_CLOSED reason=<码>` 退 3;失锁之后零写入(服务层每个写点先 `assertHeld`)。
 * gc `--write` **不**调本文件的任何函数(只删不含 proposals 的 run,不在 staged 里;而 `resumeTaint` 的 `staging_too_large` 会挡住唯一能减少 run 数的 gc)。
 */
import type { Redactor } from '../contracts/redact.js';
import type { RsiConfig } from '../rsi/config.js';
import type { RsiLockHandle } from '../rsi/lock.js';
import { commitUnderLockWith, recoverUnderLock } from '../rsi/services/commit.js';
import { refreshStagedUnderLock } from '../rsi/services/projections.js';
import type { ServiceHooks } from '../rsi/services/staging.js';
import { resumeTaintWith } from '../rsi/services/taint.js';
import { RsiFailClosedError } from '../rsi/types.js';
import type { RsiServiceCtx } from '../rsi/types.js';
import type { CommandContext } from './types.js';

export function serviceCtxOf(
  ctx: Pick<CommandContext, 'io'>,
  config: RsiConfig | undefined,
  now: (() => Date) | undefined,
): RsiServiceCtx {
  if (config === undefined || config.status !== 'on') throw new RsiFailClosedError('internal');
  return { io: ctx.io, config, ...(now !== undefined ? { now } : {}) };
}

export async function enterWriterLock(
  sctx: RsiServiceCtx,
  lock: RsiLockHandle,
  hooks: ServiceHooks | undefined,
): Promise<void> {
  await recoverUnderLock(sctx, lock, hooks ?? {});
  await resumeTaintWith(sctx, lock, hooks ?? {});
}

export async function settleStaged(
  sctx: RsiServiceCtx,
  lock: RsiLockHandle,
  redactor: Pick<Redactor, 'pass2'>,
  hooks: ServiceHooks | undefined,
): Promise<'written_staged' | 'written_full' | 'skipped_no_salt'> {
  const r = await refreshStagedUnderLock(sctx, lock, redactor, hooks ?? {});
  if (r !== 'skipped_no_salt') {
    // 不带 log:`trigger` 是必填的合法枚举值,只在有 log 时才落盘,这里没有 log,这个值不会出现在任何文件里
    await commitUnderLockWith(sctx, lock, { trigger: 'kit' }, hooks ?? {});
  }
  return r;
}
