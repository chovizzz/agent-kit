/**
 * `rsi hooks` 的 agent 版本探测(contracts §20.15 N1 订正 #3)。形状表 `agent_versions` 非 null 时,写闸({@link isShapeWritable})要本机 agent 版本。
 *
 * - 目前**只有 pi** 被核实过:`pi --version` 输出 `X.Y.Z`(2026-11-04,pi 1.5.0)。claude / codex 的版本命令与输出形状**未核实**:直接返回 `undefined`、不 spawn
 *   (它们的形状表 `agent_versions` 本来就是 null,不需要版本;等它们的形状被核实、表里写上范围时,再核实命令并加进 `AGENT_VERSION_BINARIES`)。
 * - fail-closed:找不到命令、超时、退出非 0、被信号杀死、输出不是**恰好**一个 `X.Y.Z`(带前缀 / 后缀 / 多行 / 预发布标记都算解析不了)→ `undefined`(写闸照旧拒)。
 * - 依赖倒置:子进程出口(`runAgentVersionCommand`,`src/io/agent-probe.ts`)作为端口注入;测试注入假实现。探测函数从不抛错。
 */
import {
  AGENT_VERSION_BINARIES,
  AGENT_VERSION_TIMEOUT_MS,
  runAgentVersionCommand,
  type AgentVersionResult,
} from '../../io/agent-probe.js';
import type { RsiAgentId } from '../../contracts/rsi.js';

export type AgentVersionRunner = (
  agent: string,
  opts: { pathEnv: string; timeoutMs: number },
) => AgentVersionResult;

/** 恰好 `X.Y.Z`(每段 1–6 位十进制),允许一个前导 `v`;其余一律解析不了 */
const VERSION_ONLY_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** 纯函数:输出整体(去首尾空白)必须恰好是一个版本号,返回规范的 `X.Y.Z`;否则 `undefined` */
export function parseAgentVersionOutput(text: string): string | undefined {
  const m = VERSION_ONLY_RE.exec(text.trim());
  return m === null ? undefined : `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * 生产接线:`HooksDeps.agentVersion`。先看 stdout,stdout 去空白后为空才看 stderr(版本命令把版本打到哪条流未核实,两条都收,但**各自**必须整体是版本号)。
 * @param pathEnv 子进程的 PATH(调用方经 `io/paths.ts` 取)
 */
export function makeAgentVersionProbe(
  pathEnv: string,
  run: AgentVersionRunner = runAgentVersionCommand,
): (agent: RsiAgentId) => string | undefined {
  return (agent) => {
    // 具名表(agent-probe.ts)是唯一来源:表外的 agent(claude / codex:版本命令未核实)不 spawn、直接未知
    if (!Object.hasOwn(AGENT_VERSION_BINARIES, agent)) return undefined;
    try {
      const r = run(agent, { pathEnv, timeoutMs: AGENT_VERSION_TIMEOUT_MS });
      if (r.timedOut || r.spawnError !== undefined || r.signal !== null || r.status !== 0) {
        return undefined;
      }
      const out = r.stdout.trim() !== '' ? r.stdout : r.stderr;
      return parseAgentVersionOutput(out);
    } catch {
      return undefined;
    }
  };
}
