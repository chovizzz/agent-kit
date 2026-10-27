/**
 * rsi 专用 `IoContext` 的构造(docs/contracts.md §20.2 R20-2.3 / R20-2.5、§20.9 第 17、18 条;R20-A2 B2)。
 *
 * rsi 的全部入口(自动与前台)**忽略** `KIT_STATE_DIR` 与 `KIT_WRITE_ROOTS`,除非同时设了 `KIT_TMP`(测试夹具),
 * 保证前台与后台读写同一份状态:状态目录恒为 `<[rsi] repo>/.state`,仓库根恒取 `[rsi] repo`。
 *
 * **选择发生在通用路径校验之前**:通用 `createIoContext` 会在构造时校验 `KIT_STATE_DIR`(越出仓库 / 落进 `out/` 都抛 `PathsError`)。
 * rsi 入口若先走通用构造,一个对 rsi 根本无效的 `KIT_STATE_DIR` 就会让 rsi 命令在到达自己的逻辑前失败(或更糟:先在错误的根上做了校验)。
 * 所以这里先**复制** env、剔除这两个变量(不改调用者的对象),再以 `[rsi] repo` 为 `--root` 构造。调用方必须先有一份已校验的 `[rsi] repo`
 * (`loadRsiConfig` 的 `on` 结果);配置为 `off` / 不可用时由调用方决定退出码,本函数不猜、不回退到通用上下文。
 *
 * 给了 `base`(已有的上下文,通常来自 `main()`,带着写审计钩子)时,新上下文经 {@link deriveIoContext} 派生:`writeAudit` 从 `base` 继承
 * (不得手写 `{ ...base }`,否则钩子会静默丢失),而**所有**与仓库有关的字段(`repoRoot`、`outDir`、`stateDir`、`writeRoots`、`tmpDir`、`execPath`、
 * `hostEnv`)都取新构造的值,旧上下文的状态目录 / 写入根不会泄漏进来。
 * 全局 `--root` 的显式来源经 `explicitRoot` 传入:与 `[rsi] repo` 的 `realpath` 不同 → `RsiRootMismatchError`(`RSI_USAGE reason=root_mismatch`,退出 2)。
 */
import * as path from 'node:path';
import { ExitCode } from '../contracts/exit-codes.js';
import {
  HOST_ENV_NAMES,
  createIoContext,
  deriveIoContext,
  pickProcessEnv,
  type IoContext,
  type WriteAudit,
} from '../io/paths.js';
import { realpathSync } from '../io/read-fs.js';

export class RsiRootMismatchError extends Error {
  readonly code = 'RSI_USAGE';
  readonly reason = 'root_mismatch';
  readonly exit = ExitCode.USAGE;
  constructor() {
    super('rsi: --root 与 [rsi] repo 不是同一目录');
  }
}

export interface CreateRsiIoContextOptions {
  /** 已校验的 `[rsi] repo`(绝对路径、`realpath(repo) === repo`) */
  repo: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** 全局 `--root` 的原值(给了才比较);相对路径按 `cwd` 解析 */
  explicitRoot?: string;
  /** 已有上下文:给了就从它派生(保留 `writeAudit`),不给就直接构造 */
  base?: IoContext;
  /** 没有 `base` 时的写审计钩子 */
  writeAudit?: WriteAudit;
}

/** 没注入 env 时取真实进程环境里 `createIoContext` 会读的那几个键(不是整份 env) */
const REAL_ENV_KEYS = new RegExp(
  `^(${[...HOST_ENV_NAMES, 'KIT_TMP', 'KIT_STATE_DIR', 'KIT_WRITE_ROOTS', 'KIT_REAL_HOME_OVERRIDE'].join('|')}|LC_[A-Z_]{1,32})$`,
);

/** rsi 入口看到的环境:剔除 `KIT_STATE_DIR` / `KIT_WRITE_ROOTS`(`KIT_TMP` 已设 = 测试夹具,保留) */
export function rsiEnvOf(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  if (env['KIT_TMP'] === undefined || env['KIT_TMP'] === '') {
    delete out['KIT_STATE_DIR'];
    delete out['KIT_WRITE_ROOTS'];
  }
  return out;
}

export function createRsiIoContext(opts: CreateRsiIoContextOptions): IoContext {
  const cwd = opts.cwd;
  if (opts.explicitRoot !== undefined) {
    let given: string;
    try {
      given = realpathSync(
        cwd === undefined ? path.resolve(opts.explicitRoot) : path.resolve(cwd, opts.explicitRoot),
      );
    } catch {
      throw new RsiRootMismatchError();
    }
    if (given !== opts.repo && given !== realpathSync(opts.repo)) throw new RsiRootMismatchError();
  }
  const fresh = createIoContext({
    root: opts.repo,
    env: rsiEnvOf(opts.env ?? pickProcessEnv(REAL_ENV_KEYS)),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(opts.base === undefined && opts.writeAudit !== undefined
      ? { writeAudit: opts.writeAudit }
      : {}),
  });
  if (opts.base === undefined) return fresh;
  return deriveIoContext(opts.base, {
    repoRoot: fresh.repoRoot,
    outDir: fresh.outDir,
    stateDir: fresh.stateDir,
    writeRoots: fresh.writeRoots,
    tmpDir: fresh.tmpDir,
    execPath: fresh.execPath,
    hostEnv: fresh.hostEnv,
  });
}
