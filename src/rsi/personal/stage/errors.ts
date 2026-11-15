/**
 * §21 V1 装配块 C1a(接口先行块)——个人步的**错误域**:错误类型、统一分类器 `classify`、`StepHalt` 分类。
 * 冻结(C 稿 v2 §11.2 第 2 项):合并后改动 = 回主代理。纯函数,无 I/O;不 import `src/rsi/store/**`。
 *
 * 错误域隔离(C v1 §2):P 在 worker 的 `try` 内,抛错会进 `outcomeOfError`:个人锁的 `RsiLockError`(state_dir_unsafe / write_denied / lock_lost)
 * 会被映射成 UNRECORDABLE(整轮零写入且计入 R20 采集熔断)。所以个人侧一律把锁丢失转型为 `PersonalLockLost`(非 `RsiLockError`),
 * 只有 **rsi 锁**的 `lock_lost` 照旧上抛。
 */
import { RsiLockError, type RsiLockErrorKind } from '../../lock-error.js';
import type { StepHalt } from '../candidate-ports.js';

/** 个人锁丢失(`assertHeld` 发现 nonce 不是自己的)。**不是** `RsiLockError`:不会被 worker 映射成 UNRECORDABLE */
export class PersonalLockLost extends Error {
  readonly code = 'PERSONAL_LOCK_LOST';
  constructor() {
    super('rsi-personal/lock: lock_lost');
  }
}

/**
 * 写适配器在**任何 IO 之前**的前置校验失败时抛出(如 `revocationSourceProblem`);只有它不使本轮 `unsettled`。
 * 默认一律「不确定」:任何其它错误都视为「可能已部分写入」。
 */
export class DefinitelyNotWritten extends Error {
  readonly code = 'DEFINITELY_NOT_WRITTEN';
  constructor(readonly reason: string) {
    super(`definitely_not_written: ${reason}`);
  }
}

/** 一次性授权被拒的原因(`StaleGrowth.reason`;逐值固定,测试钉住) */
export const STALE_GROWTH_REASONS = Object.freeze([
  'not_minted',
  'already_used',
  'nonce_mismatch',
  'round_mismatch',
  'gen_changed',
  'op_mismatch',
  'unsettled',
  'vetoed',
  'veto_unreadable',
] as const);
export type StaleGrowthReason = (typeof STALE_GROWTH_REASONS)[number];

/** `requireGrowth` 拒绝:nonce 不等 / gen 已变 / op 不等 / 已用过 / 非本模块铸造 / 外部否决事实。抛出即该 pass 作废 */
export class StaleGrowth extends Error {
  readonly code = 'STALE_GROWTH';
  constructor(readonly reason: StaleGrowthReason) {
    super(`stale_growth: ${reason}`);
  }
}

/** 编程错误 / 违约(写适配器嵌套、写进行中铸造 pass、调用预算超限、畸形请求……)。进 `classify` 后是 `internal` 故障 */
export class RoundInternalError extends Error {
  readonly code = 'ROUND_INTERNAL';
  constructor(readonly reason: string) {
    super(`round_internal: ${reason}`);
  }
}

/** 个人步的故障码(进 `PersonalRound.faults[]`,日志摘要取其一;不带错误消息,避免路径外泄) */
export type PersonalFaultCode =
  | `personal_lock_error:${RsiLockErrorKind | 'internal'}`
  | `lock_error:${RsiLockErrorKind}`
  | 'internal'
  | 'step_threw'
  | 'step_halted'
  | 'judge_report_invalid';
export interface PersonalFault {
  readonly code: PersonalFaultCode;
  /** 只放稳定的短标签(错误类名 / `reason`),不放 `message` */
  readonly detail?: string;
}

export type Classified =
  /** rsi 锁 `lock_lost`:无条件上抛,`finally` 不做任何补写 */
  | { readonly kind: 'rethrow' }
  /** 个人锁丢失:结束个人轮(跳过余下 S1 / 压缩 / S2P / S3),`finally` 只释放句柄、不做依赖失效句柄的补写 */
  | { readonly kind: 'end_personal_round' }
  /** 其它:记入 `faults[]` 后继续允许的独立步骤 */
  | { readonly kind: 'fault'; readonly fault: PersonalFault };

export function isRsiLockLost(e: unknown): boolean {
  return e instanceof RsiLockError && e.kind === 'lock_lost';
}

/**
 * 统一错误分类器(C v1 §2;冻结)。顺序固定:
 *  1. `RsiLockError('lock_lost')`(rsi 锁;个人锁的丢失在句柄层已转型,到不了这里)→ `rethrow`;
 *  2. `PersonalLockLost` → `end_personal_round`;
 *  3. `RoundInternalError` → `fault{internal}`;
 *  4. 其它 `RsiLockError` → `fault{lock_error:<kind>}`(**不**映射为 UNRECORDABLE,也不算「锁忙」);
 *  5. 其余一切(含非 Error 抛出物)→ `fault{step_threw}`。
 */
export function classify(e: unknown): Classified {
  if (isRsiLockLost(e)) return { kind: 'rethrow' };
  if (e instanceof PersonalLockLost) return { kind: 'end_personal_round' };
  if (e instanceof RoundInternalError) {
    return { kind: 'fault', fault: { code: 'internal', detail: e.reason } };
  }
  if (e instanceof RsiLockError) {
    return { kind: 'fault', fault: { code: `lock_error:${e.kind}`, detail: 'RsiLockError' } };
  }
  return {
    kind: 'fault',
    fault: { code: 'step_threw', detail: e instanceof Error ? e.name : typeof e },
  };
}

/** `StepHalt` 的处置分类(W9 设计 §4:`halted` 进入同一个 `classify`) */
export type HaltClass =
  /** 只停本步,不使本轮 `unsettled`(仓库不存在 / 被延期:增影响由 G3 / G4 另行拒绝) */
  | { readonly kind: 'stop_step' }
  /** 仓库完整性 / 权威状态不明:只停本步并使本轮 `unsettled` */
  | { readonly kind: 'stop_step_unsettled'; readonly cause: Exclude<StepHalt, 'lock_lost'> }
  /**
   * `StepHalt` 里只有一个 `lock_lost`,**区分不出是 rsi 锁还是个人锁**。不得默认当个人锁处理(那等于 rsi 失锁时继续写):
   * 调用方必须先 `resolveLockLoss`(`assertHeld` 两把锁);查不出是哪一把 → 按个人锁结束本轮并使本轮 `unsettled`。
   */
  | { readonly kind: 'lock_lost_unresolved' };

const HALT_CLASS: Readonly<Record<StepHalt, HaltClass>> = Object.freeze({
  repo_absent: { kind: 'stop_step' },
  repo_deferred: { kind: 'stop_step' },
  repo_invalid: { kind: 'stop_step_unsettled', cause: 'repo_invalid' },
  revocations_invalid: { kind: 'stop_step_unsettled', cause: 'revocations_invalid' },
  commit_failed: { kind: 'stop_step_unsettled', cause: 'commit_failed' },
  candidate_invalid: { kind: 'stop_step_unsettled', cause: 'candidate_invalid' },
  lock_lost: { kind: 'lock_lost_unresolved' },
});

export function classifyHalt(h: StepHalt): HaltClass {
  const c = (HALT_CLASS as Readonly<Record<string, HaltClass | undefined>>)[h];
  // 跨信任边界:未知值 = 完整性不明,按「停本步并 unsettled」处理,绝不当成可继续
  return c ?? { kind: 'stop_step_unsettled', cause: 'candidate_invalid' };
}

export type LockLossOwner = 'rsi' | 'personal' | 'unknown';
/**
 * 失锁归属判定:先问 rsi 锁(两把都丢时 rsi 优先 = 上抛);rsi 在手再问个人锁;两把都复核通过(`StepHalt` 说丢了、实际没丢)= `unknown`。
 * `assertHeld` 抛 `RsiLockError('lock_lost')` / `PersonalLockLost` 才算丢;其它错误(I/O)= `unknown`(fail-closed,调用方按个人锁结束 + unsettled)。
 */
export async function resolveLockLoss(
  rsi: { assertHeld(): Promise<void> },
  personal: { assertHeld(): Promise<void> },
): Promise<LockLossOwner> {
  try {
    await rsi.assertHeld();
  } catch (e) {
    return isRsiLockLost(e) ? 'rsi' : 'unknown';
  }
  try {
    await personal.assertHeld();
  } catch (e) {
    return e instanceof PersonalLockLost || isRsiLockLost(e) ? 'personal' : 'unknown';
  }
  return 'unknown';
}
