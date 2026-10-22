/**
 * 顶层入口 runReflect:load → classify → cluster → evidence → prompt →(注入的 LlmBackend)→ validate → dedupe → merge → stage。
 * 纯库:时钟/后端/脱敏器/已有原子都由调用方注入;不读环境变量,不 import llm-exec 或 child_process。
 *
 * - 干跑(默认):不调用后端、不写任何文件,只返回计划与报告。
 * - 任何失败(后端失败/校验全拒/守卫红灯)只产生 report.json(写进新的运行目录),不改动、不删除其它任何东西。
 * - 调用次数:每个批次 1 次,不做重试;批数 > maxCalls 在第一次调用之前就中止。
 */
import { JudgeHopIdSchema } from '../contracts/proposal.js';
import { RunIdSchema } from '../contracts/common.js';
import type { AgentId } from '../contracts/common.js';
import type { Redactor } from '../contracts/redact.js';
import {
  MAX_PROPOSALS_PER_BATCH,
  ReflectRunReportSchema,
  type ReflectRunReport,
  type ReflectorProposalDraft,
} from '../contracts/reflect.js';
import { BUILTIN_VENDORS, VENDOR_ID_RE, UNKNOWN_VENDOR } from '../contracts/vendor.js';
import type { IoContext } from '../io/paths.js';
import { DEFAULT_ATOM_MAX_BYTES } from '../contracts/common.js';
import type { LlmBackend } from './backend-iface.js';
import { isRealCli, provenVendorOf } from './backend-identity.js';
import { classifySignals } from './classify.js';
import { buildClusters } from './cluster.js';
import {
  DEFAULT_DEDUPE,
  findDuplicate,
  type DedupeTarget,
  type DedupeThresholds,
} from './dedupe.js';
import {
  DEFAULT_MAX_EVIDENCE,
  buildEvidencePack,
  dropLastEvidence,
  splitPack,
  type EvidencePack,
} from './evidence.js';
import {
  windowBounds,
  buildMatcher,
  countWindow,
  loadWindowData,
} from '../lifecycle/attest-count.js';
import { loadSignals } from './load.js';
import { mergeProposals, type GuidanceBaseline, type ReflectorInfo } from './merge.js';
import { renderWithinBudget, type RenderedPrompt } from './prompt/v1.js';
import { filesOf, simulateGuards, writeReportOnly, writeStage } from './stage.js';
import { sha256Hex } from './text.js';
import {
  ReflectCallLimitError,
  ReflectFailClosedError,
  ReflectUsageError,
  type Cluster,
  type EvidenceItem,
  type ExistingAtomInfo,
  type LoadStats,
} from './types.js';
import {
  MAX_OUTPUT_BYTES,
  evidenceExcerptSuspicious,
  validateReflectorOutput,
} from './validate.js';

export const DEFAULT_MAX_CALLS = 1;
export const HARD_MAX_CALLS = 3;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_EVIDENCE_PER_PROMPT = 40;
const OWNER_RE = /^@[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

export interface RunDeps {
  io: IoContext;
  redactor: Pick<Redactor, 'pass2'>;
  clock: () => Date;
  /** dry 模式不需要;stub/llm 模式必须给 */
  backend?: LlmBackend | undefined;
  existingAtoms: readonly ExistingAtomInfo[];
  stagedAtoms?: readonly ExistingAtomInfo[] | undefined;
  /** 已占用的提案编号(仓库 proposals/ + 暂存区) */
  usedProposalIds?: ReadonlySet<string> | undefined;
  kitVersion?: string | undefined;
}

export interface RunOpts {
  mode?: 'dry' | 'stub' | 'llm' | undefined;
  runId: string;
  owner: string;
  since?: string | undefined;
  agents?: readonly AgentId[] | undefined;
  maxProposals?: number | undefined;
  maxCalls?: number | undefined;
  timeoutMs?: number | undefined;
  /** llm 模式必须为 true(摘录将离开本机) */
  allowEgress?: boolean | undefined;
  maxEvidence?: number | undefined;
  evidencePerPrompt?: number | undefined;
  atomMaxBytes?: number | undefined;
  /**
   * 团队层 project_key 白名单(语义见 MergeInput.teamProjectKeys):名单外的项目一律按个人处理。
   * 缺省(undefined)= 空白名单 = 全部按个人处理(fail-closed),不是「不设限」。
   */
  teamProjectKeys?: ReadonlySet<string> | undefined;
  dedupe?: Partial<DedupeThresholds> | undefined;
  /** 目标预算已满:不暂存 add 提案(调用方用 computeBudget 算) */
  budgetFull?: boolean | undefined;
  /** 在结果里带回完整提示(给 --show-prompt;不会落盘) */
  includePrompt?: boolean | undefined;
}

/** 各 project_key 的会话数/信号数(只有加盐哈希 id 与计数),供用户填 `team_project_keys` */
export interface ProjectCount {
  project_key: string;
  sessions: number;
  signals: number;
}

export interface RunPlan {
  signals_loaded: number;
  clusters: number;
  evidence: number;
  evidence_truncated: number;
  /** 缺结构字段被排除的旧信号数(全部被排除时运行结果会是 0 条,调用方应提示重采) */
  structure_unknown: number;
  batches: number;
  calls_needed: number;
  exceeds_call_limit: boolean;
}

export interface DuplicateRecord {
  draft_id: string;
  /** `duplicate_of:<id>` */
  note: string;
  reason: string;
  resurrects: boolean;
}

export interface RunResult {
  report: ReflectRunReport;
  /** 建议退出码:0 成功/干跑;1 输出被拒;4 后端不可用 */
  exitCode: 0 | 1 | 4;
  plan: RunPlan;
  load: LoadStats;
  /** 装载通过的信号按 project_key 汇总(按 key 升序) */
  projectCounts: ProjectCount[];
  prompts?: RenderedPrompt[];
  staged?: { dir: string; proposalIds: string[]; patchFiles: number };
  duplicates: DuplicateRecord[];
  observations: { kind: string; target_id: string; note: string }[];
  guardrailMentions: number;
  /** 后端失败原因(outcome=not_run 且非干跑时) */
  backendFailure?: string;
}

const bump = (r: Record<string, number>, k: string, n = 1): void => {
  if (n > 0) r[k] = (r[k] ?? 0) + n;
};

function checkOpts(
  deps: RunDeps,
  opts: RunOpts,
): { mode: 'dry' | 'stub' | 'llm'; maxCalls: number } {
  const mode = opts.mode ?? 'dry';
  if (!RunIdSchema.safeParse(opts.runId).success || opts.runId.toLowerCase() === 'cwd') {
    throw new ReflectUsageError('runId 不合法(或与保留目录 cwd 冲突)');
  }
  if (!OWNER_RE.test(opts.owner)) throw new ReflectUsageError('owner 必须形如 @handle');
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > HARD_MAX_CALLS) {
    throw new ReflectUsageError(`maxCalls 必须是 1..${HARD_MAX_CALLS}`);
  }
  if (mode === 'llm' && opts.allowEgress !== true) {
    throw new ReflectUsageError('llm 模式需要 allowEgress=true(摘录将离开本机)');
  }
  const per = opts.evidencePerPrompt ?? DEFAULT_EVIDENCE_PER_PROMPT;
  if (!Number.isInteger(per) || per < 5) throw new ReflectUsageError('evidencePerPrompt 至少 5');
  const b = deps.backend;
  if (b !== undefined && !backendVendorProvable(b)) {
    throw new ReflectFailClosedError(
      'REFLECT_VENDOR_UNKNOWN',
      '后端厂商无法确定,无法证明与裁判不同厂商',
    );
  }
  return { mode, maxCalls };
}

/**
 * 后端厂商必须可证明:id 形状合法且非 unknown;`cli` 必须是 claude|codex|pi|stub(缺失/非法 fail-closed);
 * 真实 CLI 的厂商须与后端自己的 `cli`+`provider`+`model` 复算一致(自报不算数);
 * 复算不出内置厂商时(覆盖层追加家族推出的非内置厂商)沿用原行为放行——它不可能与任何裁判构成「可证明不同厂商」。
 * `stub` 不复算,但产出的提案一律带 `reflector.stub: true`(CI 拒收,#24)。
 */
function backendVendorProvable(b: LlmBackend): boolean {
  if (typeof b.vendor !== 'string' || !VENDOR_ID_RE.test(b.vendor) || b.vendor === UNKNOWN_VENDOR) {
    return false;
  }
  if (b.cli === 'stub') return true;
  if (!isRealCli(b.cli)) return false;
  const proven = provenVendorOf(b);
  if (proven === b.vendor) return true;
  return proven === UNKNOWN_VENDOR && !BUILTIN_VENDORS.includes(b.vendor) && 'provider' in b;
}

function backendInfo(b: LlmBackend | undefined): ReflectRunReport['backend'] {
  if (b === undefined) return null;
  const slot = JudgeHopIdSchema.safeParse(b.slot);
  if (!slot.success)
    throw new ReflectFailClosedError('REFLECT_BACKEND_SLOT', '后端槽位不在固定枚举内');
  return { slot: slot.data, vendor: b.vendor, model: b.model };
}

/** project_key 的契约形状(signals/ids.ts):不是这个形状的值(被篡改的信号库)不进计数输出,免得原样打到终端 */
const PROJECT_KEY_SHAPE = /^p_[0-9a-f]{16}$/;

export function countByProject(
  signals: readonly { project_key: string; session_ref: string }[],
): ProjectCount[] {
  const m = new Map<string, { sessions: Set<string>; signals: number }>();
  for (const s of signals) {
    if (!PROJECT_KEY_SHAPE.test(s.project_key)) continue;
    const e = m.get(s.project_key) ?? { sessions: new Set<string>(), signals: 0 };
    e.sessions.add(s.session_ref);
    e.signals += 1;
    m.set(s.project_key, e);
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([project_key, e]) => ({ project_key, sessions: e.sessions.size, signals: e.signals }));
}

export async function runReflect(deps: RunDeps, opts: RunOpts): Promise<RunResult> {
  const { mode, maxCalls } = checkOpts(deps, opts);
  const backend = deps.backend;
  const backendRep = backendInfo(backend);
  const dryRun = mode === 'dry';

  // 1~4 装载、分类、聚类、证据包
  // 引导窗口 [since, until):until = 运行时钟,取一次;晚于它的信号不参与提案也不参与基线
  const until = deps.clock().toISOString();
  const loaded = await loadSignals(deps.io, deps.redactor, {
    since: opts.since,
    agents: opts.agents,
    until,
  });
  const clusters: Cluster[] = buildClusters(classifySignals(loaded.signals));
  // 个人层原子的标题不进提示(否则可能被改写进团队提案)
  const fullPack = buildEvidencePack(
    clusters,
    deps.existingAtoms.filter((a) => a.layer !== 'personal'),
    {
      maxEvidence: opts.maxEvidence ?? DEFAULT_MAX_EVIDENCE,
    },
  );
  const packs = splitPack(fullPack, opts.evidencePerPrompt ?? DEFAULT_EVIDENCE_PER_PROMPT);

  // 5 提示(整份复扫;命中 → 抛 REFLECT_PROMPT_RESIDUAL,由调用方转退出码 3)
  const rendered: { prompt: RenderedPrompt; pack: EvidencePack }[] = packs.map((p) =>
    renderWithinBudget(p, deps.redactor, dropLastEvidence),
  );
  const rejected: Record<string, number> = {};
  bump(rejected, 'load_structure_unknown', loaded.stats.structure_unknown);
  bump(rejected, 'load_filtered_future', loaded.stats.filtered_future);

  const plan: RunPlan = {
    signals_loaded: loaded.stats.loaded,
    clusters: clusters.length,
    evidence: fullPack.items.length,
    evidence_truncated: fullPack.truncated,
    structure_unknown: loaded.stats.structure_unknown,
    batches: rendered.length,
    calls_needed: rendered.length,
    exceeds_call_limit: rendered.length > maxCalls,
  };
  const promptBytes = rendered.reduce((n, r) => n + r.prompt.bytes, 0);
  const digest =
    rendered.length === 0
      ? null
      : rendered.length === 1
        ? (rendered[0] as (typeof rendered)[number]).prompt.input_digest
        : `sha256:${sha256Hex(rendered.map((r) => r.prompt.input_digest).join('\n'))}`;
  const promptSha =
    rendered.length === 0 ? null : (rendered[0] as (typeof rendered)[number]).prompt.prompt_sha256;

  const base = {
    run_id: opts.runId,
    mode,
    signals_loaded: loaded.stats.loaded,
    signals_dropped: {
      schema: loaded.stats.dropped_schema,
      residual: loaded.stats.dropped_residual,
      external_excerpt_forced: loaded.stats.external_excerpt_forced,
    },
    clusters: rendered.reduce((n, r) => n + r.pack.clusters.length, 0),
    evidence_sent: rendered.reduce((n, r) => n + r.pack.items.length, 0),
    prompt_bytes: promptBytes,
    prompt_sha256: promptSha,
    input_digest: digest,
    backend: backendRep,
    calls_limit: maxCalls,
  } as const;
  const finish = (
    partial: Pick<ReflectRunReport, 'calls_made' | 'outcome' | 'staged' | 'observations_n'>,
  ): ReflectRunReport =>
    ReflectRunReportSchema.parse({ ...base, rejected: { ...rejected }, ...partial });

  const common = {
    plan,
    load: loaded.stats,
    projectCounts: countByProject(loaded.signals),
    duplicates: [] as DuplicateRecord[],
    observations: [] as RunResult['observations'],
    guardrailMentions: 0,
    ...(opts.includePrompt === true ? { prompts: rendered.map((r) => r.prompt) } : {}),
  };

  if (dryRun) {
    return {
      ...common,
      exitCode: 0,
      report: finish({ calls_made: 0, outcome: 'not_run', staged: [], observations_n: 0 }),
    };
  }

  // 超限立即中止:第一次调用之前
  if (rendered.length > maxCalls) {
    throw new ReflectCallLimitError(`需要 ${rendered.length} 次调用,超过上限 ${maxCalls}`);
  }

  const fail = async (
    outcome: ReflectRunReport['outcome'],
    callsMade: number,
    exitCode: 1 | 4,
    extra: Partial<RunResult> = {},
  ): Promise<RunResult> => {
    const report = finish({ calls_made: callsMade, outcome, staged: [], observations_n: 0 });
    await writeReportOnly(deps.io, opts.runId, report);
    return { ...common, ...extra, exitCode, report };
  };

  if (backend === undefined) {
    bump(rejected, 'backend_not_configured');
    return fail('not_run', 0, 4, { backendFailure: 'not_configured' });
  }
  if (rendered.length === 0) {
    const report = finish({
      calls_made: 0,
      outcome: 'no_proposals',
      staged: [],
      observations_n: 0,
    });
    await writeReportOnly(deps.io, opts.runId, report);
    return { ...common, exitCode: 0, report };
  }

  // 6 调用 + 校验
  const existingTargets: DedupeTarget[] = [...deps.existingAtoms, ...(deps.stagedAtoms ?? [])].map(
    toTarget,
  );
  const existingIds = new Set(existingTargets.map((t) => t.id));
  const th: DedupeThresholds = { ...DEFAULT_DEDUPE, ...(opts.dedupe ?? {}) };
  const maxProposals = Math.min(
    opts.maxProposals ?? MAX_PROPOSALS_PER_BATCH,
    MAX_PROPOSALS_PER_BATCH,
  );
  const accepted: ReflectorProposalDraft[] = [];
  const acceptedTargets: DedupeTarget[] = [];
  const duplicates: DuplicateRecord[] = [];
  const observations: RunResult['observations'] = [];
  let guardrailMentions = 0;
  let callsMade = 0;
  let produced = 0; // LLM 实际给出的提案条数(用于区分 no_proposals 与全被拒)
  let batchRejected = false;
  let duplicateCount = 0;
  const aliasMap = new Map(fullPack.items.map((i) => [i.alias, i]));

  for (const r of rendered) {
    if (callsMade >= maxCalls) {
      throw new ReflectCallLimitError(`调用次数已达上限 ${maxCalls}`);
    }
    callsMade++;
    let res;
    try {
      res = await backend.complete({
        system: r.prompt.system,
        user: r.prompt.user,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch {
      res = { ok: false as const, reason: 'error' as const };
    }
    if (!res.ok) {
      bump(rejected, `backend_${res.reason}`);
      return fail('not_run', callsMade, 4, {
        backendFailure: res.reason,
        duplicates,
        observations,
      });
    }
    const v = validateReflectorOutput(res.text, {
      allowedAliases: new Set(r.pack.items.map((i) => i.alias)),
      excerpts: r.pack.items.map((i) => i.signal.excerpt_redacted),
      existingIds: new Set([...existingIds, ...accepted.map((a) => a.id)]),
      redactor: deps.redactor,
      atomMaxBytes: opts.atomMaxBytes ?? DEFAULT_ATOM_MAX_BYTES,
      maxProposals,
    });
    if (!v.ok) {
      bump(rejected, v.code);
      batchRejected = true;
      break;
    }
    guardrailMentions += v.guardrailMentions;
    for (const [k, n] of Object.entries(v.dropped)) bump(rejected, k, n);
    produced += v.proposals.length + Object.values(v.dropped).reduce((a, b) => a + b, 0);
    observations.push(...v.observations);
    for (const d of v.proposals) {
      // 被引用的证据摘录会被机械复制进原子/提案:带注入话术或不可见字符的证据不能被引用
      const cited = d.evidence.map((a) => aliasMap.get(a)?.signal.excerpt_redacted ?? '');
      if (cited.some((x) => evidenceExcerptSuspicious(x))) {
        bump(rejected, 'evidence_suspicious');
        continue;
      }
      const hit = findDuplicate(
        { id: d.id, do: d.do, why: d.why, signature: d.signature },
        [...existingTargets, ...acceptedTargets],
        th,
      );
      if (hit !== undefined) {
        bump(rejected, 'duplicate_of');
        duplicateCount++;
        duplicates.push({
          draft_id: d.id,
          note: `duplicate_of:${hit.duplicateOf}`,
          reason: hit.reason,
          resurrects: hit.resurrects,
        });
        continue;
      }
      if (accepted.length >= maxProposals) {
        bump(rejected, 'over_batch_limit');
        continue;
      }
      accepted.push(d);
      acceptedTargets.push({ id: d.id, do: d.do, why: d.why, signature: d.signature });
    }
  }
  const tail = { duplicates, observations, guardrailMentions };

  if (batchRejected) return fail('output_rejected', callsMade, 1, tail);
  if (accepted.length === 0) {
    // 全是与已有规则重复:LLM 合理地提了已存在的规则,不算输出被拒
    if (produced === 0 || produced === duplicateCount) {
      const report = finish({
        calls_made: callsMade,
        outcome: 'no_proposals',
        staged: [],
        observations_n: Math.min(observations.length, 10),
      });
      await writeReportOnly(deps.io, opts.runId, report);
      return { ...common, ...tail, exitCode: 0, report };
    }
    return fail('output_rejected', callsMade, 1, tail);
  }
  if (opts.budgetFull === true) {
    bump(rejected, 'budget_full', accepted.length);
    return fail('output_rejected', callsMade, 1, tail);
  }

  // 7 合并 + 模拟守卫
  const items: EvidenceItem[] = fullPack.items;
  const reflector: ReflectorInfo = {
    provider: backend.slot,
    vendor: backend.vendor,
    model: backend.model,
    run_id: opts.runId,
    backend: isRealCli(backend.cli) ? backend.cli : undefined,
    prompt_id: (rendered[0] as (typeof rendered)[number]).prompt.prompt_id,
    prompt_sha256: promptSha as string,
    input_digest: digest as string,
    kit_version: deps.kitVersion,
    stub: mode === 'stub' || backend.cli === 'stub',
  };
  // 基线读到窗口内的坏记录:不写残缺基线,整批作废(SignalStoreError 等读库损坏照常向上抛 → 退出 3)
  let guidance;
  try {
    guidance = await buildGuidance(deps.io, accepted, opts.since, until, opts.agents);
  } catch (e) {
    if (!(e instanceof ReflectFailClosedError) || e.code !== 'REFLECT_BASELINE_UNAVAILABLE')
      throw e;
    bump(rejected, 'baseline_unavailable');
    return fail('output_rejected', callsMade, 1, tail);
  }
  let merged;
  try {
    merged = mergeProposals({
      guidance,
      drafts: accepted,
      items,
      clusters,
      owner: opts.owner,
      now: deps.clock(),
      reflector,
      usedProposalIds: deps.usedProposalIds ?? new Set(),
      teamProjectKeys: opts.teamProjectKeys ?? new Set<string>(), // 缺省 = 空白名单(fail-closed)
    });
  } catch {
    bump(rejected, 'merge_failed');
    return fail('output_rejected', callsMade, 1, tail);
  }
  const files = filesOf(merged);
  const diags = simulateGuards(merged, files, {
    redactor: deps.redactor,
    atomMaxBytes: opts.atomMaxBytes ?? DEFAULT_ATOM_MAX_BYTES,
    existingAtomIds: existingIds,
  });
  if (diags.some((d) => d.severity === 'error')) {
    for (const d of diags)
      if (d.severity === 'error') bump(rejected, d.code.replace(/[^A-Za-z0-9_.-]/g, '_'));
    return fail('output_rejected', callsMade, 1, tail);
  }

  // 8 暂存
  const ids = merged.map((m) => m.proposalId);
  const report = finish({
    calls_made: callsMade,
    outcome: 'staged',
    staged: ids,
    observations_n: Math.min(observations.length, 10),
  });
  const w = await writeStage(deps.io, opts.runId, report, files);
  return {
    ...common,
    ...tail,
    exitCode: 0,
    report,
    staged: { dir: w.dir, proposalIds: ids, patchFiles: w.patchFiles },
  };
}

function toTarget(a: ExistingAtomInfo): DedupeTarget {
  return {
    id: a.id,
    do: a.do,
    why: a.why,
    status: a.status,
    signature:
      a.signatureType === undefined
        ? undefined
        : { type: a.signatureType, pattern: a.signaturePattern },
  };
}

/**
 * 引导窗口落账:基线 = 该提案规则签名在 [since, until) 的计数。
 * 一律复用 attest 的 `buildMatcher` / `countWindow` / `loadWindowData`(同口径,不另写匹配)。
 * `path` 型(attest 无法计数)与不可用匹配器:只写 sessions_total,曝光/命中记 0,不假装有预测信息;
 * `always` 型按 countWindow 原样(exposure = fired = sessions_total),是否可预测由 judge(K3)按签名类型决定。
 */
async function buildGuidance(
  io: IoContext,
  drafts: readonly ReflectorProposalDraft[],
  since: string | undefined,
  until: string,
  agents: readonly AgentId[] | undefined,
): Promise<{
  since: string | null;
  until: string;
  baselineOf(d: ReflectorProposalDraft): GuidanceBaseline;
}> {
  const fromMs = since === undefined ? 0 : windowBounds(since, since).fromMs;
  const toMs = Date.parse(until);
  const ag = agents ?? [];
  const data = await loadWindowData(io, fromMs, toMs, ag);
  if (data.droppedSchema > 0) {
    throw new ReflectFailClosedError(
      'REFLECT_BASELINE_UNAVAILABLE',
      '引导窗口内有不合 schema 的记录,基线不可信',
    );
  }
  const count = (matcher: Parameters<typeof countWindow>[0]['matcher']) =>
    countWindow({
      signals: data.signals,
      sessionStats: data.sessionStats,
      matcher,
      from: fromMs,
      to: toMs,
      agents: ag,
    });
  const byDraft = new Map<ReflectorProposalDraft, GuidanceBaseline>();
  for (const d of drafts) {
    const m = buildMatcher(d.signature);
    if (m.kind === 'match' || m.kind === 'always') {
      const c = count(m);
      byDraft.set(d, {
        sessions_total: c.sessions_total,
        exposure_sessions: c.exposure_sessions,
        fired: c.fired,
      });
    } else {
      byDraft.set(d, {
        sessions_total: count({ kind: 'always' }).sessions_total,
        exposure_sessions: 0,
        fired: 0,
      });
    }
  }
  return {
    since: since ?? null,
    until,
    baselineOf: (d) => byDraft.get(d) as GuidanceBaseline,
  };
}
