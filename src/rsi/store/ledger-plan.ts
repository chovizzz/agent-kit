/**
 * 共享纯函数 `planLedgerBatch(state, key, effects, meta, opts?)`(设计稿 v3 §A.2 / §E 第 3 项):`applyOnce` 与 `LedgerRecoveryPort.recoverThrough` 共用它的合并 / 容量规则,
 * 保证**账语义只有一份**。只有 `replay` 意图(没有 intent 参数,所以调用方无法表达 `user_veto`)。无 I/O。
 */
import type { RsiEffectsLedger } from '../../contracts/rsi-store.js';
import type { TransitionEffect } from '../personal/transition.js';
import { partitionEffects, planBatch, type PlanOptions, type PlanResult } from './ledger-merge.js';
import type { ApplyOnceMeta } from './ports.js';

export type { PlanOptions, PlanResult } from './ledger-merge.js';

/**
 * 纯规划:`satisfied`(零写)/ `commit`(带新账,`gen` = 旧 +1)/ `not_committed{effects_full}`(容量)。冲突、元信息缺失、非法效果抛 `StoreError`(零写入)。
 * 审计类效果(`append_audit` / `protection_mark`)不属于账,会被忽略;`commit_lifecycle` 等不认识的类型抛 `unsupported_effect`。
 */
export function planLedgerBatch(
  state: RsiEffectsLedger,
  key: string,
  effects: readonly TransitionEffect[],
  meta: ApplyOnceMeta | undefined,
  opts: PlanOptions = {},
): PlanResult {
  return planBatch(state, key, partitionEffects(effects).ledger, meta, 'replay', opts);
}
