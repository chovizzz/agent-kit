/**
 * `agent-kit reflect`(R5,契约 #27–#29、docs/contracts.md §17):从信号库生成提案(暂存区 + apply.patch)。
 *
 * - **默认干跑**:装载/分类/聚类/构造提示并打印计划;**不构造后端、不调用后端、不写任何文件**。
 *   `--show-prompt` 只在干跑下把提示打到 stdout(不落盘);与 `--json`、`--run-llm` 互斥。
 * - **真跑**须同时:`--run-llm`、`--allow-egress`、覆盖层 `reflect.egress = true`、`--owner @handle`。
 *   缺 `--allow-egress` / 覆盖层未同意 / 缺 `--owner` → 退出 2,零调用零写入。
 * - 后端只经 `src/reflect/backends/index.ts` 的 `buildBackends`(本文件不 import llm-exec);
 *   工厂只在真跑时被调用。任何 CLI 参数集仍是 `verified:false`,默认拒绝真跑(R6 前)。
 * - 退出码:0 完成;1 输出被拒/整批不暂存;2 用法错;3 fail-closed(信号库损坏、提示复扫残留、
 *   厂商 unknown、写出口拒绝、未知异常);4 后端不可用/未配置/超出 --max-calls。多个结果走 `combineExitCodes`。
 * - stdout 只含计数、枚举、id、哈希(`--json` 为 canonical JSON);stderr 只含稳定码,不回显异常消息或任何文本。
 * - 数字参数一律 `parseDecimalUint`。
 * - **rsi/lock(R20-A2 B3b,契约 R20-5.1 / R20-5.2)**:谁拿锁——`--gc --write` 与 `--run-llm`(真跑),按 `lockGate` 判定:
 *   `[rsi]` 未启用 / 状态树确定独立 → 不拿锁、不建 `.state/rsi/`(逐字节同接线前);同一状态树 → 试锁(不排队),拿不到 `REFLECT_NOT_RUN reason=locked` 退出 4;
 *   状态目录无法证明安全 → `RSI_FAIL_CLOSED reason=state_dir_unsafe` 退出 3,不写任何东西。干跑与 `--gc`(无 `--write`)不拿锁。
 *   真跑的锁在**构造后端之前**拿、整个 LLM 调用期间持有(锁序 `rsi/lock` → `reflect/llm.lock`),LLM 返回后先 `assertHeld()` 再写暂存区;失锁 → `RSI_FAIL_CLOSED reason=lock_lost` 退出 3。
 *   本块只接锁:不更新 `counts.staged`、不做即时闸 / promote / signals collect 接线(B3c / B5)。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { computeBudget } from '../budget/budget.js';
import { AgentIdSchema, IsoDateSchema, RunIdSchema } from '../contracts/common.js';
import type { AgentId } from '../contracts/common.js';
import { OverlaySchema } from '../contracts/config.js';
import type { Overlay, ReflectBackendBinding } from '../contracts/config.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { JUDGE_HOP_CHAIN, JudgeHopIdSchema } from '../contracts/proposal.js';
import type { JudgeHopId } from '../contracts/proposal.js';
import type { Redactor } from '../contracts/redact.js';
import { KIT_VERSION } from '../contracts/meta.js';
import { canonicalJson } from '../io/canonical-json.js';
import { getRealHome } from '../io/paths.js';
import { readText, realpathSync, statSync } from '../io/read-fs.js';
import { WriteDeniedError } from '../io/safe-fs.js';
import { createRedactor } from '../redact/redactor.js';
import { loadExistingAtoms, loadStagedAtoms, loadUsedProposalIds } from '../reflect/atoms-index.js';
import type {
  LlmBackend,
  LlmCompleteRequest,
  LlmCompleteResult,
} from '../reflect/backend-iface.js';
import { loadRsiConfig } from '../rsi/config.js';
import type { RsiConfig } from '../rsi/config.js';
import { RsiLockError } from '../rsi/lock.js';
import type { RsiLockHandle } from '../rsi/lock.js';
import { RsiSnapshotBusyError } from '../rsi/exit.js';
import { RsiSnapshotError } from '../rsi/snapshot-read.js';
import { RsiStagingBlockedError, type ServiceHooks } from '../rsi/services/staging.js';
import { assertNoPurgeInProgress } from '../rsi/services/taint.js';
import { RsiFailClosedError } from '../rsi/types.js';
import { withRsiLockIfGated } from '../rsi/with-lock.js';
import type { WithRsiLockIfGatedOptions } from '../rsi/with-lock.js';
import { buildBackends, createSpawnBudget } from '../reflect/backends/index.js';
import { ReflectGcError, runReflectGc } from '../reflect/gc.js';
import type { GcResult } from '../reflect/gc.js';
import { runReflect } from '../reflect/run.js';
import type { ProjectCount, RunDeps, RunOpts, RunResult } from '../reflect/run.js';
import {
  ReflectAbortedError,
  ReflectCallLimitError,
  ReflectFailClosedError,
  ReflectUsageError,
} from '../reflect/types.js';
import type { BeforeWrite } from '../reflect/types.js';
import { SignalStoreError } from '../signals/state-store.js';
import { parseDecimalUint } from './args.js';
import { prepareBudgetInputs } from './check-budget.js';
import { enterWriterLock, serviceCtxOf, settleStaged } from './rsi-staged-wiring.js';
import { combineExitCodes } from './types.js';
import type { CommandContext, CommandDef } from './types.js';

export const DEFAULT_REFLECT_MAX_CALLS = 1;
export const REFLECT_HARD_MAX_CALLS = 3;
export const REFLECT_MAX_PROPOSALS = 5;
/** 脱敏每条每遍的时间预算:反思器要对整份提示复扫,取 5s(可经 deps 注入),避免负载抖动被当成泄露。 */
export const DEFAULT_REFLECT_REDACT_TIMEOUT_MS = 5000;
/** 干跑且未给 --owner 时的占位(runReflect 总要校验 owner;干跑不写任何文件,占位不会落盘)。 */
export const DRY_RUN_OWNER = '@dry-run';

export type CliBackends = Readonly<Partial<Record<JudgeHopId, LlmBackend>>>;

// ---------------------------------------------------------------------------
// rsi/lock 接线(R20-A2 B3b;契约 §20.5 R20-5.1 / R20-5.2、D1、D3)。reflect 与 judge 共用
// ---------------------------------------------------------------------------

/** 两个命令工厂共有的 rsi 锁注入点(测试用;缺省 = 读真实 `[rsi]` 配置、真实锁) */
export interface RsiLockWiring {
  /** 缺省 `loadRsiConfig({ env: ctx.env })`(只读,不建任何目录) */
  rsiConfig?: () => Promise<RsiConfig>;
  /** 透传给 `withRsiLockIfGated`(`gate` / `lock`:时钟、pid、isAlive 等) */
  lockDeps?: WithRsiLockIfGatedOptions;
  /**
   * 锁内、会新建暂存内容的写入方先调:purge 进行中抛 `RsiFailClosedError('purge_incomplete')`(journal 不合规 → `journal_invalid`)。
   * 缺省 = `src/rsi/services/taint.ts` 的 `assertNoPurgeInProgress`(只需 `{ io }`);测试可注入替身。只在闸门判 lock(拿到句柄)时调用。
   */
  assertNoPurge?: (ctx: { io: CommandContext['io'] }) => Promise<void>;
  /**
   * 测试缝(R20-A2 B5d):锁内 recover / resumeTaint / counts.staged 刷新 / 提交这几步的写点钩子(`before:<op>` 之前调用;抛错 = 在该点崩溃,
   * 换掉锁 nonce = 在该点失锁)。只在闸门判 lock(拿到句柄)时生效。
   */
  serviceHooks?: ServiceHooks;
}

/**
 * 写入方拿 `rsi/lock`:`lockGate` 判 off(没有 `[rsi]` / 未启用 / 状态树确定独立)→ `fn(null)`,不建 `.state/rsi/`、不写任何东西,
 * 行为与接线前逐字节一致;判 lock → 试锁(不排队)后 `fn(handle)`,返回即释放;判 refuse → 抛 `RsiFailClosedError`。
 * 锁序固定 `rsi/lock` → `reflect/llm.lock`:内层 `withLlmLock` 在 `fn` 里面,本函数不碰它。
 */
export async function withRsiWriterLock<T>(
  ctx: CommandContext,
  wiring: RsiLockWiring,
  fn: (lock: RsiLockHandle | null, config: RsiConfig) => Promise<T>,
): Promise<T> {
  const config =
    wiring.rsiConfig !== undefined
      ? await wiring.rsiConfig()
      : await loadRsiConfig(ctx.env !== undefined ? { env: ctx.env } : {});
  // 第二个参数把同一份 config 交给锁内步骤(B5d):服务层上下文与拿锁闸门同源,不再读第二遍
  return withRsiLockIfGated({ io: ctx.io, config }, (lock) => fn(lock, config), wiring.lockDeps);
}

/**
 * 拿锁相关失败的命令级稳定码(只报稳定码,不带异常消息):
 *  - 占用(`locked`)与超过 TTL 的占用(`locked_over_ttl`)→ `<PREFIX>_NOT_RUN reason=locked`,退出 4。D3 对命令级只登记 `locked`,
 *    所以 `locked_over_ttl` 也报 `locked`(**不**抢占、不删旧锁,只是对外码合并;区分要看 `rsi status` 的 `lock:` 行);
 *  - 其余(`state_dir_unsafe` / `lock_lost` / `write_denied` / `internal`,以及 gate 的 refuse)→ `RSI_FAIL_CLOSED reason=<原分类>`,退出 3。
 * 不是锁错误返回 undefined,交给调用方原有的错误映射。
 */
export function rsiLockFailure(
  e: unknown,
  prefix: 'REFLECT' | 'JUDGE',
): { line: string; exit: number } | undefined {
  if (e instanceof ReflectAbortedError) return rsiLockFailure(e.inner, prefix);
  if (e instanceof RsiLockError) {
    const s = e.toStable();
    if (s.code === 'RSI_NOT_RUN') {
      return { line: `${prefix}_NOT_RUN reason=locked\n`, exit: ExitCode.NOT_RUN };
    }
    return { line: `RSI_FAIL_CLOSED reason=${s.reason}\n`, exit: ExitCode.FAIL_CLOSED };
  }
  // 占线不是失败:与 stableOf / signals-collect 同口径退 4
  if (e instanceof RsiSnapshotBusyError) {
    return { line: `${prefix}_NOT_RUN reason=snapshot_busy\n`, exit: ExitCode.NOT_RUN };
  }
  if (
    e instanceof RsiFailClosedError ||
    e instanceof RsiSnapshotError ||
    e instanceof RsiStagingBlockedError // staging_unsafe_entry(resumeTaint 发现暂存区有无法处理的条目)
  ) {
    // RsiSnapshotError:锁内 `recoverUnderLock` 的 inspect 发现带病数据(snapshot_invalid / counts_invalid / signal_store_corrupt …),B5d 起 reflect / judge 会走到
    return { line: `RSI_FAIL_CLOSED reason=${e.reason}\n`, exit: ExitCode.FAIL_CLOSED };
  }
  return undefined;
}

/** `guardBackend` / `guardStoreFs` 共享的失锁记录:一旦 `lost` 有值,之后不再调用后端、不再写 */
export interface LockLossState {
  lost: RsiLockError | undefined;
}

/** 复核锁仍是自己的;失败 → 记入 `state`(保留原分类,非锁错误按 `internal`)并返回 false */
export async function checkHeld(lock: RsiLockHandle, state: LockLossState): Promise<boolean> {
  if (state.lost !== undefined) return false;
  try {
    await lock.assertHeld();
    return true;
  } catch (e) {
    state.lost = e instanceof RsiLockError ? e : new RsiLockError('internal');
    return false;
  }
}

/** 写前复核回调:每次实际写 / 删之前 `assertHeld`;失锁抛 `ReflectAbortedError(RsiLockError)`,调用链不得吞 */
export function beforeWriteOf(lock: RsiLockHandle, state: LockLossState): BeforeWrite {
  return async () => {
    if (!(await checkHeld(lock, state))) throw new ReflectAbortedError(state.lost);
  };
}

/**
 * 包一层后端:**LLM 返回后(成功、失败、抛错都一样)先 `assertHeld()` 再把结果交给调用方**(调用方随后才会写暂存区 / 提案)。
 * 复核失败:记入 `state.lost`,返回 `{ ok:false, reason:'error' }`(runReflect / runJudge 把后端抛错吞成 backend_error,
 * 这里不抛,免得调用方把它当成普通后端故障去写 pending 记录);`state.lost` 已有值时之后的调用直接返回失败、不再外发。
 * 命令在 runReflect / runJudge 返回(或抛错)后必须先看 `state.lost` 并改报 `RSI_FAIL_CLOSED reason=lock_lost`。
 */
export function guardBackend(
  backend: LlmBackend,
  lock: RsiLockHandle,
  state: LockLossState,
  onLost: 'result' | 'throw' = 'result',
): LlmBackend {
  const failed: LlmCompleteResult = { ok: false, reason: 'error' };
  return {
    slot: backend.slot,
    vendor: backend.vendor,
    model: backend.model,
    cli: backend.cli,
    provider: backend.provider,
    async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
      // 外发前也复核:失锁后不再把摘录发出去(`state.lost` 一旦置位保持到命令结束)
      // reflect 用 'throw':失锁走 ReflectAbortedError,runReflect 原样重抛,不写 report.json;judge 用 'result'(其写出口另有 storeFs 守卫)
      const lostResult = (): LlmCompleteResult => {
        if (onLost === 'throw') throw new ReflectAbortedError(state.lost);
        return failed;
      };
      if (!(await checkHeld(lock, state))) return lostResult();
      let res: LlmCompleteResult;
      try {
        res = await backend.complete(req);
      } catch (e) {
        await checkHeld(lock, state);
        if (state.lost !== undefined) return lostResult();
        throw e;
      }
      return (await checkHeld(lock, state)) ? res : lostResult();
    },
  };
}

// ---------------------------------------------------------------------------
// 与 judge 共用的接线辅助
// ---------------------------------------------------------------------------

/** 覆盖层 `reflect` 段里用户**显式写了**的 core 上限键(schema 默认值不算):用来分清「覆盖层的值」和「默认值」。 */
export type ExplicitLimit = 'max_calls' | 'max_proposals' | 'timeout_ms';
export type OverlayLoad =
  { ok: true; overlay: Overlay | undefined; explicit: ReadonlySet<ExplicitLimit> } | { ok: false };

/** 读覆盖层(只经 `--overlay` 显式传入)。失败不回显内容:覆盖层本身就是敏感词表。 */
export async function loadOverlay(ctx: CommandContext): Promise<OverlayLoad> {
  if (ctx.overlayPath === undefined) return { ok: true, overlay: undefined, explicit: new Set() };
  try {
    const raw = parseToml(await readText(ctx.overlayPath));
    const section = (raw as { reflect?: Record<string, unknown> }).reflect;
    const explicit = new Set<ExplicitLimit>(
      (['max_calls', 'max_proposals', 'timeout_ms'] as const).filter(
        (k) => section !== undefined && typeof section === 'object' && k in section,
      ),
    );
    return { ok: true, overlay: OverlaySchema.parse(raw), explicit };
  } catch {
    return { ok: false };
  }
}

/** 覆盖层 `reflect.egress`:缺省/缺覆盖层 = false(摘录不得离开本机)。 */
export function overlayAllowsEgress(overlay: Overlay | undefined): boolean {
  return overlay?.reflect?.egress === true;
}

/**
 * 子进程环境的来源。命令层不能读 `process.env`(eslint:只许 `src/io/paths.ts`):
 * 测试 / `main(argv, env)` 注入了 `ctx.env` 就用它(PATH 缺省取 `IoContext.execPath`,HOME 缺省取 `getRealHome()`);
 * 没有注入(真实 CLI 路径)就取 `ctx.io.hostEnv`——`paths.ts` 按名字白名单收窄过的那份,其 HOME 始终是 `getRealHome()`(contracts §12.4 ④)。
 */
export function hostEnvOf(ctx: CommandContext): Record<string, string | undefined> {
  if (ctx.env === undefined) return { ...ctx.io.hostEnv };
  const src = ctx.env;
  return {
    ...src,
    PATH: src['PATH'] ?? ctx.io.execPath,
    HOME: src['HOME'] ?? getRealHome(ctx.env),
  };
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `child` 是否在 `parent` 之内(大小写与 Unicode 形式折叠后比较,宁可多拒)。 */
function isInside(parent: string, child: string): boolean {
  const fold = (x: string): string => x.normalize('NFC').toLowerCase();
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 在 PATH 的绝对项里找 `<cli>` 的可执行常规文件。与后端同一规则:相对项、指进仓库的项(KIT_TMP 内除外)一律跳过,
 * 这样放行清单里不会出现仓库里的二进制。
 */
function resolveBinary(
  cli: string,
  pathEnv: string,
  io: { repoRoot: string; tmpDir: string | undefined },
): string | undefined {
  const repo = realOrSelf(io.repoRoot);
  const tmp = io.tmpDir === undefined ? undefined : realOrSelf(io.tmpDir);
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const real = realOrSelf(dir);
    if (isInside(repo, real) && !(tmp !== undefined && isInside(tmp, real))) continue;
    const c = path.join(dir, cli);
    try {
      const st = statSync(c);
      if (st.isFile() && (st.mode & 0o111) !== 0) return c;
    } catch {
      // 下一项
    }
  }
  return undefined;
}

export interface BuildCliBackendsInput {
  readonly ctx: CommandContext;
  readonly overlay: Overlay | undefined;
  readonly now: () => Date;
  /** spawn 预算上限(≤10) */
  readonly maxSpawns: number;
}

/**
 * 真实后端接线:覆盖层 → `buildBackends`。**只在 `--run-llm --allow-egress` 时调用**(干跑不构造)。
 * - 返回的只含**已绑定**的槽位(未绑定的占位后端被剔除,调用方据此判断「没有可用后端」);
 * - 同一 state 目录进程内只能创建一次 spawn 预算(`createSpawnBudget`),重复创建会抛错;
 * - `allow_unverified` 是**逐槽位**的:分两组各调一次 `buildBackends`,只有显式写了 `allow_unverified = true`
 *   的槽位所在那组拿到 `allowUnverified` 清单(其 CLI 二进制的绝对路径),其余槽位的清单恒为空;
 * - `allowEgress: true` 由调用方保证(用户同时给了 `--run-llm --allow-egress` 且覆盖层同意)。
 */
export function buildCliBackends(input: BuildCliBackendsInput): CliBackends {
  const { ctx, overlay, now, maxSpawns } = input;
  const bindings = overlay?.reflect?.backends ?? [];
  if (bindings.length === 0) return {};
  const budget = createSpawnBudget(ctx.io, maxSpawns);
  const envSource = hostEnvOf(ctx);
  const out: Partial<Record<JudgeHopId, LlmBackend>> = {};
  for (const allow of [false, true]) {
    const group: ReflectBackendBinding[] = bindings.filter(
      (b) => (b.allow_unverified === true) === allow,
    );
    if (group.length === 0) continue;
    const allowUnverified = allow
      ? group
          .map((b) => resolveBinary(b.cli, envSource['PATH'] ?? '', ctx.io))
          .filter((p): p is string => p !== undefined)
      : [];
    const chain = buildBackends(
      {
        backends: group,
        reset_tz: overlay?.reflect?.reset_tz ?? 'UTC',
        vendor_overrides: overlay?.reflect?.vendor_overrides ?? {},
      },
      { ctx: ctx.io, now, budget, envSource, allowEgress: true, allowUnverified },
    );
    for (const b of group) {
      const hop = JUDGE_HOP_CHAIN.indexOf(b.slot);
      const backend = chain[hop];
      if (backend !== undefined && out[b.slot] === undefined) out[b.slot] = backend;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface Parsed {
  agents: AgentId[];
  since: string | undefined;
  maxProposals: number | undefined;
  runLlm: boolean;
  allowEgress: boolean;
  backend: JudgeHopId | undefined;
  maxCalls: number | undefined;
  timeoutMs: number | undefined;
  owner: string | undefined;
  showPrompt: boolean;
  json: boolean;
  gc: boolean;
  write: boolean;
  /** 出现过 gc / write / json 以外的任何参数(gc 与其它模式互斥) */
  otherFlags: boolean;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    agents: [],
    since: undefined,
    maxProposals: undefined,
    runLlm: false,
    allowEgress: false,
    backend: undefined,
    maxCalls: undefined,
    timeoutMs: undefined,
    owner: undefined,
    showPrompt: false,
    json: false,
    gc: false,
    write: false,
    otherFlags: false,
    error: undefined,
  };
  const fail = (m: string): void => {
    if (out.error === undefined) out.error = m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
          fail(`${name} 需要一个值`);
          return undefined;
        }
        i++;
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    if (a === '--gc') out.gc = true;
    else if (a === '--write') out.write = true;
    else if (a === '--run-llm') {
      out.runLlm = true;
      out.otherFlags = true;
    } else if (a === '--allow-egress') {
      out.allowEgress = true;
      out.otherFlags = true;
    } else if (a === '--show-prompt') {
      out.showPrompt = true;
      out.otherFlags = true;
    } else if (a === '--json') out.json = true;
    else {
      out.otherFlags = true;
      const agent = value('--agent');
      if (agent !== undefined) {
        const p = AgentIdSchema.safeParse(agent);
        if (p.success) out.agents.push(p.data);
        else fail(`未知 agent:${agent}`);
        continue;
      }
      const since = value('--since');
      if (since !== undefined) {
        if (IsoDateSchema.safeParse(since).success) out.since = since;
        else fail('--since 需要 YYYY-MM-DD');
        continue;
      }
      const mp = value('--max-proposals');
      if (mp !== undefined) {
        const n = parseDecimalUint(mp);
        if (n === undefined || n < 1 || n > REFLECT_MAX_PROPOSALS) {
          fail(`--max-proposals 需要 1..${REFLECT_MAX_PROPOSALS} 的十进制整数`);
        } else out.maxProposals = n;
        continue;
      }
      const mc = value('--max-calls');
      if (mc !== undefined) {
        const n = parseDecimalUint(mc);
        if (n === undefined || n < 1 || n > REFLECT_HARD_MAX_CALLS) {
          fail(`--max-calls 需要 1..${REFLECT_HARD_MAX_CALLS} 的十进制整数`);
        } else out.maxCalls = n;
        continue;
      }
      const tm = value('--timeout-ms');
      if (tm !== undefined) {
        const n = parseDecimalUint(tm);
        if (n === undefined || n < 1000 || n > 600_000) {
          fail('--timeout-ms 需要 1000..600000 的十进制整数');
        } else out.timeoutMs = n;
        continue;
      }
      const backend = value('--backend');
      if (backend !== undefined) {
        const p = JudgeHopIdSchema.safeParse(backend);
        if (p.success) out.backend = p.data;
        else fail(`未知后端槽位:${backend}`);
        continue;
      }
      const owner = value('--owner');
      if (owner !== undefined) {
        out.owner = owner;
        continue;
      }
      fail(`未知参数:${a}`);
    }
  }
  if (out.error === undefined) {
    if (out.gc && out.otherFlags) out.error = '--gc 与其它模式互斥(只允许 --write / --json)';
    else if (out.write && !out.gc) out.error = '--write 只用于 --gc';
    else if (out.showPrompt && out.runLlm)
      out.error = '--show-prompt 只在干跑下可用(与 --run-llm 互斥)';
    else if (out.showPrompt && out.json)
      out.error = '--show-prompt 与 --json 互斥(--json 摘要绝不含任何文本)';
    else if (out.runLlm && !out.allowEgress) {
      out.error = '--run-llm 必须同时给 --allow-egress:已脱敏的摘录将离开本机,发送给所选后端的厂商';
    } else if (out.runLlm && out.owner === undefined) {
      out.error = '--run-llm 需要 --owner @handle(暂存的原子要有负责人)';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export interface ReflectCommandDeps extends RsiLockWiring {
  /** 时钟;缺省真实时间 */
  clock?: () => Date;
  /** 随机源:返回 n 字节的十六进制串(run_id 后缀);缺省 node:crypto */
  randomHex?: (bytes: number) => string;
  /** 缺省 `runReflect` */
  runReflect?: (deps: RunDeps, opts: RunOpts) => Promise<RunResult>;
  /**
   * 后端工厂。**只在真跑(--run-llm --allow-egress 且覆盖层同意)时调用**;返回「槽位 → 后端」,只含已配置的槽位。
   * 缺省 = 按覆盖层的 `reflect.backends` 经 `buildBackends` 构造真实 CLI 后端。
   */
  createBackends?(
    ctx: CommandContext,
    input: { overlay: Overlay | undefined; maxCalls: number; now: () => Date },
  ): CliBackends | Promise<CliBackends>;
  /** 测试注入;缺省按覆盖层建真实 Redactor */
  redactor?: Pick<Redactor, 'pass2'>;
  redactTimeoutMs?: number;
  /** 测试用:把提案标成 stub 产物(命令行没有对应开关) */
  stub?: boolean;
}

const SAFE_ENUM_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const safeEnum = (s: string | undefined): string | undefined =>
  s !== undefined && SAFE_ENUM_RE.test(s) ? s : undefined;

/** 退出码映射。`ReflectUsageError`→2;`ReflectFailClosedError`/`SignalStoreError`/`WriteDeniedError`→3;`ReflectCallLimitError`→4;其余未知异常→3。 */
export function reflectErrorExit(e: unknown): { code: number; reason: string } {
  if (e instanceof ReflectUsageError) return { code: ExitCode.USAGE, reason: e.code };
  if (e instanceof ReflectCallLimitError) return { code: ExitCode.NOT_RUN, reason: e.code };
  if (e instanceof ReflectFailClosedError) return { code: ExitCode.FAIL_CLOSED, reason: e.code };
  if (e instanceof SignalStoreError) return { code: ExitCode.FAIL_CLOSED, reason: 'SIGNAL_STORE' };
  if (e instanceof WriteDeniedError) return { code: ExitCode.FAIL_CLOSED, reason: e.code };
  return { code: ExitCode.FAIL_CLOSED, reason: 'internal' };
}

type BudgetState = 'ok' | 'full' | 'unknown';

function newRunId(now: Date, rnd: (bytes: number) => string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `run-${stamp}-${rnd(3)}`;
}

function summaryOf(
  r: RunResult,
  extra: { budget: BudgetState; plannedBackend: string | null; exit: number },
): Record<string, unknown> {
  const rep = r.report;
  return {
    run_id: rep.run_id,
    mode: rep.mode,
    outcome: rep.outcome,
    exit_code: extra.exit,
    signals: {
      loaded: rep.signals_loaded,
      dropped_schema: rep.signals_dropped.schema,
      dropped_residual: rep.signals_dropped.residual,
      external_excerpt_forced: rep.signals_dropped.external_excerpt_forced,
      structure_unknown: r.plan.structure_unknown,
      // 仅 >0 时出现,保持旧输出形状
      ...(r.load.filtered_future > 0 ? { filtered_future: r.load.filtered_future } : {}),
    },
    plan: {
      clusters: r.plan.clusters,
      evidence: r.plan.evidence,
      evidence_truncated: r.plan.evidence_truncated,
      batches: r.plan.batches,
      calls_needed: r.plan.calls_needed,
      exceeds_call_limit: r.plan.exceeds_call_limit,
    },
    prompt: { bytes: rep.prompt_bytes, sha256: rep.prompt_sha256, input_digest: rep.input_digest },
    backend: rep.backend,
    planned_backend: extra.plannedBackend,
    calls: { made: rep.calls_made, limit: rep.calls_limit },
    budget: extra.budget,
    rejected: rep.rejected,
    staged: rep.staged,
    duplicates: r.duplicates.length,
    observations: rep.observations_n,
    guardrail_mentions: r.guardrailMentions,
    // 仅干跑且有信号时出现(旧字段与旧形状不变);只含加盐哈希 id 与计数
    ...(rep.mode === 'dry' && r.projectCounts.length > 0
      ? { project_key_counts: r.projectCounts }
      : {}),
  };
}

function humanLines(s: Record<string, unknown>): string {
  const g = <T>(k: string): T => s[k] as T;
  const sig = g<Record<string, number>>('signals');
  const plan = g<Record<string, number | boolean>>('plan');
  const prompt = g<Record<string, unknown>>('prompt');
  const calls = g<Record<string, number>>('calls');
  const backend = g<{ slot: string; vendor: string; model: string } | null>('backend');
  const rejected = Object.entries(g<Record<string, number>>('rejected'))
    .map(([k, n]) => `${k}=${n}`)
    .join(',');
  const counts = s['project_key_counts'] as ProjectCount[] | undefined;
  return (
    [
      `reflect: run=${String(s['run_id'])} mode=${String(s['mode'])} outcome=${String(s['outcome'])} exit=${String(s['exit_code'])}`,
      `signals: loaded=${sig['loaded']} dropped_schema=${sig['dropped_schema']} dropped_residual=${sig['dropped_residual']} external_excerpt_forced=${sig['external_excerpt_forced']} structure_unknown=${sig['structure_unknown']}${sig['filtered_future'] !== undefined ? ` filtered_future=${sig['filtered_future']}` : ''}`,
      `plan: clusters=${plan['clusters']} evidence=${plan['evidence']} truncated=${plan['evidence_truncated']} batches=${plan['batches']} calls_needed=${plan['calls_needed']} exceeds_call_limit=${String(plan['exceeds_call_limit'])}`,
      `prompt: bytes=${String(prompt['bytes'])} sha256=${String(prompt['sha256'])}`,
      `backend: ${backend === null ? `none planned=${String(s['planned_backend'])}` : `slot=${backend.slot} vendor=${backend.vendor} model=${backend.model}`}`,
      `calls: made=${calls['made']} limit=${calls['limit']} budget=${String(s['budget'])}`,
      `staged: ${g<string[]>('staged').join(',') || '-'}`,
      `rejected: ${rejected || '-'}`,
      ...(counts === undefined
        ? []
        : [
            'project_keys(填入覆盖层 reflect.team_project_keys 即允许该项目进团队层;只有哈希 id 与计数):',
            ...counts.map((c) => `  ${c.project_key} sessions=${c.sessions} signals=${c.signals}`),
          ]),
    ].join('\n') + '\n'
  );
}

const safeRunId = (id: string): string => (RunIdSchema.safeParse(id).success ? id : '-');

function gcJson(r: GcResult): Record<string, unknown> {
  return {
    mode: 'gc',
    write: r.write,
    retention_days: r.retentionDays,
    scanned: r.scanned,
    candidates: r.candidates.map((c) => ({
      run_id: safeRunId(c.runId),
      reason: c.reason,
      bytes: c.bytes,
    })),
    kept: r.kept.map((k) => ({ run_id: safeRunId(k.runId), reason: k.reason })),
    deleted: [...r.deleted],
    bytes: r.candidates.reduce((n, c) => n + c.bytes, 0),
  };
}

function gcLines(r: GcResult): string {
  const bytes = r.candidates.reduce((n, c) => n + c.bytes, 0);
  const verb = r.write ? 'did_delete' : 'would_delete';
  return (
    [
      `reflect gc: mode=${r.write ? 'write' : 'dry'} retention_days=${r.retentionDays} scanned=${r.scanned} candidates=${r.candidates.length} kept=${r.kept.length} deleted=${r.deleted.length} bytes=${bytes}`,
      ...r.candidates.map(
        (c) =>
          `${r.write && !r.deleted.includes(c.runId) ? 'skip_delete' : verb} run=${safeRunId(c.runId)} reason=${c.reason} bytes=${c.bytes}`,
      ),
      ...r.kept.map((k) => `keep run=${safeRunId(k.runId)} reason=${k.reason}`),
    ].join('\n') + '\n'
  );
}

async function runGc(
  ctx: CommandContext,
  args: Parsed,
  clock: () => Date,
  wiring: RsiLockWiring,
): Promise<number> {
  try {
    // 干跑零写入:不读 rsi 配置、不拿锁;只有 --write(真删)才按闸门拿 rsi/lock,覆盖整个 runReflectGc
    const res = args.write
      ? await withRsiWriterLock(ctx, wiring, async (lock) => {
          await lock?.assertHeld();
          const out = await runReflectGc(ctx.io, clock(), {
            write: true,
            ...(lock !== null ? { beforeDelete: beforeWriteOf(lock, { lost: undefined }) } : {}),
          });
          // 返回前最后复核一次:锁已不属于自己 = lock_lost(退出 3),不输出成功摘要
          await lock?.assertHeld();
          return out;
        })
      : await runReflectGc(ctx.io, clock(), { write: false });
    ctx.stdout(args.json ? canonicalJson(gcJson(res)) : gcLines(res));
    return ExitCode.OK;
  } catch (e) {
    const locked = rsiLockFailure(e, 'REFLECT');
    if (locked !== undefined) {
      ctx.stderr(locked.line);
      return locked.exit;
    }
    const reason =
      e instanceof ReflectGcError || e instanceof WriteDeniedError ? e.code : 'internal';
    ctx.stderr(`REFLECT_FAIL_CLOSED reason=${reason}\n`); // 只报稳定码
    return ExitCode.FAIL_CLOSED;
  }
}

export function createReflectCommand(deps: ReflectCommandDeps = {}): CommandDef {
  const clock = deps.clock ?? ((): Date => new Date());
  const randomHex = deps.randomHex ?? ((n: number): string => randomBytes(n).toString('hex'));
  const doReflect = deps.runReflect ?? runReflect;
  const def: CommandDef = {
    name: 'reflect',
    summary: '反思器:从信号生成提案(默认干跑;暂存区 + apply.patch)',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      { name: '--agent <id>', description: '(可重复)只处理该 agent 的信号;缺省 = 全部' },
      { name: '--since <YYYY-MM-DD>', description: '只处理该日期及之后的信号' },
      { name: '--max-proposals <n>', description: '本批提案数上限,1..5,默认 5' },
      {
        name: '--run-llm',
        description:
          '真跑:调用后端(须同时给 --allow-egress 与 --owner,且覆盖层 reflect.egress=true);缺省干跑',
      },
      { name: '--allow-egress', description: '同意把已脱敏摘录发送给所选后端的厂商' },
      { name: '--backend <slot>', description: '后端槽位;已配置多个槽位时必填' },
      { name: '--max-calls <n>', description: '本次最多调用后端次数,默认 1,上限 3' },
      { name: '--timeout-ms <n>', description: '单次调用超时,1000..600000,默认 180000' },
      { name: '--owner <@handle>', description: '暂存原子的负责人;--run-llm 必填' },
      { name: '--show-prompt', description: '仅干跑:把提示打到 stdout(不落盘);与 --json 互斥' },
      { name: '--json', description: '输出 canonical JSON 摘要(只含计数、枚举、id、哈希)' },
      {
        name: '--gc',
        description:
          '回收暂存区:只清已过期(30 天)且无引用、仅含 report.json 的 run;默认干跑,与其它模式互斥',
      },
      { name: '--write', description: '仅 --gc:真正删除(缺省只列出将删除的 run)' },
    ],
    async run(rawCtx: CommandContext): Promise<number> {
      const ctx = rawCtx;
      const args = parseArgs(ctx.argv);
      if (args.error !== undefined) {
        ctx.stderr(`agent-kit reflect: ${args.error}\n`);
        return ExitCode.USAGE;
      }
      if (args.gc) return runGc(ctx, args, clock, deps);
      const live = args.runLlm && args.allowEgress;

      const loaded = await loadOverlay(ctx);
      if (!loaded.ok) {
        ctx.stderr('agent-kit reflect: 覆盖层读取或校验失败\n'); // 不回显覆盖层内容
        return ExitCode.USAGE;
      }
      const overlay = loaded.overlay;
      if (live && !overlayAllowsEgress(overlay)) {
        ctx.stderr(
          'agent-kit reflect: 覆盖层未同意外发(reflect.egress = true 才允许摘录离开本机);未调用、未写入\n',
        );
        return ExitCode.USAGE;
      }

      let redactor = deps.redactor;
      if (redactor === undefined) {
        try {
          redactor = createRedactor(
            {
              sensitive_words: overlay?.sensitive_words ?? [],
              timeout_ms: deps.redactTimeoutMs ?? DEFAULT_REFLECT_REDACT_TIMEOUT_MS,
            },
            { internalDomains: overlay?.internal_domains ?? [] },
          );
        } catch {
          ctx.stderr('REFLECT_FAIL_CLOSED reason=redactor_init\n');
          return ExitCode.FAIL_CLOSED;
        }
      }

      // 预算(budgetFull):算不出来时,干跑只标 unknown;真跑 fail-closed(不知道预算就不暂存)
      let budget: BudgetState = 'unknown';
      let kitReflect: { max_calls?: number; max_proposals?: number; timeout_ms?: number } = {};
      try {
        const prepared = await prepareBudgetInputs(ctx.io.repoRoot, () => undefined);
        if (prepared.inputs !== undefined) {
          const report = computeBudget({
            outputs: prepared.inputs.rendered.files,
            config: prepared.inputs.config.budget,
          });
          budget = report.targets.some((t) => t.level !== 'ok') ? 'full' : 'ok';
          kitReflect = prepared.inputs.config.reflect ?? {};
        }
      } catch {
        budget = 'unknown';
      }
      if (live && budget === 'unknown') {
        ctx.stderr('REFLECT_FAIL_CLOSED reason=budget_unavailable\n');
        return ExitCode.FAIL_CLOSED;
      }

      // 优先级:命令行 > 覆盖层里显式写的值 > kit.toml 的 [reflect] > 内置默认。
      // (覆盖层 schema 给这三项套了默认值,不看「是否显式写过」就会盖掉 kit.toml 的上限。)
      const ov = overlay?.reflect;
      const explicit = loaded.explicit;
      const maxCalls =
        args.maxCalls ??
        (explicit.has('max_calls') ? ov?.max_calls : undefined) ??
        kitReflect.max_calls ??
        DEFAULT_REFLECT_MAX_CALLS;
      const maxProposals =
        args.maxProposals ??
        (explicit.has('max_proposals') ? ov?.max_proposals : undefined) ??
        kitReflect.max_proposals ??
        REFLECT_MAX_PROPOSALS;
      const timeoutMs =
        args.timeoutMs ??
        (explicit.has('timeout_ms') ? ov?.timeout_ms : undefined) ??
        kitReflect.timeout_ms;

      // 预算已满:真跑不必调用后端(调用了摘录也白发一次,结果还是整批不暂存)
      if (live && budget === 'full') {
        ctx.stderr('REFLECT_BUDGET_FULL: 目标预算已满,不调用后端、未写入\n');
        return ExitCode.CHECK_FAILED;
      }

      try {
        // 真跑(live)才拿 rsi/lock,且在**构造后端之前**拿:覆盖读已有/暂存原子、LLM 调用、写暂存区;锁序 rsi/lock → reflect/llm.lock
        // (内层 withLlmLock 在 runReflect 的后端里,不变)。干跑不读 rsi 配置、不拿锁。
        const loss: LockLossState = { lost: undefined };
        const execute = async (lock: RsiLockHandle | null, cfg?: RsiConfig): Promise<number> => {
          // 锁内、建任何暂存内容之前(B5d,方案 §8):recoverUnderLock → resumeTaint(补完上一次中断的提交与 taint),然后 purge 进行中拒绝(assertNoPurgeInProgress)。
          // 与 judge 的顺序故意不同(judge 在 assertNoPurge 之后):有 purge journal 时 reflect 先补完 taint(合法 journal 的目标也会被标记 / 清理)再拒绝;journal 不合规 / 读不出由 resumeTaint 抛 journal_invalid / purge_incomplete
          const sctx = lock !== null ? serviceCtxOf(ctx, cfg, clock) : undefined;
          if (lock !== null && sctx !== undefined)
            await enterWriterLock(sctx, lock, deps.serviceHooks);
          if (lock !== null) await (deps.assertNoPurge ?? assertNoPurgeInProgress)({ io: ctx.io });
          const now = clock();
          let backend: LlmBackend | undefined;
          if (live) {
            const backends = await (deps.createBackends ?? defaultCreateBackends)(ctx, {
              overlay,
              maxCalls,
              now: clock,
            });
            const bound = JUDGE_HOP_CHAIN.filter((h) => backends[h] !== undefined);
            let slot: JudgeHopId | undefined = args.backend;
            if (slot === undefined) {
              if (bound.length > 1) {
                ctx.stderr(
                  `agent-kit reflect: 已配置 ${bound.length} 个后端槽位,须用 --backend <slot> 指定(不自动挑选:摘录将发给所选厂商)\n`,
                );
                return ExitCode.USAGE;
              }
              slot = bound[0];
            }
            backend = slot === undefined ? undefined : backends[slot];
            if (backend === undefined) {
              ctx.stderr('REFLECT_NOT_RUN reason=backend_not_configured\n'); // 未调用、未写入
              return ExitCode.NOT_RUN;
            }
            // LLM 返回后先 assertHeld 再往下写暂存区(见 guardBackend);lock 为 null(闸门 off)时不包,行为不变
            if (lock !== null) backend = guardBackend(backend, lock, loss, 'throw');
            ctx.stderr(
              `REFLECT_EGRESS slot=${safeEnum(backend.slot) ?? '?'} vendor=${safeEnum(backend.vendor) ?? '?'}\n`,
            );
          }

          const runDeps: RunDeps = {
            io: ctx.io,
            redactor,
            clock,
            ...(backend !== undefined ? { backend } : {}),
            existingAtoms: await loadExistingAtoms(ctx.io),
            stagedAtoms: await loadStagedAtoms(ctx.io),
            usedProposalIds: await loadUsedProposalIds(ctx.io),
            kitVersion: KIT_VERSION,
            // 每个实际写出口(报告 / 暂存文件 / 建目录 / 最终 rename)之前复核锁;闸门 off 不传,行为不变
            ...(lock !== null ? { beforeWrite: beforeWriteOf(lock, loss) } : {}),
          };
          const result = await doReflect(runDeps, {
            mode: live ? (deps.stub === true ? 'stub' : 'llm') : 'dry',
            runId: newRunId(now, randomHex),
            owner: args.owner ?? DRY_RUN_OWNER,
            since: args.since,
            agents: args.agents.length > 0 ? args.agents : undefined,
            maxProposals,
            maxCalls,
            timeoutMs,
            allowEgress: live,
            teamProjectKeys: new Set(ov?.team_project_keys ?? []),
            budgetFull: budget === 'full',
            includePrompt: args.showPrompt,
          });
          if (loss.lost !== undefined) throw loss.lost; // 失锁:不打印摘要,改报 RSI_FAIL_CLOSED reason=lock_lost
          // 暂存区写完之后、同一把锁内更新 counts.staged(只在真的暂存了 run 时;失败 / 无提案的运行不动 counts)。失败 → 稳定码退 3,不打印摘要
          if (lock !== null && sctx !== undefined && result.staged !== undefined) {
            await settleStaged(sctx, lock, redactor, deps.serviceHooks);
          }

          const exit = combineExitCodes([result.exitCode]);
          const bindings = overlay?.reflect?.backends ?? [];
          const planned =
            args.backend !== undefined
              ? bindings.find((b) => b.slot === args.backend)
              : bindings.length === 1
                ? bindings[0]
                : undefined;
          const summary = summaryOf(result, {
            budget,
            plannedBackend: live || planned === undefined ? null : `${planned.slot}/${planned.cli}`,
            exit,
          });
          if (args.json) ctx.stdout(canonicalJson(summary));
          else ctx.stdout(humanLines(summary));
          if (args.showPrompt) {
            // 仅干跑;提示文本只到 stdout,不落盘
            for (const p of result.prompts ?? []) ctx.stdout(`${p.system}\n\n${p.user}\n`);
          }
          const failure = safeEnum(result.backendFailure);
          if (failure !== undefined) ctx.stderr(`REFLECT_NOT_RUN reason=backend_${failure}\n`);
          return exit;
        };
        return live ? await withRsiWriterLock(ctx, deps, execute) : await execute(null);
      } catch (e) {
        const locked = rsiLockFailure(e, 'REFLECT');
        if (locked !== undefined) {
          ctx.stderr(locked.line);
          return locked.exit;
        }
        const { code, reason } = reflectErrorExit(e);
        const tag =
          code === ExitCode.USAGE ? 'USAGE' : code === ExitCode.NOT_RUN ? 'NOT_RUN' : 'FAIL_CLOSED';
        ctx.stderr(`REFLECT_${tag} reason=${reason}\n`); // 只报稳定码,不带异常消息
        return combineExitCodes([code]);
      }
    },
  };
  return def;
}

function defaultCreateBackends(
  ctx: CommandContext,
  input: { overlay: Overlay | undefined; maxCalls: number; now: () => Date },
): CliBackends {
  return buildCliBackends({
    ctx,
    overlay: input.overlay,
    now: input.now,
    maxSpawns: input.maxCalls,
  });
}

export const command: CommandDef = createReflectCommand();
