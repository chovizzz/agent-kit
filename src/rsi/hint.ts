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
 * `--canary`(R21-6.2 / R21-6.10 / R21-6.11,V1b):`--agent <id> --format <f> --canary`(必须带 `--format`;纯文本模式不走矩阵)。读集合再追加 `.state/rsi/{canary.json,
 * canary-admission.json,AUTO_PAUSE}` 与 HOME 侧 `rsi-personal/revocations.jsonl`(只读,见 `canary/permit-read.ts`);唯一多出的写入是分组账一行(`O_APPEND` + `fsync`)与探针票占用文件。
 * 计数行与 canary 部分**独立判定**、合并成一个 `additionalContext`(计数行 ≤ 200 + canary 部分 ≤ 1536 = 1736 字节)。
 *
 * 输出:模板之一加 `\n`,经唯一出口 {@link finalizeHint}(> 200 字节 → 空串);计数显示 `min(n, 9999)`,超过写 `9999+`。
 * 全部计算、字节校验与预算检查在去重写入**之前**完成;去重标记(`.state/rsi/hint/<agent>-<窗口>`,独占创建,`EEXIST` → 空串)是唯一的写入,
 * 输出空串的调用零写入。
 */
import * as path from 'node:path';
import { ExitCode } from '../contracts/exit-codes.js';
import {
  PRODUCTION_SHAPES,
  formatHintOutput,
  isHintFormat,
  type HintFormat,
} from '../contracts/rsi-hooks.js';
import {
  RSI_AGENT_IDS,
  RSI_AUTO_PHASE,
  RSI_DIR_MODE,
  RSI_FILE_MODE,
  RSI_HINT_BUDGET_MS,
  RSI_HINT_CANARY_TOTAL_MAX_BYTES,
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
import { getRealHome, type WriteAudit } from '../io/paths.js';
import { lstat } from '../io/read-fs.js';
import { createExclusive, mkdirp } from '../io/safe-fs.js';
import type { AttributionProbe, IndexStatus } from './attribution.js';
import { isAutoLoopEffective, resolveAutoConfig } from './auto-config.js';
import { runCanaryPart } from './canary/canary-hint.js';
import { makePermitPort } from './canary/permit-read.js';
import { cryptoBytes, cryptoUnit } from './canary/rng.js';
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
  /** `--canary`(R21-6.2):随机源、相位、HOME、agent 版本现算,全部可注入;缺省取生产实现 */
  random?: () => number;
  randomBytes?: (n: number) => Uint8Array;
  phase?: number;
  home?: string;
  /** 当前 agent 版本;`null` = 现算不出(契约未给 hint 的取版本方式,缺省恒为 null → 探针与准入一律 fail-closed) */
  agentVersion?: (agent: RsiAgentId) => string | null;
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
): { agent: RsiAgentId; format: HintFormat | undefined; canary: boolean } | undefined {
  if (argv.length !== 2 && argv.length !== 4 && argv.length !== 5) return undefined;
  if (argv[0] !== '--agent') return undefined;
  const id = argv[1];
  if (!(RSI_AGENT_IDS as readonly string[]).includes(id as string)) return undefined;
  if (argv.length === 2) return { agent: id as RsiAgentId, format: undefined, canary: false };
  const f = argv[3];
  if (argv[2] !== '--format' || f === undefined || !isHintFormat(f)) return undefined;
  // `--canary` 只接在 `--format <f>` 之后(R21-6.11:纯文本模式不走矩阵 → 没有 `--format` 的 `--canary` 是参数错误)
  if (argv.length === 5 && argv[4] !== '--canary') return undefined;
  return { agent: id as RsiAgentId, format: f, canary: argv.length === 5 };
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

interface Composed {
  /** 计数行(已过 `finalizeHint`);空串 = 本次没有计数行(只在 `--canary` 调用里出现,普通调用此时返回 null) */
  text: string;
  agent: RsiAgentId;
  format: HintFormat | undefined;
  io: Parameters<typeof rsiDir>[0];
  /** 仅 `--canary`:R21-6.11 第 1 行已放行(状态 confirmed、配置可用)后,canary 部分需要的现算值 */
  canary: null | {
    rsiDir: string;
    autoLoopEffective: boolean;
    policyFp: string;
  };
}

/** 计算候选输出(不写盘);`null` = 不输出 */
async function compose(
  argv: readonly string[],
  env: Env,
  deps: RunHintDeps,
  over: () => boolean,
): Promise<Composed | null> {
  if (autoSkip(env, 'hint') !== null) return null;
  const parsed = parseHintArgs(argv); // 其它参数一律空串(R20-3.3.5)
  if (parsed === undefined) return null;
  const { agent, format } = parsed;
  const wantCanary = parsed.canary;
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

  if (st.state !== 'armed' && st.state !== 'confirmed') return null;
  // 计数行(R20-3.3):`null` = 本次没有计数行(计数侧的任何失败 / 不够显示)。普通调用此时整体返回 null;
  // `--canary` 调用里它**不影响** canary 部分(R21-6.11:两部分独立判定)
  const count = await (async (): Promise<string | null> => {
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
    }
    const out = finalizeHint(text);
    return out === '' ? null : out;
  })();
  if (over()) return null;
  if (!wantCanary) return count === null ? null : { text: count, agent, format, io, canary: null };
  return {
    text: count ?? '',
    agent,
    format,
    io,
    // R21-6.11 第 1 行:只有 `confirmed`(且 `.state/rsi` 目录存在)才进入 canary 部分
    canary:
      st.state === 'confirmed' && d.kind === 'ok'
        ? {
            rsiDir: d.dir,
            autoLoopEffective: isAutoLoopEffective(
              true,
              resolveAutoConfig(config),
              deps.phase ?? RSI_AUTO_PHASE,
            ),
            policyFp: policyFingerprint(policy),
          }
        : null,
  };
}

/**
 * 计数行的去重(唯一的计数侧写入):30 分钟窗口内同一 agent 只输出一次。已有标记 → 只读判定即返回空串,不做任何写尝试。
 * 返回要输出的计数行(空串 = 本次不输出计数行)。
 */
async function dedupedCount(c: Composed, nowMs: number): Promise<string> {
  if (c.text === '') return '';
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
  return c.text;
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
    const now = deps.now ?? ((): Date => new Date());
    let countOut = '';
    try {
      countOut = await dedupedCount(c, now().getTime());
    } catch {
      // 计数行的写入失败只丢计数行;`--canary` 部分独立判定(R21-6.11)。普通调用此时 canary 部分不存在,结果仍是空串
      if (c.canary === null) return '';
    }
    let canaryOut = '';
    if (c.canary !== null) {
      // `--canary`(R21-6.2):不受 30 分钟去重约束;与计数行独立判定。canary 部分只在账行落盘之后才返回文本(未落账不注入)
      const shape = PRODUCTION_SHAPES[c.agent];
      canaryOut = await runCanaryPart({
        io: c.io,
        rsiDir: c.canary.rsiDir,
        agent: c.agent,
        autoLoopEffective: c.canary.autoLoopEffective,
        phase: deps.phase ?? RSI_AUTO_PHASE,
        policyFp: c.canary.policyFp,
        shapeVersion: shape.shape_version,
        agentVersion: (deps.agentVersion ?? ((): null => null))(c.agent),
        nowMs: now().getTime(),
        port: makePermitPort(c.canary.rsiDir, deps.home ?? getRealHome(env)),
        now,
        random: deps.random ?? cryptoUnit,
        randomBytes: deps.randomBytes ?? cryptoBytes,
        over,
      });
    }
    const combined = countOut + canaryOut;
    if (combined === '') return '';
    // 合计 ≤ 200 + 1536(R21-6.11);两部分各自已受限,这里是最后一道(超限不输出)
    if (
      c.canary !== null &&
      Buffer.byteLength(combined, 'utf8') > RSI_HINT_CANARY_TOTAL_MAX_BYTES
    ) {
      return '';
    }
    return c.format === undefined ? combined : formatHintOutput(c.format, combined);
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
