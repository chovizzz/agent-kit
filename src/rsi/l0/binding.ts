/**
 * 运行绑定与检查点(R20-3.9.2 / R20-6.8;B4b)。纯函数 + 注入的观测函数,本文件不读盘:
 * 真实观测(重读配置与状态、STOP 标记,经 `rsiStateOf` 现算)由 B4c2 / B5 用 {@link observationFrom} 包装后注入。
 *
 * 检查点判定顺序(先命中先返回):STOP → `stopped`;停止采集(config.block / 状态不可算)→ `skipped_collect_blocked`;
 * 运行绑定与现算不一致(repo / policy_fp / agents / confirmed_at 任一不同,含「收紧排除」)→ `skipped_binding_changed`;
 * 墙钟 ≥ 上限 → `time_limit`,**但 `where === 'commit'` 永不返回 `time_limit`**(已开始的有序提交一定走完)。
 */
import type { RsiConfirm } from '../../contracts/rsi.js';
import type { RsiIdentity, RsiStateResult } from '../state.js';
import type { Checkpoint, CheckpointVerdict, CheckpointWhere, RunBinding } from './types.js';
import { policyFingerprint } from '../config.js';

/** 检查点上现算的状态 */
export interface BindingObservation {
  stopPresent: boolean;
  /** 停止采集(`config.block` 非空、配置变 off、状态变 armed 等「不再允许采集」) */
  collectBlocked: boolean;
  /** 现算后仍是 confirmed 时的绑定;否则 null */
  current: RunBinding | null;
}

/** 由 `rsiStateOf` 的结果与现算身份造 {@link BindingObservation}(纯函数) */
export function observationFrom(i: {
  state: RsiStateResult;
  stopPresent: boolean;
  identity: RsiIdentity;
  confirm: RsiConfirm | null;
}): BindingObservation {
  const confirmed = i.state.state === 'confirmed' && i.confirm !== null;
  return {
    stopPresent: i.stopPresent,
    // 「状态不可算」(state.json 过不了 schema,rsiStateOf 退回 armed + stateInvalid)与配置 off / 停止采集一样归 collect_blocked,
    // 不能落到「绑定变化」里
    collectBlocked:
      i.state.collectBlocked !== null || i.state.state === 'off' || i.state.stateInvalid,
    current: confirmed
      ? bindingOf({
          identity: i.identity,
          confirmedAt: (i.confirm as RsiConfirm).confirmed_at,
        })
      : null,
  };
}

/** 运行绑定(`policyFp` 取当前策略的指纹,不是确认时的) */
export function bindingOf(i: { identity: RsiIdentity; confirmedAt: string | null }): RunBinding {
  return {
    repoSha256: i.identity.repoSha256,
    repoDevIno: { dev: i.identity.repoDevIno.dev, ino: i.identity.repoDevIno.ino },
    policyFp: policyFingerprint(i.identity.policy),
    agents: [...i.identity.policy.agents],
    confirmedAt: i.confirmedAt,
  };
}

export function sameBinding(a: RunBinding, b: RunBinding): boolean {
  return (
    a.repoSha256 === b.repoSha256 &&
    a.repoDevIno.dev === b.repoDevIno.dev &&
    a.repoDevIno.ino === b.repoDevIno.ino &&
    a.policyFp === b.policyFp &&
    a.confirmedAt === b.confirmedAt &&
    a.agents.length === b.agents.length &&
    a.agents.every((x, i) => x === b.agents[i])
  );
}

/** 只比对观测与绑定(不含墙钟) */
export function compareBinding(run: RunBinding, obs: BindingObservation): CheckpointVerdict {
  if (obs.stopPresent) return { kind: 'abort', outcome: 'stopped' };
  if (obs.collectBlocked) return { kind: 'abort', outcome: 'skipped_collect_blocked' };
  if (obs.current === null || !sameBinding(run, obs.current)) {
    return { kind: 'abort', outcome: 'skipped_binding_changed' };
  }
  return { kind: 'continue' };
}

export interface CheckpointDeps {
  /** 注入时钟(毫秒);只经它取时间 */
  nowMs: () => number;
  startedAtMs: number;
  maxMs: number;
  binding: RunBinding;
  observe: () => Promise<BindingObservation>;
}

export function createCheckpoint(d: CheckpointDeps): Checkpoint {
  return async (where: CheckpointWhere): Promise<CheckpointVerdict> => {
    const v = compareBinding(d.binding, await d.observe());
    if (v.kind !== 'continue') return v;
    if (where !== 'commit' && d.nowMs() - d.startedAtMs >= d.maxMs) return { kind: 'time_limit' };
    return v;
  };
}
