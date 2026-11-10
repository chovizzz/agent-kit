/**
 * 个人层统一转移表(docs/contracts.md R21-4.1 / R21-4.2 / R21-4.4 / R21-4.4a / R21-4.5 / R21-4.6;§21.24 W0-1 / W0-13)。纯数据 + 纯守卫函数,无 I/O。
 *
 * 一行 = 一条转移。R21-4.5 要求每条转移的**四件事显式写出**,所以它们是行的字段而不是注释:
 *  ① 守卫 `guard`(返回 `null` = 通过,否则返回守卫码;全部为真才转移);
 *  ② 幂等键 `evidence`(触发证据指纹的构成;键本身由 `idemKey` 派生:`sha256(id, dim, agent, from, to, 指纹)` 前 16 位,不含时钟);
 *  ③ 注入的时钟 `clock = 'ctx.now'`(引擎不读系统时间);
 *  ④ 崩溃恢复入口 `recovery`(哪份记录是续做的依据)。
 * 能力相位:`caps` 列出该转移依赖的能力键(`RSI_CAPABILITY_PHASE`),由引擎经 `capabilityAvailable(key, ctx.phase)` 判定;
 * 表里没有的能力默认拒绝(`phase_not_available`)。`blocked / adopted / stable / retiring` 与 `category=exec` 在本期没有任何行。
 */
import { z } from 'zod';
import { IsoDateSchema, IsoTimestampSchema, Sha256Schema } from '../../contracts/common.js';
import {
  RSI_AUTO_PHASE_ORDER,
  RSI_DECIDE_BETTER_ENABLED,
  RSI_GATE_REASONS,
  RSI_HARM_METRICS,
  RSI_LIFECYCLE_STATES,
  RSI_MAX_CANARY_DAYS,
  RSI_MAX_SESSIONS_PER_ARM,
  RSI_ROLLBACK_PHASES,
  RSI_SHADOW_MIN_HITS,
  RSI_SHADOW_MIN_SESSIONS,
  RSI_SHADOW_QUEUE_MAX_DAYS,
  RSI_TARGET_TERMINALS,
  RSI_TERMINAL_REASONS,
  RsiAgentSchema,
  capabilityAvailable,
  phaseAtLeast,
  rsiG0Reasons,
  type RsiLifecycleState,
} from '../../contracts/rsi.js';
import {
  RsiClusterSignatureSchema,
  type PersonalLifecycleRecord,
} from '../../contracts/rsi-personal.js';
import { canonicalJson } from '../../io/canonical-json.js';

// ---------------------------------------------------------------------------
// 类型与输入 schema(跨信任边界:引擎入口一律先过这些 schema)
// ---------------------------------------------------------------------------
export type Dim = 'lifecycle' | 'deploy' | 'rollback';
export type TerminalReason = (typeof RSI_TERMINAL_REASONS)[number];
export type TargetTerminal = (typeof RSI_TARGET_TERMINALS)[number];
export type RollbackPhase = (typeof RSI_ROLLBACK_PHASES)[number];

/** 转移上下文:环境事实。`phase` **必填、无缺省**(忘传 = 校验失败,不会静默取当前相位) */
export const TransitionCtxSchema = z.strictObject({
  phase: z
    .number()
    .int()
    .min(0)
    .max(RSI_AUTO_PHASE_ORDER.length - 1),
  /** 注入的时钟:所有 `at` 与 UTC 日期都从这里来 */
  now: IsoTimestampSchema,
  /** 持 `personal/lock` 时重读 `revocations.jsonl` 的结果:该候选被凭据列出(R21-9.5「对账先于授予」) */
  revocation_listed: z.boolean(),
  /** 同一临界区内重读的权威 `lifecycle/<id>.json` 的状态(M13-2:权威已终态而手里的副本还是 shadow → 不推进) */
  authoritative_lifecycle: z.enum(RSI_LIFECYCLE_STATES),
});
export type TransitionCtx = z.infer<typeof TransitionCtxSchema>;

const GATE_REASON_SET: ReadonlySet<string> = new Set<string>([
  ...RSI_GATE_REASONS,
  ...rsiG0Reasons(),
]);
/** 闸红的原因码:G0 子码与 G1–G8 码(封闭集合;`gate_internal` 是熔断码,不在其中,所以永远产不出 `rejected`) */
const GateReasonSchema = z.string().refine((r) => GATE_REASON_SET.has(r), '不是闸原因码');

const Evidence = z.string().min(1).max(128);
const NonNegInt = z.number().int().nonnegative();

/** `shadow → canary` 的推进事实(W0-13;M13-1 逐项前置)。全部必填:缺一项 = 输入校验失败(fail-closed) */
export const PromoteFactsSchema = z.strictObject({
  config_valid: z.boolean(),
  enabled: z.boolean(),
  authorized: z.boolean(),
  tainted: z.boolean(),
  cooldown_active: z.boolean(),
  tombstoned: z.boolean(),
  blacklisted: z.boolean(),
  evidence_valid: z.boolean(),
  /** 有观测会话数与签名命中数(R21-1.6 口径,调用方给) */
  sessions: NonNegInt,
  hits: NonNegInt,
  current_content_sha256: Sha256Schema,
  current_cluster_signature: RsiClusterSignatureSchema.nullable(),
  /** 全局评估名额被占(R21-6.8;名额的占用判定见 {@link evaluationSlotOccupied}) */
  slot_occupied: z.boolean(),
});
export type PromoteFacts = z.infer<typeof PromoteFactsSchema>;

const JudgeSchema = {
  /** 关联提案上通过完整校验的 `session_confirmed` 或 `proven` 的 `spawned` 记录(N4-2) */
  validated: z.boolean(),
  verdict_reject: z.boolean(),
  injection_suspected: z.boolean(),
};

export const TransitionEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('gates_passed'), evidence: Evidence, gates_green: z.boolean() }),
  z.strictObject({
    kind: z.literal('gate_red'),
    evidence: Evidence,
    gate_reason: GateReasonSchema,
  }),
  z.strictObject({
    kind: z.literal('shadow_no_hit'),
    evidence: Evidence,
    sessions: NonNegInt,
    hits: NonNegInt,
  }),
  z.strictObject({
    kind: z.literal('shadow_queue_expired'),
    evidence: Evidence,
    queued_since: IsoDateSchema.nullable(),
  }),
  PromoteFactsSchema.extend({ kind: z.literal('shadow_promote'), evidence: Evidence }),
  z.strictObject({ kind: z.literal('veto'), evidence: Evidence }),
  z.strictObject({ kind: z.literal('taint'), evidence: Evidence }),
  z.strictObject({ kind: z.literal('clear'), evidence: Evidence }),
  z.strictObject({ kind: z.literal('judge_reject'), evidence: Evidence, ...JudgeSchema }),
  z.strictObject({
    kind: z.literal('harm'),
    evidence: Evidence,
    metric: z.enum(RSI_HARM_METRICS),
    /** R21-7.4 判变差的结论(调用方给);不是「变差」就不转移 */
    worse: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('canary_limit'),
    evidence: Evidence,
    max_arm_sessions: NonNegInt,
  }),
  z.strictObject({ kind: z.literal('decide_better'), evidence: Evidence }),
  z.strictObject({
    kind: z.literal('deploy_inject'),
    evidence: Evidence,
    agent: RsiAgentSchema,
    /** R21-6.5 准入已通过 */
    admitted: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('rollback_advance'),
    evidence: Evidence,
    to: z.enum(RSI_ROLLBACK_PHASES),
    /** 当前子状态的完成判据成立(R21-9.1「完成判据(机器可判)」) */
    current_completed: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('removal_done'),
    evidence: Evidence,
    agent: RsiAgentSchema,
    /** R21-9.1 第四段完成判据对该 agent 成立(V1 恒真,R21-9.2) */
    criterion_met: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('compensation_done'),
    evidence: Evidence,
    completion_met: z.boolean(),
  }),
]);
export type TransitionEvent = z.infer<typeof TransitionEventSchema>;
export type EventKind = TransitionEvent['kind'];
type Ev<K extends EventKind> = Extract<TransitionEvent, { kind: K }>;

// ---------------------------------------------------------------------------
// 原因码 / 终态理由 / 目标终态(R21-4.4a、R21-4.6)
// ---------------------------------------------------------------------------
/** R21-4.4a ①:终止事件(已在 `rolling_back` 或终态时再来的那一类) */
export const TERMINATION_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'veto',
  'taint',
  'clear',
  'judge_reject',
  'harm',
  'canary_limit',
]);

/** 终止事件的转移原因码(封闭枚举内) */
export function terminationReason(e: TransitionEvent): string {
  switch (e.kind) {
    case 'veto':
      return 'vetoed';
    case 'taint':
      return 'tainted';
    case 'clear':
      return 'cleared';
    case 'judge_reject':
      return e.injection_suspected ? 'judge_injection' : 'judge_reject';
    case 'harm':
      return `harm_${e.metric}`;
    case 'canary_limit':
      return 'limit_reached';
    default:
      return 'invalid_termination';
  }
}

/** 终止事件对 `rolling_back` 的目标终态:`limit_reached` → `expired`,其余 → `rolled_back`(R21-4.1) */
export function terminationTarget(e: TransitionEvent): TargetTerminal {
  return e.kind === 'canary_limit' ? 'expired' : 'rolled_back';
}

/** 转移原因码 → 终态理由(显式映射;闸码另判)。未知码 → undefined(调用方 fail-closed) */
const TERMINAL_REASON_OF: Readonly<Record<string, TerminalReason>> = Object.freeze({
  vetoed: 'vetoed',
  tainted: 'tainted',
  cleared: 'cleared',
  judge_reject: 'judge_rejected',
  judge_injection: 'judge_rejected',
  harm_c1: 'auto_rollback',
  harm_c2: 'auto_rollback',
  harm_c3: 'auto_rollback',
  harm_c4: 'auto_rollback',
  harm_c6: 'auto_rollback',
  limit_reached: 'auto_expired',
  static_sync_timeout: 'static_sync_timeout',
  no_hit: 'no_hit',
});
export function terminalReasonOf(reason: string): TerminalReason | undefined {
  if (Object.hasOwn(TERMINAL_REASON_OF, reason)) return TERMINAL_REASON_OF[reason];
  return GATE_REASON_SET.has(reason) ? 'rejected_gate' : undefined;
}

/** 终态理由优先级下标(`RSI_TERMINAL_REASONS` 靠前者高:vetoed > tainted > cleared > judge_rejected > …);未知 → 最低 */
export function terminalPriority(reason: string): number {
  const t = terminalReasonOf(reason);
  return t === undefined ? RSI_TERMINAL_REASONS.length : RSI_TERMINAL_REASONS.indexOf(t);
}
/** 目标终态优先级下标(`RSI_TARGET_TERMINALS` 靠前者高:rolled_back > retired > expired > shadow) */
export function targetPriority(t: TargetTerminal): number {
  return RSI_TARGET_TERMINALS.indexOf(t);
}

// ---------------------------------------------------------------------------
// UTC 日期(只用注入值)
// ---------------------------------------------------------------------------
export function utcDay(ts: string): string {
  return new Date(Date.parse(ts)).toISOString().slice(0, 10);
}
/** `a - b` 的 UTC 日数(a、b 为 `YYYY-MM-DD`) */
export function utcDayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}
/** 排队「满 30 个 UTC 日」:今日与 `queued_since` 相差 ≥ 30(起算日当天不算已满;汇报「问题」节记录此选择) */
export function queueExpired(queuedSince: string | null, today: string): boolean {
  return queuedSince !== null && utcDayDiff(today, queuedSince) >= RSI_SHADOW_QUEUE_MAX_DAYS;
}
/** 进入 canary 以来的 UTC 日数;找不到进入记录(超过 256 条被合并)→ `Infinity`(走向更少生效) */
export function canaryDays(record: PersonalLifecycleRecord, today: string): number {
  for (let i = record.transitions.length - 1; i >= 0; i--) {
    const t = record.transitions[i];
    if (t !== undefined && t.dim === 'lifecycle' && t.to === 'canary') {
      return utcDayDiff(today, utcDay(t.at));
    }
  }
  return Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// 守卫(逐项独立的 `if`,不合并成 every():M13-1 的变异锚点要求「逐个删去该项检查」)
// ---------------------------------------------------------------------------
type Guard = string | null;

/** 「增加影响」类转移的权威与撤销前置(R21-9.5 对账先于授予;M13-2) */
export function authorityBlocker(record: PersonalLifecycleRecord, ctx: TransitionCtx): Guard {
  if (ctx.revocation_listed) return 'revoked';
  if (ctx.authoritative_lifecycle !== record.lifecycle) return 'authority_mismatch';
  return null;
}

/** `shadow → canary` 的资格(W0-13 第 ② 步;不含名额)。第一个不成立的项的守卫码,全部成立返回 `null` */
export function promoteEligibilityBlocker(
  record: PersonalLifecycleRecord,
  f: PromoteFacts,
  ctx: TransitionCtx,
): Guard {
  if (!capabilityAvailable('transition_shadow_to_canary', ctx.phase)) return 'phase_not_available';
  const auth = authorityBlocker(record, ctx);
  if (auth !== null) return auth;
  if (record.category === 'exec') return 'category_exec_unsupported';
  if (record.cluster_signature === undefined) return 'no_cluster_signature';
  if (!f.config_valid) return 'config_invalid';
  if (!f.enabled) return 'auto_disabled';
  if (!f.authorized) return 'not_authorized';
  if (f.tainted) return 'tainted';
  if (f.cooldown_active) return 'cooldown_active';
  if (f.tombstoned) return 'tombstoned';
  if (f.blacklisted) return 'veto_blacklisted';
  if (f.current_content_sha256 !== record.content_sha256) return 'content_changed';
  if (
    f.current_cluster_signature === null ||
    canonicalJson(f.current_cluster_signature) !== canonicalJson(record.cluster_signature)
  ) {
    return 'signature_changed';
  }
  if (!f.evidence_valid) return 'evidence_invalid';
  if (f.sessions < RSI_SHADOW_MIN_SESSIONS) return 'shadow_sessions_short';
  if (f.hits < RSI_SHADOW_MIN_HITS) return 'shadow_hits_short';
  // R21-4.1:profile ≥ medium 且相位 ≥ V3 时另需 G8;G8 在 V3 才实现 → 在此之前到达该相位一律拒绝(fail-closed)
  if (phaseAtLeast('V3', ctx.phase)) return 'g8_not_implemented';
  return null;
}

/** 全局评估名额(R21-6.8 / G7):被占 → 守卫码 */
export function slotBlocker(f: PromoteFacts): Guard {
  return f.slot_occupied ? 'slot_occupied' : null;
}

/**
 * 全局评估名额是否被占用(R21-6.8;输入 = 其它候选的 `lifecycle` 与 `watch`):`canary` / `adopted` 占用;`stable` 在任一参与 agent 的
 * `watch.result ∈ not_started | pending | withdrawn_residual` 时占用;`rolling_back`(回滚期间只会减少影响)与其余状态不占。
 */
export function evaluationSlotOccupied(
  others: readonly Pick<PersonalLifecycleRecord, 'lifecycle' | 'watch'>[],
): boolean {
  return others.some((o) => {
    if (o.lifecycle === 'canary' || o.lifecycle === 'adopted') return true;
    if (o.lifecycle !== 'stable') return false;
    return [o.watch.claude, o.watch.pi, o.watch.codex].some(
      (w) =>
        w !== null &&
        (w.result === 'not_started' || w.result === 'pending' || w.result === 'withdrawn_residual'),
    );
  });
}

// ---------------------------------------------------------------------------
// 转移表
// ---------------------------------------------------------------------------
/** 行的应用形状(引擎按它决定怎么改记录) */
export type RowShape =
  | 'to_terminal' // proposed|shadow → rejected|expired(无部署,直接终态)
  | 'simple' // proposed → shadow、shadow → canary
  | 'enter_rollback' // canary → rolling_back(连带 deploy injected → removal_pending、写 rollback)
  | 'repeat_rollback' // rolling_back → rolling_back(R21-4.4a ①,自环)
  | 'complete' // rolling_back → <target_terminal>
  | 'deploy' // 维度二
  | 'rollback_phase' // 维度三(rollback.phase 顺序推进)
  | 'blocked_decide'; // canary → adopted:V2,永不应用

export interface TransitionRow {
  name: string;
  dim: Dim;
  kind: EventKind;
  shape: RowShape;
  /** 该行适用的个人生命周期状态(deploy / rollback 行要求记录当前处于它) */
  lifecycle: RsiLifecycleState;
  /** dim 内的来源状态;`lifecycle` 行即 lifecycle 本身 */
  from: string;
  /** dim 内的目标状态;`'target'` = 取 `record.rollback.target_terminal` */
  to: string;
  /** 额外的事件过滤(如 rollback_advance 只匹配 `to` 相同的那一行) */
  applies: (e: TransitionEvent) => boolean;
  /** 依赖的能力键(经 `capabilityAvailable(key, ctx.phase)`;不在能力表里的键 = 默认拒绝) */
  caps: (e: TransitionEvent, r: PersonalLifecycleRecord) => readonly string[];
  /** 本次转移写入 `transitions[]` 的原因码(封闭枚举) */
  reason: (e: TransitionEvent, r: PersonalLifecycleRecord) => string;
  /** 进入终态(`to_terminal`)时的终态理由 */
  terminal: (e: TransitionEvent) => TerminalReason | undefined;
  // ----- R21-4.5 的四件事 -----
  /** ① 守卫:`null` = 通过 */
  guard: (r: PersonalLifecycleRecord, e: TransitionEvent, ctx: TransitionCtx) => Guard;
  /** ② 幂等键里的「触发证据指纹」:事件种类 + 区分原因 + 调用方证据(**不含时钟**) */
  evidence: (e: TransitionEvent) => string;
  /** ③ 时钟只来自 `ctx.now` */
  clock: 'ctx.now';
  /** ④ 崩溃恢复入口 */
  recovery: string;
}

const RECOVER_AUTH =
  '以私有仓库权威 lifecycle/<id>.json 为准续做(R21-3.8);同一 idem_key 重放为空操作';
const RECOVER_TXN =
  '按 rsi-personal/txn/<id>.json 续做(R21-9.6),续做可再崩溃再续;同一 idem_key 重放为空操作';

/** 区分原因的指纹片段:同类事件的不同原因(如 harm 的指标、judge 的两种原因)不会撞同一个键 */
function discriminator(e: TransitionEvent): string {
  switch (e.kind) {
    case 'harm':
      return e.metric;
    case 'judge_reject':
      return e.injection_suspected ? 'injection' : 'reject';
    case 'gate_red':
      return e.gate_reason;
    case 'deploy_inject':
    case 'removal_done':
      return e.agent;
    case 'rollback_advance':
      return e.to;
    default:
      return '-';
  }
}
export const eventEvidence = (e: TransitionEvent): string =>
  `${e.kind}:${discriminator(e)}:${e.evidence}`;

interface Spec<K extends EventKind> {
  name: string;
  dim?: Dim;
  kind: K;
  shape: RowShape;
  lifecycle: RsiLifecycleState;
  from: string;
  to: string;
  applies?: (e: Ev<K>) => boolean;
  caps: (e: Ev<K>, r: PersonalLifecycleRecord) => readonly string[];
  reason: (e: Ev<K>, r: PersonalLifecycleRecord) => string;
  terminal?: (e: Ev<K>) => TerminalReason | undefined;
  guard: (r: PersonalLifecycleRecord, e: Ev<K>, ctx: TransitionCtx) => Guard;
}

function row<K extends EventKind>(s: Spec<K>): TransitionRow {
  const dim = s.dim ?? 'lifecycle';
  return {
    name: s.name,
    dim,
    kind: s.kind,
    shape: s.shape,
    lifecycle: s.lifecycle,
    from: s.from,
    to: s.to,
    // 行只按 `kind` 取出,所以这里的收窄转换成立
    applies: (e) => (s.applies ? s.applies(e as Ev<K>) : true),
    caps: (e, r) => s.caps(e as Ev<K>, r),
    reason: (e, r) => s.reason(e as Ev<K>, r),
    terminal: (e) => (s.terminal ? s.terminal(e as Ev<K>) : undefined),
    guard: (r, e, ctx) => s.guard(r, e as Ev<K>, ctx),
    evidence: eventEvidence,
    clock: 'ctx.now',
    recovery: dim === 'lifecycle' || s.shape === 'simple' ? RECOVER_AUTH : RECOVER_TXN,
  };
}

const NONE = (): Guard => null;
const CAPS_REJECT = ['transition_to_rejected'] as const;
const CAPS_ROLLING_BACK = [
  'transition_canary_to_rolling_back',
  'rollback_four_phase',
  'deploy_removal_pending',
] as const;

/** 各终止事件自带的守卫(同一事件在 canary / rolling_back 上共用) */
function terminationGuard(
  e: TransitionEvent,
  r: PersonalLifecycleRecord,
  ctx: TransitionCtx,
): Guard {
  switch (e.kind) {
    case 'judge_reject':
      // N4-2:守卫 = 通过完整校验的记录且(verdict=reject 或 injection_suspected)
      if (!e.validated) return 'judge_unvalidated';
      if (!e.verdict_reject && !e.injection_suspected) return 'judge_not_reject';
      return null;
    case 'harm':
      return e.worse ? null : 'not_worse';
    case 'canary_limit':
      if (
        e.max_arm_sessions >= RSI_MAX_SESSIONS_PER_ARM ||
        canaryDays(r, utcDay(ctx.now)) >= RSI_MAX_CANARY_DAYS
      ) {
        return null;
      }
      return 'limit_not_reached';
    default:
      return null;
  }
}

const ROW_LIST: TransitionRow[] = [];

// --- proposed → shadow(V1a) ---
ROW_LIST.push(
  row({
    name: 'proposed_to_shadow',
    kind: 'gates_passed',
    shape: 'simple',
    lifecycle: 'proposed',
    from: 'proposed',
    to: 'shadow',
    caps: () => ['transition_proposed_to_shadow'],
    reason: () => 'gates_passed',
    guard: (r, e, ctx) => {
      if (!e.gates_green) return 'gates_not_green';
      const auth = authorityBlocker(r, ctx);
      if (auth !== null) return auth;
      // 缺 cluster_signature = 旧版记录,不参与 G6 / shadow(W0-2)
      if (r.cluster_signature === undefined) return 'no_cluster_signature';
      return null;
    },
  }),
);

// --- proposed → rejected:任一闸红(G7 排队不是拒绝;G8 属 V3) ---
ROW_LIST.push(
  row({
    name: 'proposed_to_rejected_gate',
    kind: 'gate_red',
    shape: 'to_terminal',
    lifecycle: 'proposed',
    from: 'proposed',
    to: 'rejected',
    caps: (e) => (e.gate_reason.startsWith('g8_') ? [...CAPS_REJECT, 'gate_g8'] : CAPS_REJECT),
    reason: (e) => e.gate_reason,
    terminal: () => 'rejected_gate',
    guard: (_r, e) => (e.gate_reason === 'g7_queued' ? 'g7_queued_is_not_rejection' : null),
  }),
);

// --- proposed|shadow → rejected:veto / taint / clear / judge_reject ---
for (const from of ['proposed', 'shadow'] as const) {
  ROW_LIST.push(
    row({
      name: `${from}_to_rejected_veto`,
      kind: 'veto',
      shape: 'to_terminal',
      lifecycle: from,
      from,
      to: 'rejected',
      caps: () => CAPS_REJECT,
      reason: () => 'vetoed',
      terminal: () => 'vetoed',
      guard: NONE,
    }),
    row({
      name: `${from}_to_rejected_taint`,
      kind: 'taint',
      shape: 'to_terminal',
      lifecycle: from,
      from,
      to: 'rejected',
      caps: () => CAPS_REJECT,
      reason: () => 'tainted',
      terminal: () => 'tainted',
      guard: NONE,
    }),
    row({
      name: `${from}_to_rejected_clear`,
      kind: 'clear',
      shape: 'to_terminal',
      lifecycle: from,
      from,
      to: 'rejected',
      caps: () => CAPS_REJECT,
      reason: () => 'cleared',
      terminal: () => 'cleared',
      guard: NONE,
    }),
    row({
      name: `${from}_to_rejected_judge`,
      kind: 'judge_reject',
      shape: 'to_terminal',
      lifecycle: from,
      from,
      to: 'rejected',
      caps: () => CAPS_REJECT,
      reason: (e) => terminationReason(e),
      terminal: () => 'judge_rejected',
      guard: (r, e, ctx) => terminationGuard(e, r, ctx),
    }),
  );
}

// --- shadow → expired:无命中(≥ 20 会话且命中 < 2)与排队满 30 个 UTC 日 ---
ROW_LIST.push(
  row({
    name: 'shadow_to_expired_no_hit',
    kind: 'shadow_no_hit',
    shape: 'to_terminal',
    lifecycle: 'shadow',
    from: 'shadow',
    to: 'expired',
    caps: () => ['transition_shadow_to_expired'],
    reason: () => 'no_hit',
    terminal: () => 'no_hit',
    guard: (_r, e) => {
      if (e.sessions < RSI_SHADOW_MIN_SESSIONS) return 'shadow_sessions_short';
      if (e.hits >= RSI_SHADOW_MIN_HITS) return 'shadow_hits_met';
      return null;
    },
  }),
  row({
    name: 'shadow_to_expired_queue',
    kind: 'shadow_queue_expired',
    shape: 'to_terminal',
    lifecycle: 'shadow',
    from: 'shadow',
    to: 'expired',
    caps: () => ['transition_shadow_to_expired'],
    reason: () => 'limit_reached',
    terminal: () => 'auto_expired',
    guard: (_r, e, ctx) =>
      queueExpired(e.queued_since, utcDay(ctx.now)) ? null : 'queue_not_expired',
  }),
);

// --- shadow → canary(V1b;W0-13 合期后与 V1a 同版发布,但能力仍按相位) ---
ROW_LIST.push(
  row({
    name: 'shadow_to_canary',
    kind: 'shadow_promote',
    shape: 'simple',
    lifecycle: 'shadow',
    from: 'shadow',
    to: 'canary',
    caps: (_e, r) =>
      r.category === 'exec'
        ? ['transition_shadow_to_canary', 'exec_admission']
        : ['transition_shadow_to_canary'],
    reason: () => 'shadow_hits_met',
    guard: (r, e, ctx) => promoteEligibilityBlocker(r, e, ctx) ?? slotBlocker(e),
  }),
);

// --- canary → rolling_back(V1b)与 rolling_back 自环(R21-4.4a ①) ---
for (const kind of ['harm', 'veto', 'taint', 'clear', 'judge_reject', 'canary_limit'] as const) {
  const caps = (e: TransitionEvent): readonly string[] =>
    e.kind === 'harm' ? [...CAPS_ROLLING_BACK, 'harm_test'] : CAPS_ROLLING_BACK;
  const reason = (e: TransitionEvent): string => terminationReason(e);
  const guard = (r: PersonalLifecycleRecord, e: TransitionEvent, ctx: TransitionCtx): Guard =>
    terminationGuard(e, r, ctx);
  ROW_LIST.push(
    row<EventKind>({
      name: `canary_to_rolling_back_${kind}`,
      kind,
      shape: 'enter_rollback',
      lifecycle: 'canary',
      from: 'canary',
      to: 'rolling_back',
      caps,
      reason,
      guard,
    }),
    row<EventKind>({
      name: `rolling_back_repeat_${kind}`,
      kind,
      shape: 'repeat_rollback',
      lifecycle: 'rolling_back',
      from: 'rolling_back',
      to: 'rolling_back',
      caps,
      reason,
      guard,
    }),
  );
}

// --- canary → adopted:V2,本期永不应用(相位 ≥ V2 时也因判定开关为假而拒) ---
ROW_LIST.push(
  row({
    name: 'canary_to_adopted',
    kind: 'decide_better',
    shape: 'blocked_decide',
    lifecycle: 'canary',
    from: 'canary',
    to: 'adopted',
    caps: () => ['transition_canary_to_adopted', 'decide_better'],
    reason: () => 'decided_better',
    guard: () => (RSI_DECIDE_BETTER_ENABLED ? 'adopted_not_implemented' : 'decide_better_disabled'),
  }),
);

// --- rolling_back → <target_terminal>(R21-9.1 四段全部完成) ---
ROW_LIST.push(
  row({
    name: 'rolling_back_to_terminal',
    kind: 'compensation_done',
    shape: 'complete',
    lifecycle: 'rolling_back',
    from: 'rolling_back',
    to: 'target',
    caps: () => ['transition_rolling_back_to_terminal', 'rollback_four_phase'],
    reason: () => 'compensation_done',
    guard: (r, e) => {
      if (r.rollback === null) return 'no_rollback_record';
      if (r.rollback.phase !== 'rollback_complete') return 'rollback_not_complete';
      if (!e.completion_met) return 'completion_not_met';
      if (r.deploy.claude !== 'none' || r.deploy.pi !== 'none' || r.deploy.codex !== 'none') {
        return 'deploy_not_cleared';
      }
      // `shadow`(E1 授权身份变化)与 `retired`(retiring)本期不存在
      if (r.rollback.target_terminal === 'shadow') return 'target_shadow_exec_only';
      if (r.rollback.target_terminal === 'retired') return 'target_retired_not_available';
      if (terminalReasonOf(r.rollback.reason) === undefined) return 'terminal_reason_unmapped';
      return null;
    },
  }),
);

// --- 维度二:本机部署 ---
ROW_LIST.push(
  row({
    name: 'deploy_none_to_injected',
    dim: 'deploy',
    kind: 'deploy_inject',
    shape: 'deploy',
    lifecycle: 'canary',
    from: 'none',
    to: 'injected',
    caps: () => ['deploy_none_to_injected'],
    reason: () => 'deploy_injected',
    guard: (r, e, ctx) => {
      const auth = authorityBlocker(r, ctx);
      if (auth !== null) return auth;
      // R21-4.2:codex 恒不进入;只有 claude / pi 且通过 R21-6.5 准入
      if (e.agent === 'codex') return 'codex_not_participating';
      if (!e.admitted) return 'not_admitted';
      return null;
    },
  }),
  row({
    name: 'deploy_removal_pending_to_none',
    dim: 'deploy',
    kind: 'removal_done',
    shape: 'deploy',
    lifecycle: 'rolling_back',
    from: 'removal_pending',
    to: 'none',
    caps: () => ['deploy_removal_pending'],
    reason: () => 'compensation_done',
    guard: (r, e) => {
      if (r.rollback === null || r.rollback.phase !== 'rollback_complete')
        return 'rollback_not_complete';
      return e.criterion_met ? null : 'removal_criterion_not_met';
    },
  }),
);

// --- 维度三:rollback.phase 顺序推进(四段,只前进一步) ---
for (let i = 0; i < RSI_ROLLBACK_PHASES.length - 1; i++) {
  const from = RSI_ROLLBACK_PHASES[i] as RollbackPhase;
  const to = RSI_ROLLBACK_PHASES[i + 1] as RollbackPhase;
  ROW_LIST.push(
    row({
      name: `rollback_${from}_to_${to}`,
      dim: 'rollback',
      kind: 'rollback_advance',
      shape: 'rollback_phase',
      lifecycle: 'rolling_back',
      from,
      to,
      applies: (e) => e.to === to,
      caps: () => ['rollback_four_phase'],
      reason: (_e, r) => r.rollback?.reason ?? 'invalid_rollback',
      guard: (_r, e) => (e.current_completed ? null : 'phase_not_completed'),
    }),
  );
}

export const TRANSITION_TABLE: readonly TransitionRow[] = Object.freeze(ROW_LIST);

/** 本期**没有任何行**的个人生命周期状态:收到任何事件一律 `phase_not_available`(表外 = 默认拒绝) */
export const UNIMPLEMENTED_LIFECYCLES: ReadonlySet<RsiLifecycleState> = new Set<RsiLifecycleState>([
  'blocked',
  'adopted',
  'stable',
  'retiring',
]);
export const TERMINAL_LIFECYCLES: ReadonlySet<RsiLifecycleState> = new Set<RsiLifecycleState>([
  'rejected',
  'expired',
  'rolled_back',
  'retired',
]);

export function rowsOfKind(kind: EventKind): readonly TransitionRow[] {
  return TRANSITION_TABLE.filter((r) => r.kind === kind);
}
