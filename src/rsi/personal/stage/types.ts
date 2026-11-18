/**
 * §21 V1 装配块 C1a——个人步的**冻结接口类型**(C 稿 v2 §11.2 第 1、2 项):`PersonalStage`、`PersonalCtx`、`PersonalRound`、`FallbackCtx` / `FallbackReport`、
 * `WriteKind` / `DIRTY_KINDS`、`UnsettledReason`、`RsiOnlyTripReason`。除常量外只有类型,无 I/O;合并后改动 = 回主代理(`c1-freeze.test.ts` 钉住形状)。
 * 本块不接线:`worker.ts` 没有注入点、生产入口 import 闭包不含本目录(`c1-inert.test.ts`)。
 */
import type { RsiAutoPauseReason, RsiOutcome } from '../../../contracts/rsi.js';
import type { RsiObservation } from '../../services/observe.js';
import type { RsiServiceCtx } from '../../types.js';
import type { StepHalt } from '../candidate-ports.js';
import type { PersonalFault } from './errors.js';
import type { HeldRsi } from './lock-identity.js';
import type { BothRound } from './round.js';

// ---------- 写种类 / 脏标记 / 未决原因 ----------
/**
 * 写适配器的种类(`round.writeAdapter(kind, impl)`)。**任何**持久写都使 `gen` 递增;只有 `DIRTY_KINDS` 里的种类才置 `safetyDirty`。
 *  - `state_pause_flag`:`state.json` 的暂停码 / 标志写;`revocation`:新增撤销凭据;`rollback_transition`:`startRollback` / canary 记录转移;`trip`:熔断置位;
 *  - `safety_mute`:S0 / 扫尾的静音动作(`muteCanary` / `removeCanary` / B 标记)与 `reconcileCaches`——它们**就是**安全动作本身,不置脏;
 *  - `audit_append` / `compaction` / `effects`:审计补行、压缩、effects 写——不置脏(否则无关写会导致永久 `unsettled`);
 *  - `candidate_record` / `grant` / `bootstrap` / `admission`:D 的增影响写(不置脏,每次写前各自重新 `evaluateGrowth`)。
 */
export const WRITE_KINDS = Object.freeze([
  'state_pause_flag',
  'revocation',
  'rollback_transition',
  'trip',
  'safety_mute',
  'audit_append',
  'compaction',
  'effects',
  'candidate_record',
  'grant',
  'bootstrap',
  'admission',
] as const);
export type WriteKind = (typeof WRITE_KINDS)[number];

export const DIRTY_KINDS = Object.freeze([
  'state_pause_flag',
  'revocation',
  'rollback_transition',
  'trip',
] as const satisfies readonly WriteKind[]);
export type DirtyKind = (typeof DIRTY_KINDS)[number];

/** 本轮「不能证明已收敛」的原因;非空 = `evaluateGrowth` 返回 `unsettled`,S3 不运行 */
export type UnsettledReason =
  /** 写适配器内抛出了非 `DefinitelyNotWritten` 的错误:写结果不可判定 */
  | `write_outcome_unknown:${WriteKind}`
  /** 单次扫尾 `settleSafety` 核验失败 / 任一步故障 */
  | 'safety_not_settled'
  /** 压缩抛错 / 返回非法值(S2 照跑,但本轮拒绝增影响) */
  | 'compaction_failed'
  /** `StepHalt` 为仓库完整性类 / 权威状态不明(只停本步并使本轮未决) */
  | `step_integrity:${Exclude<StepHalt, 'lock_lost' | 'repo_absent' | 'repo_deferred' | 'growth_denied'>}`
  /** 调用预算超限(`RoundBudget`;防循环) */
  | `budget_exceeded:${string}`
  /** `StepHalt='lock_lost'` 查不出是哪一把锁 */
  | 'lock_loss_unresolved';

// ---------- 熔断码 ----------
/**
 * personal 锁忙 / 故障的回合里,只含 **rsi 驻留事实**的触发码(`T_rsi`):没有个人锁,个人侧事实读不到。
 * 仅需 rsi 锁的 `tripAndMute` 的参数类型收窄为它,**个人侧码在类型上不可传入**(`@ts-expect-error` 负向用例钉住)。
 */
export const RSI_ONLY_TRIP_REASONS = Object.freeze([
  'no_observation',
  'redaction_changed',
  'kit_major_changed',
] as const satisfies readonly RsiAutoPauseReason[]);
export type RsiOnlyTripReason = (typeof RSI_ONLY_TRIP_REASONS)[number];
/** 持两锁的 S2P 可传的全部熔断码(= 契约的 `RSI_AUTO_PAUSE_REASONS`) */
export type TripReason = RsiAutoPauseReason;

// ---------- 兜底(`safetyFallback`)----------
export type FallbackOrigin = 'recover_under_lock' | 'p_contract_violation' | 'other';
export interface FallbackCtx {
  readonly sctx: RsiServiceCtx;
  readonly lock: HeldRsi;
  readonly now: () => Date;
  readonly nowMs: () => number;
  /** 兜底从哪条入口被调(诊断用;`catch` 与 P 违约包装层共用同一个 `runFallbackOnce`) */
  readonly origin: FallbackOrigin;
}
/**
 * 兜底的结果(只进测试返回与日志一行 `safety_fallback_<kind>`;**不改** outcome / 结果 / 退出码)。
 * `muted` / `removed` / `marker`:对应阶梯 ②③④;`unreliable`:阶梯 ⑤;`nothing`:已读出且无需动作;`threw`:兜底自身抛错(已吞);
 * `aborted`:兜底中途丢了 rsi 锁(立即停写;worker 不再调 `finish`,零后续写入)。
 */
export type FallbackReport =
  | { readonly kind: 'muted' | 'removed' | 'marker' | 'unreliable' | 'nothing' }
  | { readonly kind: 'threw'; readonly name: string }
  | { readonly kind: 'aborted'; readonly why: 'rsi_lock_lost' };
export const FALLBACK_REPORT_KINDS = Object.freeze([
  'muted',
  'removed',
  'marker',
  'unreliable',
  'nothing',
  'threw',
  'aborted',
] as const);

// ---------- 个人步接口 ----------
export interface PersonalCtx {
  readonly sctx: RsiServiceCtx;
  readonly lock: HeldRsi;
  readonly obs: RsiObservation;
  readonly now: () => Date;
  readonly nowMs: () => number;
  /** `update/lock` 被存活进程持有:S0–S2 照跑,**S3 不运行**(`GrowthAccess` 不交出 `BothRound`,`GrowthDeny` 码 `update_busy`) */
  readonly updateBusy: boolean;
}

/**
 * S3(增影响)的入口许可。**只有 `open` 变体带 `BothRound`**:personal 锁忙 / 故障 / `update_busy` / 个人锁丢失时没有 round,
 * `evaluateGrowth` 在类型上不可调用;`denied` 变体的 `code` 即本轮 verdict。
 */
export type GrowthAccessDeny = 'personal_busy' | 'personal_fault' | 'update_busy' | 'lock_lost';
export type GrowthAccess =
  | { readonly kind: 'open'; readonly round: BothRound }
  | { readonly kind: 'denied'; readonly code: GrowthAccessDeny };

export interface PersonalRound {
  readonly growth: GrowthAccess;
  /** 非致命故障(逐项;日志摘要取最高优先级一行,细项只在此) */
  readonly faults: readonly PersonalFault[];
  readonly unsettled: readonly UnsettledReason[];
  /** 本轮 L0 是否到期(S3 的节流依据;由 P 在 S2 之后用当前 state 现算) */
  readonly l0DueNow: boolean;
  /** 个人侧标志(W0-25):D 的写者与 `rsi auto status` 消费 */
  readonly flags: { readonly diverged: boolean; readonly owner_changed: boolean };
  /** 回滚卡住的候选 id(只读事实,给 D 的 auto-view 写者) */
  readonly rollback_stalled: readonly string[];
  /** 保护标记(终态保护等;只读事实,给 D 的写者) */
  readonly protection_marks: readonly string[];
  /** P 内部违约 / 兜底的报告(正常路径无) */
  readonly fallback?: FallbackReport;
}

export interface PersonalStage {
  /** 位置 1:worker.ts 在 `recoverUnderLock` 之后调一次;永不抛,唯一例外:rsi 锁 `lock_lost` 原样上抛 */
  run(ctx: PersonalCtx): Promise<PersonalRound>;
  /** 位置 2:worker.ts catch 内,仅在 P 尚未完成时调一次;**永不抛**(含 rsi `lock_lost`,以 `aborted` 报告返回) */
  safetyFallback(ctx: FallbackCtx): Promise<FallbackReport>;
  /** 两个位置共用的相位资格判断:无 IO、纯函数;相位 < V1a → false → 两处都不进 */
  eligible(): boolean;
}

/** 兜底跳过集合 = worker 既有的「零写入」契约 `UNRECORDABLE`(worker.ts;`c1-fallback.test.ts` 与 worker 源码逐项核对) */
export const FALLBACK_SKIP_OUTCOMES = Object.freeze([
  'lock_lost',
  'write_denied',
  'state_dir_unsafe',
  'state_invalid',
  'snapshot_invalid',
] as const satisfies readonly RsiOutcome[]);
