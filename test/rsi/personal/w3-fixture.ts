/**
 * W3 测试夹具:暂存提案 / 信号 / 草稿 / 全绿闸事实,以及步骤用的内存端口(与生产端口同一份契约:读失败抛错或 invalid,写失败抛错)。
 * **不调用被测闸与步骤**;期望值由测试自己手写。
 */
import { stringify } from 'yaml';
import { ProposalSchema } from '../../../src/contracts/proposal.js';
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
  RsiAuditLine,
  RsiRevocationLine,
} from '../../../src/contracts/rsi-personal.js';
import { PersonalLifecycleRecordSchema } from '../../../src/contracts/rsi-personal.js';
import type { Signal } from '../../../src/contracts/signal.js';
import type {
  AuthoritativeStore,
  FactsProvider,
  MarksStore,
  RecordRead,
  RepoRead,
  RevocationRead,
  StepEnv,
  WorkerMarks,
} from '../../../src/rsi/personal/candidate-ports.js';
import { buildDraft, type StagedProposal } from '../../../src/rsi/personal/candidate-source.js';
import type { StepDeps } from '../../../src/rsi/personal/candidate-step.js';
import type { CommitResult, TreeSpec } from '../../../src/rsi/personal/commit.js';
import type { CandidateDraft, GateFacts } from '../../../src/rsi/personal/gate-types.js';
import type { TransitionEffect } from '../../../src/rsi/personal/transition.js';
import type { PromoteBase } from '../../../src/rsi/personal/transition-table.js';

export const NOW = new Date('2026-11-10T12:00:00.000Z');
export const TODAY = '2026-11-10';
export const SHA = 'a'.repeat(64);

export const sigId = (n: number): string => `sig_${n.toString(16).padStart(16, '0')}`;
export const sessRef = (n: number): string => `s_${n.toString(16).padStart(16, '0')}`;

/** 失败的 Bash 工具信号(只填被测代码读的字段) */
export function toolSignal(
  n: number,
  day: string,
  session: number,
  over: Partial<Signal> = {},
): Signal {
  return {
    sig_id: sigId(n),
    session_ref: sessRef(session),
    project_key: 'proj',
    ts: `${day}T08:00:00Z`,
    type: 'tool_fail_retry',
    excerpt_redacted: `bash failed ${n}`,
    event_kind: 'tool_result_failed',
    tool_name: 'Bash',
    tool_error_class: 'not_found',
    ...over,
  } as unknown as Signal;
}

export const DEFAULT_SIGNALS: Signal[] = [
  toolSignal(1, '2026-11-01', 1),
  toolSignal(2, '2026-11-02', 2),
];

export const BODY = {
  do: '运行 pnpm test 前先确认依赖已经安装并且锁文件没有变化。',
  why: '缺少依赖时测试会以难以理解的方式失败。',
  verify: '检查命令退出码为零并且输出里没有模块缺失报错。',
};

export interface StagedOpts {
  atomId?: string;
  runId?: string;
  proposalId?: string;
  kind?: 'practice' | 'fact' | 'preference';
  volatility?: 'stable' | 'volatile';
  trigger?: string;
  layer?: 'personal' | 'team';
  op?: 'add' | 'edit';
  targets?: string[];
  body?: Partial<typeof BODY>;
  title?: string;
  signals?: Signal[];
}

export function staged(o: StagedOpts = {}): StagedProposal {
  const atomId = o.atomId ?? 'prefer-frozen-lockfile';
  const body = { ...BODY, ...o.body };
  const sigs = o.signals ?? DEFAULT_SIGNALS;
  const fm = {
    id: atomId,
    title: o.title ?? '安装依赖后再跑测试',
    layer: 'personal',
    strength: 'should',
    kind: o.kind ?? 'practice',
    volatility: o.volatility ?? 'stable',
    status: 'proposed',
    owner: '@me',
    created: '2026-11-05',
    review_by: '2027-02-05',
    evidence: sigs.map((s) => ({ type: 'trace', ref: s.sig_id, excerpt: s.excerpt_redacted })),
    verifier: { type: 'none' },
    signature: { type: 'tool', pattern: 'Bash' },
    origin: 'proposal/2026-11-05-001',
    ...(o.trigger !== undefined ? { trigger: o.trigger } : {}),
  };
  const ruleText = `---\n${stringify(fm, { lineWidth: 0, blockQuote: false })}---\n\n**做**:${body.do}\n**为什么**:${body.why}\n**怎么验**:${body.verify}\n`;
  const proposal = ProposalSchema.parse({
    id: o.proposalId ?? '2026-11-05-001',
    op: o.op ?? 'add',
    targets: o.targets ?? [atomId],
    layer: o.layer ?? 'personal',
    rationale: '同一类失败在多个会话里重复出现。',
    evidence: sigs.map((s) => ({
      sig: s.sig_id,
      project_key: s.project_key,
      excerpt: s.excerpt_redacted,
    })),
    budget_delta_bytes: 200,
    paired_retirements: [],
    cases: [],
    reflector: {
      provider: 'p',
      vendor: 'v',
      model: 'm',
      run_id: o.runId ?? 'run-20261105T000000Z-abc',
    },
  });
  return { runId: o.runId ?? 'run-20261105T000000Z-abc', proposal, ruleText };
}

export const fingerprint = (t: string): string =>
  Buffer.from(t).toString('hex').padEnd(16, '0').slice(0, 16);

export function draftOf(o: StagedOpts = {}): CandidateDraft {
  const r = buildDraft(staged(o), o.signals ?? DEFAULT_SIGNALS, { fingerprint });
  if (r.kind !== 'draft') throw new Error(`夹具草稿应成功:${r.reason}`);
  return r.draft;
}

/** 全绿的闸事实(逐项由测试改成红) */
export function goodFacts(draft: CandidateDraft = draftOf()): GateFacts {
  return {
    draft,
    evidence: DEFAULT_SIGNALS.map((s) => ({
      sig: s.sig_id,
      excerpt: s.excerpt_redacted,
      signal: {
        excerpt: s.excerpt_redacted,
        sessionRef: s.session_ref,
        day: s.ts.slice(0, 10),
        excluded: false,
        attribution: 'collecting' as const,
      },
    })),
    failureTriggerHits: 3,
    pass2Clean: true,
    existing: {
      atoms: [],
      presets: [],
      stableCandidates: [],
      frameworkIds: new Set(['agent-kit-rsi', 'commit-checklist']),
      safetyAtomIds: new Set(['no-secrets']),
      projectNames: ['secret-project'],
    },
    tombstoned: false,
    cooldownActive: false,
    budget: {
      renderLevelOk: true,
      profile: 'lite',
      pairedRetirement: false,
      targets: [
        {
          target: 'claude',
          unit: 'lines',
          total: 200,
          used: { rule: 0, pitfall: 0, skill: 0 },
          add: 3,
        },
        {
          target: 'pi',
          unit: 'bytes',
          total: 16384,
          used: { rule: 0, pitfall: 0, skill: 0 },
          add: 250,
        },
        {
          target: 'codex',
          unit: 'bytes',
          total: 16384,
          used: { rule: 0, pitfall: 0, skill: 0 },
          add: 250,
        },
      ],
    },
    replay: { hitSessions: 5, totalSessions: 20 },
    clusterBusy: false,
  };
}

/** 闸事实(不含 clusterBusy:那一项由步骤自己按权威记录计算) */
export function gateFactsNoBusy(
  draft: CandidateDraft = draftOf(),
  over: Partial<Omit<GateFacts, 'clusterBusy'>> = {},
): Omit<GateFacts, 'clusterBusy'> {
  const f: Partial<GateFacts> = { ...goodFacts(draft) };
  delete f.clusterBusy;
  return { ...(f as Omit<GateFacts, 'clusterBusy'>), ...over };
}

// ---------------------------------------------------------------------------
// 内存端口
// ---------------------------------------------------------------------------
let seq = 0;
export class MemStore implements AuthoritativeStore {
  records = new Map<string, PersonalLifecycleRecord>();
  files = new Map<string, string>();
  commits: TreeSpec[] = [];
  mode: RepoRead<never>['kind'] | 'ok' = 'ok';
  /** 让 `read(id)` 返回与 `readAll` 不同的状态(模拟权威记录在列表之后变了) */
  readOverride = new Map<string, PersonalLifecycleRecord>();
  readAllCount = 0;
  failCommit: CommitResult | null = null;
  throwOnCommit: Error | null = null;

  put(r: PersonalLifecycleRecord): void {
    this.records.set(r.id, PersonalLifecycleRecordSchema.parse(r));
  }
  private head = 'f'.repeat(40);
  async readAll(): Promise<RepoRead<PersonalLifecycleRecord[]>> {
    this.readAllCount++;
    if (this.mode === 'absent') return { kind: 'absent' };
    if (this.mode === 'deferred')
      return { kind: 'deferred', reason: 'personal_repo_diverged', why: 'x' };
    if (this.mode === 'invalid') return { kind: 'invalid', why: 'candidate_invalid' };
    return {
      kind: 'ok',
      head: this.head,
      value: [...this.records.values()].map((r) => structuredClone(r)),
    };
  }
  async read(id: string): Promise<RecordRead> {
    const all = await this.readAll();
    if (all.kind !== 'ok') return all;
    const r = this.readOverride.get(id) ?? this.records.get(id);
    return r === undefined
      ? { kind: 'missing', head: all.head }
      : { kind: 'ok', head: all.head, record: structuredClone(r) };
  }
  async commit(spec: TreeSpec): Promise<CommitResult> {
    if (this.throwOnCommit !== null) throw this.throwOnCommit;
    if (this.failCommit !== null) return this.failCommit;
    this.commits.push(spec);
    for (const f of spec.upserts) {
      this.files.set(f.path, f.content);
      const m = /^lifecycle\/(.+)\.json$/.exec(f.path);
      if (m !== null) this.put(JSON.parse(f.content) as PersonalLifecycleRecord);
    }
    seq++;
    this.head = seq.toString(16).padStart(40, '0');
    return { status: 'committed', commit: this.head, tree: 'e'.repeat(40) };
  }
}

export const REV = (id: string, reason = 'cleared', sha = SHA): RsiRevocationLine => ({
  at: '2026-11-10T11:00:00Z',
  candidate_id: id,
  content_sha256: sha,
  identity12: null,
  reason: reason as RsiRevocationLine['reason'],
  // W0-17:写入方须与原因相符(clear→cleared、veto→vetoed,其余为 worker)
  by: reason === 'cleared' ? 'clear' : reason === 'vetoed' ? 'veto' : 'worker',
});

export interface World3 {
  d: StepDeps;
  store: MemStore;
  working: Map<string, CandidateWorkingCopy>;
  audits: RsiAuditLine[];
  effects: TransitionEffect[];
  revs: { value: RevocationRead };
  env: StepEnv;
  marks: { value: WorkerMarks | null };
  stagedList: StagedProposal[];
  signals: Signal[];
  gateFacts: {
    fn: (rec: PersonalLifecycleRecord) => Promise<Omit<GateFacts, 'clusterBusy'> | null>;
  };
  promoteFacts: {
    fn: (
      rec: PersonalLifecycleRecord,
      wc: CandidateWorkingCopy,
    ) => Promise<Omit<PromoteBase, 'slot_occupied'> | null>;
  };
  now: { value: Date };
  effectsFail: { value: boolean };
  /** 工作副本写入失败(提交之后的落地失败)注入 */
  putFail: { error: Error | null };
}

export function promoteBaseFor(
  rec: PersonalLifecycleRecord,
  o: Partial<Omit<PromoteBase, 'slot_occupied'>> = {},
): Omit<PromoteBase, 'slot_occupied'> {
  return {
    config_valid: true,
    enabled: true,
    authorized: true,
    tainted: false,
    cooldown_active: false,
    tombstoned: false,
    blacklisted: false,
    evidence_valid: true,
    sessions: 25,
    hits: 3,
    current_content_sha256: rec.content_sha256,
    current_cluster_signature: rec.cluster_signature ?? null,
    ...o,
  };
}

export function world3(over: { phase?: number } = {}): World3 {
  const store = new MemStore();
  const working = new Map<string, CandidateWorkingCopy>();
  const audits: RsiAuditLine[] = [];
  const effects: TransitionEffect[] = [];
  const revs: { value: RevocationRead } = { value: { kind: 'ok', lines: [] } };
  const marks: { value: WorkerMarks | null } = {
    value: {
      enabled: true,
      paused: false,
      policyFp: 'p1',
      repoReachable: true,
      revocationCount: 0,
      resetGen: 0,
    },
  };
  const env: StepEnv = {
    phase: over.phase ?? 1,
    autoLoopEffective: true,
    autoPaused: false,
    marks: { enabled: true, paused: false, policyFp: 'p1', resetGen: 0 },
  };
  const now = { value: NOW };
  const effectsFail = { value: false };
  const putFail: { error: Error | null } = { error: null };
  const w: World3 = {
    store,
    working,
    audits,
    effects,
    revs,
    env,
    marks,
    stagedList: [],
    signals: DEFAULT_SIGNALS,
    gateFacts: { fn: async () => null },
    promoteFacts: { fn: async () => null },
    now,
    effectsFail,
    putFail,
    d: undefined as unknown as StepDeps,
  };
  const facts: FactsProvider = {
    gateFacts: (rec) => w.gateFacts.fn(rec),
    promoteFacts: (rec, wc) => w.promoteFacts.fn(rec, wc),
  };
  const markStore: MarksStore = {
    read: async () => marks.value,
    write: async (m) => void (marks.value = m),
  };
  w.d = {
    store,
    working: {
      list: async () => [...working.values()].map((x) => structuredClone(x)),
      put: async (c) => {
        if (putFail.error !== null) throw putFail.error;
        working.set(c.id, structuredClone(c));
      },
    },
    revocations: { read: async () => revs.value },
    audit: { append: async (l) => void audits.push(...l) },
    effects: {
      apply: async (e) => {
        if (effectsFail.value) throw new Error('effects down');
        effects.push(...e);
      },
    },
    env: { read: async () => env },
    now: () => now.value,
    staged: { list: async () => w.stagedList },
    signals: { getMany: async (s) => w.signals.filter((x) => s.includes(x.sig_id)) },
    presets: { presets: async () => [] },
    facts,
    marks: markStore,
    fingerprint,
    locks: { personal: { assertHeld: async () => undefined } },
  };
  return w;
}
