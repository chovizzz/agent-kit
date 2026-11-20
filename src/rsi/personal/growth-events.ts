/**
 * 转移事件的「增影响」分类(§21 V1 D1b-2;W0-30;owner 2026-11-17「gates_passed 算增效」):`applyEvent` 据此决定一个事件是否必须先过 {@link GrowthClaimPort}。
 *  - 增影响类:`gates_passed`(proposed → shadow,op = `candidate_create`)、`shadow_promote`(→ canary,`shadow_to_canary`)、`deploy_inject`(`deploy_inject`);
 *  - `decide_better`:没有对应的增影响 op(转移表本期本就 `decide_better_disabled`),分类为 `unmappable` = **恒拒**;
 *  - 其余(终止 / 回滚 / 撤销对账 / 到期 / 无命中 / 闸红 / 补偿 / 移除)= 减影响类(`null`):**不走授权、不受暂停限制**(安全方向的动作任何时候都能做)。
 * 纯函数、零 import(只有类型):`candidate-apply.ts` 经它进入 worker 闭包,不得带进 stage 模块。
 * 分类表是 `Record<EventKind, …>`:新增事件而未分类 = 编译错误;运行期对**未知 kind 一律按 `unmappable` 拒绝**(不当成减影响放行)。
 */
import type { GrowthClaimOp } from './candidate-ports.js';
import type { EventKind } from './transition-table.js';

export type GrowthEventClass = GrowthClaimOp | 'unmappable' | null;

export const GROWTH_EVENT_CLASS: Readonly<Record<EventKind, GrowthEventClass>> = Object.freeze({
  gates_passed: 'candidate_create',
  shadow_promote: 'shadow_to_canary',
  deploy_inject: 'deploy_inject',
  decide_better: 'unmappable',
  gate_red: null,
  shadow_no_hit: null,
  shadow_queue_expired: null,
  veto: null,
  taint: null,
  clear: null,
  revocation_reconcile: null,
  judge_reject: null,
  harm: null,
  canary_limit: null,
  rollback_advance: null,
  removal_done: null,
  compensation_done: null,
});

/** `null` = 减影响类(免授权);`'unmappable'` = 恒拒;其余 = 必须先 claim 该 op。未登记的 kind(跨信任边界的脏值)= `unmappable` */
export function growthOpOfEvent(kind: EventKind): GrowthEventClass {
  if (typeof kind !== 'string' || !Object.hasOwn(GROWTH_EVENT_CLASS, kind)) return 'unmappable';
  return GROWTH_EVENT_CLASS[kind];
}
