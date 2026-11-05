/**
 * `reflect --ingest - --digest <id> --agent <a> --owner @h` 的锁内流程(docs/contracts.md §20.16-3,R20-16.14 ~ R20-16.17;R20-A4)。
 * 会话 agent 把提案交回 kit:kit 做**全量校验**后才暂存(`.state/reflect/<run_id>/`,**不 apply**)。授权不是安全边界:能保证的只有「kit 不接受未经校验的提案」。
 *
 * 调用方(`commands/reflect.ts`)负责:参数、读 stdin(> 64KiB → `RSI_INGEST_TOO_LARGE`,不拿锁)、`openRsiIo`、取 `rsi/lock`。本函数在**持有 `rsi/lock`** 时按契约的 13 步执行,
 * 每步失败的去向写在注释里;第 6–12 步的任何拒绝 = 整批拒、**零暂存写入**(名额与 digest 的消费已持久化,不回滚)。
 *
 * 顺序要点(变异表钉死):名额(4)**先于**消费 digest(5)持久化;证据保持别名形态走完校验(9),合并器按别名机械解析、摘录取自信号库(10);
 * 严格批次(9)——`ok:false` 按 code 映射,`ok:true` 但任一 `dropped` 计数非零也整批拒;提交前最终复核(12)重读授权 / 状态并**重新执行项目归属判定**。
 */
import { randomBytes } from 'node:crypto';
import {
  RSI_INGEST_MAX_PROPOSALS,
  RSI_STAGING_MAX_BYTES,
  RSI_STAGING_MAX_RUNS,
  VALIDATOR_CODE_TO_REJECT,
  VALIDATOR_DROPPED_TO_REJECT,
  type RsiAgentId,
  type RsiIngestRejectReason,
} from '../contracts/rsi.js';
import { DEFAULT_ATOM_MAX_BYTES } from '../contracts/common.js';
import type { Redactor } from '../contracts/redact.js';
import { ReflectRunReportSchema, type ReflectorProposalDraft } from '../contracts/reflect.js';
import { UNKNOWN_VENDOR } from '../contracts/vendor.js';
import type { IoContext } from '../io/paths.js';
import { loadExistingAtoms, loadStagedAtoms, loadUsedProposalIds } from '../reflect/atoms-index.js';
import { DEFAULT_DEDUPE, findDuplicate, type DedupeTarget } from '../reflect/dedupe.js';
import { isEvidenceEligible } from '../reflect/evidence.js';
import { emptyStats, finalizeCandidates } from '../reflect/load.js';
import { mergeProposals, type MergedProposal, type ReflectorInfo } from '../reflect/merge.js';
import { toTarget } from '../reflect/run.js';
import { buildApplyPatch, filesOf, simulateGuards, writeStage } from '../reflect/stage.js';
import type { EvidenceItem, LoadedSignal } from '../reflect/types.js';
import {
  MAX_INGEST_OUTPUT_BYTES,
  checkReflectorShape,
  evidenceExcerptSuspicious,
  validateReflectorOutput,
} from '../reflect/validate.js';
import { KIT_VERSION } from '../contracts/meta.js';
import {
  createAttributor,
  defaultProbe,
  latestRoot,
  type AttributionProbe,
} from './attribution.js';
import {
  findDigest,
  removeDigestIfSame,
  withDigestsLock,
  type FoundDigest,
  type SlotDeps,
} from './digest-slots.js';
import { candidatesFromFiles, indexAndCounts, readConsistent } from './digest.js';
import { reserveIngestQuota, type QuotaDeps } from './ingest-quota.js';
import type { RsiConfigOn } from './config.js';
import { forbiddenPaths } from './output.js';
import type { RsiLockHandle } from './lock.js';
import { rsiRedactor } from './redactor.js';
import { utcToday } from './session.js';
import { factsKey, observeSessionFacts, stateGate } from './session-facts.js';
import { invalidateForFacts } from './session-invalidate.js';
import { commitUnderLockWith, recoverUnderLock } from './services/commit.js';
import { refreshStagedUnderLock } from './services/projections.js';
import type { ServiceHooks } from './services/staging.js';
import { resumeTaintWith } from './services/taint.js';
import { stagingUsage } from './staging-usage.js';
import { RsiFailClosedError, type RsiServiceCtx } from './types.js';

type Env = Readonly<Record<string, string | undefined>> | undefined;

export interface IngestInput {
  digestId: string;
  agent: RsiAgentId;
  owner: string;
  /** stdin 全文(调用方已确认 ≤ 64KiB) */
  raw: string;
}

export interface IngestDeps {
  io: IoContext;
  /** 调用方持有的 `rsi/lock`;本函数的每个写出口前都 `assertHeld()` */
  lock: RsiLockHandle;
  env: Env;
  now: () => Date;
  redactor?: Pick<Redactor, 'pass2'>;
  /** 覆盖层 `reflect.team_project_keys`(层判定沿用白名单,缺省全部 personal) */
  teamProjectKeys?: ReadonlySet<string>;
  kitVersion?: string;
  probe?: AttributionProbe;
  slots?: SlotDeps;
  quota?: QuotaDeps;
  serviceHooks?: ServiceHooks;
  randomHex?: (bytes: number) => string;
  /** 命名点:`ingest:after_quota`、`ingest:after_consume`、`ingest:after_validate`(第 9 步后)、`ingest:before_final`(第 12 步之前)、`ingest:before_write` */
  hooks?: { point?(name: string): Promise<void> | void };
}

export type IngestOutcome =
  | { kind: 'ok'; runId: string; proposals: string[] }
  | { kind: 'rejected'; reason: RsiIngestRejectReason }
  /** 退出 4 的几类(`RSI_NOT_RUN` / `RSI_SESSION_DENIED`)与退出 1 的 `RSI_STAGING_FULL` */
  | {
      kind: 'not_run';
      code: 'RSI_NOT_RUN' | 'RSI_SESSION_DENIED' | 'RSI_STAGING_FULL';
      reason: string;
      exit: 1 | 4;
    };

/** 第 3a 步预检与第 9 步全量校验共用的形状参数(同一份,防漂移) */
const INGEST_SHAPE_CTX = {
  atomMaxBytes: DEFAULT_ATOM_MAX_BYTES,
  maxProposals: RSI_INGEST_MAX_PROPOSALS,
  maxOutputBytes: MAX_INGEST_OUTPUT_BYTES,
} as const;
const OWNER_RE = /^@[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const rej = (reason: RsiIngestRejectReason): IngestOutcome => ({ kind: 'rejected', reason });
const notRun = (reason: string): IngestOutcome => ({
  kind: 'not_run',
  code: 'RSI_NOT_RUN',
  reason,
  exit: 4,
});
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function newRunId(now: Date, rnd: (bytes: number) => string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `run-${stamp}-${rnd(3)}`;
}

/** 验证:owner 形状(命令层用它在拿锁前做参数检查) */
export const ownerOk = (owner: string): boolean => OWNER_RE.test(owner);

/**
 * 第 7 步的归一化:证据元素是字符串(别名)原样保留;若是带 `alias` 字符串的对象,取别名、**丢弃其余全部字段**(包括 agent 自带的 `excerpt`)。
 * agent 提供的任何证据文本都不进入校验与合并——摘录只能由合并器从信号库复制(§16 / F5)。返回被丢弃的摘录数(只计数,不留文本)。
 */
function normalizeEvidence(doc: unknown): {
  text: string | null;
  /** agent 自带的证据摘录(别名 → 文本):**只用于计数后丢弃**,绝不进入校验与合并 */
  agentExcerpts: Map<string, string>;
} {
  const agentExcerpts = new Map<string, string>();
  if (!isRecord(doc) || !Array.isArray(doc['proposals'])) return { text: null, agentExcerpts };
  const proposals = (doc['proposals'] as unknown[]).map((p) => {
    if (!isRecord(p) || !Array.isArray(p['evidence'])) return p;
    const evidence = (p['evidence'] as unknown[]).map((e) => {
      if (isRecord(e) && typeof e['alias'] === 'string') {
        if (typeof e['excerpt'] === 'string') agentExcerpts.set(e['alias'], e['excerpt']);
        return e['alias'];
      }
      return e;
    });
    return { ...p, evidence };
  });
  return { text: JSON.stringify({ ...doc, proposals }), agentExcerpts };
}

/** 引用到的别名(只收字符串元素,形状不对的留给校验器拒) */
function referencedAliases(doc: unknown): string[] {
  if (!isRecord(doc) || !Array.isArray(doc['proposals'])) return [];
  const out = new Set<string>();
  for (const p of doc['proposals'] as unknown[]) {
    if (!isRecord(p) || !Array.isArray(p['evidence'])) continue;
    for (const e of p['evidence'] as unknown[]) if (typeof e === 'string') out.add(e);
  }
  return [...out].sort();
}

export async function runIngest(input: IngestInput, deps: IngestDeps): Promise<IngestOutcome> {
  const { io, lock } = deps;
  const point = async (n: string): Promise<void> => void (await deps.hooks?.point?.(n));
  const now = deps.now();
  const today = utcToday(now); // 本次调用取一次 UTC 今天
  const slotDeps = deps.slots ?? {};
  const agent = input.agent;

  // ---- 第 1 步:重读配置与会话授权;STOP / purge journal(拒绝路径零写入:先读后写) ----
  const f0 = await observeSessionFacts(io, deps.env, agent, today);
  const gate1 = stateGate(f0);
  if (gate1 !== null) return notRun(gate1);
  if (f0.config.status !== 'on' || f0.judgement === null) throw new RsiFailClosedError('internal');
  if (f0.judgement.kind === 'denied') {
    await invalidateForFacts(io, f0, agent, slotDeps); // 观察性作废(尽力)
    return { kind: 'not_run', code: 'RSI_SESSION_DENIED', reason: f0.judgement.reason, exit: 4 };
  }
  if (f0.journalPresent) return notRun('purge_pending');
  // 观察性作废(R20-16.12 ②,尽力):策略指纹变过的其它旧 digest 一并作废;目标 digest 由第 3 步用自己的子码处理(digest_policy_changed)
  await invalidateForFacts(io, f0, agent, slotDeps, input.digestId);

  // 锁内、建任何暂存内容之前:补完上一次中断的提交与 taint(同 reflect --run-llm 的 enterWriterLock)。它可能推进快照代次,所以之后重取事实作为本次的基线
  const sctx: RsiServiceCtx = { io, config: f0.config, now: deps.now };
  await recoverUnderLock(sctx, lock, deps.serviceHooks ?? {});
  await resumeTaintWith(sctx, lock, deps.serviceHooks ?? {});
  const f1 = await observeSessionFacts(io, deps.env, agent, today);
  const gate1b = stateGate(f1);
  if (gate1b !== null) return notRun(gate1b);
  if (f1.config.status !== 'on' || f1.judgement === null) throw new RsiFailClosedError('internal');
  if (f1.judgement.kind === 'denied') {
    return { kind: 'not_run', code: 'RSI_SESSION_DENIED', reason: f1.judgement.reason, exit: 4 };
  }
  if (f1.journalPresent) return notRun('purge_pending');
  const config: RsiConfigOn = f1.config;

  // ---- 第 2 步:暂存容量预检 ----
  const u0 = await stagingUsage(io);
  if (u0.runs >= RSI_STAGING_MAX_RUNS || u0.bytes >= RSI_STAGING_MAX_BYTES) {
    return { kind: 'not_run', code: 'RSI_STAGING_FULL', reason: 'staging_full', exit: 1 };
  }

  // ---- 第 3 步:持槽位锁读 digest ----
  const step3 = await withDigestsLock(
    io,
    async (dl): Promise<{ bad: RsiIngestRejectReason } | { found: FoundDigest }> => {
      const f = await findDigest(io, dl, input.digestId);
      if (f === null) return { bad: 'digest_invalid' };
      if (Date.parse(f.record.expires_at) <= now.getTime()) return { bad: 'digest_expired' };
      if (f.record.agent !== agent) {
        await removeDigestIfSame(io, dl, f, slotDeps);
        return { bad: 'digest_agent_mismatch' };
      }
      if (f.record.session_policy_fp !== f1.fp) {
        await removeDigestIfSame(io, dl, f, slotDeps);
        return { bad: 'digest_policy_changed' };
      }
      return { found: f };
    },
    slotDeps,
  );
  if ('bad' in step3) return rej(step3.bad);
  const found = step3.found;

  // ---- 第 3a 步(订正 #9):格式预检,**在预留名额之前**。JSON 对象 / 条数 / schema 与 digest、会话无关:格式不对不占名额、不消费 digest ----
  // 证据归一化(第 7 步的 agent 摘录丢弃)也在此做一次,第 6、7 步直接复用这里的 doc / norm,不重读
  let doc: unknown;
  try {
    doc = JSON.parse(input.raw.trim());
  } catch {
    doc = undefined;
  }
  if (
    isRecord(doc) &&
    Array.isArray(doc['proposals']) &&
    doc['proposals'].length > RSI_INGEST_MAX_PROPOSALS
  ) {
    return rej('too_many_proposals');
  }
  const norm = normalizeEvidence(doc);
  const text = norm.text ?? input.raw;
  const shape = checkReflectorShape(text, INGEST_SHAPE_CTX);
  if (!shape.ok) return rej(VALIDATOR_CODE_TO_REJECT[shape.code] ?? 'schema_invalid');

  // ---- 第 4 步:先预留名额(先于消费 digest 持久化) ----
  await point('ingest:before_quota');
  const q = await reserveIngestQuota(io, lock, agent, today, deps.quota ?? {});
  if (q === 'limited') return notRun('rate_limited'); // 不消费 digest
  await point('ingest:after_quota');

  // ---- 第 5 步:消费 digest(重读,digest_id 与 sha256 须仍与第 3 步一致) ----
  const consumed = await withDigestsLock(
    io,
    (dl) => removeDigestIfSame(io, dl, found, slotDeps),
    slotDeps,
  );
  await point('ingest:after_consume');
  if (consumed === 'gone') return rej('digest_invalid'); // 名额照计,不碰该槽位
  const record = found.record;

  // ---- 第 6 步:解析 stdin 与条数上限已在第 3a 步(名额之前)完成,doc / norm / text 直接使用 ----

  // ---- 第 7 步:证据只能是该 digest 的别名;agent 的摘录 / 证据文本一律丢弃 ----
  // norm.agentExcerpts 只记着「有多少条被丢弃」,下游不读它的内容
  const used = referencedAliases(norm.text === null ? doc : JSON.parse(norm.text));
  if (used.some((a) => !Object.hasOwn(record.aliases, a))) return rej('alias_unknown');

  // ---- 第 8 步:逐条复核每个被引用的 sig_id ----
  const redactor = deps.redactor ?? (await rsiRedactor(config));
  const rd = await readConsistent(io);
  const data = indexAndCounts(rd.files);
  const stats = emptyStats();
  const loaded = finalizeCandidates(candidatesFromFiles(rd.files, stats), redactor, stats);
  const bySig = new Map<string, LoadedSignal>(loaded.map((s) => [s.sig_id, s]));
  const probe = deps.probe ?? defaultProbe;
  const cited = new Map<string, LoadedSignal>();
  for (const alias of used) {
    const sig = bySig.get(record.aliases[alias] as string);
    if (sig === undefined || sig.project_key !== record.project_key || !isEvidenceEligible(sig)) {
      return rej('evidence_stale');
    }
    cited.set(alias, sig);
  }
  let rootDevIno0: { dev: number; ino: number } | null = null;
  if (used.length > 0) {
    const key = record.project_key;
    if (key === null) return rej('attribution_unknown');
    const att = await createAttributor({ config, probe, ...data });
    const cls = await att.classify(key);
    if (cls === 'X') return rej('project_excluded');
    if (cls === 'U') return rej('attribution_unknown');
    const entry = data.index?.entries.find((e) => e.key === key);
    if (entry === undefined) return rej('attribution_unknown');
    rootDevIno0 = await probe.devIno(latestRoot(entry.roots).path);
  }

  // ---- 第 9 步:validateReflectorOutput 全量校验(64KiB),严格批次 ----
  const existingAtoms = await loadExistingAtoms(io);
  const stagedAtoms = await loadStagedAtoms(io);
  const usedProposalIds = await loadUsedProposalIds(io);
  const existingTargets: DedupeTarget[] = [...existingAtoms, ...stagedAtoms].map(toTarget);
  const existingIds = new Set(existingTargets.map((t) => t.id));
  const v = validateReflectorOutput(text, {
    allowedAliases: new Set(Object.keys(record.aliases)),
    excerpts: Object.values(record.aliases)
      .map((sid) => bySig.get(sid)?.excerpt_redacted)
      .filter((x): x is string => typeof x === 'string' && x !== ''),
    existingIds,
    redactor,
    ...INGEST_SHAPE_CTX,
  });
  if (!v.ok) return rej(VALIDATOR_CODE_TO_REJECT[v.code] ?? 'schema_invalid');
  // 严格批次:任一 dropped 计数非零 → 整批拒,子码取首个非零类别(按类别名字典序)。LLM 路径的单条丢弃行为不变
  const droppedKinds = Object.entries(v.dropped)
    .filter(([, n]) => n > 0)
    .map(([k]) => k)
    .sort();
  if (droppedKinds.length > 0) {
    return rej(VALIDATOR_DROPPED_TO_REJECT[droppedKinds[0] as string] ?? 'schema_invalid');
  }
  const drafts: ReflectorProposalDraft[] = v.proposals;
  if (drafts.length === 0) return rej('schema_invalid');
  await point('ingest:after_validate');

  // ---- 第 10 步:合并(按别名机械解析,摘录取自信号库)、查重、路径守卫模拟 ----
  for (const d of drafts) {
    for (const a of d.evidence) {
      const s = cited.get(a);
      if (s === undefined || evidenceExcerptSuspicious(s.excerpt_redacted)) {
        return rej('injection_suspected_local');
      }
    }
  }
  const acceptedTargets: DedupeTarget[] = [];
  for (const d of drafts) {
    const t: DedupeTarget = { id: d.id, do: d.do, why: d.why, signature: d.signature };
    if (findDuplicate(t, [...existingTargets, ...acceptedTargets], DEFAULT_DEDUPE) !== undefined) {
      return rej('duplicate');
    }
    acceptedTargets.push(t);
  }
  const runId = newRunId(
    now,
    deps.randomHex ?? ((n: number): string => randomBytes(n).toString('hex')),
  );
  const items: EvidenceItem[] = [...cited.entries()].map(([alias, sig]) => ({
    alias,
    signal: { ...sig, excerpt_redacted: sig.excerpt_redacted }, // 摘录 = 信号库原文(§16);agent 给的一律不用
    clusterId: '',
    projectAlias: 'P1',
  }));
  const reflector: ReflectorInfo = {
    provider: 'session',
    vendor: UNKNOWN_VENDOR,
    model: 'undeclared',
    run_id: runId,
    backend: agent,
    input_digest: `sha256:${found.sha256}`,
    kit_version: deps.kitVersion ?? KIT_VERSION,
    stub: false,
    provenance: 'session_declared',
  };
  let merged: MergedProposal[];
  try {
    merged = mergeProposals({
      drafts,
      items,
      clusters: [],
      owner: input.owner,
      now,
      reflector,
      usedProposalIds,
      teamProjectKeys: deps.teamProjectKeys ?? new Set<string>(),
    });
  } catch {
    return rej('schema_invalid');
  }
  const files = filesOf(merged);
  const diags = simulateGuards(merged, files, {
    redactor,
    atomMaxBytes: DEFAULT_ATOM_MAX_BYTES,
    existingAtomIds: existingIds,
  });
  if (diags.some((d) => d.severity === 'error')) return rej('path_guard');

  // ---- 第 11 步:完整暂存产物(内存)复扫 + 容量终检 ----
  const ids = merged.map((m) => m.proposalId);
  const report = ReflectRunReportSchema.parse({
    run_id: runId,
    mode: 'ingest',
    signals_loaded: stats.loaded,
    signals_dropped: {
      schema: stats.dropped_schema,
      residual: stats.dropped_residual,
      external_excerpt_forced: stats.external_excerpt_forced,
    },
    clusters: 0,
    evidence_sent: Object.keys(record.aliases).length,
    prompt_bytes: 0,
    prompt_sha256: null,
    input_digest: reflector.input_digest,
    backend: null,
    calls_made: 0,
    calls_limit: 1,
    outcome: 'staged',
    rejected: {},
    staged: ids,
    observations_n: 0,
  });
  const patchFiles = files.filter((f) => f.inPatch);
  const artifacts = [
    ...files.map((f) => f.content),
    ...(patchFiles.length > 0 ? [buildApplyPatch(patchFiles)] : []),
    `${JSON.stringify(report, null, 2)}\n`,
  ];
  const forbidden = await forbiddenPaths(deps.env, [io.stateDir, io.repoRoot, config.repo]);
  for (const a of artifacts) {
    let clean = false;
    try {
      clean = redactor.pass2(a).clean;
    } catch {
      clean = false;
    }
    const leaked = forbidden.some(
      (f) => f.length > 1 && (a.includes(f) || a.includes(JSON.stringify(f).slice(1, -1))),
    );
    if (!clean || leaked) return rej('rescan_hit');
  }
  const u1 = await stagingUsage(io);
  const newBytes = artifacts.reduce((n, a) => n + Buffer.byteLength(a, 'utf8'), 0);
  if (u1.runs + 1 > RSI_STAGING_MAX_RUNS || u1.bytes + newBytes > RSI_STAGING_MAX_BYTES) {
    return { kind: 'not_run', code: 'RSI_STAGING_FULL', reason: 'staging_full', exit: 1 };
  }

  // ---- 第 12 步:提交前最终复核(重读授权 / 状态,重新执行项目归属判定) ----
  await point('ingest:before_final');
  const f2 = await observeSessionFacts(io, deps.env, agent, today);
  const rd2 = await readConsistent(io);
  let sameProject = true;
  if (used.length > 0 && record.project_key !== null && f2.config.status === 'on') {
    const data2 = indexAndCounts(rd2.files);
    const att2 = await createAttributor({ config: f2.config, probe, ...data2 });
    const cls2 = await att2.classify(record.project_key);
    const entry2 = data2.index?.entries.find((e) => e.key === record.project_key);
    const di2 = entry2 === undefined ? null : await probe.devIno(latestRoot(entry2.roots).path);
    sameProject = cls2 === 'P' && JSON.stringify(di2) === JSON.stringify(rootDevIno0);
  }
  if (factsKey(f1) !== factsKey(f2) || rd.generation !== rd2.generation || !sameProject) {
    await invalidateForFacts(io, f2, agent, slotDeps); // 最终复核读到的授权 / 策略变化同样触发观察性作废(尽力)
    return rej('policy_changed');
  }

  // ---- 第 13 步:writeStage(不 apply);每个写出口前 assertHeld ----
  await point('ingest:before_write');
  await lock.assertHeld();
  await writeStage(io, runId, report, files, () => lock.assertHeld());
  // 暂存写完、同一把锁内更新 counts.staged(让 purge 的 taint 目标计算 / hint 看得到本 run;证据 sig 在 proposals/*.yaml 里)
  const r = await refreshStagedUnderLock(sctx, lock, redactor, deps.serviceHooks ?? {});
  if (r !== 'skipped_no_salt') {
    await commitUnderLockWith(sctx, lock, { trigger: 'kit' }, deps.serviceHooks ?? {});
  }
  return { kind: 'ok', runId, proposals: ids };
}
