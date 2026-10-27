/**
 * rsi 子命令的上下文入口(契约 R20-2.5、§20.9 第 17、18 条;v2 §5;R20-A2 B3a 实装,B3b / B3c 复用结果类型)。
 *
 * 顺序(冻结,见 `src/rsi/types.ts` 头注释):`loadRsiConfig`(只读)→ off 则返回 `off`,**不**建任何上下文 →
 * on 才 `createRsiIoContext`(`--root` 与 `[rsi] repo` 的 realpath 不同 → `usage` / `root_mismatch`)。
 * **不创建目录、不拿锁、不恢复快照**:那些由调用方在拿到 `ready` 之后经 `withRsiLockIfGated` 做。
 * 本文件只 import 只读模块(config / io / read-fs):`rsi status` / `rsi projects` 的 import 闭包经它进入,不含任何写出口。
 */
import { PathsError, pickProcessEnv, type IoContext } from '../../io/paths.js';
import { safeOpenSupported } from '../../io/read-fs.js';
import { loadRsiConfig, type RsiConfigOn } from '../config.js';
import { RsiRootMismatchError, createRsiIoContext } from '../io.js';
import { RsiFailClosedError, type RsiEarlyContext, type RsiOpenResult } from '../types.js';

export type { RsiOpenResult };

/** 只给测试的注入点 */
export interface OpenRsiIoDeps {
  /** 缺省 `createRsiIoContext` */
  createContext?: (opts: {
    repo: string;
    env?: Readonly<Record<string, string | undefined>>;
    cwd?: string;
    explicitRoot?: string;
    writeAudit?: RsiEarlyContext['writeAudit'];
  }) => IoContext;
  /** 缺省 `safeOpenSupported()`(D8:缺 `O_NOFOLLOW` / `O_NONBLOCK` / `O_DIRECTORY` / `getuid` 的平台) */
  platformSupported?: () => boolean;
}

export async function openRsiIo(
  early: RsiEarlyContext,
  deps: OpenRsiIoDeps = {},
): Promise<RsiOpenResult> {
  const config = await loadRsiConfig({ ...(early.env !== undefined ? { env: early.env } : {}) });
  if (config.status === 'off') return { kind: 'off', reason: config.reason };
  // D8:配置 on 而平台无法做句柄级安全读 → rsi 前台命令退出 3
  if (!(deps.platformSupported ?? safeOpenSupported)()) {
    throw new RsiFailClosedError('state_dir_unsafe');
  }
  try {
    const io = (deps.createContext ?? createRsiIoContext)({
      repo: config.repo,
      ...(early.env !== undefined ? { env: early.env } : {}),
      ...(early.cwd !== undefined ? { cwd: early.cwd } : {}),
      ...(early.explicitRoot !== undefined ? { explicitRoot: early.explicitRoot } : {}),
      ...(early.writeAudit !== undefined ? { writeAudit: early.writeAudit } : {}),
    });
    return { kind: 'ready', ctx: { io, config } satisfies { io: IoContext; config: RsiConfigOn } };
  } catch (e) {
    if (e instanceof RsiRootMismatchError) {
      return { kind: 'usage', code: 'RSI_USAGE', reason: 'root_mismatch', exit: 2 };
    }
    if (e instanceof PathsError) throw new RsiFailClosedError('state_dir_unsafe');
    throw e;
  }
}

/** 没注入 env 时,取真实进程环境里与 rsi 只读命令有关的那一个名字(`PI_CODING_AGENT_DIR` 是否已设置,R20-2.9) */
export function piDirIsSet(env: Readonly<Record<string, string | undefined>> | undefined): boolean {
  const e = env ?? pickProcessEnv(/^PI_CODING_AGENT_DIR$/);
  return e['PI_CODING_AGENT_DIR'] !== undefined;
}
