/**
 * 唯一允许 import child_process 的文件。
 * - 不经 shell(execFile 语义):参数是数组,不拼接命令串。
 * - 默认 env 只有 PATH,**不继承 HOME**、不继承 XDG_* / CODEX_HOME 等;需要的变量由调用方在 opts.env 显式给。
 * - 二进制白名单:P0 只有 `git`。要加别的二进制 = 契约变更(主代理评审),不要在块内自己放开。
 * - env 键白名单:GIT_* / HOME / LANG / LC_* / TZ;HOME 的值必须在 KIT_TMP 之内(防指向真实 HOME)。
 * - 同步执行(确定性、测试好写)。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { IoContext } from './paths.js';

export const EXEC_ALLOWLIST: readonly string[] = ['git'];
const ENV_KEY_RE = /^(GIT_[A-Z0-9_]+|HOME|LANG|LC_[A-Z_]+|TZ)$/;

export class ExecDeniedError extends Error {
  readonly code = 'IO_EXEC_DENIED';
}

function assertExecAllowed(
  ctx: IoContext,
  file: string,
  env: Readonly<Record<string, string>>,
): void {
  if (!EXEC_ALLOWLIST.includes(file)) {
    throw new ExecDeniedError(`不在可执行白名单内:${file}(白名单:${EXEC_ALLOWLIST.join(', ')})`);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k)) throw new ExecDeniedError(`不允许传给子进程的环境变量:${k}`);
    if (k === 'HOME') {
      const home = path.resolve(v);
      const tmp = ctx.tmpDir;
      const rel = tmp === undefined ? undefined : path.relative(tmp, home);
      if (rel === undefined || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new ExecDeniedError('子进程的 HOME 必须指向 KIT_TMP 之内的目录');
      }
    }
  }
}

export interface ExecOptions {
  cwd?: string;
  /** 显式追加的环境变量;不会被默认值覆盖 */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  input?: string;
  maxBufferBytes?: number;
}

export interface ExecResult {
  /** 进程退出码;被信号杀死或超时为 null */
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 启动失败(如 ENOENT)的错误信息 */
  spawnError?: string;
}

export function runSync(
  ctx: IoContext,
  file: string,
  args: readonly string[],
  opts: ExecOptions = {},
): ExecResult {
  assertExecAllowed(ctx, file, opts.env ?? {});
  const r = spawnSync(file, [...args], {
    cwd: opts.cwd ?? ctx.repoRoot,
    // HOME 缺失时 git 会经 passwd 回退读真实 ~/.gitconfig,所以默认显式屏蔽全局/系统配置(调用方可覆盖)
    env: {
      PATH: ctx.execPath,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...opts.env,
    },
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: opts.maxBufferBytes ?? 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut,
    ...(r.error && !timedOut ? { spawnError: r.error.message } : {}),
  };
}
