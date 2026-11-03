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
 * A6(订正 ⑥):读集合追加 `<stateDir>/reflect/` 的直接子项列举、暂存 run 的 `report.json`(受 R20-17.4 上限)与 `.state/rsi/dismissed.json`;**不读** `notice.json`、不读 run 里的其它文件。
 * **不读**盐、信号库、会话计数、会话根、`cursor.json`、STOP 内容;不拿锁。计数由 `counts.json` + 当前配置 + 当前索引现算(R20-4.6),
 * 盐指纹只用 `projects.json` 与 `counts.json` 各自的 `salt_fp` 互相核对(`attribution.ts`)。
 *
 * 输出:模板之一加 `\n`,经唯一出口 {@link finalizeHint}(> 200 字节 → 空串);计数显示 `min(n, 9999)`,超过写 `9999+`。
 * 全部计算、字节校验与预算检查在去重写入**之前**完成;去重标记(`.state/rsi/hint/<agent>-<窗口>`,独占创建,`EEXIST` → 空串)是唯一的写入,
 * 输出空串的调用零写入。
 */
import * as path from 'node:path';
import { ExitCode } from '../contracts/exit-codes.js';
import { formatHintOutput, isHintFormat, type HintFormat } from '../contracts/rsi-hooks.js';
import {
  RSI_AGENT_IDS,
  RSI_DIR_MODE,
  RSI_FILE_MODE,
  RSI_HINT_BUDGET_MS,
  RSI_HINT_COUNT_CAP,
  RSI_HINT_DEDUP_MS,
  RSI_HINT_MAX_BYTES,
  RSI_HINT_MIN_CLUSTERS,
  RSI_HINT_STAGING_FULL_LINE,
  RSI_STAGING_MAX_RUNS,
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
import type { AttributionProbe, IndexStatus } from './attribution.js';
import { buildRsiPolicy, policyFingerprint } from './config.js';
import { armedListingForHint } from './l0/armed-listing.js';
import { rsiDirReadonly } from './lock-read.js';
import { rsiDir } from './rsi-dir.js';
import { windowIndex } from './services/breaker.js';
import { readDismissed, scanPending } from './pending.js';
import { projectStats } from './project-stats.js';
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
  /** 待审 run(R20-17.2)里的提案数 */
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

function parseJson(b: Buffer): unknown {
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 参数:`--agent <id>`,或 `--agent <id> --format <claude-json|codex-json>`(R20-3.3.5,A5)。其余一律视为参数错误(空串)。
 * `--format` 只改输出的包装(见 `formatHintOutput`),文本内容与 200 字节上限不变。
 */
function parseHintArgs(
  argv: readonly string[],
): { agent: RsiAgentId; format: HintFormat | undefined } | undefined {
  if (argv.length !== 2 && argv.length !== 4) return undefined;
  if (argv[0] !== '--agent') return undefined;
  const id = argv[1];
  if (!(RSI_AGENT_IDS as readonly string[]).includes(id as string)) return undefined;
  if (argv.length === 2) return { agent: id as RsiAgentId, format: undefined };
  const f = argv[3];
  if (argv[2] !== '--format' || f === undefined || !isHintFormat(f)) return undefined;
  return { agent: id as RsiAgentId, format: f };
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
): Promise<{
  text: string;
  agent: RsiAgentId;
  format: HintFormat | undefined;
  io: Parameters<typeof rsiDir>[0];
} | null> {
  if (autoSkip(env, 'hint') !== null) return null;
  const parsed = parseHintArgs(argv); // 其它参数一律空串(R20-3.3.5)
  if (parsed === undefined) return null;
  const { agent, format } = parsed;
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
    const stats = await projectStats({
      config,
      indexStatus,
      index,
      counts,
      ackGen: docState?.projects_ack_generation ?? 0,
      now: (deps.now ?? ((): Date => new Date()))(),
      ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
    });
    // R20-17.16 / R20-17.4:M = 待审 run 里的提案数(排除已忽略);读取集合追加 `reflect/` 子项列举、各 run 的 report.json、dismissed.json(订正 ⑥)。
    // hint 不读 notice.json。扫描结果未知(子项过多 / 总读取超限)→ 本次空输出,零写入。
    const dismissed = await readDismissed(d.kind === 'ok' ? d.dir : null);
    const scan = await scanPending(
      {
        stateDir: d.kind === 'ok' ? path.dirname(d.dir) : io.stateDir,
        staged: counts?.staged ?? [],
        classify: stats.classify,
        dismissed: dismissed.ids,
        notified: null,
      },
      { over },
    );
    if (!scan.known) return null;
    if (over()) return null;
    // R20-17.17:暂存 run 目录数达到上限 → 换成一行满区提示(只数目录,不扫字节;不暗示 dismiss 能释放容量)
    if (scan.runDirs >= RSI_STAGING_MAX_RUNS) {
      text = RSI_HINT_STAGING_FULL_LINE;
    } else {
      const M = scan.pending.reduce((sum, r) => sum + r.proposals, 0);
      const c: HintCounts = {
        N: stats.N,
        K: stats.K,
        M,
        P: stats.P,
        n: stats.n,
        X: stats.X,
        U: stats.U,
      };
      if (!(c.K >= RSI_HINT_MIN_CLUSTERS || c.M >= 1 || c.n >= 1)) return null;
      text = confirmedTemplate(c);
    }
  } else {
    return null;
  }
  const out = finalizeHint(text);
  if (out === '' || over()) return null;
  return { text: out, agent, format, io };
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
    // 去重(唯一写入):30 分钟窗口内同一 agent 只输出一次。已有标记 → 只读判定即返回空串,不做任何写尝试
    const nowMs = (deps.now ?? ((): Date => new Date()))().getTime();
    const markerName = `${c.agent}-${windowIndex(nowMs, RSI_HINT_DEDUP_MS)}`;
    const ro = await rsiDirReadonly(c.io);
    if (ro.kind === 'unsafe') return '';
    if (ro.kind === 'ok' && (await exists(path.join(ro.dir, 'hint', markerName)))) return '';
    const dir = await rsiDir(c.io);
    const hintDir = path.join(dir, 'hint');
    await mkdirp(c.io, hintDir, RSI_DIR_MODE);
    try {
      await createExclusive(c.io, path.join(hintDir, markerName), '', RSI_FILE_MODE);
    } catch {
      return '';
    }
    return c.format === undefined ? c.text : formatHintOutput(c.format, c.text);
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
