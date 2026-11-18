/**
 * §21 V1 装配块 C1a——个人步的**窄端口类型**(C v2 §11.2 第 5、6 项;冻结;接口隔离):`FallbackPorts`、`SafetyPort`、`RecoveryPort`、`ReducePort`、`Compactor`。
 * 只有类型,**不含任何实现 / I/O**(真实现归 C1b / C2)。三组互不可见:S0 / 兜底只拿 rsi 侧能力,S1 只拿恢复,S2 只拿减影响;没有任何一组含增影响能力。
 * 所有写端口在装配处经 `round.writeAdapter(kind, impl)` 包装(`isWriteAdapted` 架构测试)。
 */
import type { RsiOnlyTripReason, TripReason } from './types.js';
import type { BothRound } from './round.js';
import type { TaintCandidate } from './taint-types.js';

// ---------- 共用结果 ----------
/** 静音动作的结果(= `FallbackReport` 的前五类):阶梯 ①→⑤ */
export type MuteResult = 'muted' | 'removed' | 'marker' | 'unreliable' | 'nothing';
/** S0 的稳定故障子码(`safety_fault:<kind>`;`state_invalid` 区分 missing / schema) */
export type SafetyFaultKind =
  'state_invalid:missing' | 'state_invalid:schema' | 'mute_unreliable' | 'safety_unavailable';
export interface EnforceResult {
  readonly mute: MuteResult;
  readonly fault: SafetyFaultKind | null;
}
/** 只读核验:暂停 / 标志 / B / U 任一时 `canary.json` 的 `agents_inject` 必须为空或文件不存在;凭据列出的 canary 条目必须已不在 `canary.json` */
export type MutedVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly why: 'inject_present_while_paused' | 'credential_entry_present' | 'unreadable';
    };
export interface TripResult {
  /** 本次是否新置位了熔断(已置位 = false) */
  readonly tripped: boolean;
  /** `tripAndMute` 内含自己的静音(state 写失败时**仍**静音) */
  readonly mute: MuteResult;
}
export type StopCause = 'source_unknown' | 'taint_hit' | 'sweep';

/** 一步的结果(S1 / S2 逐步独立;`failed` 不挡下一步,`lock_lost` 走 `classify`) */
export type StepOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'skipped'; readonly why: string }
  | { readonly kind: 'incomplete'; readonly why: string }
  | { readonly kind: 'failed'; readonly why: string };

// ---------- 兜底(`safetyFallback`;不写 state)----------
export type StateRead =
  | { readonly kind: 'ok'; readonly paused: boolean }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unreadable' };
/**
 * 兜底端口:**没有**任何写 state / 清单的成员(`writeStateFile` / `commitUnderLockWith` / `recoverSnapshot`……);`@ts-expect-error` 负向用例钉住。
 * `readStateRaw` = `readRsiFixed` + `parseRsiStateDoc`,纯读,不走 `readStateForWrite`。写点前各自 `assertHeld`。
 */
export interface FallbackPorts {
  readStateRaw(): Promise<StateRead>;
  markers(): Promise<{ readonly B: boolean; readonly U: boolean }>;
  /** 返回是否实际改动了 `canary.json`(对空 inject 幂等返回 false) */
  muteCanary(): Promise<boolean>;
  removeCanary(): Promise<boolean>;
  /** 创建 B 标记(`gate_internal`);已存在 = `exists` */
  ensureBreakerMarker(cause: 'gate_internal'): Promise<'created' | 'exists'>;
  assertHeld(): Promise<void>;
}

// ---------- S0 / S2R / T_rsi / 扫尾:只需 rsi 锁 ----------
export interface SafetyPort {
  /** S0 阶梯五级(`muteCanary` → `removeCanary` → 创建 B → `mute_unreliable`;`state_invalid` 不写字节) */
  enforceMute(): Promise<EnforceResult>;
  /** 凭据列出的 canary 条目移除 + stop 行(幂等) */
  reconcileCaches(): Promise<StepOutcome>;
  verifyMuted(): Promise<MutedVerdict>;
  /** personal 锁忙 / 故障时 `T_rsi` 的触发评估:**只含 rsi 驻留事实**,返回值类型收窄 */
  evaluateRsiTriggers(): Promise<readonly RsiOnlyTripReason[]>;
  /**
   * 仅需 rsi 锁的 `tripAndMute`:码集类型收窄为 `RsiOnlyTripReason`,**个人侧码在类型上不可传入**。
   * 持两锁的回合调的是同一个实现(它的参数是更宽的 `TripReason`,逆变兼容)。
   */
  tripAndMute(reasons: readonly RsiOnlyTripReason[]): Promise<TripResult>;
  /** 与 S0 **共用**的窄端口(降级阶梯 ③–⑤,同一实现,不复制算法):来源 unknown 的 canary 只停注入、不转移 */
  stopExistingInjection(cause: StopCause): Promise<MuteResult>;
}

// ---------- S1 恢复(持两锁)----------
export type RepoJudgement = 'at_record' | 'diverged' | 'indeterminate' | 'owner_changed';
export type RepoRecovery =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'deferred' }
  | { readonly kind: 'incomplete'; readonly why: string }
  | { readonly kind: 'judged'; readonly judgement: RepoJudgement };
export interface FlagUpdate {
  readonly diverged?: boolean;
  readonly owner_changed?: boolean;
}
export interface RecoveryPort {
  /** 仓库 + journal 续做;**只用 `complete_only` 语义**(遇 bootstrap 类 journal:planned / initialized 不续建,报 `incomplete`;committed / recorded 先核真实 ref 与树再收尾) */
  recoverRepo(): Promise<RepoRecovery>;
  /** 标志重算后的一次 state 写 + 紧随的静音(复合操作 `setFlagAndMute`,计入预算) */
  setFlagAndMute(flags: FlagUpdate): Promise<StepOutcome>;
  resumeRollbacks(): Promise<StepOutcome>;
  recoverTerminalEffects(): Promise<StepOutcome>;
  reconcileRevocations(): Promise<StepOutcome>;
}

// ---------- S2 只减影响(持两锁)----------
export interface RollbackRequest {
  readonly id: string;
  readonly kind: 'rollback' | 'reconcile' | 'limit_reached';
  readonly reason: string;
}
export interface ReducePort {
  /** 命中后的撤销路径(凭据先于转移;凭据 already 必须回读,冲突不覆盖) */
  applyTaint(tainted: readonly TaintCandidate[]): Promise<StepOutcome>;
  runAnalysis(): Promise<StepOutcome>;
  expireCandidates(): Promise<StepOutcome>;
  reconcileRevocations(): Promise<StepOutcome>;
  /** 触发评估放最后(唯一一次) */
  evaluateTriggers(): Promise<readonly TripReason[]>;
  tripAndMute(reasons: readonly TripReason[]): Promise<TripResult>;
  /** 自动解除(先状态带证据后删 B;唯一一次;忙 / 故障轮不做) */
  applyAutoRelease(): Promise<StepOutcome>;
  startRollback(req: RollbackRequest): Promise<StepOutcome>;
}

// ---------- 压缩(可选;C2 调度)----------
export type CompactResult =
  | { readonly kind: 'noop' | 'compacted' }
  | {
      readonly kind: 'compact_blocked';
      readonly cause: 'audit_full' | 'effects_full' | 'region_open' | 'store_io';
    };
export interface Compactor {
  /** 每轮至多一次;S1 之后、S2P 之前(此时无 `SealRegion`);必收 round */
  compact(round: BothRound): Promise<CompactResult>;
}
