/**
 * 钩子形状的零网络入口(契约 R20-1.1 / R20-1.2a / R20-1.9 / R20-3.9.1;A3)。
 *
 * 根入口 `cli.ts` 识别到 `rsi poke …`、`rsi hint …` 或 `__rsi …`(前面可夹全局选项)时,在加载启动器之前直接 `import()` 本文件:
 * 不调 `launchCurrent`(不转发到 `current`)、不调 `noticeAutoSyncDeclined`、不调 update 的 `scheduleBackground`,
 * 也不经 `src/cli.ts` 的 main——后者静态引入全部命令与 update worker,闭包含 `net.ts` / `llm-exec`(A3 订正:R20-3.9.1 / §20.9 第 3 条④
 * 改为「根入口识别并加载本模块」,`src/cli.ts` 对 `__rsi` 只经动态 `import()` 转交到这里)。
 *
 * 参数:钩子参数不可信(R20-1.9)。`--root` / `--overlay` 只被根入口跳过以识别形状,**从不**传给 rsi;本模块看到任何全局选项
 * 或多余记号(含 `--help` / `--version` / `--`)→ poke / hint 空操作(退 0、无输出),`__rsi` 只接受精确的 `--background`,其余退 2(无输出)。
 * 不读 stdin、不使用调用方 cwd。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { RUN_SELF_ENV_PICK_RE } from '../io/exec.js';
import { HOST_ENV_NAMES, pickProcessEnv } from '../io/paths.js';

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
      const { runWorker } = await import('./worker.js');
      await runWorker({ env });
      return ExitCode.OK;
    }
    if (shape.hadGlobal) return ExitCode.OK;
    if (shape.kind === 'poke') {
      const { runPoke } = await import('./poke.js');
      await runPoke(shape.rest, { env });
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
