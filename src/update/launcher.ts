/**
 * 启动器(S7c-B;docs/contracts.md §19.5「启动器」)。**唯一能引用 `io/exec.ts` 的 `runSelf` 的文件**(eslint 授权闸)。
 *
 * 职责:
 *  1. {@link launchCurrent}:`current` 有效、版本更高、major 相同 → 以 `KIT_LAUNCHED=1` 启动 current 里的 `dist/cli.js`;
 *     任何一环对不上 → 退回当前进程自己(CLI 不会因更新坏掉而变砖),并在 stderr 报一行 `UPDATE_CURRENT_BROKEN`。
 *     子进程一旦 spawn 成功,无论它退出码是多少都不再回退(否则用户命令会执行两遍)。
 *  2. {@link smokeCandidate}:安装前对 `staging/st-<hex>` 真执行 `dist/cli.js --version`(`InstallDeps.smoke` 的实现)。
 *  3. {@link scheduleBackground}:前台命令结束后(TTY、非 CI、节流到期)起 `__update --background` 后台 worker,
 *     stdio 丢弃,TMPDIR 指向 spawn 前创建并复核过的受控目录。
 *  4. {@link noticeAutoSyncDeclined}:TTY 下把后台留下的 `AUTO_SYNC_DECLINED` 记录提示一次。
 *
 * 信任判据(S7c-A 留下的接口点):`state.installed.version` 等于 `current` 解析出的版本目录名,且该目录通过完整树校验
 * (`integrity.json` 的 sha256 等于 `state.installed.anchor`、文件集合与逐文件摘要一致)。校验通过后 spawn 的是**解析后的版本目录**
 * (runSelf 内部再按 `versions/<该版本>` 复核),不再经 `current` 链接,避免「验证 A、执行 B」。
 * 本文件不引用 net / home-fs;需要落盘的动作(受控 TMPDIR、提示记账)由 `install.ts` 的导出函数完成。
 */
import { KIT_VERSION } from '../contracts/meta.js';
import { runSelf, RUN_SELF_ENV_PICK_RE, type RunSelfResult } from '../io/exec.js';
import { getRealHome, pickProcessEnv } from '../io/paths.js';
import { ensureControlledTmp, markNoticeShown, type InstallEnv } from './install.js';
import { decideCurrent, pickWorkerTarget, readUpdateState } from './installed.js';
import { autoUpdateGate, checkDue } from './policy.js';
import { signalCode } from './signal-code.js';
import { shouldNotify } from './state.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface LauncherDeps {
  /** 测试注入:替换 runSelf(记录调用参数 / 模拟 spawn 失败) */
  runSelf?: typeof runSelf;
  /** 本进程自己的版本(缺省 KIT_VERSION) */
  ownVersion?: string;
  now?: () => Date;
  isTTY?: boolean;
  nodeVersion?: string;
}

export type LaunchResult =
  /** 已由 current 的新版本执行完毕;code 是它的退出码,调用方直接作为本进程退出码 */
  | { launched: true; code: number }
  /** 没有启动:调用方继续用自己;broken 非空时已向 stderr 报过 UPDATE_CURRENT_BROKEN */
  | { launched: false; broken?: string };

/**
 * @param stderr 写一行稳定码;缺省不输出(测试 / 库调用)
 */
export async function launchCurrent(
  input: { argv: readonly string[]; home: string; env: Env },
  deps: LauncherDeps = {},
  stderr: (t: string) => void = () => undefined,
): Promise<LaunchResult> {
  // 判据与钩子转发共用同一份实现(D-AU1 / `decideCurrent`):KIT_LAUNCHED 防递归 → state → current 版本 → installed 对齐 → 更高且同 major → 完整树校验
  const d = await decideCurrent({
    home: input.home,
    env: input.env,
    own: deps.ownVersion ?? KIT_VERSION,
  });
  if (!d.launch) {
    if ('broken' in d) {
      stderr(`UPDATE_CURRENT_BROKEN reason=${d.broken}\n`);
      return { launched: false, broken: d.broken };
    }
    return { launched: false };
  }
  const cur = d.version;

  let run: RunSelfResult;
  try {
    run = (deps.runSelf ?? runSelf)({
      home: input.home,
      target: { kind: 'current', version: cur },
      args: input.argv,
      env: input.env,
      ...(deps.nodeVersion !== undefined ? { nodeVersion: deps.nodeVersion } : {}),
    });
  } catch {
    // runSelf 只会在 spawn 之前(参数 / 路径前置条件)抛错;spawn 之后的一切都以返回值表达,所以这里等价于「没能启动」
    stderr('UPDATE_CURRENT_BROKEN reason=spawn_failed\n');
    return { launched: false, broken: 'spawn_failed' };
  }
  if (!run.spawned) {
    stderr(`UPDATE_CURRENT_BROKEN reason=${run.reason}\n`);
    return { launched: false, broken: run.reason };
  }
  return { launched: true, code: run.status ?? signalCode(run.signal) };
}

/** `InstallDeps.smoke` 的真实现:候选版本的 `dist/cli.js --version` 必须退出 0 且 stdout 恰为目标版本号 */
export function smokeCandidate(
  c: { home: string; stagingAbs: string; version: string },
  deps: LauncherDeps = {},
): boolean {
  const r: RunSelfResult = (deps.runSelf ?? runSelf)({
    home: c.home,
    target: { kind: 'candidate', stagingAbs: c.stagingAbs },
    args: [],
    env: {},
    timeoutMs: 15_000,
  });
  return r.spawned && r.status === 0 && r.stdout.trim() === c.version;
}

/** 命令名:第一个非选项记号(跳过带值的全局选项 --root / --overlay) */
export function commandOf(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--root' || a === '--overlay') {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

export interface ScheduleInput {
  argv: readonly string[];
  home: string;
  env: Env;
}

export type ScheduleResult = { scheduled: true } | { scheduled: false; why: string };

/**
 * 前台命令结束后调用。条件(§19.1 ⑥、§19.5):`KIT_AUTO_UPDATE` 不是关、非 `KIT_LAUNCHED`、非 CI、stdout 与 stdin 是 TTY、
 * 命令不是 check|build|__update、节流到期(24h;时钟往回走视为到期)。worker 起来后会在**锁内**再查一遍节流与配置。
 * 配置里 `auto_install=false` 由 worker 判(前台不读 config.toml)。
 */
export async function scheduleBackground(
  input: ScheduleInput,
  deps: LauncherDeps = {},
): Promise<ScheduleResult> {
  const command = commandOf(input.argv);
  if (command === undefined || command === '__update')
    return { scheduled: false, why: 'no_command' };
  const gate = autoUpdateGate({
    env: input.env,
    isTTY: deps.isTTY ?? (process.stdout.isTTY === true && process.stdin.isTTY === true),
    autoInstall: true,
    command,
  });
  if (!gate.enabled) return { scheduled: false, why: gate.reason };
  const st = await readUpdateState(input.home);
  if (st.kind === 'unsafe' || st.kind === 'unreadable') return { scheduled: false, why: 'state' };
  const nowMs = (deps.now ?? ((): Date => new Date()))().getTime();
  const due = checkDue(st.kind === 'ok' ? st.state.last_check_at : undefined, nowMs);
  if (!due.due) return { scheduled: false, why: 'throttled' };

  const ienv: InstallEnv = {
    home: input.home,
    tmpDir: input.env['KIT_TMP'],
    env: input.env,
    deps: {},
  };
  const tmp = await ensureControlledTmp(ienv);
  if (tmp === undefined) return { scheduled: false, why: 'tmp' };

  // 有效的 current 就由 current 起 worker(最新代码);否则用本进程所在的包(引导版本)——信任不高于当前进程自己
  const target = await pickWorkerTarget(input.home, st);
  const r = (deps.runSelf ?? runSelf)({
    home: input.home,
    target,
    args: ['__update', '--background'],
    env: input.env,
    tmpDir: tmp,
    background: true,
    ...(deps.nodeVersion !== undefined ? { nodeVersion: deps.nodeVersion } : {}),
  });
  return r.spawned ? { scheduled: true } : { scheduled: false, why: r.reason };
}

/**
 * 钩子调度的前置条件(D-AU2 / 评审 H2-B):钩子路径零写入,不能自己建受控 TMPDIR,所以由前台命令保证它存在——
 * 开关未关(`KIT_AUTO_UPDATE` / CI / `KIT_LAUNCHED`)就调用既有 `ensureControlledTmp`(已存在且合格 → 零写入)。
 * 不读 config.toml(前台不读配置;`auto_install=false` 的用户多一个空的 0700 目录,无害,钩子侧的调度谓词仍会读配置并拒绝)。
 * 不要求 TTY:`rsi hooks --install` 等一次性前台命令也应当把它备好。
 */
export async function ensureHookTmp(input: { home: string; env: Env }): Promise<boolean> {
  if (!autoUpdateGate({ env: input.env, isTTY: true, autoInstall: true }).enabled) return false;
  const ienv: InstallEnv = {
    home: input.home,
    tmpDir: input.env['KIT_TMP'],
    env: input.env,
    deps: {},
  };
  return (await ensureControlledTmp(ienv)) !== undefined;
}

/** TTY 下提示后台自动同步被拒(每条记录只提一次,靠 last_notice_at 记账) */
export async function noticeAutoSyncDeclined(
  input: { home: string; env: Env },
  stderr: (t: string) => void,
  deps: LauncherDeps = {},
): Promise<boolean> {
  const isTTY = deps.isTTY ?? process.stderr.isTTY === true;
  if (!isTTY) return false;
  const st = await readUpdateState(input.home);
  if (st.kind !== 'ok') return false;
  const last = st.state.last_auto_sync;
  if (last === undefined || last.outcome !== 'declined' || last.reasons.length === 0) return false;
  const nowMs = (deps.now ?? ((): Date => new Date()))().getTime();
  const seen = st.state.last_notice_at;
  if (seen !== undefined && Date.parse(seen) >= Date.parse(last.at)) return false;
  if (!shouldNotify({ ...st.state, last_notice_at: undefined }, nowMs)) return false;
  stderr(`AUTO_SYNC_DECLINED reason=${last.reasons[0]}\nSYNC_PENDING\n`);
  await markNoticeShown({
    home: input.home,
    tmpDir: input.env['KIT_TMP'],
    env: input.env,
    deps: {},
  });
  return true;
}

/** 给入口用:取启动器需要的那几个环境键(避免调用方碰 process.env) */
export function launcherEnv(): Record<string, string | undefined> {
  return pickProcessEnv(RUN_SELF_ENV_PICK_RE);
}

/**
 * 根入口 `cli.ts` 的全部逻辑:先试启动 current,不行就加载自己的主程序;命令结束后(此时不阻塞用户)提示 / 调度后台更新。
 * 启动器本身的任何异常都退回自己——CLI 不能因为更新机制坏掉而用不了。
 */
export async function launchAndSchedule(
  argv: readonly string[],
  loadMain: () => Promise<(argv: readonly string[]) => Promise<number>>,
): Promise<number> {
  const home = getRealHome();
  const env = launcherEnv();
  const stderr = (t: string): void => void process.stderr.write(t);
  let result: LaunchResult = { launched: false };
  try {
    result = await launchCurrent({ argv, home, env }, {}, stderr);
  } catch {
    result = { launched: false };
  }
  const code = result.launched ? result.code : await (await loadMain())(argv);
  try {
    await noticeAutoSyncDeclined({ home, env }, stderr);
    await scheduleBackground({ argv, home, env });
  } catch {
    // 后台调度失败不影响本次命令
  }
  try {
    await ensureHookTmp({ home, env });
  } catch {
    // 同上
  }
  try {
    // 提醒一次(R20-17.11):命令自身的锁已全部释放;与 update 提示、RSI 顺带调度各自隔离异常。先于顺带调度,免得与后台 worker 抢 rsi/lock
    const { runRsiNotice } = await import('../rsi/notice.js');
    const { hookEnv } = await import('../rsi/hook-entry.js');
    await runRsiNotice({
      argv,
      env: hookEnv(),
      isTty: process.stdin.isTTY === true && process.stderr.isTTY === true,
      stderr,
    });
  } catch {
    // 提醒失败不影响本次命令
  }
  try {
    // 自动 RSI 的顺带调度(R20-1.7):与 update 的调度并列、互不影响;模块本身零网络,失败一律吞掉
    const { scheduleRsiAfterCommand } = await import('../rsi/kit-schedule.js');
    const { hookEnv } = await import('../rsi/hook-entry.js');
    await scheduleRsiAfterCommand({
      argv,
      env: hookEnv(),
      isTty: process.stdout.isTTY === true && process.stdin.isTTY === true,
    });
  } catch {
    // 同上
  }
  return code;
}
