/**
 * 提醒一次(契约 R20-17.11–R20-17.15;A6)。根入口在命令返回、命令自身的锁全部释放之后调用(`src/update/launcher.ts` 的 `launchAndSchedule`),
 * 与 update 的提示、RSI 顺带调度**各自隔离异常**;本函数从不抛错、不改命令退出码、不输出到 stdout。
 *
 * 触发条件(R20-17.12,全部满足才进入;任一不满足 → 零读 `reflect/`、零写入、不拿锁):
 *  stdin 与 stderr 都是 TTY;不是 R20-1.6 的跳过情形(`KIT_AUTO_RSI=0` / `KIT_RSI_CHILD=1` / CI);本次命令不是 `rsi poke` / `rsi hint` / 钩子入口;
 *  状态为 `confirmed`(有效确认、无停止标记);配置无 collect block;不存在 `purge-journal.json`。`armed` / `stopped` 一律不提醒。
 * 两行提示(stderr,各一行,不含路径 / run_id / 提案正文):先采集、后提案。
 *  - `RSI_COLLECTION_STARTED projects=P excluded=X`:`confirm.baseline_pending = false` 且 `notice.json` 的 `collection_started_for` ≠ 当前确认时刻;
 *  - `RSI_PROPOSALS_READY runs=N proposals=M`:只计待通知 run(R20-17.3),N = 0 不输出;`notice_full`(R20-17.14a)时不发、不新增已通知。
 * 记账(R20-17.14):**先写后印**。非阻塞试拿 `rsi/lock` 一次(拿不到 → 不提示、不记账);拿到 → 锁内重算 → 写 `notice.json` → 放锁 → 打印。
 * 承诺是「每个 run 至多一次尝试展示」:写完后崩溃或 stderr 写失败会漏提示,不会重复。`notice.json` 损坏 → 不覆盖、不重建、不提醒。
 * 预算(R20-17.15):尽力 ≤ 200ms,一个截止时间贯穿锁前、锁内与每个写点(`writeAccountingFile` 在 assertHeld 之后、实际写入之前复核);
 * 超出即放弃且此后零写入(释放自己持有的锁不算记账写入)。
 * 放弃只放弃本次、下次命令再试,没有重试上限:触发条件满足之后、写 `notice.json` 之前的任何放弃(预算 / 锁被占 / 锁内复检失效 / 扫描未知)都是零写;
 * 暂存区很大或机器很忙时可能迟迟不提示。失败一律静默;A6i-3:不写 log.jsonl,除「写尝试失败」(`write_failed`,原因被合并)外,
 * `locked` / `over_budget` / `not_eligible` / `error` 都没有任何持久痕迹;status / D17 的 warning 呈现的是**状态**(`notice.json` 损坏 / 满),不是本次放弃
 * (是否扩大窄记账例外去写日志待主代理拍板)。跳过命令清单(R20-17.12)目前分散在 `skip.ts`(环境类)与本文件的 `isHookCommand`(命令类),见 A6i。
 */
import * as path from 'node:path';
import {
  RSI_NOTICE_BUDGET_MS,
  RSI_NOTICE_LOG_CODES,
  RSI_NOTICE_LOG_DEDUP_MS,
  RSI_NOTICE_LOG_READ_MAX_BYTES,
  RsiLogLineSchema,
  type RsiNotice,
  type RsiNoticeLogCode,
} from '../contracts/rsi.js';
import { canonicalJsonLine } from '../io/canonical-json.js';
import type { IoContext, WriteAudit } from '../io/paths.js';
import { lstat, readFileSafe } from '../io/read-fs.js';
import { appendFile } from '../io/safe-fs.js';
import type { AttributionProbe, IndexStatus } from './attribution.js';
import { RsiCountsSchema, RsiProjectIndexSchema } from '../contracts/rsi.js';
import { acquireRsiLock, type RsiLockDeps } from './lock.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from './lock-read.js';
import {
  noticeFull,
  readDismissed,
  readNotice,
  scanPending,
  type RunRef,
  type ScanDeps,
} from './pending.js';
import { projectStats } from './project-stats.js';
import { AccountingDeadlineError, writeAccountingFile } from './services/fixed-write.js';
import { observeRsi } from './services/observe.js';
import { openRsiIo, type OpenRsiIoDeps } from './services/open.js';
import type { ServiceHooks } from './services/staging.js';
import { autoSkip } from './skip.js';
import { readVerified } from './snapshot-read.js';
import type { RsiServiceCtx } from './types.js';

type Env = Readonly<Record<string, string | undefined>>;

const NOTICE_READ_NAMES = ['state.json', 'projects.json', 'counts.json'] as const;

export interface NoticeInput {
  argv: readonly string[];
  env: Env;
  /** stdin 与 stderr 都是 TTY */
  isTty: boolean;
  stderr: (t: string) => void;
  writeAudit?: WriteAudit;
}

export interface NoticeDeps {
  now?: () => Date;
  /** 墙钟毫秒(预算用) */
  clockMs?: () => number;
  open?: OpenRsiIoDeps;
  probe?: AttributionProbe;
  lock?: RsiLockDeps;
  hooks?: ServiceHooks;
  /** 测试缝:覆盖扫描上限(默认上限下 `notice_full` 不可达:S ∪ T ⊆ 仍存在的目录 ≤ 1000,见 A6i-12) */
  scanLimits?: ScanDeps['limits'];
  /** 测试缝:各检查点(`first_eval` / `read_reflect` / `locked` / `second_eval`)到达时调用,用来推进注入时钟或断言「零读 reflect/」 */
  point?: (name: string) => void;
}

export type NoticeOutcome =
  | { kind: 'skipped'; why: string }
  | { kind: 'nothing' }
  | { kind: 'not_recorded'; why: string }
  | { kind: 'printed'; lines: string[] };

/** 命令名与子命令(跳过带值的全局选项 `--root` / `--overlay`,与启动器同口径) */
function commandAndSub(argv: readonly string[]): {
  name: string | undefined;
  sub: string | undefined;
} {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--root' || a === '--overlay') {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    return { name: a, sub: argv[i + 1] };
  }
  return { name: undefined, sub: undefined };
}

/** 本次命令是钩子形状(`rsi poke` / `rsi hint` / `__rsi`)→ 不提醒(R20-17.12) */
export function isHookCommand(argv: readonly string[]): boolean {
  const { name, sub } = commandAndSub(argv);
  return name === '__rsi' || (name === 'rsi' && (sub === 'poke' || sub === 'hint'));
}

interface Eval {
  confirmedAt: string;
  collectionDue: boolean;
  projects: number;
  excluded: number;
  toNotify: readonly RunRef[];
  notice: { proposals_notified: string[]; collection_started_for: string | null };
  dirNames: ReadonlySet<string>;
}

function parseJson(b: Buffer): unknown {
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'; // 无法确认 = 当作在场
  }
}

/**
 * 全部判定(无副作用):返回 `null` = 不提醒(任一触发条件不满足、读不了、`notice.json` 损坏、扫描未知、超时)。
 * 锁外一次、锁内一次(锁内为权威),两次用同一份代码。
 */
async function evaluate(
  sctx: RsiServiceCtx,
  env: Env,
  deps: NoticeDeps,
  over: () => boolean,
): Promise<Eval | null> {
  const { io, config } = sctx;
  const obs = await observeRsi(io, env);
  if (
    obs.state.state !== 'confirmed' ||
    obs.state.collectBlocked !== null ||
    obs.state.stateInvalid ||
    obs.stop !== 'absent' ||
    obs.doc.kind !== 'ok' ||
    obs.doc.state.confirm === null
  ) {
    return null;
  }
  const confirm = obs.doc.state.confirm;
  const d = await rsiDirReadonly(io);
  if (d.kind !== 'ok') return null;
  if (await exists(path.join(d.dir, 'purge-journal.json'))) return null;
  if (over()) return null;

  const v = await readVerified(io, NOTICE_READ_NAMES);
  if (v.status !== 'ok') return null;
  const idxBytes = v.files.get('projects.json') ?? null;
  let indexStatus: IndexStatus = 'absent';
  let index = null;
  if (idxBytes !== null) {
    const p = RsiProjectIndexSchema.safeParse(parseJson(idxBytes));
    if (!p.success) return null;
    indexStatus = 'ok';
    index = p.data;
  }
  const cntBytes = v.files.get('counts.json') ?? null;
  let counts = null;
  if (cntBytes !== null) {
    const p = RsiCountsSchema.safeParse(parseJson(cntBytes));
    if (!p.success) return null;
    counts = p.data;
  }
  const notice = await readNotice(d.dir);
  if (notice.kind === 'invalid') return null; // 不覆盖、不重建、不提醒
  const dismissed = await readDismissed(d.dir);
  if (over()) return null;

  const stats = await projectStats({
    config,
    indexStatus,
    index,
    counts,
    ackGen: obs.doc.state.projects_ack_generation,
    now: (deps.now ?? ((): Date => new Date()))(),
    ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
  });
  if (over()) return null;
  const doc = notice.notice ?? {
    schema_version: 1 as const,
    proposals_notified: [] as string[],
    collection_started_for: null,
  };
  deps.point?.('read_reflect');
  const scan = await scanPending(
    {
      stateDir: path.dirname(d.dir),
      staged: counts?.staged ?? [],
      classify: stats.classify,
      dismissed: dismissed.ids,
      notified: new Set(doc.proposals_notified),
    },
    { over, ...(deps.scanLimits !== undefined ? { limits: deps.scanLimits } : {}) },
  );
  if (!scan.known || over()) return null;
  const full = noticeFull(doc.proposals_notified, scan.dirNames, scan.toNotify);
  return {
    confirmedAt: confirm.confirmed_at,
    collectionDue:
      confirm.baseline_pending === false && doc.collection_started_for !== confirm.confirmed_at,
    projects: stats.P,
    excluded: stats.X,
    toNotify: full ? [] : scan.toNotify,
    notice: doc,
    dirNames: scan.dirNames,
  };
}

const nothingToSay = (e: Eval): boolean => !e.collectionDue && e.toNotify.length === 0;

/**
 * 提醒一次(R20-17.11–17.15)。放弃(本应提醒却没提醒成)时另记一行 `log.jsonl`(A6 订正 #1,见 {@link logNoticeGiveUp});
 * 跳过分支(非 TTY、环境跳过、钩子命令、配置不可用、不满足触发条件)与「没有要说的」不写。返回值不受日志成败影响。
 */
export async function runRsiNotice(
  input: NoticeInput,
  deps: NoticeDeps = {},
): Promise<NoticeOutcome> {
  const holder: { io?: IoContext } = {};
  const out = await runNoticeCore(input, deps, holder);
  const code = giveUpCode(out);
  if (code !== null && holder.io !== undefined) {
    await logNoticeGiveUp(holder.io, code, (deps.now ?? ((): Date => new Date()))()).catch(
      () => undefined,
    );
  }
  return out;
}

function giveUpCode(out: NoticeOutcome): RsiNoticeLogCode | null {
  if (out.kind === 'not_recorded') {
    return (RSI_NOTICE_LOG_CODES as readonly string[]).includes(out.why)
      ? (out.why as RsiNoticeLogCode)
      : 'internal';
  }
  if (out.kind === 'skipped' && out.why === 'error') return 'internal';
  return null;
}

/**
 * 放弃日志(A6 订正 #1):锁已释放(或从未拿到)之后,无锁 `O_APPEND` 追加一行 `{at, trigger:notice, action:skipped, code}`
 * (R20-5.1 锁矩阵的「`log.jsonl` 单行追加」)。只在 `rsi/` 通过只读安全校验时写,不建目录、不修权限;
 * 去重:`log.jsonl`(有界、句柄级安全读取)里 30 分钟内已有同 `code` 的提醒放弃行 → 不追加;读不了 / 不安全 → 不写(宁可少记)。
 */
export async function logNoticeGiveUp(
  io: IoContext,
  code: RsiNoticeLogCode,
  now: Date,
): Promise<void> {
  const d = await rsiDirReadonly(io);
  if (d.kind !== 'ok') return;
  const file = path.join(d.dir, 'log.jsonl');
  const r = await readFileSafe(file, {
    maxBytes: RSI_NOTICE_LOG_READ_MAX_BYTES,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind !== 'ok' && r.kind !== 'missing') return;
  if (r.kind === 'ok') {
    for (const l of r.bytes.toString('utf8').split('\n')) {
      if (l === '') continue;
      const v = parseJson(Buffer.from(l, 'utf8')) as
        { trigger?: unknown; code?: unknown; at?: unknown } | undefined;
      if (v?.trigger !== 'notice' || v.code !== code || typeof v.at !== 'string') continue;
      const age = now.getTime() - Date.parse(v.at);
      if (age >= 0 && age < RSI_NOTICE_LOG_DEDUP_MS) return;
    }
  }
  const line = canonicalJsonLine(
    RsiLogLineSchema.parse({ at: now.toISOString(), trigger: 'notice', action: 'skipped', code }),
  );
  await appendFile(io, file, line, { mode: 0o600 });
}

async function runNoticeCore(
  input: NoticeInput,
  deps: NoticeDeps,
  holder: { io?: IoContext },
): Promise<NoticeOutcome> {
  try {
    if (!input.isTty) return { kind: 'skipped', why: 'not_tty' };
    if (autoSkip(input.env, 'hint') !== null) return { kind: 'skipped', why: 'auto_skip' };
    if (isHookCommand(input.argv)) return { kind: 'skipped', why: 'hook_command' };

    const clock = deps.clockMs ?? ((): number => Date.now());
    const t0 = clock();
    const over = (): boolean => clock() - t0 > RSI_NOTICE_BUDGET_MS;

    const open = await openRsiIo(
      {
        argv: [],
        overlayPath: undefined,
        explicitRoot: undefined,
        env: input.env,
        ...(input.writeAudit !== undefined ? { writeAudit: input.writeAudit } : {}),
        stdout: () => undefined,
        stderr: () => undefined,
      },
      deps.open,
    );
    if (open.kind !== 'ready') return { kind: 'skipped', why: 'config' };
    holder.io = open.ctx.io;
    if (over()) return { kind: 'not_recorded', why: 'over_budget' };
    const sctx: RsiServiceCtx = {
      ...open.ctx,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };

    deps.point?.('first_eval');
    const first = await evaluate(sctx, input.env, deps, over);
    if (first === null) return { kind: 'skipped', why: 'not_eligible' };
    if (nothingToSay(first)) return { kind: 'nothing' };
    if (over()) return { kind: 'not_recorded', why: 'over_budget' };

    // 非阻塞试拿 rsi/lock 一次:拿不到 → 本次不提示、不记账
    let lock;
    try {
      lock = await acquireRsiLock(sctx.io, deps.lock);
    } catch {
      return { kind: 'not_recorded', why: 'locked' };
    }
    let lines: string[];
    try {
      deps.point?.('locked');
      if (over()) return { kind: 'not_recorded', why: 'over_budget' };
      const e = await evaluate(sctx, input.env, deps, over);
      if (e === null) return { kind: 'not_recorded', why: 'not_eligible' };
      if (nothingToSay(e)) return { kind: 'nothing' };
      deps.point?.('second_eval');
      const cleaned = e.notice.proposals_notified.filter((id) => e.dirNames.has(id));
      const notified = [...new Set([...cleaned, ...e.toNotify.map((r) => r.runId)])].sort();
      const doc: RsiNotice = {
        schema_version: 1,
        proposals_notified: notified,
        collection_started_for: e.collectionDue ? e.confirmedAt : e.notice.collection_started_for,
      };
      try {
        await writeAccountingFile(
          sctx,
          lock,
          { name: 'notice.json', doc },
          { ...(deps.hooks !== undefined ? { hooks: deps.hooks } : {}), overDeadline: over },
        );
      } catch (err) {
        return {
          kind: 'not_recorded',
          why: err instanceof AccountingDeadlineError ? 'over_budget' : 'write_failed',
        };
      }
      lines = [];
      if (e.collectionDue) {
        lines.push(`RSI_COLLECTION_STARTED projects=${e.projects} excluded=${e.excluded}\n`);
      }
      if (e.toNotify.length > 0) {
        const proposals = e.toNotify.reduce((n, r) => n + r.proposals, 0);
        lines.push(`RSI_PROPOSALS_READY runs=${e.toNotify.length} proposals=${proposals}\n`);
      }
    } finally {
      await lock.release().catch(() => undefined);
    }
    // 先写后印:记账已落盘、锁已放,才写 stderr
    for (const l of lines) input.stderr(l);
    return { kind: 'printed', lines };
  } catch {
    return { kind: 'skipped', why: 'error' };
  }
}
