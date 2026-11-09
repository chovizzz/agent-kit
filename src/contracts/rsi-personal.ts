/**
 * §21 个人层 schema(docs/contracts.md §21.3 / §21.4 / §21.6 / §21.9 / §21.10 / §21.12 与 §21.24 W0-1 … W0-12)。
 * W0 只落 schema 与示例(`test/contracts/registry.ts` 登记);**没有任何自动路径调用**——对应能力按 {@link RSI_CAPABILITY_PHASE} 到期前不存在。
 * 全部 `strictObject`:旧版读到未知键 → 校验失败(调用方按 `candidate_invalid` / `ledger_line_invalid` / `txn_invalid` 等 fail-closed 处理)。
 * 常量与枚举都在 `src/contracts/rsi.ts`(契约:不另起一份)。
 */
import { z } from 'zod';
import {
  IsoDateSchema,
  IsoTimestampSchema,
  RunIdSchema,
  SessionRefIdSchema,
  Sha256Schema,
} from './common.js';
import {
  RSI_AUDIT_KINDS,
  RSI_BOOTSTRAP_PHASES,
  RSI_CANDIDATE_CATEGORIES,
  RSI_CANARY_INJECT_MAX_BYTES,
  RSI_COMMIT_KINDS,
  RSI_COMMIT_PHASES,
  RSI_DEPLOY_STATES,
  RSI_GATE_REASONS,
  RSI_LEDGER_ARMS,
  RSI_LEDGER_EXCLUDED_REASONS,
  RSI_LIFECYCLE_STATES,
  RSI_REVOCATION_BY,
  RSI_ROLLBACK_PHASES,
  RSI_SIGNATURE_MAX_TOKENS,
  RSI_TARGET_TERMINALS,
  RSI_TERMINAL_REASONS,
  RSI_TRANSITIONS_MAX,
  RSI_TRANSITION_REASONS_NORMAL,
  RSI_TRANSITION_REASONS_TERMINATING,
  RSI_WATCH_RESULTS,
  RSI_ADMISSION_FAIL_REASONS,
  RSI_ADMISSION_STATES,
  RsiAgentSchema,
  RsiCandidateIdSchema,
  RsiMarkerSchema,
  rsiG0Reasons,
  type RsiLifecycleState,
} from './rsi.js';

const NonNegInt = z.number().int().nonnegative();
const Hex = (n: number): z.ZodString => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`));
const GitSha = Hex(40);
const Prob = z.number().min(0).max(1);
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/** 灰度只有 claude 与 pi 参与(R21-6.1) */
const GroupAgentSchema = z.enum(['claude', 'pi']);

// --- 枚举 schema ---
const LifecycleSchema = z.enum(RSI_LIFECYCLE_STATES);
const DeploySchema = z.enum(RSI_DEPLOY_STATES);
const TerminalReasonSchema = z.enum(RSI_TERMINAL_REASONS);
const TargetTerminalSchema = z.enum(RSI_TARGET_TERMINALS);

const TRANSITION_REASON_SET: ReadonlySet<string> = new Set<string>([
  ...RSI_TRANSITION_REASONS_NORMAL,
  ...RSI_TRANSITION_REASONS_TERMINATING,
  ...RSI_GATE_REASONS,
  ...rsiG0Reasons(),
]);
/** 转移原因码:封闭集合(R21-4.6 + R21-5.1 + N4-2) */
export const RsiTransitionReasonSchema = z
  .string()
  .refine((r) => TRANSITION_REASON_SET.has(r), '不是封闭枚举内的转移原因码');

// --- R21-3.7 PersonalLifecycleRecord ---
const DeployMapSchema = z.strictObject({
  claude: DeploySchema,
  pi: DeploySchema,
  codex: DeploySchema,
});
const WatchEntrySchema = z
  .strictObject({
    phase: z.enum(['pre', 'post']),
    started_at_session: NonNegInt,
    pre_sessions: NonNegInt,
    post_sessions: NonNegInt,
    result: z.enum(RSI_WATCH_RESULTS),
  })
  .nullable();
const TransitionSchema = z.strictObject({
  dim: z.enum(['lifecycle', 'deploy', 'rollback']),
  agent: RsiAgentSchema.optional(),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  at: IsoTimestampSchema,
  reason: RsiTransitionReasonSchema,
  idem_key: Hex(16),
});
/** W0-2:候选签名(来源聚类的机械判据;与 `AtomFrontmatter.signature` 无关) */
export const RsiClusterSignatureSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tool'),
    tool_name: z.string().min(1).max(128),
    tool_error_class: z.string().min(1).max(64).optional(),
  }),
  z.strictObject({
    kind: z.literal('lesson'),
    rep_tokens: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(RSI_SIGNATURE_MAX_TOKENS)
      .refine((a) => a.every((x, i) => i === 0 || (a[i - 1] as string) < x), '升序且不重复'),
  }),
]);

/** R21-4.3 合法组合矩阵:`lifecycle` × 三 agent 的 `deploy`;非法一律拒绝(`candidate_invalid`) */
export function deployMatrixViolation(
  lifecycle: RsiLifecycleState,
  deploy: Readonly<Record<'claude' | 'pi' | 'codex', string>>,
): string | null {
  const vals = [deploy.claude, deploy.pi, deploy.codex];
  switch (lifecycle) {
    case 'proposed':
    case 'shadow':
    case 'blocked':
    case 'rejected':
    case 'expired':
    case 'rolled_back':
    case 'retired':
      return vals.every((v) => v === 'none') ? null : `${lifecycle} 要求三个 agent 全为 none`;
    case 'canary':
    case 'adopted':
      if (deploy.codex !== 'none') return `${lifecycle} 下 codex 恒为 none`;
      return vals.every((v) => v === 'none' || v === 'injected')
        ? null
        : `${lifecycle} 只允许 none | injected`;
    case 'stable':
      return null; // 六个取值全部合法(DeploySchema 已限定集合)
    case 'rolling_back':
    case 'retiring':
      return vals.every((v) => v === 'none' || v === 'removal_pending')
        ? null
        : `${lifecycle} 只允许 none | removal_pending`;
  }
}

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  'rejected',
  'expired',
  'rolled_back',
  'retired',
]);

export const PersonalLifecycleRecordSchema = z
  .strictObject({
    schema_version: z.literal(1),
    id: RsiCandidateIdSchema,
    category: z.enum(RSI_CANDIDATE_CATEGORIES),
    lifecycle: LifecycleSchema,
    deploy: DeployMapSchema,
    watch: z.strictObject({
      claude: WatchEntrySchema,
      pi: WatchEntrySchema,
      codex: WatchEntrySchema,
    }),
    rollback: z
      .strictObject({
        phase: z.enum(RSI_ROLLBACK_PHASES),
        reason: RsiTransitionReasonSchema,
        target_terminal: TargetTerminalSchema,
      })
      .nullable(),
    target_paths: z.array(z.string().min(1).max(256)).min(1).max(4),
    content_sha256: Sha256Schema,
    fp_hmac: Hex(16),
    cluster_id: z.string().min(1).max(128),
    case_set_sha256: Sha256Schema.nullable(),
    blocked_from: LifecycleSchema.nullable(),
    transitions: z.array(TransitionSchema).max(RSI_TRANSITIONS_MAX),
    transitions_dropped: NonNegInt,
    terminal_reason: TerminalReasonSchema.nullable(),
    overlaps_preset: z.boolean(),
    /** N4-2(R20-18.33):候选 ↔ 暂存提案关联;缺失 = null = 不消费不展示;创建时写入、之后不可变 */
    source_proposal: z
      .strictObject({ run_id: RunIdSchema, proposal_id: z.string().min(1).max(128) })
      .nullable()
      .optional(),
    /** W0-2:创建时写入、之后不可变;缺失 = 旧版记录(不参与 G6 / shadow) */
    cluster_signature: RsiClusterSignatureSchema.optional(),
  })
  .superRefine((r, ctx) => {
    const v = deployMatrixViolation(r.lifecycle, r.deploy);
    if (v !== null) ctx.addIssue({ code: 'custom', path: ['deploy'], message: v });
    if ((r.lifecycle === 'rolling_back' || r.lifecycle === 'retiring') && r.rollback === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['rollback'],
        message: `${r.lifecycle} 必须带 rollback 记录`,
      });
    }
    if ((r.blocked_from !== null) !== (r.lifecycle === 'blocked')) {
      ctx.addIssue({
        code: 'custom',
        path: ['blocked_from'],
        message: '仅 blocked 状态带 blocked_from',
      });
    }
    if (TERMINAL_STATES.has(r.lifecycle) && r.terminal_reason === null) {
      ctx.addIssue({ code: 'custom', path: ['terminal_reason'], message: '终态必须带终态理由' });
    }
    if (!TERMINAL_STATES.has(r.lifecycle) && r.terminal_reason !== null) {
      ctx.addIssue({ code: 'custom', path: ['terminal_reason'], message: '非终态不得带终态理由' });
    }
  });
export type PersonalLifecycleRecord = z.infer<typeof PersonalLifecycleRecordSchema>;

// --- R21-3.6a / W0-5 提交 journal ---
export const PersonalCommitJournalSchema = z
  .strictObject({
    schema_version: z.literal(1),
    txn_id: Hex(16),
    kind: z.enum(RSI_COMMIT_KINDS),
    candidate_ids: z.array(RsiCandidateIdSchema).max(64),
    ref: z.literal('refs/heads/rsi'),
    old_head: GitSha.nullable(),
    target_tree: GitSha,
    new_commit: GitSha.nullable(),
    phase: z.enum([...new Set([...RSI_COMMIT_PHASES, ...RSI_BOOTSTRAP_PHASES])] as [
      string,
      ...string[],
    ]),
    at: IsoTimestampSchema,
  })
  .superRefine((j, ctx) => {
    const boot = j.kind === 'bootstrap';
    const phases: readonly string[] = boot ? RSI_BOOTSTRAP_PHASES : RSI_COMMIT_PHASES;
    if (!phases.includes(j.phase)) {
      ctx.addIssue({
        code: 'custom',
        path: ['phase'],
        message: `${j.kind} 的 phase 不在其状态机内`,
      });
    }
    if (boot && j.old_head !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['old_head'],
        message: 'bootstrap 无旧引用(old_head 必须为 null)',
      });
    }
    if (!boot && j.old_head === null) {
      ctx.addIssue({ code: 'custom', path: ['old_head'], message: '非 bootstrap 必须带 old_head' });
    }
    // 提交对象在 `objects_written`(commit-tree)时已存在;bootstrap 在 `committed` 起已存在:此后的 journal 必须能指明它
    const needsCommit = boot
      ? j.phase === 'committed' || j.phase === 'recorded'
      : j.phase !== 'planned';
    if (needsCommit && j.new_commit === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['new_commit'],
        message: `${j.kind} 的 ${j.phase} 阶段必须带 new_commit`,
      });
    }
  });
export type PersonalCommitJournal = z.infer<typeof PersonalCommitJournalSchema>;

/** `rsi-personal/head.json`(R21-3.2) */
export const PersonalHeadSchema = z.strictObject({
  schema_version: z.literal(1),
  head: GitSha,
  owner_repo_fp: Hex(16),
});
export type PersonalHead = z.infer<typeof PersonalHeadSchema>;

/** `rsi-personal/txn/<id>.json`(R21-9.1;字段由 W0-7 补定) */
export const PersonalTxnSchema = z.strictObject({
  schema_version: z.literal(1),
  txn_id: Hex(16),
  candidate_id: RsiCandidateIdSchema,
  kind: z.enum(['rollback', 'clear', 'reconcile', 'identity_change']),
  reason: RsiTransitionReasonSchema,
  target_terminal: TargetTerminalSchema,
  phase: z.enum(RSI_ROLLBACK_PHASES),
  identity12: Hex(12).nullable(),
  at: IsoTimestampSchema,
});
export type PersonalTxn = z.infer<typeof PersonalTxnSchema>;

/** `rsi-personal/revocations.jsonl` 的一行(R21-9.5) */
export const RsiRevocationLineSchema = z.strictObject({
  at: IsoTimestampSchema,
  candidate_id: RsiCandidateIdSchema,
  content_sha256: Sha256Schema,
  identity12: Hex(12).nullable(),
  reason: RsiTransitionReasonSchema,
  by: z.enum(RSI_REVOCATION_BY),
});
export type RsiRevocationLine = z.infer<typeof RsiRevocationLineSchema>;

// --- R21-6.4 分组账 ---
const AssignLineSchema = z
  .strictObject({
    kind: z.literal('assign'),
    at: IsoTimestampSchema,
    agent: GroupAgentSchema,
    marker: RsiMarkerSchema.nullable(),
    candidate_id: RsiCandidateIdSchema.nullable(),
    arm: z.enum(RSI_LEDGER_ARMS),
    reason: z.enum(RSI_LEDGER_EXCLUDED_REASONS).nullable(),
    p: Prob,
    background_fp: Hex(16),
    background_fp_ex: Hex(16),
    policy_fp: Sha256Schema,
    case_set_sha256: Sha256Schema.nullable(),
    overlaps_preset: z.boolean(),
    hint_version: NonNegInt,
  })
  .superRefine((l, ctx) => {
    const bad = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (l.arm === 'excluded') {
      if (l.reason === null) return bad('reason', 'excluded 必须带原因码');
      if (l.p !== 0) bad('p', 'excluded 的 p 恒为 0');
      const probe = l.reason === 'admission_probe';
      // W0-3:探针行是唯一「marker 非空且 candidate_id 为 null」的情形,反之亦然
      if (probe !== (l.marker !== null && l.candidate_id === null)) {
        bad('marker', 'admission_probe 行 ⇔ marker 非空且 candidate_id 为 null');
      }
      if (!probe && (l.marker !== null || l.candidate_id === null)) {
        bad('marker', '非探针的 excluded 行:marker 为 null、candidate_id 非空(未输出标记)');
      }
    } else {
      if (l.reason !== null) bad('reason', 'treat / control 的 reason 为 null');
      if (l.marker === null || l.candidate_id === null)
        bad('marker', 'treat / control 必须带 marker 与 candidate_id');
      if (l.p <= 0) bad('p', 'treat / control 的 p > 0');
    }
  });
const StopLineSchema = z
  .strictObject({
    kind: z.literal('stop'),
    at: IsoTimestampSchema,
    candidate_id: RsiCandidateIdSchema,
    reason: RsiTransitionReasonSchema,
    revocation_ref: Hex(16).nullable(),
  })
  .superRefine((l, ctx) => {
    const reconciled = l.reason === 'revocation_reconciled';
    if (reconciled !== (l.revocation_ref !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['revocation_ref'],
        message: 'reason=revocation_reconciled ⇔ revocation_ref 必填(对账行),普通 stop 行为 null',
      });
    }
  });
export const RsiCanaryLedgerLineSchema = z.discriminatedUnion('kind', [
  AssignLineSchema,
  StopLineSchema,
]);
export type RsiCanaryLedgerLine = z.infer<typeof RsiCanaryLedgerLineSchema>;

/** `.state/rsi/canary.json`(R21-6.10,十一键) */
export const CanaryDocSchema = z.strictObject({
  candidate_id: RsiCandidateIdSchema,
  content_sha256: Sha256Schema,
  body: z
    .string()
    .min(1)
    .refine((s) => byteLen(s) <= RSI_CANARY_INJECT_MAX_BYTES, '正文超过注入上限'),
  content_sha12: Hex(12),
  p_by_agent: z.strictObject({ claude: Prob.optional(), pi: Prob.optional() }),
  agents_inject: z.array(GroupAgentSchema).max(2),
  background_fp: Hex(16),
  background_fp_ex: Hex(16),
  policy_fp: Sha256Schema,
  revocation_gen: NonNegInt,
  generation: NonNegInt,
});
export type CanaryDoc = z.infer<typeof CanaryDocSchema>;

/** `.state/rsi/canary-admission.json`(W0-3;唯一写入方 worker) */
const AdmissionEntrySchema = z
  .strictObject({
    state: z.enum(RSI_ADMISSION_STATES),
    shape_version: z.string().min(1).max(64),
    agent_version: z.string().min(1).max(64).nullable(),
    /** 探针代数:worker 每次重新 armed 加 1;票号 `<generation>-<i>`(i = 1..tickets),旧代的票作废 */
    generation: NonNegInt,
    armed_at: IsoTimestampSchema,
    probe_expires_at: IsoTimestampSchema,
    tickets: NonNegInt,
    decided_at: IsoTimestampSchema.nullable(),
    reason: z.enum(RSI_ADMISSION_FAIL_REASONS).nullable(),
  })
  .superRefine((e, ctx) => {
    const bad = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if ((e.state === 'probing') !== (e.decided_at === null))
      bad('decided_at', '仅 probing 的 decided_at 为 null');
    if ((e.state === 'failed') !== (e.reason !== null)) bad('reason', '仅 failed 带原因');
  });
export const CanaryAdmissionSchema = z.strictObject({
  schema_version: z.literal(1),
  agents: z.strictObject({
    claude: AdmissionEntrySchema.optional(),
    pi: AdmissionEntrySchema.optional(),
  }),
});
export type CanaryAdmission = z.infer<typeof CanaryAdmissionSchema>;

// --- R21-3.8 工作副本 ---
export const CandidateWorkingCopySchema = z.strictObject({
  schema_version: z.literal(1),
  id: RsiCandidateIdSchema,
  cluster_signature: RsiClusterSignatureSchema,
  source: z.strictObject({ run_id: RunIdSchema, proposal_id: z.string().min(1).max(128) }),
  shadow: z.strictObject({
    sessions: NonNegInt,
    hits: NonNegInt,
    /** 展示缓存,不是授权(W0-1) */
    canary_ready_since: IsoDateSchema.nullable(),
    /** 因全局名额被占而排队的起算 UTC 日(`g7_queued`);相位未到的等待不计 */
    queued_since: IsoDateSchema.nullable(),
  }),
  evidence: z.strictObject({
    sessions: z.array(SessionRefIdSchema).max(256),
    days: z.array(IsoDateSchema).max(256),
  }),
  stats: z.strictObject({
    sessions_observed: NonNegInt,
    sessions_treat: NonNegInt,
    sessions_control: NonNegInt,
    bytes_injected: NonNegInt,
  }),
  repo_removal_deferred: z.boolean(),
});
export type CandidateWorkingCopy = z.infer<typeof CandidateWorkingCopySchema>;

// --- R21-12.10 审计 ---
export const RsiAuditLineSchema = z.strictObject({
  at: IsoTimestampSchema,
  kind: z.enum(RSI_AUDIT_KINDS),
  id: z.string().min(1).max(128),
  dim: z.enum(['lifecycle', 'deploy', 'rollback']).optional(),
  agent: RsiAgentSchema.optional(),
  from: z.string().min(1).max(64).optional(),
  to: z.string().min(1).max(64).optional(),
  reason: z.string().min(1).max(64).optional(),
  hashes: z.array(Hex(16)).max(16).optional(),
  counts: z.record(z.string().max(64), NonNegInt).optional(),
  seed: z
    .string()
    .regex(/^[0-9a-f]{8,64}$/)
    .optional(),
  exec: z
    .strictObject({
      started_at: IsoTimestampSchema,
      ended_at: IsoTimestampSchema,
      exit_code: z.number().int(),
      duration_ms: NonNegInt,
      cpu_ms: NonNegInt,
      max_rss_kib: NonNegInt,
      post_check: z.enum(['pass', 'undeclared_write', 'unchecked', 'error']),
    })
    .optional(),
});
export type RsiAuditLine = z.infer<typeof RsiAuditLineSchema>;

// --- R21-11.3 / R21-11.4 ---
export const RsiVetoDocSchema = z.strictObject({
  schema_version: z.literal(1),
  entries: z
    .array(
      z.strictObject({
        candidate_id: RsiCandidateIdSchema,
        fp_hmac: Hex(16),
        near_fp: z.array(Hex(8)).max(64),
        at: IsoTimestampSchema,
      }),
    )
    .max(1000),
});
export type RsiVetoDoc = z.infer<typeof RsiVetoDocSchema>;

export const RsiTombstonesSchema = z.strictObject({
  schema_version: z.literal(1),
  entries: z
    .array(
      z.strictObject({
        id: RsiCandidateIdSchema,
        terminal: z.enum(['rejected', 'expired', 'rolled_back', 'retired']),
        reason: TerminalReasonSchema,
        at: IsoTimestampSchema,
      }),
    )
    .max(5000)
    .refine((a) => new Set(a.map((e) => e.id)).size === a.length, 'id 不得重复'),
});
export type RsiTombstones = z.infer<typeof RsiTombstonesSchema>;
