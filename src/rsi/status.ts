/**
 * `agent-kit rsi status [--json]`(`--ack` 见 `status-ack.ts`)(契约 R20-3.4;R20-A2 B3a 实装;`--ack` 由分发器路由到 `status-ack.ts`,本文件保持只读闭包)。
 *
 * 只读、不拿锁、不建 `rsi/`、不恢复快照:`openRsiIo`(配置 off 也退出 0,把原因码放进 `reason`)→ `readRsiState`(快照协议)→
 * `rsiStateOf`(现算状态)→ `attribute`(现算 P / X / U,R20-4.6)→ `peekRsiLock`(锁状态)→ 一次性输出(过泄漏闸)。
 * 熔断只现算(`state.json` 的记录 + 当前时间),不写任何东西。输出只有枚举与计数,不含路径、key、项目名;
 * `tainted` 只列 run id 与原因码。时间只经注入(`deps.now`)。
 * 本文件的 import 闭包不含 safe-fs / lock.ts / snapshot.ts / with-lock.ts / exec.ts(`test/rsi/readonly-zero-write.test.ts` 静态审计)。
 */
import * as path from 'node:path';
import { ExitCode } from '../contracts/exit-codes.js';
import {
  RSI_INDEX_MAX_ENTRIES,
  RSI_STATUS_NEXT_REBUILD,
  RsiTaintMarkSchema,
  type RsiAgentId,
  type RsiState,
} from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import { getRealHome } from '../io/paths.js';
import { readFileSafe, statDirSafe } from '../io/read-fs.js';
import { parseFlags } from './args.js';
import { attribute, type AttributionProbe } from './attribution.js';
import { buildRsiPolicy, type RsiConfigOn } from './config.js';
import { failExit } from './exit.js';
import { currentCursorFingerprint } from './l0/fingerprint.js';
import { evaluateAgentRoot } from './l0/roots.js';
import { peekRsiLock, type RsiLockDeps } from './lock-read.js';
import { emitLines, forbiddenPaths, jsonLines } from './output.js';
import { readRsiState, type RsiReadData } from './read-state.js';
import type { OutLine } from './sanitize.js';
import { openRsiIo, piDirIsSet, type OpenRsiIoDeps } from './services/open.js';
import { readSaltFile } from '../signals/salt-read.js';
import { RsiSnapshotError } from './snapshot-read.js';
import { loadRepoIdentity, rsiStateOf } from './state.js';
import type { RsiEarlyContext, RsiSubcommand } from './types.js';

/** 稳定码字符集(同 `RsiLogLineSchema.code`,排除 `/`、空白与控制字符) */
const STABLE_CODE_RE = /^[A-Za-z0-9_=.:-]{1,64}$/;

export interface RsiStatusDeps {
  now?: () => Date;
  open?: OpenRsiIoDeps;
  probe?: AttributionProbe;
  lock?: RsiLockDeps;
  /** 当前 cursor 指纹(契约 R20-6.9 的定义由 B4 落地);缺省 `null` = 不比较,`fingerprint_match` 报 `null` */
  cursorFingerprint?: () => Promise<string | null> | string | null;
}

type Agents = { id: RsiAgentId; status: 'ok' | 'not_evaluated'; reason: string | null }[];

export interface StatusDoc {
  state: string;
  reason: string | null;
  first_armed: boolean;
  overlay: 'absent' | 'ok' | 'invalid';
  agents: Agents;
  counts: {
    projects_collecting: number;
    projects_excluded: number;
    projects_new: number;
    unknown_signals: number;
    signals_total: number;
    signals_new_7d: number;
    clusters_pending: number;
    staged_runs: number;
    staged_proposals: number;
    tainted_runs: number;
  };
  last_tick: {
    at: string;
    trigger: string;
    outcome: string;
    code: string | null;
    duration_ms: number;
    files_read: number;
    bytes_read: number;
  } | null;
  breaker: {
    state: 'closed' | 'open' | 'half_open';
    kind: 'retryable' | 'safety' | null;
    consecutive_failures: number;
    until: string | null;
  };
  index: { status: 'ok' | 'absent' | 'invalid'; entries: number };
  cursor: {
    status: 'ok' | 'absent';
    fingerprint_match: boolean | null;
    full_scan: { epoch: number; done: boolean; last_completed_at: string | null };
  };
  snapshot: 'ok' | 'absent';
  confirm: {
    confirmed_at: string | null;
    policy_fp12: string | null;
    invalid_reason: string | null;
  } | null;
  stop: { present: boolean; at: string | null };
  purge: { journal: 'absent' | 'present' };
  lock: string;
  tainted: { run_id: string; reason: 'exclude' | 'purge' }[];
  warnings: string[];
}

function offDoc(reason: string): StatusDoc {
  return {
    state: 'off',
    reason,
    first_armed: false,
    overlay: 'absent',
    agents: [],
    counts: {
      projects_collecting: 0,
      projects_excluded: 0,
      projects_new: 0,
      unknown_signals: 0,
      signals_total: 0,
      signals_new_7d: 0,
      clusters_pending: 0,
      staged_runs: 0,
      staged_proposals: 0,
      tainted_runs: 0,
    },
    last_tick: null,
    breaker: { state: 'closed', kind: null, consecutive_failures: 0, until: null },
    index: { status: 'absent', entries: 0 },
    cursor: {
      status: 'absent',
      fingerprint_match: null,
      full_scan: { epoch: 0, done: false, last_completed_at: null },
    },
    snapshot: 'absent',
    confirm: null,
    stop: { present: false, at: null },
    purge: { journal: 'absent' },
    lock: 'free',
    tainted: [],
    warnings: [],
  };
}

/** 云同步目录的路径段启发式(只按路径段判断;路径本身不输出) */
const CLOUD_SEGMENTS = [
  'dropbox',
  'onedrive',
  'icloud drive',
  'iclouddrive',
  'mobile documents',
  'google drive',
  'cloudstorage',
  'box sync',
  'nextcloud',
];
const cloudSyncSuspected = (repo: string): boolean =>
  repo
    .split('/')
    .some(
      (s) => CLOUD_SEGMENTS.includes(s.toLowerCase()) || s.toLowerCase().startsWith('onedrive'),
    );

/** R20-2.7 / R20-2.9:会话根链上有符号链接、不是目录 → `not_evaluated`;pi 且 `PI_CODING_AGENT_DIR` 已设同样(判定在 `l0/roots.ts`,唯一实现) */
async function evaluateAgents(config: RsiConfigOn, env: RsiEarlyContext['env']): Promise<Agents> {
  const home = getRealHome(env);
  const out: Agents = [];
  for (const id of config.agents) {
    const r = await evaluateAgentRoot(home, id, piDirIsSet(env));
    out.push(
      r.status === 'not_evaluated'
        ? { id, status: 'not_evaluated', reason: r.reason }
        : { id, status: 'ok', reason: null }, // absent:没有东西可读,不算问题
    );
  }
  return out;
}

function breakerOf(
  st: Pick<RsiState, 'breaker' | 'consecutive_failures'> | null,
  now: Date,
): StatusDoc['breaker'] {
  if (st === null || st.breaker === null) {
    return {
      state: 'closed',
      kind: null,
      consecutive_failures: st?.consecutive_failures ?? 0,
      until: null,
    };
  }
  const b = st.breaker;
  const state =
    b.kind === 'retryable' && b.until !== null && now.getTime() >= Date.parse(b.until)
      ? 'half_open'
      : 'open';
  return { state, kind: b.kind, consecutive_failures: st.consecutive_failures, until: b.until };
}

/** 近 7 个 UTC 日(含今天)的日期串 */
function last7Days(now: Date): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < 7; i++) {
    out.add(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** `.state/reflect/<run_id>/TAINTED` 的原因码:缺失 → 按 journal 在场与否回退;不安全 / 内容不合规 → fail-closed,不吞 */
async function taintReason(
  stateDir: string | null,
  runId: string,
  journalPresent: boolean,
): Promise<'exclude' | 'purge'> {
  const fallback = journalPresent ? 'purge' : 'exclude';
  if (stateDir === null) return fallback;
  // 父目录链:`reflect/` 与 `reflect/<run_id>/` 必须是真实目录(`O_DIRECTORY | O_NOFOLLOW`);符号链接 / 非目录 → fail-closed,
  // 不让 `O_NOFOLLOW`(只管末级)放过「目录被换成指向别处的链接」。run_id 经 `RunIdSchema`(单段、首字符字母数字、无 `/`)。
  const reflect = path.join(stateDir, 'reflect');
  for (const dir of [reflect, path.join(reflect, runId)]) {
    const d = await statDirSafe(dir);
    if (d.kind === 'missing') return fallback;
    if (d.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  }
  const r = await readFileSafe(path.join(stateDir, 'reflect', runId, 'TAINTED'), {
    maxBytes: 4096,
  });
  if (r.kind === 'missing') return fallback;
  if (r.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  try {
    const m = RsiTaintMarkSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
    if (m.success) return m.data.reason;
  } catch {
    // 落到下面
  }
  throw new RsiSnapshotError('state_invalid');
}

/** 读盐失败(缺失 / 违规)一律当「没有可用的盐」:不出告警、不抛,不改变 status 现有的退出行为 */
async function indexRebuildRequired(
  io: Parameters<typeof peekRsiLock>[0],
  data: RsiReadData,
): Promise<boolean> {
  let saltFp: string | null = null;
  try {
    const r = await readSaltFile(io.stateDir);
    if (r.kind === 'ok') saltFp = r.saltFp;
  } catch {
    saltFp = null;
  }
  if (saltFp === null) return false;
  if (data.index.status === 'absent') return data.cursor.status === 'ok';
  if (data.index.status === 'invalid') return true;
  return data.index.value !== null && data.index.value.salt_fp !== saltFp;
}

async function buildDoc(
  config: RsiConfigOn,
  data: RsiReadData,
  ctx: RsiEarlyContext,
  io: Parameters<typeof peekRsiLock>[0],
  deps: RsiStatusDeps,
): Promise<StatusDoc> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const policy = await buildRsiPolicy(config);
  const identity = await loadRepoIdentity(config, policy);
  const st = rsiStateOf({
    config,
    stopPresent: data.stop.present,
    doc: data.stateDoc,
    identity,
  });
  const docState: Omit<RsiState, 'confirm'> | null =
    data.stateDoc.kind === 'ok' || data.stateDoc.kind === 'confirm_schema_invalid'
      ? data.stateDoc.state
      : null;
  const att = await attribute({
    config,
    indexStatus: data.index.status,
    index: data.index.value,
    counts: data.counts,
    ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
  });

  const entries = data.index.value?.entries ?? [];
  const ackGen = docState?.projects_ack_generation ?? 0;
  let collecting = 0;
  let excluded = 0;
  let fresh = 0;
  for (const e of entries) {
    const a = att.byKey.get(e.key);
    if (a === 'P') {
      collecting++;
      if (e.first_indexed_generation > ackGen) fresh++;
    } else if (a === 'X') excluded++;
  }

  const c = data.counts;
  const days = last7Days(now);
  let unknown = c?.unknown_keys_signals ?? 0;
  let total = c?.unknown_keys_signals ?? 0;
  let new7 = 0;
  if (c !== null) {
    for (const [k, v] of Object.entries(c.per_key)) {
      total += v.signals_total;
      const cls = att.classify(k);
      if (cls === 'U') unknown += v.signals_total;
      if (cls === 'P') {
        for (const [d, n] of Object.entries(v.signals_by_day)) if (days.has(d)) new7 += n;
      }
    }
  } else {
    // counts.json 缺失:回退索引条目的 signals(与 rsi projects 同口径;不读信号库);U 按统一分类结果累加
    for (const e of entries) {
      total += e.signals;
      if (att.classify(e.key) === 'U') unknown += e.signals;
    }
  }
  let clusters = 0;
  let stagedRuns = 0;
  let stagedProposals = 0;
  const tainted: StatusDoc['tainted'] = [];
  if (c !== null) {
    for (const cl of c.clusters) {
      let n = 0;
      for (const [k, v] of Object.entries(cl.evidence_by_key)) if (att.classify(k) === 'P') n += v;
      if (n >= c.cluster_min) clusters++;
    }
    const stateDir = data.rsiDir === null ? null : path.dirname(data.rsiDir);
    for (const s of c.staged) {
      const hasX = s.evidence_keys.some((k) => att.classify(k) === 'X');
      if (s.tainted || hasX) {
        tainted.push({
          run_id: s.run_id,
          reason: s.tainted
            ? await taintReason(stateDir, s.run_id, data.journalPresent)
            : 'exclude',
        });
        continue;
      }
      if (s.evidence_keys.length > 0 && s.evidence_keys.every((k) => att.classify(k) === 'P')) {
        stagedRuns++;
        stagedProposals += s.proposals;
      }
    }
  }
  tainted.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));

  const confirmDoc = data.stateDoc.kind === 'ok' ? data.stateDoc.state.confirm : null;
  const confirm: StatusDoc['confirm'] =
    data.stateDoc.kind === 'confirm_schema_invalid'
      ? { confirmed_at: null, policy_fp12: null, invalid_reason: 'schema' }
      : confirmDoc === null
        ? null
        : {
            confirmed_at: confirmDoc.confirmed_at,
            policy_fp12: confirmDoc.policy_fp.slice(0, 12),
            invalid_reason: st.confirmInvalid,
          };

  const lastTick = docState?.last_tick ?? null;
  // 从状态文件复制到输出的自由字符串只有 last_tick.code:按稳定码字符集校验(与 RsiLogLine.code 同集),不合规 fail-closed,稳定码不带内容
  if (lastTick !== null && lastTick.code !== null && !STABLE_CODE_RE.test(lastTick.code)) {
    throw new RsiSnapshotError('state_invalid');
  }
  const cur = data.cursor.value;
  let match: boolean | null = null;
  if (cur !== null) {
    const fp = await (
      deps.cursorFingerprint ?? ((): Promise<string | null> => currentCursorFingerprint(io, config))
    )();
    if (fp !== null) match = cur.fingerprint === fp;
  }
  const breaker = breakerOf(docState, now);
  const warnings: string[] = [];
  if (config.warnings.includes('overlay_absent')) warnings.push('overlay_absent');
  if (cloudSyncSuspected(config.repo)) warnings.push('cloud_sync_suspected');
  if (entries.length >= RSI_INDEX_MAX_ENTRIES) warnings.push('index_full');
  if (breaker.state === 'open') warnings.push('breaker_open');
  // D7 / Q-C:盐有效,但索引缺失而 cursor 在、或索引损坏 / 盐不符 —— tick 不会重建索引,需要 `projects --rebuild-index --write`
  if (await indexRebuildRequired(io, data)) warnings.push('index_rebuild_required');

  return {
    state: st.state,
    reason: st.collectBlocked,
    first_armed: st.firstArmed,
    overlay:
      config.overlayPath === null ? 'absent' : config.overlaySha256 === null ? 'invalid' : 'ok',
    agents: await evaluateAgents(config, ctx.env),
    counts: {
      projects_collecting: collecting,
      projects_excluded: excluded,
      projects_new: fresh,
      unknown_signals: unknown,
      signals_total: total,
      signals_new_7d: new7,
      clusters_pending: clusters,
      staged_runs: stagedRuns,
      staged_proposals: stagedProposals,
      tainted_runs: tainted.length,
    },
    last_tick:
      lastTick === null
        ? null
        : {
            at: lastTick.completed_at,
            trigger: lastTick.trigger,
            outcome: lastTick.outcome,
            code: lastTick.code,
            duration_ms: lastTick.duration_ms,
            files_read: lastTick.files_read,
            bytes_read: lastTick.bytes_read,
          },
    breaker,
    index: { status: data.index.status, entries: entries.length },
    cursor: {
      status: data.cursor.status,
      fingerprint_match: match,
      full_scan: {
        epoch: cur?.full_scan.epoch ?? 0,
        done: cur?.full_scan.done ?? false,
        last_completed_at: cur?.full_scan.last_completed_at ?? null,
      },
    },
    snapshot: data.snapshot,
    confirm,
    stop: data.stop,
    purge: { journal: data.journalPresent ? 'present' : 'absent' },
    lock: await peekRsiLock(io, deps.lock),
    tainted,
    warnings,
  };
}

/** 非 `--json`:`key=value` 逐行,嵌套键用 `a.b`,数组按元素展开为 `a[i].b`,空数组 `a=` */
export function flattenDoc(v: unknown, prefix = ''): string[] {
  if (v === null) return [`${prefix}=-`];
  if (Array.isArray(v)) {
    if (v.length === 0) return [`${prefix}=`];
    return v.flatMap((x, i) => flattenDoc(x, `${prefix}[${i}]`));
  }
  if (typeof v === 'object') {
    return Object.keys(v as object)
      .sort()
      .flatMap((k) =>
        flattenDoc((v as Record<string, unknown>)[k], prefix === '' ? k : `${prefix}.${k}`),
      );
  }
  return [`${prefix}=${String(v)}`];
}

export async function runStatus(ctx: RsiEarlyContext, deps: RsiStatusDeps = {}): Promise<number> {
  const parsed = parseFlags(ctx.argv, ['--json']);
  if (!parsed.ok) {
    ctx.stderr('RSI_USAGE reason=unknown_arg\n');
    return ExitCode.USAGE;
  }
  const json = parsed.flags.has('--json');
  try {
    const open = await openRsiIo(ctx, deps.open);
    if (open.kind === 'usage') {
      ctx.stderr(`${open.code} reason=${open.reason}\n`);
      return ExitCode.USAGE;
    }
    let doc: StatusDoc;
    let forbidden: string[];
    if (open.kind === 'off') {
      doc = offDoc(open.reason);
      forbidden = await forbiddenPaths(ctx.env, []);
    } else {
      const { io, config } = open.ctx;
      const data = await readRsiState(io);
      doc = await buildDoc(config, data, ctx, io, deps);
      forbidden = await forbiddenPaths(ctx.env, [io.stateDir, io.repoRoot, config.repo]);
    }
    const lines: OutLine[] = json
      ? jsonLines(canonicalJson(doc))
      : flattenDoc(doc).map((head) => ({ head }));
    // 文本模式的「下一步」行(固定枚举词,不含路径);JSON 只靠 warnings
    if (!json && doc.warnings.includes('index_rebuild_required')) {
      lines.push({ head: `next=${RSI_STATUS_NEXT_REBUILD}` });
    }
    return emitLines(ctx, lines, forbidden);
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'status',
  owner: 'B3a',
  run: (ctx) => runStatus(ctx),
};
