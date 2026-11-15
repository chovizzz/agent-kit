/**
 * C1a:**冻结接口**——类型层(`tsc` 检查,改形状即红)+ 运行期导出清单(多导出 / 少导出一个符号即红,包括「GrowthPass 构造函数不导出」)。
 * 冻结 = 合并后不得改签名,改了须回主代理(C 稿 v2 §11.2)。照 B1a `ports-freeze.test.ts` 的写法。
 * 八组:1 PersonalStage 族 / 2 错误域与写适配器 / 3 授权类型 / 4 判决槽 / 5 污染扫描类型 / 6 端口 / 7 settleSafety 与预算 / 8 监测。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import type { RsiLifecycleState } from '../../../src/contracts/rsi.js';
import type { RsiObservation } from '../../../src/rsi/services/observe.js';
import type { RsiServiceCtx } from '../../../src/rsi/types.js';
import type { StepHalt } from '../../../src/rsi/personal/candidate-ports.js';
import type {
  JudgeGrowthDeny,
  JudgeGrowthSlot,
  JudgeGrowthVerdict,
  JudgeReduceReport,
  JudgeReduceSlot,
  JudgeSlots,
} from '../../../src/rsi/personal/judge-slot.js';
import type { PersonalFault, PersonalFaultCode } from '../../../src/rsi/personal/stage/errors.js';
import type { FallbackTrack } from '../../../src/rsi/personal/stage/fallback.js';
import type {
  AdmissionFact,
  BarrierDeny,
  CandidateReq,
  CheckResult,
  ConfigFact,
  ExtraDeny,
  GrowthDeny,
  GrowthOp,
  GrowthPass,
  GrowthReaders,
  GrowthReq,
  GrowthStage,
  GrowthVerdict,
  OpProfile,
  PurgeFact,
  StateFact,
  TaintFact,
  VetoFact,
} from '../../../src/rsi/personal/stage/growth.js';
import type {
  HeldLock,
  HeldPersonal,
  HeldRsi,
} from '../../../src/rsi/personal/stage/lock-identity.js';
import type { MonitorSignal } from '../../../src/rsi/personal/stage/monitoring.js';
import type {
  CompactResult,
  Compactor,
  EnforceResult,
  FlagUpdate,
  FallbackPorts,
  MuteResult,
  MutedVerdict,
  ReducePort,
  RecoveryPort,
  RepoRecovery,
  RollbackRequest,
  SafetyPort,
  StateRead,
  StepOutcome,
  StopCause,
  TripResult,
} from '../../../src/rsi/personal/stage/ports.js';
import type {
  BothRound,
  RoundOpen,
  RsiOnlyRound,
  SafetyDirtyView,
} from '../../../src/rsi/personal/stage/round.js';
import type {
  RoundBudget,
  SettleResult,
  SweepPorts,
} from '../../../src/rsi/personal/stage/settle.js';
import type {
  TaintCandidate,
  TaintScanResult,
  TaintScanner,
} from '../../../src/rsi/personal/stage/taint-types.js';
import type {
  DirtyKind,
  FallbackCtx,
  FallbackReport,
  GrowthAccess,
  PersonalCtx,
  PersonalRound,
  PersonalStage,
  RsiOnlyTripReason,
  TripReason,
} from '../../../src/rsi/personal/stage/types.js';

const names = (m: object): string[] => Object.keys(m).sort();
// 排除 unique-symbol 品牌键(类型里有、运行期没有、不可命名)
type K<T> = Exclude<keyof T, symbol>;
type Assignable<A, B> = [A] extends [B] ? true : false;

describe('运行期导出清单(多一个 / 少一个符号都红;GrowthPass 的构造点不导出)', () => {
  it('stage/growth.ts', async () => {
    expect(names(await import('../../../src/rsi/personal/stage/growth.js'))).toEqual([
      'CANDIDATE_OPS',
      'CHECK_FAILURE_CODE',
      'CHECK_ORDER',
      'GROWTH_DENY_CODES',
      'GROWTH_OPS',
      'OP_CHECK_PROFILE',
      'checkGrowthVeto',
      'evaluateGrowth',
      'growthDenied',
      'isGrowthPass',
      'opOfReq',
      'requireGrowth',
      'sameOp',
    ]);
  });
  it('stage/round.ts', async () => {
    expect(names(await import('../../../src/rsi/personal/stage/round.js'))).toEqual([
      'isWriteAdapted',
      'judgeBlockedOf',
      'markRoundUnsettled',
      'openRound',
      'recordJudgeBlocked',
      'roundInternals',
    ]);
  });
  it('stage/errors.ts', async () => {
    expect(names(await import('../../../src/rsi/personal/stage/errors.js'))).toEqual([
      'DefinitelyNotWritten',
      'PersonalLockLost',
      'RoundInternalError',
      'STALE_GROWTH_REASONS',
      'StaleGrowth',
      'classify',
      'classifyHalt',
      'isRsiLockLost',
      'resolveLockLoss',
    ]);
  });
  it('stage/lock-identity.ts', async () => {
    expect(names(await import('../../../src/rsi/personal/stage/lock-identity.js'))).toEqual([
      'attemptPersonal',
      'isProducedAttempt',
      'newRoundId',
      'wrapPersonalLock',
    ]);
  });
  it('stage/settle.ts / fallback.ts / monitoring.ts / types.ts / taint-types.ts / ports.ts', async () => {
    expect(names(await import('../../../src/rsi/personal/stage/settle.js'))).toEqual([
      'BUDGET_PORTS',
      'ROUND_BUDGET_LIMITS',
      'createRoundBudget',
      'settleSafety',
    ]);
    expect(names(await import('../../../src/rsi/personal/stage/fallback.js'))).toEqual([
      'fallbackLogCode',
      'fallbackSkipReason',
      'newFallbackTrack',
      'planAfterFallback',
      'runFallbackOnce',
    ]);
    expect(names(await import('../../../src/rsi/personal/stage/monitoring.js'))).toEqual([
      'MONITOR_INPUTS',
      'MONITOR_SIGNALS',
      'MONITOR_THRESHOLDS',
    ]);
    expect(names(await import('../../../src/rsi/personal/stage/types.js'))).toEqual([
      'DIRTY_KINDS',
      'FALLBACK_REPORT_KINDS',
      'FALLBACK_SKIP_OUTCOMES',
      'RSI_ONLY_TRIP_REASONS',
      'WRITE_KINDS',
    ]);
    expect(names(await import('../../../src/rsi/personal/stage/taint-types.js'))).toEqual([
      'TAINT_UNAVAILABLE_WHY',
      'TAINT_UNKNOWN_WHY',
    ]);
    expect(names(await import('../../../src/rsi/personal/stage/ports.js'))).toEqual([]);
  });
  it('judge-slot.ts', async () => {
    expect(names(await import('../../../src/rsi/personal/judge-slot.js'))).toEqual([
      'JUDGE_CHECK_TIMEOUT_MS',
      'JUDGE_GROWTH_DENY_CODES',
      'UNAVAILABLE_JUDGE',
      'checkJudgeGrowth',
      'normalizeJudgeReport',
      'normalizeJudgeVerdict',
    ]);
  });
});

describe('1 PersonalStage 族', () => {
  it('PersonalStage {run, safetyFallback, eligible}', () => {
    expectTypeOf<keyof PersonalStage>().toEqualTypeOf<'run' | 'safetyFallback' | 'eligible'>();
    expectTypeOf<PersonalStage['run']>().toEqualTypeOf<
      (ctx: PersonalCtx) => Promise<PersonalRound>
    >();
    expectTypeOf<PersonalStage['safetyFallback']>().toEqualTypeOf<
      (ctx: FallbackCtx) => Promise<FallbackReport>
    >();
    expectTypeOf<PersonalStage['eligible']>().toEqualTypeOf<() => boolean>();
    expect(true).toBe(true);
  });
  it('PersonalCtx / FallbackCtx / PersonalRound 的键与成员类型', () => {
    expectTypeOf<keyof PersonalCtx>().toEqualTypeOf<
      'sctx' | 'lock' | 'obs' | 'now' | 'nowMs' | 'updateBusy'
    >();
    expectTypeOf<PersonalCtx['sctx']>().toEqualTypeOf<RsiServiceCtx>();
    expectTypeOf<PersonalCtx['obs']>().toEqualTypeOf<RsiObservation>();
    expectTypeOf<PersonalCtx['lock']>().toEqualTypeOf<HeldRsi>();
    expectTypeOf<PersonalCtx['now']>().toEqualTypeOf<() => Date>();
    expectTypeOf<PersonalCtx['nowMs']>().toEqualTypeOf<() => number>();
    expectTypeOf<PersonalCtx['updateBusy']>().toEqualTypeOf<boolean>();
    expectTypeOf<keyof FallbackCtx>().toEqualTypeOf<'sctx' | 'lock' | 'now' | 'nowMs' | 'origin'>();
    expectTypeOf<keyof PersonalRound>().toEqualTypeOf<
      | 'growth'
      | 'faults'
      | 'unsettled'
      | 'l0DueNow'
      | 'flags'
      | 'rollback_stalled'
      | 'protection_marks'
      | 'fallback'
    >();
    expectTypeOf<PersonalRound['faults']>().toEqualTypeOf<readonly PersonalFault[]>();
    expectTypeOf<PersonalRound['l0DueNow']>().toEqualTypeOf<boolean>();
    expectTypeOf<PersonalRound['flags']>().toEqualTypeOf<{
      readonly diverged: boolean;
      readonly owner_changed: boolean;
    }>();
    expectTypeOf<PersonalRound['rollback_stalled']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<PersonalRound['protection_marks']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<PersonalRound['fallback']>().toEqualTypeOf<FallbackReport | undefined>();
    expect(true).toBe(true);
  });
  it('GrowthAccess:open 带 BothRound;denied 只有四个码', () => {
    expectTypeOf<GrowthAccess>().toEqualTypeOf<
      | { readonly kind: 'open'; readonly round: BothRound }
      | {
          readonly kind: 'denied';
          readonly code: 'personal_busy' | 'personal_fault' | 'update_busy' | 'lock_lost';
        }
    >();
    expect(true).toBe(true);
  });
  it('FallbackReport 的七类与 FALLBACK_REPORT_KINDS 一致', () => {
    expectTypeOf<FallbackReport['kind']>().toEqualTypeOf<
      'muted' | 'removed' | 'marker' | 'unreliable' | 'nothing' | 'threw' | 'aborted'
    >();
    expectTypeOf<
      Extract<FallbackReport, { kind: 'aborted' }>['why']
    >().toEqualTypeOf<'rsi_lock_lost'>();
    expectTypeOf<Extract<FallbackReport, { kind: 'threw' }>['name']>().toEqualTypeOf<string>();
    expect(true).toBe(true);
  });
});

describe('2 错误域 / 写适配器 / 回合', () => {
  it('BothRound / RsiOnlyRound 的键(不含品牌)', () => {
    expectTypeOf<K<BothRound>>().toEqualTypeOf<
      'id' | 'rsiNonce' | 'personalNonce' | 'gen' | 'unsettled' | 'safetyDirty' | 'writeAdapter'
    >();
    expectTypeOf<K<RsiOnlyRound>>().toEqualTypeOf<
      'id' | 'rsiNonce' | 'gen' | 'unsettled' | 'safetyDirty' | 'writeAdapter'
    >();
    expectTypeOf<BothRound['gen']>().toEqualTypeOf<() => number>();
    expectTypeOf<K<SafetyDirtyView>>().toEqualTypeOf<'isDirty' | 'kinds'>();
    expectTypeOf<ReturnType<SafetyDirtyView['kinds']>>().toEqualTypeOf<readonly DirtyKind[]>();
    expect(true).toBe(true);
  });
  it('RoundOpen / HeldLock / HeldPersonal', () => {
    expectTypeOf<RoundOpen['kind']>().toEqualTypeOf<'both' | 'rsi_only'>();
    expectTypeOf<keyof HeldLock>().toEqualTypeOf<'nonce' | 'assertHeld'>();
    expectTypeOf<keyof HeldPersonal>().toEqualTypeOf<'nonce' | 'assertHeld' | 'kind' | 'release'>();
    expectTypeOf<HeldPersonal['kind']>().toEqualTypeOf<'personal'>();
    expect(true).toBe(true);
  });
  it('WriteKind / DirtyKind / RsiOnlyTripReason / TripReason / UnsettledReason 模板', () => {
    expectTypeOf<DirtyKind>().toEqualTypeOf<
      'state_pause_flag' | 'revocation' | 'rollback_transition' | 'trip'
    >();
    expectTypeOf<RsiOnlyTripReason>().toEqualTypeOf<
      'no_observation' | 'redaction_changed' | 'kit_major_changed'
    >();
    expectTypeOf<Assignable<RsiOnlyTripReason, TripReason>>().toEqualTypeOf<true>();
    expectTypeOf<Assignable<PersonalFaultCode, string>>().toEqualTypeOf<true>();
    expectTypeOf<PersonalFault['code']>().toEqualTypeOf<PersonalFaultCode>();
    expect(true).toBe(true);
  });
});

describe('2b 兜底协调器的状态', () => {
  it('FallbackTrack 四个字段(pending 是单飞的共享 Promise)', () => {
    expectTypeOf<K<FallbackTrack>>().toEqualTypeOf<
      'pCompleted' | 'fallbackTried' | 'fb' | 'pending'
    >();
    expectTypeOf<FallbackTrack['pending']>().toEqualTypeOf<Promise<FallbackReport | null> | null>();
    expect(true).toBe(true);
  });
});

describe('3 授权类型(C 为唯一来源)', () => {
  it('GrowthOp / GrowthReq / GrowthVerdict / GrowthPass', () => {
    expectTypeOf<GrowthOp['cap']>().toEqualTypeOf<
      | 'bootstrap'
      | 'candidate_create'
      | 'admission'
      | 'shadow_to_canary'
      | 'grant'
      | 'deploy_inject'
    >();
    expectTypeOf<GrowthReq['op']>().toEqualTypeOf<GrowthOp['cap']>();
    expectTypeOf<CandidateReq['op']>().toEqualTypeOf<
      'shadow_to_canary' | 'grant' | 'deploy_inject'
    >();
    expectTypeOf<CandidateReq['cand']>().toEqualTypeOf<TaintCandidate>();
    expectTypeOf<K<GrowthPass>>().toEqualTypeOf<'rsiNonce' | 'personalNonce' | 'gen' | 'op'>();
    expectTypeOf<GrowthPass['gen']>().toEqualTypeOf<number>();
    expectTypeOf<GrowthPass['op']>().toEqualTypeOf<GrowthOp>();
    expectTypeOf<GrowthVerdict>().toEqualTypeOf<
      { readonly ok: false; readonly code: GrowthDeny } | GrowthPass
    >();
    expect(true).toBe(true);
  });
  it('evaluateGrowth / requireGrowth / checkGrowthVeto 的签名', async () => {
    const m = await import('../../../src/rsi/personal/stage/growth.js');
    expectTypeOf(m.evaluateGrowth).toEqualTypeOf<
      (
        round: BothRound,
        req: GrowthReq,
        readers: GrowthReaders,
        stage: GrowthStage | undefined,
      ) => Promise<GrowthVerdict>
    >();
    expectTypeOf(m.requireGrowth).toEqualTypeOf<
      (pass: GrowthPass, round: BothRound, op: GrowthOp) => void
    >();
    expectTypeOf(m.checkGrowthVeto).toEqualTypeOf<
      (
        pass: GrowthPass,
        round: BothRound,
        op: GrowthOp,
        readers: Pick<GrowthReaders, 'externalVeto'>,
      ) => Promise<void>
    >();
    expect(m.requireGrowth.length).toBe(3);
    expect(m.checkGrowthVeto.length).toBe(4);
    expect(m.evaluateGrowth.length).toBe(4);
  });
  it('GrowthStage { ops };GrowthReaders 每个方法必收 round(无参缓存读法不存在)', () => {
    expectTypeOf<keyof GrowthStage>().toEqualTypeOf<'ops'>();
    expectTypeOf<GrowthStage['ops']>().toEqualTypeOf<ReadonlySet<GrowthOp['cap']>>();
    expectTypeOf<keyof GrowthReaders>().toEqualTypeOf<
      | 'capability'
      | 'config'
      | 'state'
      | 'repo'
      | 'barrier'
      | 'taint'
      | 'purge'
      | 'judge'
      | 'throttle'
      | 'locks'
      | 'admission'
      | 'extra'
      | 'externalVeto'
    >();
    for (const k of [
      'capability',
      'config',
      'state',
      'repo',
      'barrier',
      'taint',
      'purge',
      'judge',
      'throttle',
      'locks',
      'admission',
      'extra',
      'externalVeto',
    ] as const) {
      expectTypeOf<Parameters<GrowthReaders[typeof k]>[0]>().toEqualTypeOf<BothRound>();
    }
    expect(true).toBe(true);
  });
  it('事实类型 / 拒绝子集', () => {
    expectTypeOf<keyof ConfigFact>().toEqualTypeOf<'trusted' | 'autoEnabled' | 'confirmed'>();
    expectTypeOf<keyof StateFact>().toEqualTypeOf<'valid' | 'paused' | 'flags' | 'safetyFault'>();
    expectTypeOf<keyof TaintFact>().toEqualTypeOf<
      'capabilityReady' | 'scan' | 'rescanRequired' | 'rescanned' | 'candidate'
    >();
    expectTypeOf<keyof PurgeFact>().toEqualTypeOf<'capabilityReady' | 'journalPresent'>();
    expectTypeOf<keyof AdmissionFact>().toEqualTypeOf<'wired' | 'effective' | 'versionsMatch'>();
    expectTypeOf<BarrierDeny>().toEqualTypeOf<
      'recovery_incomplete' | 'reconcile_incomplete' | 'store_unreadable' | 'store_full'
    >();
    expectTypeOf<ExtraDeny>().toEqualTypeOf<
      | 'near_fp_unavailable'
      | 'fp_key_unavailable'
      | 'creation_unready'
      | 'source_unknown'
      | 'purge'
      | 'recovery_incomplete'
    >();
    expectTypeOf<VetoFact['vetoed']>().toEqualTypeOf<boolean>();
    expectTypeOf<CheckResult<'repo'>>().toEqualTypeOf<
      { readonly ok: true } | { readonly ok: false; readonly code: 'repo' }
    >();
    expectTypeOf<K<OpProfile>>().toEqualTypeOf<
      'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9' | 'G10' | 'G11' | 'extra'
    >();
    expectTypeOf<Assignable<GrowthDeny, string>>().toEqualTypeOf<true>();
    expect(true).toBe(true);
  });
});

describe('4 判决槽(W9 §4;C 定义槽、W9 提供实现)', () => {
  it('JudgeReduceSlot.run / JudgeGrowthSlot.check / 报告 / 拒绝码', () => {
    expectTypeOf<keyof JudgeReduceSlot>().toEqualTypeOf<'run'>();
    expectTypeOf<keyof JudgeGrowthSlot>().toEqualTypeOf<'check'>();
    expectTypeOf<JudgeReduceSlot['run']>().toEqualTypeOf<
      (a: { readonly ids?: readonly string[] }) => Promise<JudgeReduceReport>
    >();
    expectTypeOf<JudgeGrowthSlot['check']>().toEqualTypeOf<
      (rec: PersonalLifecycleRecord) => Promise<JudgeGrowthVerdict>
    >();
    expectTypeOf<JudgeGrowthDeny>().toEqualTypeOf<
      'judge_unavailable' | 'judge_indeterminate' | 'judge_signal_pending'
    >();
    expectTypeOf<keyof JudgeReduceReport>().toEqualTypeOf<
      'evaluated' | 'transitioned' | 'blocked' | 'deferred' | 'halted' | 'unavailable'
    >();
    expectTypeOf<JudgeReduceReport['halted']>().toEqualTypeOf<StepHalt | null>();
    expectTypeOf<keyof JudgeSlots>().toEqualTypeOf<'reduce' | 'growth'>();
    expect(true).toBe(true);
  });
});

describe('5 污染扫描类型(v1 §6)', () => {
  it('TaintCandidate / TaintScanResult / TaintScanner', () => {
    expectTypeOf<keyof TaintCandidate>().toEqualTypeOf<
      'id' | 'content_sha256' | 'lifecycle' | 'source'
    >();
    expectTypeOf<TaintCandidate['lifecycle']>().toEqualTypeOf<RsiLifecycleState>();
    expectTypeOf<TaintCandidate['source']>().toEqualTypeOf<
      { readonly run_id: string; readonly proposal_id: string } | null | undefined
    >();
    expectTypeOf<TaintScanResult['kind']>().toEqualTypeOf<'ok' | 'unavailable'>();
    expectTypeOf<Extract<TaintScanResult, { kind: 'unavailable' }>['why']>().toEqualTypeOf<
      'journal_invalid' | 'journal_unreadable' | 'staging_too_large' | 'rsi_dir_untrusted'
    >();
    expectTypeOf<
      Extract<TaintScanResult, { kind: 'ok' }>['unknown'][number]['why']
    >().toEqualTypeOf<'source_missing' | 'run_dir_missing' | 'mark_unreadable'>();
    expectTypeOf<TaintScanner['scan']>().toEqualTypeOf<
      (round: BothRound, cands: readonly TaintCandidate[]) => Promise<TaintScanResult>
    >();
    expect(true).toBe(true);
  });
});

describe('6 端口', () => {
  it('FallbackPorts 六个成员,无任何写 state 的方法', () => {
    expectTypeOf<keyof FallbackPorts>().toEqualTypeOf<
      | 'readStateRaw'
      | 'markers'
      | 'muteCanary'
      | 'removeCanary'
      | 'ensureBreakerMarker'
      | 'assertHeld'
    >();
    expectTypeOf<ReturnType<FallbackPorts['readStateRaw']>>().toEqualTypeOf<Promise<StateRead>>();
    expect(true).toBe(true);
  });
  it('SafetyPort / RecoveryPort / ReducePort / Compactor 的键', () => {
    expectTypeOf<keyof SafetyPort>().toEqualTypeOf<
      | 'enforceMute'
      | 'reconcileCaches'
      | 'verifyMuted'
      | 'evaluateRsiTriggers'
      | 'tripAndMute'
      | 'stopExistingInjection'
    >();
    expectTypeOf<SafetyPort['tripAndMute']>().toEqualTypeOf<
      (reasons: readonly RsiOnlyTripReason[]) => Promise<TripResult>
    >();
    expectTypeOf<SafetyPort['stopExistingInjection']>().toEqualTypeOf<
      (cause: StopCause) => Promise<MuteResult>
    >();
    expectTypeOf<keyof RecoveryPort>().toEqualTypeOf<
      | 'recoverRepo'
      | 'setFlagAndMute'
      | 'resumeRollbacks'
      | 'recoverTerminalEffects'
      | 'reconcileRevocations'
    >();
    expectTypeOf<RecoveryPort['recoverRepo']>().toEqualTypeOf<() => Promise<RepoRecovery>>();
    expectTypeOf<RecoveryPort['setFlagAndMute']>().toEqualTypeOf<
      (flags: FlagUpdate) => Promise<StepOutcome>
    >();
    expectTypeOf<keyof ReducePort>().toEqualTypeOf<
      | 'applyTaint'
      | 'runAnalysis'
      | 'expireCandidates'
      | 'reconcileRevocations'
      | 'evaluateTriggers'
      | 'tripAndMute'
      | 'applyAutoRelease'
      | 'startRollback'
    >();
    expectTypeOf<ReducePort['tripAndMute']>().toEqualTypeOf<
      (reasons: readonly TripReason[]) => Promise<TripResult>
    >();
    expectTypeOf<ReducePort['startRollback']>().toEqualTypeOf<
      (req: RollbackRequest) => Promise<StepOutcome>
    >();
    expectTypeOf<keyof Compactor>().toEqualTypeOf<'compact'>();
    expectTypeOf<Compactor['compact']>().toEqualTypeOf<
      (round: BothRound) => Promise<CompactResult>
    >();
    expectTypeOf<CompactResult['kind']>().toEqualTypeOf<'noop' | 'compacted' | 'compact_blocked'>();
    expectTypeOf<keyof EnforceResult>().toEqualTypeOf<'mute' | 'fault'>();
    expectTypeOf<MutedVerdict['ok']>().toEqualTypeOf<boolean>();
    expectTypeOf<MuteResult>().toEqualTypeOf<
      'muted' | 'removed' | 'marker' | 'unreliable' | 'nothing'
    >();
    expectTypeOf<StepOutcome['kind']>().toEqualTypeOf<
      'done' | 'skipped' | 'incomplete' | 'failed'
    >();
    expect(true).toBe(true);
  });
  it('rsi-only 的 SafetyPort 与 S1 / S2 的端口互不可见(S0 拿不到 setFlagAndMute / applyAutoRelease / startRollback)', () => {
    expectTypeOf<SafetyPort>().not.toHaveProperty('setFlagAndMute');
    expectTypeOf<SafetyPort>().not.toHaveProperty('applyAutoRelease');
    expectTypeOf<SafetyPort>().not.toHaveProperty('startRollback');
    expectTypeOf<ReducePort>().not.toHaveProperty('setFlagAndMute');
    expectTypeOf<RecoveryPort>().not.toHaveProperty('tripAndMute');
    expect(true).toBe(true);
  });
});

describe('7 settleSafety / RoundBudget', () => {
  it('签名与结果', async () => {
    const m = await import('../../../src/rsi/personal/stage/settle.js');
    expectTypeOf(m.settleSafety).toEqualTypeOf<
      (
        round: BothRound | RsiOnlyRound,
        ports: SweepPorts,
        budget: RoundBudget,
      ) => Promise<SettleResult>
    >();
    expectTypeOf<keyof SweepPorts>().toEqualTypeOf<
      'enforceMute' | 'reconcileCaches' | 'verifyMuted'
    >();
    expectTypeOf<keyof RoundBudget>().toEqualTypeOf<'form' | 'charge' | 'used' | 'limit'>();
    expectTypeOf<SettleResult['kind']>().toEqualTypeOf<'settled' | 'unsettled'>();
    expect(m.BUDGET_PORTS).toEqual([
      'enforceMute',
      'setFlagAndMute',
      'tripAndMute',
      'reconcileCaches',
      'applyAutoRelease',
      'evaluateTriggers',
      'startRollback',
    ]);
    expect(m.ROUND_BUDGET_LIMITS).toEqual({
      both: {
        enforceMute: 2,
        setFlagAndMute: 1,
        tripAndMute: 1,
        reconcileCaches: 2,
        applyAutoRelease: 1,
        evaluateTriggers: 1,
      },
      rsi_only: {
        enforceMute: 2,
        setFlagAndMute: 0,
        tripAndMute: 1,
        reconcileCaches: 2,
        applyAutoRelease: 0,
        evaluateTriggers: 1,
        startRollback: 0,
      },
    });
  });
});

describe('8 监测信号表(常量)', () => {
  it('阈值 3 条 / 30 分钟 / 24 小时;四个信号逐个钉死', async () => {
    const m = await import('../../../src/rsi/personal/stage/monitoring.js');
    expect(m.MONITOR_THRESHOLDS).toEqual({
      skippedLockedMinCount: 3,
      skippedLockedMinSpanMs: 30 * 60 * 1000,
      lastTickMaxAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(m.MONITOR_SIGNALS.map((s) => [s.id, s.conditional, s.inputs])).toEqual([
      ['lock_starvation', false, ['peekRsiLock', 'log_tail']],
      ['safety_breaker_inject', false, ['state_json', 'canary_json', 'marker_lstat']],
      ['p_heartbeat_approx', false, ['state_json']],
      ['state_written_not_muted', true, ['state_json', 'canary_json', 'marker_lstat']],
    ]);
    expect(m.MONITOR_INPUTS).toEqual([
      'peekRsiLock',
      'log_tail',
      'state_json',
      'canary_json',
      'marker_lstat',
    ]);
    expect(m.MONITOR_SIGNALS.find((s) => s.id === 'p_heartbeat_approx')?.caveat).toMatch(/误报/);
    expect(Object.isFrozen(m.MONITOR_SIGNALS)).toBe(true);
    expectTypeOf<keyof MonitorSignal>().toEqualTypeOf<
      'id' | 'inputs' | 'meaning' | 'conditional' | 'caveat'
    >();
  });
});
