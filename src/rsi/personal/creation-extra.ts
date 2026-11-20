/**
 * 候选创建的额外检查端口 `CreationExtra`(§21 V1 D1b-2;D v4 b0;W0-30):`candidate_create` 的 `extra` 位(`OP_CHECK_PROFILE`:G3 full、G6 rescan、G9 implied、G11 off、**extra on**)
 * 由它填。D1b-2 只交**端口与恒拒默认**:`REFUSING_CREATION_EXTRA` 恒返回 `{ok:false, code:'creation_unready'}`——「创建恒拒」的第二层(第一层 = `growth` 端口缺则拒,第三层 = `GrowthStage` 缺项)。
 * 它是**防误接线**,不是功能:真实现(来源指纹 / purge 状态 / `fp.key` 可用性的判定)归 D3,在部署组装处注入;本期生产没有任何装配引用本文件(只有 D3 的 readers 装配会引用)。
 * 返回码是 C1a `ExtraDeny` 的子集(`creation_unready` / `purge` / `fp_key_unavailable`);**只 `import type`**——本文件不进 worker 闭包与严格入口闭包。
 */
import type { CheckResult } from './stage/growth.js';
import type { BothRound } from './stage/round.js';

export type CreationExtraDeny = 'creation_unready' | 'purge' | 'fp_key_unavailable';

export interface CreationExtra {
  /** 纯读;拒绝返回 `{ok:false, code}`(不抛);抛错 = 调用方按拒绝处理(fail-closed,由 readers 装配层收敛) */
  check(round: BothRound): Promise<CheckResult<CreationExtraDeny>>;
}

/** 默认实现:创建一律未就绪(D3 前不得让创建通过) */
export const REFUSING_CREATION_EXTRA: CreationExtra = Object.freeze({
  check: (): Promise<CheckResult<CreationExtraDeny>> =>
    Promise.resolve({ ok: false, code: 'creation_unready' }),
});
