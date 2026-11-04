/**
 * agent 版本探测出口(contracts §20.15-12 N1 订正 #3):第三个可 import child_process 的文件(与 `exec.ts` / `llm-exec.ts` 并列,
 * 各自一张具名表、互不借道)。**只许** `src/rsi/hooks/**` 及其测试引用(eslint 授权闸,见 `eslint.config.js` 的 `allowAgentProbe`);
 * 不经 `launcher.ts` / `net.ts` 链,不 import `exec.ts`。
 * 只读、零联网、短超时地跑一条**固定**的版本命令并返回原始结果;解析与 fail-closed 在 `src/rsi/hooks/agent-version.ts`。
 */
import { spawnSync } from 'node:child_process';

export class AgentProbeDeniedError extends Error {
  readonly code = 'IO_AGENT_PROBE_DENIED';
}

export interface AgentVersionResult {
  /** 进程退出码;被信号杀死或超时为 null */
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 启动失败(如 ENOENT)的错误信息 */
  spawnError?: string;
}

/**
 * 版本探测的**具名**可执行表:agent id → 二进制名。只有 pi 的版本命令(`pi --version`,输出 `X.Y.Z`)被核实过(2026-11-04 pi 1.5.0);
 * claude / codex 的版本命令与输出形状**未核实**,所以不在表内(调用它们 = `AgentProbeDeniedError`,不 spawn)。
 * 与 `EXEC_ALLOWLIST`(git)是两张独立的表:要给 `runSync` 加二进制仍是契约变更,这里也不能借道。
 */
export const AGENT_VERSION_BINARIES: Readonly<Record<string, string>> = Object.freeze({ pi: 'pi' });
/** 探测的固定参数:只有 `--version`,调用方不能指定 */
const AGENT_VERSION_ARGS: readonly string[] = Object.freeze(['--version']);
export const AGENT_VERSION_TIMEOUT_MS = 3_000;
const AGENT_VERSION_MAX_BUFFER = 4 * 1024;

export interface AgentVersionCommandOptions {
  /** 传给子进程的 PATH(唯一的环境变量;不含 HOME / 任何 agent 的配置与密钥变量 / 代理变量) */
  pathEnv: string;
  /** 测试注入;生产恒为缺省 {@link AGENT_VERSION_TIMEOUT_MS}(3 秒);超时 = SIGKILL */
  timeoutMs?: number;
}

/**
 * 只读、零联网(不给代理变量、不给任何 API key)地运行该 agent 的版本命令,返回原始结果;**不解析**(解析与 fail-closed 在 `src/rsi/hooks/agent-version.ts`)。
 * 不经 shell、固定 argv、环境只有 PATH、cwd 固定为 `/`(PATH 里的相对项不会解析到仓库)、stdin 关闭、输出上限 4 KiB。
 * eslint 闸限定只有 `src/rsi/hooks/**` 及其测试能 import 本文件。
 */
export function runAgentVersionCommand(
  agent: string,
  opts: AgentVersionCommandOptions,
): AgentVersionResult {
  const file = Object.hasOwn(AGENT_VERSION_BINARIES, agent)
    ? AGENT_VERSION_BINARIES[agent]
    : undefined;
  if (file === undefined) {
    throw new AgentProbeDeniedError(
      `没有已核实的版本命令:${agent}(已核实:${Object.keys(AGENT_VERSION_BINARIES).join(', ')})`,
    );
  }
  const r = spawnSync(file, [...AGENT_VERSION_ARGS], {
    cwd: '/',
    env: { PATH: opts.pathEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? AGENT_VERSION_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: AGENT_VERSION_MAX_BUFFER,
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
