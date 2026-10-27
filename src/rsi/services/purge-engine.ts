/**
 * purge 阶段机(R20-3.8.4;R20-A2 B5 方案 §6.1 / §0.5 R1;**B5-0 只放签名桩,B5c 实装**;tick 也调它)。
 * `resumePurgeUnderLock` 按 journal `mode` 分派:`'purge'` → 五阶段;`'salvage'` → `salvageInvalidJournal` 从对应 phase 续做;
 * 两者 `phase === 'done'` 都只 `commitUnderLock` 加删 journal(R5)。
 */
import type { RsiLockHandle } from '../lock.js';
import type { RsiServiceCtx } from '../types.js';
import { notImplemented } from './not-implemented.js';
import type { PurgeTargets } from './purge-plan.js';
import type { ServiceHooks } from './staging.js';

/** 测试缝:`hooks.point` 同其它服务;`beforeWrite` 在每个阶段结束、写 journal 之前调用(故障注入点) */
export interface PurgeDeps {
  hooks?: ServiceHooks;
  beforeWrite?: (stage: string) => Promise<void> | void;
}

export interface PurgeResult {
  keys: number;
  signalsRemoved: number;
  sessionRowsRemoved: number;
  cursorRemoved: number;
  indexRemoved: number;
  runsTainted: number;
  promotesTainted: number;
}

export interface SalvageResult {
  runsTainted: number;
  promotesTainted: number;
}

/** 新 purge:写 journal(`planned`)之后走续做 */
export async function runPurgeUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  plan: { keys: readonly string[]; targets: PurgeTargets },
  deps?: PurgeDeps,
): Promise<PurgeResult> {
  return notImplemented('runPurgeUnderLock', ctx, lock, plan, deps);
}

/** 按 journal 已记下的集合续做(不重新从信号库推导) */
export async function resumePurgeUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  deps?: PurgeDeps,
): Promise<PurgeResult> {
  return notImplemented('resumePurgeUnderLock', ctx, lock, deps);
}

/** Q-A:S1–S4(方案 §0.5 R1);入口是 invalid 或 `mode: 'salvage'` 的 journal */
export async function salvageInvalidJournal(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  deps?: PurgeDeps,
): Promise<SalvageResult> {
  return notImplemented('salvageInvalidJournal', ctx, lock, deps);
}
