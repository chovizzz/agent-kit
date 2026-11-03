/**
 * `agent-kit rsi digest --agent <claude|codex|pi> --json | --revoke`(docs/contracts.md §20.16-2,R20-16.5 ~ R20-16.13;R20-A4)。
 * 会话 agent 的受控入口之一:读脱敏摘要。**会话授权不是安全边界**(设计稿 §6.3):授权只决定 kit 是否主动把脱敏摘录交给会话。
 *
 * 流程(每步失败的去向见契约;stdout 只在**最后一步成功后**才有输出):
 *  1. 参数(严格):`--json` 必填、`--agent` 必填且 ∈ claude|codex|pi、`--revoke` 与其它参数互斥;`--scope` 等未知参数 → 退出 2。
 *  2. 开 rsi 上下文 → 现读事实({@link observeSessionFacts}:配置、状态、STOP、purge journal、授权判定、策略指纹、快照代次)。
 *     状态须 `confirmed`(off / armed / stopped 按原码退出 4);授权 `ok`(否则 `RSI_SESSION_DENIED`,并做观察性作废);无 purge journal(否则 `purge_pending`)。
 *  3. 预留槽位(持 `digests/lock`,毫秒级;满 → `digest_backlog`)。之后**任何**出口都放弃本进程的预留(只删自己 token 的文件)。
 *  4. **不拿 `rsi/lock`**,按快照协议读(状态 / 索引 / counts / 信号月文件,按清单核对;不一致重读一次,仍不一致 `RSI_SNAPSHOT_BUSY`)。
 *  5. 当前项目 = cwd 经 `canonical()` → 本机盐 → key;排除 / 归属不明 → 空 clusters + reason。**先剔除 X / U 的信号,再** classify / cluster / 门槛 / 排序 / 计数(R20-16.7)。
 *  6. 取舍(R20-16.8)→ 输出 canonical JSON(≤48KiB,超出从末尾整簇丢弃)→ 整份 pass2 复扫 + 路径泄漏闸(命中 `RSI_DIGEST_REJECTED`,不写不输出)。
 *  7. 最终复核:重读事实并**重新执行归属判定**(根路径 `(dev, ino)` 与归属结果),与开始时任一不同 → `policy_changed`(可重试)。
 *  8. 发布槽位(持锁,token 仍是自己的才 tmp → fsync → rename → fsync 目录),**写成功后才输出**;写失败 → `RSI_FAIL_CLOSED reason=internal`。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  RSI_AGENT_IDS,
  RSI_DIGEST_MAX_BYTES,
  RSI_DIGEST_MAX_CLUSTERS,
  RSI_DIGEST_MAX_EVIDENCE_PER_CLUSTER,
  RSI_DIGEST_TTL_MS,
  RSI_EXCERPT_MARK_CLOSE,
  RSI_EXCERPT_MARK_OPEN,
  RsiCountsSchema,
  RsiProjectIndexSchema,
  type RsiAgentId,
  type RsiCounts,
  type RsiDigestReason,
  type RsiDigestRecord,
  type RsiProjectIndex,
} from '../contracts/rsi.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { SignalSchema } from '../contracts/signal.js';
import type { Redactor } from '../contracts/redact.js';
import { canonicalJson } from '../io/canonical-json.js';
import { getProcessCwd, type IoContext, type WriteAudit } from '../io/paths.js';
import { lstat } from '../io/read-fs.js';
import { classifySignals } from '../reflect/classify.js';
import { buildClusters } from '../reflect/cluster.js';
import { isEvidenceEligible } from '../reflect/evidence.js';
import { emptyStats, finalizeCandidates } from '../reflect/load.js';
import type { LoadedSignal } from '../reflect/types.js';
import { readSaltFile, SaltError } from '../signals/salt-read.js';
import { projectKeyFor } from '../signals/ids.js';
import { canonical } from '../signals/exclude.js';
import { hasStructureFields } from '../signals/structure.js';
import {
  createAttributor,
  defaultProbe,
  type Attribution,
  type AttributionProbe,
  type IndexStatus,
} from './attribution.js';
import {
  revokeAllSlots,
  abandonSlot,
  publishSlot,
  reserveSlot,
  withDigestsLock,
  type Reservation,
  type SlotDeps,
} from './digest-slots.js';
import { createExcludeMatcher } from './exclude-match.js';
import { RsiSnapshotBusyError, failExit } from './exit.js';
import { RsiLockError } from './lock-error.js';
import { rsiDirReadonly } from './lock-read.js';
import { emitLines, forbiddenPaths, jsonLines } from './output.js';
import { rsiRedactor } from './redactor.js';
import { factsKey, observeSessionFacts, stateGate } from './session-facts.js';
import { invalidateForFacts } from './session-invalidate.js';
import { openRsiIo, type OpenRsiIoDeps } from './services/open.js';
import { RsiSnapshotError, readSnapshot, readVerified } from './snapshot-read.js';
import { RsiFailClosedError, type RsiEarlyContext, type RsiSubcommand } from './types.js';
import { utcToday } from './session.js';

type Env = Readonly<Record<string, string | undefined>> | undefined;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
export type DigestArgs =
  | { ok: true; revoke: true }
  | { ok: true; revoke: false; agent: RsiAgentId }
  | {
      ok: false;
      reason: 'unknown_arg' | 'mode_conflict' | 'missing:--agent' | 'bad_agent' | 'missing:--json';
    };

/** R20-16.5:严格解析。未知参数(含 `--scope`、`--x=y`、位置参数)、重复参数 → `unknown_arg`;`--revoke` 与其它参数同用 → `mode_conflict` */
export function parseDigestArgs(argv: readonly string[]): DigestArgs {
  let json = false;
  let revoke = false;
  let agent: string | undefined;
  let agentSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json' && !json) json = true;
    else if (a === '--revoke' && !revoke) revoke = true;
    else if (a === '--agent' && !agentSeen) {
      agentSeen = true;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { ok: false, reason: 'missing:--agent' };
      agent = v;
      i++;
    } else return { ok: false, reason: 'unknown_arg' };
  }
  if (revoke)
    return json || agentSeen ? { ok: false, reason: 'mode_conflict' } : { ok: true, revoke: true };
  if (agent === undefined) return { ok: false, reason: 'missing:--agent' };
  if (!(RSI_AGENT_IDS as readonly string[]).includes(agent))
    return { ok: false, reason: 'bad_agent' };
  if (!json) return { ok: false, reason: 'missing:--json' };
  return { ok: true, revoke: false, agent: agent as RsiAgentId };
}

// ---------------------------------------------------------------------------
// 快照协议读(R20-5.6;R20-16.6):状态 / 索引 / counts / 信号月文件
// ---------------------------------------------------------------------------
const SIGNAL_NAME_RE = /^signals\/(claude|codex|pi)\/\d{6}\.jsonl$/;
const FIXED_NAMES = ['state.json', 'projects.json', 'counts.json'] as const;

export interface ConsistentRead {
  generation: number;
  files: Map<string, Buffer | null>;
}

/**
 * 读清单 → 列出其中的信号月文件 → `readVerified`(逐文件 sha256 / 字节数与清单核对)→ 清单代次必须未变;不一致重读一次,仍不一致 → `RsiSnapshotBusyError`。
 * 清单缺失(从未提交过)= 代次 0、没有任何文件。
 */
export async function readConsistent(io: IoContext): Promise<ConsistentRead> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snap = await readSnapshot(io);
    if (snap.kind === 'missing') return { generation: 0, files: new Map() };
    if (snap.kind === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
    if (snap.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
    const names = [
      ...FIXED_NAMES,
      ...snap.snapshot.files.map((f) => f.name).filter((n) => SIGNAL_NAME_RE.test(n)),
    ];
    const v = await readVerified(io, names);
    if (v.status === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
    if (v.status === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
    if (v.status === 'no_snapshot') return { generation: 0, files: new Map() };
    if (v.status === 'ok' && v.generation === snap.snapshot.generation) {
      return { generation: v.generation, files: v.files };
    }
  }
  throw new RsiSnapshotBusyError();
}

function parseJson(b: Buffer): unknown {
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** 索引 / counts 的解析:索引损坏 → `index_invalid`(契约:digest / ingest 退出 3,直到重建);counts 损坏当作缺失(只影响盐核对 → 归属不明) */
export function indexAndCounts(files: ReadonlyMap<string, Buffer | null>): {
  indexStatus: IndexStatus;
  index: RsiProjectIndex | null;
  counts: RsiCounts | null;
} {
  const ib = files.get('projects.json') ?? null;
  let indexStatus: IndexStatus = 'absent';
  let index: RsiProjectIndex | null = null;
  if (ib !== null) {
    const p = RsiProjectIndexSchema.safeParse(parseJson(ib));
    if (!p.success) throw new RsiFailClosedError('index_invalid');
    indexStatus = 'ok';
    index = p.data;
  }
  const cb = files.get('counts.json') ?? null;
  let counts: RsiCounts | null = null;
  if (cb !== null) {
    const p = RsiCountsSchema.safeParse(parseJson(cb));
    counts = p.success ? p.data : null;
  }
  return { indexStatus, index, counts };
}

/** 从核对过的字节解析信号候选(坏行 → `signal_store_corrupt`;不合 schema 的行计数丢弃;缺结构字段的旧信号排除) */
export function candidatesFromFiles(
  files: ReadonlyMap<string, Buffer | null>,
  stats: ReturnType<typeof emptyStats>,
): LoadedSignal[] {
  const out: LoadedSignal[] = [];
  for (const [name, bytes] of [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (bytes === null || !SIGNAL_NAME_RE.test(name)) continue;
    for (const line of bytes.toString('utf8').split('\n')) {
      if (line === '') continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new RsiFailClosedError('signal_store_corrupt');
      }
      const parsed = SignalSchema.safeParse(raw);
      if (!parsed.success) {
        stats.dropped_schema++;
        continue;
      }
      if (!hasStructureFields(parsed.data)) {
        stats.structure_unknown++;
        continue;
      }
      out.push(parsed.data);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 当前项目的归属判定(R20-4.1 / R20-4.3 / R20-4.4;最终复核要重新执行一遍)
// ---------------------------------------------------------------------------
export interface ProjectFacts {
  reason: Extract<
    RsiDigestReason,
    'ok' | 'no_project' | 'project_excluded' | 'attribution_unknown'
  >;
  key: string | null;
  /** canonical(cwd) 的 `(dev, ino)`;取不到 = null(根被删) */
  devIno: { dev: number; ino: number } | null;
}

export async function judgeProject(
  io: IoContext,
  config: Parameters<typeof createExcludeMatcher>[0],
  cwd: string | undefined,
  data: ReturnType<typeof indexAndCounts>,
  probe: AttributionProbe = defaultProbe,
): Promise<ProjectFacts> {
  if (cwd === undefined || !cwd.startsWith('/') || cwd.includes('\0')) {
    return { reason: 'no_project', key: null, devIno: null };
  }
  const canon = await canonical(cwd);
  const devIno = await probe.devIno(canon);
  const matcher = await createExcludeMatcher(config, probe);
  if (await matcher.matchesRoot(canon)) return { reason: 'project_excluded', key: null, devIno };
  let salt;
  try {
    salt = await readSaltFile(io.stateDir);
  } catch (e) {
    if (e instanceof SaltError) return { reason: 'attribution_unknown', key: null, devIno };
    throw e;
  }
  if (salt.kind !== 'ok') return { reason: 'attribution_unknown', key: null, devIno };
  const key = projectKeyFor(salt.salt, canon);
  const attributor = await createAttributor({ config, probe, ...data });
  const cls: Attribution = await attributor.classify(key);
  if (cls === 'X') return { reason: 'project_excluded', key, devIno };
  if (cls === 'U') return { reason: 'attribution_unknown', key, devIno };
  return { reason: 'ok', key, devIno };
}

// ---------------------------------------------------------------------------
// 取舍与输出(R20-16.7 ~ R20-16.9)
// ---------------------------------------------------------------------------
export interface SelectedCluster {
  kind: string;
  /** 当前项目的证据(给摘录) */
  current: LoadedSignal[];
  /** 其它「采集中」项目的证据数(N3:只给计数) */
  other: number;
}

const hasMark = (s: string): boolean =>
  s.includes(RSI_EXCERPT_MARK_OPEN) || s.includes(RSI_EXCERPT_MARK_CLOSE);

/**
 * 在**已剔除 X / U** 的信号上做 classify / cluster(复用 reflect 干跑的分类、聚类与门槛),再按 R20-16.8 取舍:
 * 只有当前项目证据数 ≥ 1 的簇入选;(当前项目证据数降序、簇 id 升序)稳定排序;最多 5 簇、每簇最多 8 条摘录(按 sig_id 升序取)。
 * 含不可信标记文本的摘录不进 digest(免得伪造闭合标记)。入参必须只含「采集中」项目的信号——调用方在聚类**之前**剔除(变异表:挪到聚类之后 → 必红)。
 */
export function selectClusters(
  kept: readonly LoadedSignal[],
  currentKey: string,
): SelectedCluster[] {
  const clusters = buildClusters(classifySignals(kept));
  const rows = clusters.map((c) => {
    const eligible = c.members.filter((s) => isEvidenceEligible(s) && !hasMark(s.excerpt_redacted));
    const current = eligible
      .filter((s) => s.project_key === currentKey)
      .sort((a, b) => (a.sig_id < b.sig_id ? -1 : a.sig_id > b.sig_id ? 1 : 0));
    return { id: c.id, kind: c.kind as string, current, other: eligible.length - current.length };
  });
  return rows
    .filter((r) => r.current.length >= 1)
    .sort((a, b) => b.current.length - a.current.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, RSI_DIGEST_MAX_CLUSTERS)
    .map((r) => ({
      kind: r.kind,
      current: r.current.slice(0, RSI_DIGEST_MAX_EVIDENCE_PER_CLUSTER),
      other: r.other,
    }));
}

export interface DigestBody {
  text: string;
  aliases: Record<string, string>;
  reason: RsiDigestReason;
  clustersDropped: number;
}

/** 渲染 canonical JSON;> 48KiB 时从末尾整簇丢弃(`clusters_dropped`)。别名 `e1…`/`c1…` 按输出顺序编号,整份内唯一 */
export function renderDigest(i: {
  digestId: string;
  expiresAt: string;
  agent: RsiAgentId;
  reason: Exclude<RsiDigestReason, 'no_clusters'>;
  selected: readonly SelectedCluster[];
}): DigestBody {
  const kept = [...i.selected];
  let dropped = 0;
  for (;;) {
    let n = 0;
    const aliases: Record<string, string> = {};
    const clusters = kept.map((c, ci) => ({
      alias: `c${ci + 1}`,
      kind: c.kind,
      evidence: c.current.map((s) => {
        const alias = `e${++n}`;
        aliases[alias] = s.sig_id;
        return {
          alias,
          excerpt: `${RSI_EXCERPT_MARK_OPEN}${s.excerpt_redacted}${RSI_EXCERPT_MARK_CLOSE}`,
        };
      }),
      other_evidence: c.other,
    }));
    const reason: RsiDigestReason =
      i.reason === 'ok' && clusters.length === 0 ? 'no_clusters' : i.reason;
    const text = canonicalJson({
      digest_id: i.digestId,
      expires_at: i.expiresAt,
      agent: i.agent,
      reason,
      clusters,
      truncated: { clusters_dropped: dropped },
    });
    if (Buffer.byteLength(text, 'utf8') <= RSI_DIGEST_MAX_BYTES || kept.length === 0) {
      return { text, aliases, reason, clustersDropped: dropped };
    }
    kept.pop();
    dropped++;
  }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------
/** 确定性交错的测试缝 + 其它注入点 */
export interface RunDigestDeps {
  env?: Env;
  cwd?: string;
  writeAudit?: WriteAudit;
  now?: () => Date;
  open?: OpenRsiIoDeps;
  probe?: AttributionProbe;
  slots?: SlotDeps;
  redactor?: Pick<Redactor, 'pass2'>;
  randomHex?: (bytes: number) => string;
  /** 命名点:`digest:after_read`(读完快照后)、`digest:before_final`(最终复核之前)、`digest:before_publish`(发布之前) */
  hooks?: { point?(name: string): Promise<void> | void };
}

interface Out {
  stdout(t: string): void;
  stderr(t: string): void;
}

const usage = (o: Out, reason: string): number => {
  o.stderr(`RSI_USAGE reason=${reason}\n`);
  return ExitCode.USAGE;
};
const notRun = (o: Out, reason: string): number => {
  o.stderr(`RSI_NOT_RUN reason=${reason}\n`);
  return ExitCode.NOT_RUN;
};

async function revoke(ctx: RsiEarlyContext, deps: RunDigestDeps): Promise<number> {
  const open = await openRsiIo(openArgs(ctx, deps), deps.open);
  if (open.kind === 'off') return notRun(ctx, 'off');
  if (open.kind === 'usage') return usage(ctx, open.reason);
  const { io } = open.ctx;
  // 没有 digests/ 目录 = 没有任何 digest:不建目录、不取锁
  const ro = await rsiDirReadonly(io);
  if (ro.kind === 'unsafe') throw new RsiFailClosedError('state_dir_unsafe');
  if (ro.kind === 'missing') return ExitCode.OK;
  try {
    await lstat(path.join(ro.dir, 'digests'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ExitCode.OK;
    throw new RsiFailClosedError('state_dir_unsafe');
  }
  await withDigestsLock(io, (lock) => revokeAllSlots(io, lock, deps.slots ?? {}), deps.slots ?? {});
  return ExitCode.OK;
}

function openArgs(ctx: RsiEarlyContext, deps: RunDigestDeps): RsiEarlyContext {
  return {
    argv: [],
    overlayPath: undefined,
    explicitRoot: ctx.explicitRoot,
    ...((deps.env ?? ctx.env) !== undefined
      ? { env: (deps.env ?? ctx.env) as NonNullable<Env> }
      : {}),
    ...((deps.cwd ?? ctx.cwd) !== undefined ? { cwd: (deps.cwd ?? ctx.cwd) as string } : {}),
    ...((deps.writeAudit ?? ctx.writeAudit) !== undefined
      ? { writeAudit: (deps.writeAudit ?? ctx.writeAudit) as WriteAudit }
      : {}),
    stdout: () => undefined,
    stderr: () => undefined,
  };
}

export async function runDigest(ctx: RsiEarlyContext, deps: RunDigestDeps = {}): Promise<number> {
  const parsed = parseDigestArgs(ctx.argv);
  if (!parsed.ok) return usage(ctx, parsed.reason);
  try {
    if (parsed.revoke) return await revoke(ctx, deps);
    return await digest(ctx, deps, parsed.agent);
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

async function digest(
  ctx: RsiEarlyContext,
  deps: RunDigestDeps,
  agent: RsiAgentId,
): Promise<number> {
  const env: Env = deps.env ?? ctx.env;
  const now = (deps.now ?? ((): Date => new Date()))();
  const today = utcToday(now); // 本次调用取一次 UTC 今天,全程沿用(R20-16.3)
  const point = async (n: string): Promise<void> => void (await deps.hooks?.point?.(n));

  const open = await openRsiIo(openArgs(ctx, deps), deps.open);
  if (open.kind === 'off') return notRun(ctx, 'off');
  if (open.kind === 'usage') return usage(ctx, open.reason);
  const { io } = open.ctx;

  // 开始时的事实
  const f0 = await observeSessionFacts(io, env, agent, today);
  // 观察性作废(R20-16.12 ②,尽力,不改变本次结果):授权非 ok / 策略指纹变过 → 删受影响的已发布 digest。读到事实就做,先于状态闸
  await invalidateForFacts(io, f0, agent, deps.slots ?? {});
  const gate0 = stateGate(f0);
  if (gate0 !== null) return notRun(ctx, gate0);
  if (f0.config.status !== 'on' || f0.judgement === null) throw new RsiFailClosedError('internal');
  const config0 = f0.config;
  if (f0.judgement.kind === 'denied') {
    ctx.stderr(`RSI_SESSION_DENIED reason=${f0.judgement.reason}\n`);
    return ExitCode.NOT_RUN;
  }
  if (f0.journalPresent) return notRun(ctx, 'purge_pending');

  // 预留槽位
  const slotDeps = deps.slots ?? {};
  const reservation: Reservation | null = await withDigestsLock(
    io,
    (lock) => reserveSlot(io, lock, now, slotDeps),
    slotDeps,
  );
  if (reservation === null) return notRun(ctx, 'digest_backlog');
  const held: Reservation = reservation;
  let published = false;
  try {
    // 脱敏器(规则 = 种子 + overlay)
    const redactor = deps.redactor ?? (await rsiRedactor(config0));

    // 快照协议读 + 当前项目归属
    const rd = await readConsistent(io);
    const data = indexAndCounts(rd.files);
    const cwd = getProcessCwd(deps.cwd ?? ctx.cwd);
    const p0 = await judgeProject(io, config0, cwd, data, deps.probe);
    await point('digest:after_read');

    // 先剔除 X / U,再聚类(R20-16.7)
    let selected: SelectedCluster[] = [];
    /** 参与分类 / 聚类的各项目的归属基线(最终复核要重判:其它项目的归属变化也会改变入选与 other_evidence) */
    let classBaseline: [string, Attribution][] = [];
    if (p0.reason === 'ok' && p0.key !== null) {
      const stats = emptyStats();
      const loaded = finalizeCandidates(candidatesFromFiles(rd.files, stats), redactor, stats, {
        pass2: false,
      });
      const attributor = await createAttributor({
        config: config0,
        probe: deps.probe ?? defaultProbe,
        ...data,
      });
      const classOf = new Map<string, Attribution>();
      for (const k of new Set(loaded.map((s) => s.project_key))) {
        classOf.set(k, await attributor.classify(k));
      }
      classBaseline = [...classOf.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const kept = loaded.filter((s) => classOf.get(s.project_key) === 'P');
      selected = selectClusters(kept, p0.key);
    }
    const digestId = `d_${(deps.randomHex ?? ((n: number): string => randomBytes(n).toString('hex')))(8)}`;
    const expiresAt = new Date(now.getTime() + RSI_DIGEST_TTL_MS).toISOString();
    const body = renderDigest({
      digestId,
      expiresAt,
      agent,
      reason: p0.reason,
      selected: p0.reason === 'ok' ? selected : [],
    });

    // 输出复扫:整份文本 pass2 + 路径泄漏闸(R20-16.11 ①)
    let clean = false;
    try {
      clean = redactor.pass2(body.text).clean;
    } catch {
      clean = false;
    }
    if (!clean) {
      ctx.stderr('RSI_DIGEST_REJECTED reason=rescan_hit\n');
      return ExitCode.FAIL_CLOSED;
    }
    const forbidden = await forbiddenPaths(env, [io.stateDir, io.repoRoot, config0.repo]);
    const lines = jsonLines(body.text);
    const leak: string[] = [];
    const leakSink = { stdout: () => undefined, stderr: (t: string) => void leak.push(t) };
    if (emitLines(leakSink, lines, forbidden) !== ExitCode.OK) {
      ctx.stderr('RSI_DIGEST_REJECTED reason=output_leak\n');
      return ExitCode.FAIL_CLOSED;
    }

    // 最终复核(R20-16.11 ②):重读事实 + 重新执行归属判定
    await point('digest:before_final');
    const f1 = await observeSessionFacts(io, env, agent, today);
    const rd1 = await readConsistent(io);
    const data1 = indexAndCounts(rd1.files);
    const p1 =
      f1.config.status === 'on' ? await judgeProject(io, f1.config, cwd, data1, deps.probe) : null;
    // 参与分类的其它项目的归属也重判:它们的根被换掉 / 删除,会让已进入 other_evidence / 门槛的证据变成 X / U
    let classesSame = true;
    if (classBaseline.length > 0 && f1.config.status === 'on') {
      const att1 = await createAttributor({
        config: f1.config,
        probe: deps.probe ?? defaultProbe,
        ...data1,
      });
      for (const [k, c] of classBaseline) {
        if ((await att1.classify(k)) !== c) classesSame = false;
      }
    }
    const same =
      classesSame &&
      factsKey(f0) === factsKey(f1) &&
      rd.generation === rd1.generation &&
      p1 !== null &&
      p1.reason === p0.reason &&
      p1.key === p0.key &&
      JSON.stringify(p1.devIno) === JSON.stringify(p0.devIno);
    if (!same) {
      await invalidateForFacts(io, f1, agent, slotDeps); // 最终复核读到的授权 / 策略变化同样触发观察性作废(尽力)
      return notRun(ctx, 'policy_changed');
    }

    // 发布(持槽位锁;写成功后才输出)
    await point('digest:before_publish');
    const record: RsiDigestRecord = {
      digest_id: digestId,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      agent,
      project_key: p0.key,
      aliases: body.aliases,
      session_policy_fp: f0.fp as string,
      snapshot_generation: rd.generation,
    };
    let res: 'published' | 'lost';
    try {
      res = await withDigestsLock(
        io,
        (lock) => publishSlot(io, lock, held, record, slotDeps),
        slotDeps,
      );
    } catch (e) {
      if (
        e instanceof RsiFailClosedError ||
        e instanceof RsiSnapshotError ||
        e instanceof RsiLockError
      )
        throw e;
      throw new RsiFailClosedError('internal'); // 写失败:不输出
    }
    if (res === 'lost') {
      published = true; // 槽位已不是我们的:不碰
      return notRun(ctx, 'policy_changed');
    }
    published = true;
    ctx.stdout(body.text);
    return ExitCode.OK;
  } finally {
    if (!published) {
      // 放弃预留:只删本进程 token 的文件;失败不改变已确定的结果
      await withDigestsLock(io, (lock) => abandonSlot(io, lock, held, slotDeps), slotDeps).catch(
        () => undefined,
      );
    }
  }
}

export const subcommand: RsiSubcommand = {
  name: 'digest',
  owner: 'A4',
  run: (ctx) => runDigest(ctx),
};
