/**
 * `state.json` 回写时的纯函数不变量(R20-A2 B4c2;D2 / D10 / B2):规划侧模块,无 I/O。
 *  - `armed_listing`(D2):只有**完整**的列举(`complete !== false`)才持久化;不完整时保持磁盘上原有的值不变(没有就不写),不得把部分扫描的计数落盘;`confirm` 时删除该键;
 *  - `baseline_pending`(D10):只许 true → false(`ackBaseline`),并把 `projects_ack_generation` 置为本次索引的 generation;其它任何路径都不得把它改回 true;
 *  - `confirm` 记录不由 L0 改:`carryConfirm` 把 StateMutator 返回值里的 `confirm` 一律换回磁盘上的值(再叠加 ack),mutator 改它无效。
 */
import type { RsiAgentId, RsiState } from '../../contracts/rsi.js';
import type { ArmedListing } from './types.js';

export type ArmedListingField = NonNullable<RsiState['armed_listing']>;

/** 完整列举 → 要持久化的字段;`complete === false` → `undefined`(不持久化)。`projects` = 未排除的行,`excluded` = 已排除的行 */
export function armedListingField(
  listing: Pick<ArmedListing, 'rows' | 'unknownSessions' | 'complete'>,
  at: string,
  policyFp: string,
  agents: readonly RsiAgentId[],
): ArmedListingField | undefined {
  if (listing.complete === false) return undefined;
  return {
    at,
    policy_fp: policyFp,
    agents: [...new Set(agents)].sort() as RsiAgentId[],
    projects: listing.rows.filter((r) => !r.excluded).length,
    excluded: listing.rows.filter((r) => r.excluded).length,
    unknown_sessions: listing.unknownSessions,
  };
}

function withoutArmedListing(s: RsiState): RsiState {
  const { armed_listing: _drop, ...rest } = s;
  void _drop;
  return rest;
}

/**
 * armed 提交里最终写下的 state:`field` 给了就写它;没给(列举不完整)→ 一律还原为 `prev` 的 `armed_listing`(没有就删键),
 * 不管 StateMutator 返回了什么——持久化与否的决定权在这里,不在 mutator。
 */
export function applyArmedListing(
  next: RsiState,
  prev: RsiState | null,
  field: ArmedListingField | undefined,
): RsiState {
  const base = withoutArmedListing(next);
  if (field !== undefined) return { ...base, armed_listing: field };
  return prev?.armed_listing !== undefined ? { ...base, armed_listing: prev.armed_listing } : base;
}

/** `confirm` 时清空 `armed_listing`(删除该键) */
export function clearArmedListing(s: RsiState): RsiState {
  return withoutArmedListing(s);
}

/** `confirm` 记录与磁盘一致;`baseline_pending` 不得 false → true(mutator 想改也改不掉) */
export function carryConfirm(prev: RsiState | null, next: RsiState): RsiState {
  return { ...next, confirm: prev?.confirm ?? null };
}

/**
 * 确认后第一次成功 L0:`baseline_pending` true → false,`projects_ack_generation` = 本次索引 generation(R20-4.2a)。
 * 没有 confirm / 已经是 false → 原样返回(幂等,不会重复推进 ack 基线;之后只有 `rsi status --ack` 能推进)。
 */
export function ackBaseline(s: RsiState, indexGeneration: number): RsiState {
  if (s.confirm === null || !s.confirm.baseline_pending) return s;
  return {
    ...s,
    projects_ack_generation: indexGeneration,
    confirm: { ...s.confirm, baseline_pending: false },
  };
}
