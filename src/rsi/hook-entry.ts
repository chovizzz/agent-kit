/**
 * 钩子形状的零网络入口(契约 R20-1.1 / R20-1.2a / R20-1.9 / R20-3.9.1;A3)。
 *
 * 根入口 `cli.ts` 识别到 `rsi poke …`、`rsi hint …` 或 `__rsi …`(前面可夹全局选项)时,在加载启动器之前直接 `import()` 本文件:
 * 不调 `launchCurrent`(它在 `launcher.ts → install.ts → net.ts` 的闭包里)、不调 `noticeAutoSyncDeclined`、不调 update 的 `scheduleBackground`,
 * 也不经 `src/cli.ts` 的 main——后者静态引入全部命令与 update worker,闭包含 `net.ts` / `llm-exec`(A3 订正:R20-3.9.1 / §20.9 第 3 条④
 * 改为「根入口识别并加载本模块」,`src/cli.ts` 对 `__rsi` 只经动态 `import()` 转交到这里)。
 *
 * D-AU1(取代 Q25-A):执行自身逻辑前,经零网络桥接 `forwardHookToCurrent` 按与启动器同一份判据(`decideCurrent` + 完整树校验)尝试转发到
 * `current` 里更高的同 major 版本;转发成功即返回(poke / hint 恒 0,`__rsi` 返回子进程码),否则静默用自己。
 * D-AU2:poke 的正常逻辑结束后,谓词成立则经零网络桥接 detached 拉起 `__update --background`(24h 节流;hint / `__rsi` 不调度)。
 *
 * 参数:钩子参数不可信(R20-1.9)。`--root` / `--overlay` 只被根入口跳过以识别形状,**从不**传给 rsi;本模块看到任何全局选项
 * 或多余记号(含 `--help` / `--version` / `--`)→ poke / hint 空操作(退 0、无输出),`__rsi` 只接受精确的 `--background`,其余退 2(无输出)。
 * 不读 stdin、不使用调用方 cwd。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { RUN_SELF_ENV_PICK_RE } from '../io/exec.js';
import { HOST_ENV_NAMES, getRealHome, pickProcessEnv } from '../io/paths.js';
import { autoSkip } from './skip.js';

type Env = Record<string, string | undefined>;

/** 钩子入口关心的环境键:rsi 上下文构造需要的宿主键 + runSelf 白名单(含跳过条件、CI、`PI_CODING_AGENT_DIR`) */
const HOOK_ENV_RE = new RegExp(
  `^(${[...HOST_ENV_NAMES, 'KIT_TMP', 'KIT_STATE_DIR', 'KIT_WRITE_ROOTS', 'KIT_REAL_HOME_OVERRIDE'].join('|')}|LC_[A-Z_]{1,32})$`,
);

export function hookEnv(): Env {
  return { ...pickProcessEnv(RUN_SELF_ENV_PICK_RE), ...pickProcessEnv(HOOK_ENV_RE) };
}

export type HookShape =
  | { kind: 'poke'; rest: readonly string[] }
  | { kind: 'hint'; rest: readonly string[] }
  | { kind: 'worker'; rest: readonly string[] };

/**
 * 形状识别(与根入口 `cli.ts` 的内联判定同口径,测试对拍):跳过 `--root <v>`、`--overlay <v>` 与其它 `-` 开头的记号,
 * 第一个非选项记号是 `__rsi` → worker;是 `rsi` 且下一个记号是 `poke` / `hint` → 对应钩子。`hadGlobal` = 前面出现过任何选项。
 */
export function hookShapeOf(
  argv: readonly string[],
): (HookShape & { hadGlobal: boolean }) | undefined {
  let i = 0;
  let hadGlobal = false;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a === '--root' || a === '--overlay') {
      hadGlobal = true;
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      hadGlobal = true;
      i += 1;
      continue;
    }
    break;
  }
  const head = argv[i];
  if (head === '__rsi') return { kind: 'worker', rest: argv.slice(i + 1), hadGlobal };
  if (head === 'rsi') {
    const sub = argv[i + 1];
    if (sub === 'poke' || sub === 'hint') return { kind: sub, rest: argv.slice(i + 2), hadGlobal };
  }
  return undefined;
}

export interface HookEntryDeps {
  env?: Env;
  /** 测试注入:替换转发 / 调度的桥接(缺省动态加载 `src/update/self-spawn.ts`) */
  bridge?: HookBridge;
}

export interface HookBridge {
  forward: (input: {
    argv: readonly string[];
    home: string;
    env: Env;
    timeoutMs?: number | null;
  }) => Promise<{ forwarded: true; code: number } | { forwarded: false }>;
  scheduleUpdate: (input: { home: string; env: Env }) => Promise<unknown>;
}

async function loadBridge(): Promise<HookBridge> {
  const m = await import('../update/self-spawn.js');
  return { forward: m.forwardHookToCurrent, scheduleUpdate: m.spawnUpdateWorker };
}

/** 根入口调用:返回进程退出码。poke / hint 恒 0;worker 精确形状 0,否则 2。从不抛错、从不输出。 */
export async function runHookEntry(
  argv: readonly string[],
  deps: HookEntryDeps = {},
): Promise<number> {
  const shape = hookShapeOf(argv);
  try {
    const env = deps.env ?? hookEnv();
    if (shape === undefined) return ExitCode.USAGE;
    if (shape.kind === 'worker') {
      if (shape.hadGlobal || shape.rest.length !== 1 || shape.rest[0] !== '--background') {
        return ExitCode.USAGE;
      }
      // 跳过条件命中:worker 自己也会空操作,不必为它起 current 的进程
      if (autoSkip(env, 'worker') !== null) return ExitCode.OK;
      const bridge = deps.bridge ?? (await loadBridge());
      const f = await bridge.forward({ argv, home: getRealHome(env), env, timeoutMs: null });
      if (f.forwarded) return f.code;
      const { runWorker } = await import('./worker.js');
      await runWorker({ env });
      return ExitCode.OK;
    }
    if (shape.hadGlobal) return ExitCode.OK;
    // 评审 M2:跳过条件命中(`KIT_AUTO_RSI=0` / `KIT_RSI_CHILD` / CI)先于转发,不为空操作付一次完整树校验与第二个 node 进程
    if (autoSkip(env, shape.kind) !== null) return ExitCode.OK;
    const bridge = deps.bridge ?? (await loadBridge());
    // 转发超时 / 被信号终止也算已转发:不在本进程重跑(命令会执行两遍),钩子恒 0、无输出(评审 H4)
    const f = await bridge.forward({ argv, home: getRealHome(env), env });
    if (f.forwarded) return ExitCode.OK;
    if (shape.kind === 'poke') {
      const { runPoke } = await import('./poke.js');
      await runPoke(shape.rest, {
        env,
        scheduleUpdate: () => bridge.scheduleUpdate({ home: getRealHome(env), env }),
      });
      return ExitCode.OK;
    }
    const { runHint } = await import('./hint.js');
    const text = await runHint(shape.rest, { env });
    if (text !== '') process.stdout.write(text);
    return ExitCode.OK;
  } catch {
    // 钩子与 worker 永不把失败暴露给宿主(R20-3.2.1 / R20-3.3.1 / R20-3.9.1)
    return ExitCode.OK;
  }
}
