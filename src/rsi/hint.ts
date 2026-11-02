/**
 * `agent-kit rsi hint --agent <claude|codex|pi>`(契约 R20-3.3;A3)。会话开始钩子注入的一行计数提示。
 *
 * 退出码恒 0;任何失败(参数、配置、快照不一致、超过 1s 尽力预算、索引损坏……)输出空串。
 *
 * 读集合(受限读取器,A3 方案 v2 R6;R20-3.3.1 + A3 订正):
 *  - 用户配置与 overlay(`openRsiIo` / `buildRsiPolicy`);
 *  - 快照清单 + `.state/rsi/{state.json,projects.json,counts.json}`(`readVerified` 只核对这三个);
 *  - 索引根路径的 `lstat` / `realpath`(`attribute` 的探测,≤ 索引条目数);
 *  - `.state/rsi/STOP` 与 `.state/rsi/purge-journal.json` **只 `lstat` 判存在**(STOP → stopped → 空;journal 在 → 空,R20-3.8.5 ③)。
 * **不读**盐、信号库、会话计数、会话根、`cursor.json`、STOP 内容;不拿锁。计数由 `counts.json` + 当前配置 + 当前索引现算(R20-4.6),
 * 盐指纹只用 `projects.json` 与 `counts.json` 各自的 `salt_fp` 互相核对(`attribution.ts`)。
 *
 * 输出:模板之一加 `\n`,经唯一出口 {@link finalizeHint}(> 200 字节 → 空串);计数显示 `min(n, 9999)`,超过写 `9999+`。
 * 全部计算、字节校验与预算检查在去重写入**之前**完成;去重标记(`.state/rsi/hint/<agent>-<窗口>`,独占创建,`EEXIST` → 空串)是唯一的写入,
 * 输出空串的调用零写入。
 */
import * as path from 'node:path';
import { ExitCode } from '../contracts/exit-codes.js';
import {
  RSI_AGENT_IDS,
  RSI_DIR_MODE,
  RSI_FILE_MODE,
  RSI_HINT_BUDGET_MS,
  RSI_HINT_COUNT_CAP,
  RSI_HINT_DEDUP_MS,
  RSI_HINT_MAX_BYTES,
  RSI_HINT_MIN_CLUSTERS,
  RsiCountsSchema,
  RsiProjectIndexSchema,
  type RsiAgentId,
  type RsiCounts,
  type RsiProjectIndex,
  type RsiState,
} from '../contracts/rsi.js';
import type { WriteAudit } from '../io/paths.js';
import { lstat } from '../io/read-fs.js';
import { createExclusive, mkdirp } from '../io/safe-fs.js';
import { attribute, type AttributionProbe, type IndexStatus } from './attribution.js';
import { buildRsiPolicy, policyFingerprint } from './config.js';
import { armedListingForHint } from './l0/armed-listing.js';
import { rsiDirReadonly } from './lock-read.js';
import { rsiDir } from './rsi-dir.js';
import { windowIndex } from './services/breaker.js';
import { openRsiIo, type OpenRsiIoDeps } from './services/open.js';
import { autoSkip } from './skip.js';
import { readVerified } from './snapshot-read.js';
import { loadRepoIdentity, parseRsiStateDoc, rsiStateOf } from './state.js';
import type { RsiSubcommand } from './types.js';

type Env = Readonly<Record<string, string | undefined>>;

/** hint 读的固定文件(清单只核对这三个) */
export const HINT_READ_NAMES = ['state.json', 'projects.json', 'counts.json'] as const;

export interface RunHintDeps {
  env?: Env;
  writeAudit?: WriteAudit;
  now?: () => Date;
  /** 墙钟毫秒(预算用) */
  clockMs?: () => number;
  open?: OpenRsiIoDeps;
  probe?: AttributionProbe;
}

/** 计数显示:`min(n, 9999)`,超过写 `9999+`(R20-3.3.2) */
export function showCount(n: number): string {
  return n > RSI_HINT_COUNT_CAP ? `${RSI_HINT_COUNT_CAP}+` : String(n);
}

/** 唯一出口(R20-3.3.2):带一个末尾换行;超过 200 字节(`Buffer.byteLength`)→ 空串。测试直接喂候选文本(变异:去掉上限 → 必杀) */
export function finalizeHint(candidate: string): string {
  if (candidate === '') return '';
  const text = candidate.endsWith('\n') ? candidate : `${candidate}\n`;
  return Buffer.byteLength(text, 'utf8') <= RSI_HINT_MAX_BYTES ? text : '';
}

export interface HintCounts {
  /** 近 7 个 UTC 日内由 L0 新增、归属「采集中」的信号数 */
  N: number;
  /** 剔除 X 与 U 的证据后仍达门槛的聚类数 */
  K: number;
  /** 证据全部归属「采集中」且不是 tainted 的暂存 run 里的提案数 */
  M: number;
  P: number;
  n: number;
  X: number;
  U: number;
}

export function confirmedTemplate(c: HintCounts): string {
  return `agent-kit RSI: 新信号 ${showCount(c.N)}、待反思聚类 ${showCount(c.K)}、待审提案 ${showCount(c.M)}、项目 ${showCount(c.P)}(新增 ${showCount(c.n)}、排除 ${showCount(c.X)}、归属不明 ${showCount(c.U)})。仅在用户要求时使用技能 agent-kit-rsi。`;
}

export function armedTemplate(p: number): string {
  return `agent-kit RSI: 待确认,将采集 ${showCount(p)} 个项目。仅在用户要求时运行 agent-kit rsi confirm。`;
}

function last7Days(now: Date): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < 7; i++) {
    out.add(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function parseJson(b: Buffer): unknown {
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** 计数现算(与 `rsi status` 同口径;`test/rsi/a3-hint.test.ts` 对拍) */
export async function hintCounts(i: {
  config: Parameters<typeof attribute>[0]['config'];
  indexStatus: IndexStatus;
  index: RsiProjectIndex | null;
  counts: RsiCounts | null;
  ackGen: number;
  now: Date;
  probe?: AttributionProbe;
}): Promise<HintCounts> {
  const att = await attribute({
    config: i.config,
    indexStatus: i.indexStatus,
    index: i.index,
    counts: i.counts,
    ...(i.probe !== undefined ? { probe: i.probe } : {}),
  });
  const entries = i.index?.entries ?? [];
  let P = 0;
  let X = 0;
  let n = 0;
  for (const e of entries) {
    const a = att.byKey.get(e.key);
    if (a === 'P') {
      P++;
      if (e.first_indexed_generation > i.ackGen) n++;
    } else if (a === 'X') X++;
  }
  const c = i.counts;
  let U = c?.unknown_keys_signals ?? 0;
  let N = 0;
  let K = 0;
  let M = 0;
  if (c !== null) {
    const days = last7Days(i.now);
    for (const [k, v] of Object.entries(c.per_key)) {
      const cls = att.classify(k);
      if (cls === 'U') U += v.signals_total;
      if (cls === 'P')
        for (const [d, x] of Object.entries(v.signals_by_day)) if (days.has(d)) N += x;
    }
    for (const cl of c.clusters) {
      let m = 0;
      for (const [k, v] of Object.entries(cl.evidence_by_key)) if (att.classify(k) === 'P') m += v;
      if (m >= c.cluster_min) K++;
    }
    for (const s of c.staged) {
      if (s.tainted) continue;
      if (s.evidence_keys.length > 0 && s.evidence_keys.every((k) => att.classify(k) === 'P')) {
        M += s.proposals;
      }
    }
  } else {
    for (const e of entries) if (att.classify(e.key) === 'U') U += e.signals;
  }
  return { N, K, M, P, n, X, U };
}

function parseAgentArg(argv: readonly string[]): RsiAgentId | undefined {
  if (argv.length !== 2 || argv[0] !== '--agent') return undefined;
  const id = argv[1];
  return (RSI_AGENT_IDS as readonly string[]).includes(id as string)
    ? (id as RsiAgentId)
    : undefined;
}

/** 只 lstat 判存在;无法确认 = 当作在场(→ 空串) */
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** 计算候选输出(不写盘);空串 = 不输出 */
async function compose(
  argv: readonly string[],
  env: Env,
  deps: RunHintDeps,
  over: () => boolean,
): Promise<{ text: string; agent: RsiAgentId; io: Parameters<typeof rsiDir>[0] } | null> {
  if (autoSkip(env, 'hint') !== null) return null;
  const agent = parseAgentArg(argv); // `--format`(P1)与其它参数一律空串(R20-3.3.5)
  if (agent === undefined) return null;
  const open = await openRsiIo(
    {
      argv: [],
      overlayPath: undefined,
      explicitRoot: undefined,
      env,
      ...(deps.writeAudit !== undefined ? { writeAudit: deps.writeAudit } : {}),
      stdout: () => undefined,
      stderr: () => undefined,
    },
    deps.open,
  );
  if (open.kind !== 'ready') return null;
  const { io, config } = open.ctx;
  if (config.block !== null) return null; // 停止采集(R20-2.8)
  if (!config.agents.includes(agent)) return null;
  if (over()) return null;

  const d = await rsiDirReadonly(io);
  if (d.kind === 'unsafe') return null;
  let stop = false;
  if (d.kind === 'ok') {
    if (await exists(path.join(d.dir, 'purge-journal.json'))) return null;
    stop = await exists(path.join(d.dir, 'STOP'));
  }
  const v = await readVerified(io, HINT_READ_NAMES);
  if (v.status !== 'ok' && v.status !== 'no_snapshot') return null;
  const get = (name: string): Buffer | null =>
    v.status === 'ok' ? (v.files.get(name) ?? null) : null;
  const doc = parseRsiStateDoc(get('state.json'));
  if (doc.kind === 'invalid') return null;
  if (over()) return null;
  const policy = await buildRsiPolicy(config);
  const identity = await loadRepoIdentity(config, policy);
  const st = rsiStateOf({ config, stopPresent: stop, doc, identity });
  const docState: Omit<RsiState, 'confirm'> | null =
    doc.kind === 'ok' || doc.kind === 'confirm_schema_invalid' ? doc.state : null;

  let text = '';
  if (st.state === 'armed') {
    const a = armedListingForHint(docState, policyFingerprint(policy), policy.agents);
    if (a === null) return null;
    text = armedTemplate(a.projects);
  } else if (st.state === 'confirmed') {
    const idxBytes = get('projects.json');
    let indexStatus: IndexStatus = 'absent';
    let index: RsiProjectIndex | null = null;
    if (idxBytes !== null) {
      const p = RsiProjectIndexSchema.safeParse(parseJson(idxBytes));
      if (!p.success) return null; // 索引损坏 → 空串(R20-3.3.1)
      indexStatus = 'ok';
      index = p.data;
    }
    const cntBytes = get('counts.json');
    let counts: RsiCounts | null = null;
    if (cntBytes !== null) {
      const p = RsiCountsSchema.safeParse(parseJson(cntBytes));
      if (!p.success) return null;
      counts = p.data;
    }
    const c = await hintCounts({
      config,
      indexStatus,
      index,
      counts,
      ackGen: docState?.projects_ack_generation ?? 0,
      now: (deps.now ?? ((): Date => new Date()))(),
      ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
    });
    if (!(c.K >= RSI_HINT_MIN_CLUSTERS || c.M >= 1 || c.n >= 1)) return null;
    text = confirmedTemplate(c);
  } else {
    return null;
  }
  const out = finalizeHint(text);
  if (out === '' || over()) return null;
  return { text: out, agent, io };
}

/** 返回要写到 stdout 的文本(空串 = 不输出)。从不抛错 */
export async function runHint(argv: readonly string[], deps: RunHintDeps = {}): Promise<string> {
  const clock = deps.clockMs ?? ((): number => Date.now());
  const t0 = clock();
  const over = (): boolean => clock() - t0 > RSI_HINT_BUDGET_MS;
  try {
    const env: Env = deps.env ?? {};
    const c = await compose(argv, env, deps, over);
    if (c === null) return '';
    // 去重(唯一写入):30 分钟窗口内同一 agent 只输出一次
    const nowMs = (deps.now ?? ((): Date => new Date()))().getTime();
    const dir = await rsiDir(c.io);
    const hintDir = path.join(dir, 'hint');
    await mkdirp(c.io, hintDir, RSI_DIR_MODE);
    try {
      await createExclusive(
        c.io,
        path.join(hintDir, `${c.agent}-${windowIndex(nowMs, RSI_HINT_DEDUP_MS)}`),
        '',
        RSI_FILE_MODE,
      );
    } catch {
      return '';
    }
    return c.text;
  } catch {
    return '';
  }
}

export const subcommand: RsiSubcommand = {
  name: 'hint',
  owner: 'A3',
  run: async (ctx) => {
    const text = await runHint(ctx.argv, {
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      ...(ctx.writeAudit !== undefined ? { writeAudit: ctx.writeAudit } : {}),
    });
    if (text !== '') ctx.stdout(text);
    return ExitCode.OK;
  },
};
