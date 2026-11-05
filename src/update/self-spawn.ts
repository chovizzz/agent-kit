/**
 * 钩子入口的零网络 `runSelf` 桥接(R20-A0 起;D-AU1 / D-AU2 扩充;docs/contracts.md §20.1 R20-1.1、§20.9 第 3 条 ①②、§20.19)。
 *
 * 为什么单独一个文件:`launcher.ts` 经 `install.ts` 传递引入 `io/net.ts`(还有 registry / provenance / sigstore),
 * 而 poke / hint / `__rsi --background` / 各前台 rsi 命令从入口起算的 import 传递闭包**不得**含网络出口(R20-1.1)。
 * 钩子要起 worker、要转发到 `current`,就只能走这里:本文件只引用 `io/exec.ts`(`runSelf`)、零网络只读的 `installed.ts` /
 * `auto-install.ts` / `policy.ts` / `signal-code.ts`,**不得**引用 `install.ts` / `registry.ts` / `provenance.ts` / `launcher.ts` /
 * `net.ts` / `home-fs.ts`(eslint 对本文件的授权块只放行 `runSelf`,不放行这些;`test/rsi/import-closure.test.ts` 另从多个入口起算断言闭包里没有它们;
 * `test/update/self-spawn.test.ts` 钉桥接的调用形状)。
 *
 * 三个出口:
 *  - {@link spawnRsiWorker}:`target: self` 起 `__rsi --background`(R20-A0,形状不变)。
 *  - {@link forwardHookToCurrent}(D-AU1,取代 Q25-A):钩子执行自身逻辑前,按与启动器**同一份**判据 `decideCurrent`(完整树校验)
 *    尝试把整条钩子命令转发到 `current`;任何一环不满足 → 静默用自己(不输出 `UPDATE_CURRENT_BROKEN`)。
 *  - {@link spawnUpdateWorker}(D-AU2):poke 在满足调度谓词时零网络、零写入地 detached 拉起 `__update --background`。
 *
 * 其余约束都在 `runSelf` 里:不经 shell、不继承 NODE_OPTIONS、环境走具名白名单;
 * `cwd` 固定为调用方给的仓库根(须为绝对、规范、真实目录);`PI_CODING_AGENT_DIR` 只传「已设置」这一事实(`KIT_RSI_PI_DIR_SET=1`)。
 */
import { KIT_VERSION } from '../contracts/meta.js';
import {
  RunSelfDeniedError,
  runSelf,
  type RunSelfRefusal,
  type RunSelfResult,
} from '../io/exec.js';
import { readAutoInstall } from './auto-install.js';
import {
  checkControlledTmp,
  decideCurrent,
  pickWorkerTarget,
  readUpdateState,
  type DecideCurrentDeps,
} from './installed.js';
import { checkDue, hookUpdateGate } from './policy.js';
import { signalCode } from './signal-code.js';

type Env = Readonly<Record<string, string | undefined>>;

/** worker 的参数是固定的单一形状;`__rsi` 只接受它(别的参数退出 2,§20.3) */
export const RSI_WORKER_ARGS: readonly string[] = ['__rsi', '--background'];

export interface RsiWorkerInput {
  /** 已校验的真实 HOME(runSelf 据此推出安装目录并强制子进程 HOME) */
  home: string;
  /** `realpath([rsi] repo)`:worker 的固定 cwd。是否等于配置值由调用方(`src/rsi/config.ts`)保证 */
  repo: string;
  /** 调用方环境(只取 `RUN_SELF_ENV_KEYS` 里的具名键;`PI_CODING_AGENT_DIR` 只折成存在性标志) */
  env: Env;
}

export interface RsiWorkerDeps {
  /** 测试注入:替换 runSelf(记录调用参数 / 模拟拒绝) */
  runSelf?: typeof runSelf;
  nodeVersion?: string;
}

export type RsiWorkerResult =
  { spawned: true } | { spawned: false; why: RunSelfRefusal | 'denied' | 'threw' };

/**
 * 以 detached、stdio 丢弃的方式起一个 `__rsi --background` worker,不等待。**从不抛错、不写任何文件**:
 * 失败只返回 `spawned: false`,调用方(poke / 顺带调度)据此静默放弃,不改变用户命令的退出码。
 */
export function spawnRsiWorker(input: RsiWorkerInput, deps: RsiWorkerDeps = {}): RsiWorkerResult {
  let r: RunSelfResult;
  try {
    r = (deps.runSelf ?? runSelf)({
      home: input.home,
      target: { kind: 'self' },
      args: RSI_WORKER_ARGS,
      env: input.env,
      background: true,
      cwd: input.repo,
      ...(deps.nodeVersion !== undefined ? { nodeVersion: deps.nodeVersion } : {}),
    });
  } catch (e) {
    return { spawned: false, why: e instanceof RunSelfDeniedError ? 'denied' : 'threw' };
  }
  return r.spawned ? { spawned: true } : { spawned: false, why: r.reason };
}

// ---------------------------------------------------------------------------
// D-AU1:钩子转发到 current
// ---------------------------------------------------------------------------

/** 钩子转发的超时(poke / hint 在宿主的会话生命周期里被同步调用,不能无限等;`__rsi` 不设) */
export const HOOK_FORWARD_TIMEOUT_MS = 10_000;

export interface ForwardHookInput {
  /** 原样转发的整条钩子命令行(`rsi poke --agent x` / `rsi hint …` / `__rsi --background`) */
  argv: readonly string[];
  /** 真实 HOME(必须是绝对路径,否则不转发) */
  home: string;
  env: Env;
  /** 缺省 {@link HOOK_FORWARD_TIMEOUT_MS};`null` = 不设超时(`__rsi`) */
  timeoutMs?: number | null;
}

export interface ForwardHookDeps {
  runSelf?: typeof runSelf;
  ownVersion?: string;
  nodeVersion?: string;
  decide?: DecideCurrentDeps;
}

/**
 * 已转发:`code` 是子进程退出码(被信号终止 / 超时折成 128+signo);**子进程一旦 spawn 成功就不回退重跑**(与 `launchCurrent` 同)。
 * 没转发:调用方继续用自己。从不抛、从不输出(stdout / stderr 的透传只来自子进程本身)。
 */
export type ForwardHookResult = { forwarded: true; code: number } | { forwarded: false };

export async function forwardHookToCurrent(
  input: ForwardHookInput,
  deps: ForwardHookDeps = {},
): Promise<ForwardHookResult> {
  try {
    const d = await decideCurrent(
      { home: input.home, env: input.env, own: deps.ownVersion ?? KIT_VERSION },
      deps.decide,
    );
    if (!d.launch) return { forwarded: false };
    const timeoutMs = input.timeoutMs === undefined ? HOOK_FORWARD_TIMEOUT_MS : input.timeoutMs;
    const run: RunSelfResult = (deps.runSelf ?? runSelf)({
      home: input.home,
      target: { kind: 'current', version: d.version },
      args: input.argv,
      env: input.env,
      ...(timeoutMs !== null ? { timeoutMs } : {}),
      ...(deps.nodeVersion !== undefined ? { nodeVersion: deps.nodeVersion } : {}),
    });
    if (!run.spawned) return { forwarded: false };
    return { forwarded: true, code: run.status ?? signalCode(run.signal) };
  } catch {
    return { forwarded: false };
  }
}

// ---------------------------------------------------------------------------
// D-AU2:poke 顺带调度 update worker
// ---------------------------------------------------------------------------

export interface UpdateWorkerInput {
  home: string;
  env: Env;
}

export interface UpdateWorkerDeps {
  runSelf?: typeof runSelf;
  nodeVersion?: string;
  now?: () => Date;
  decide?: Pick<DecideCurrentDeps, 'readCurrent' | 'verifyTree'>;
}

export type UpdateWorkerResult =
  | { scheduled: true }
  | {
      scheduled: false;
      why: 'gate' | 'config' | 'state' | 'throttled' | 'tmp' | RunSelfRefusal | 'denied' | 'threw';
    };

/**
 * 以 detached、stdio 丢弃的方式起一个 `__update --background` worker,不等待。**零网络、零写入**:
 * 谓词依次为 `hookUpdateGate`(KIT_AUTO_UPDATE / CI)→ 状态可读 → `checkDue`(24h 节流)→ `auto_install`(`readAutoInstall`,再过 gate)→ 受控 TMPDIR **已存在且合格**
 * (只读 {@link checkControlledTmp},不创建;创建由前台命令的 `ensureControlledTmp` 完成)。worker 自己会在锁内再查节流与配置,
 * 所以并发的多个 poke 至多多起几个会立即 `skipped_locked` / `skipped_throttled` 的 worker(D-AU2 / M5)。
 * 从不抛错:失败只返回 `scheduled: false`。
 */
export async function spawnUpdateWorker(
  input: UpdateWorkerInput,
  deps: UpdateWorkerDeps = {},
): Promise<UpdateWorkerResult> {
  try {
    // 由便宜到贵:不碰盘的环境开关 → 状态 + 节流(常见情形在这里就结束)→ config.toml(auto_install)→ 受控 tmp
    if (!hookUpdateGate({ env: input.env, autoInstall: true }).enabled) {
      return { scheduled: false, why: 'gate' };
    }
    const st = await readUpdateState(input.home);
    if (st.kind === 'unsafe' || st.kind === 'unreadable') return { scheduled: false, why: 'state' };
    const nowMs = (deps.now ?? ((): Date => new Date()))().getTime();
    if (!checkDue(st.kind === 'ok' ? st.state.last_check_at : undefined, nowMs).due) {
      return { scheduled: false, why: 'throttled' };
    }
    const cfg = await readAutoInstall(input.home);
    if (!cfg.ok) return { scheduled: false, why: 'config' };
    if (!hookUpdateGate({ env: input.env, autoInstall: cfg.autoInstall }).enabled) {
      return { scheduled: false, why: 'gate' };
    }
    const tmp = await checkControlledTmp(input.home);
    if (tmp === undefined) return { scheduled: false, why: 'tmp' };
    const target = await pickWorkerTarget(input.home, st, deps.decide);
    const r = (deps.runSelf ?? runSelf)({
      home: input.home,
      target,
      args: UPDATE_WORKER_ARGS,
      env: input.env,
      tmpDir: tmp,
      background: true,
      ...(deps.nodeVersion !== undefined ? { nodeVersion: deps.nodeVersion } : {}),
    });
    return r.spawned ? { scheduled: true } : { scheduled: false, why: r.reason };
  } catch (e) {
    return { scheduled: false, why: e instanceof RunSelfDeniedError ? 'denied' : 'threw' };
  }
}

/** update worker 的固定参数形状(与启动器 `scheduleBackground` 一致) */
export const UPDATE_WORKER_ARGS: readonly string[] = ['__update', '--background'];
