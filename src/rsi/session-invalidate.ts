/**
 * 观察性作废(docs/contracts.md R20-16.12 ②;R20-A4):digest、ingest、worker 任一次读到某 agent 的会话授权非 `ok`,或 `session_policy_fp` 与某份已发布 digest 记录的不同,
 * 即在持槽位锁时删除受影响的已发布 digest。**尽力**:槽位锁只试一次、拿不到就跳过,不改变调用方本次的结果;没有 `digests/` 目录时不建目录。
 * 受影响的判定:
 *  - 策略指纹与当前不同的 digest(授权 / 排除 / overlay / repo 任一变过),不分 agent;
 *  - 授权判定非 `ok` 时:`agent_not_authorized` 只作废该 agent 的 digest;`off` / `invalid` / `expired` 与 agent 无关,作废全部。
 * 预留文件不算已发布记录(`invalidateDigests` 只看 digest 内容)。边界如实:用户把授权关掉再原样打开、期间没有任何 kit 调用时,kit 观察不到这次撤销(契约原文)。
 */
import { RSI_AGENT_IDS, type RsiAgentId } from '../contracts/rsi.js';
import type { IoContext } from '../io/paths.js';
import { invalidateDigests, type SlotDeps } from './digest-slots.js';
import { utcToday } from './session.js';
import { observeSessionFacts, type SessionFacts } from './session-facts.js';

export async function invalidateForFacts(
  io: IoContext,
  facts: Pick<SessionFacts, 'config' | 'fp' | 'judgement'>,
  agent: RsiAgentId,
  deps: SlotDeps = {},
  /** 不作废的 digest id(ingest 的目标 digest 由第 3 步用自己的子码处理) */
  except?: string,
): Promise<number> {
  if (facts.config.status !== 'on') return 0;
  const j = facts.judgement;
  const fp = facts.fp;
  const denied = (rec: { agent: string }): boolean =>
    j !== null &&
    j.kind === 'denied' &&
    (j.reason !== 'agent_not_authorized' || rec.agent === agent);
  return invalidateDigests(
    io,
    (rec) =>
      rec.digest_id !== except && ((fp !== null && rec.session_policy_fp !== fp) || denied(rec)),
    deps,
  );
}

/**
 * worker 的观察点(R20-16.12 ②「digest、ingest、worker 任一次」):在 worker 持 `rsi/lock` 之后、业务之前,对三个 agent 各读一次授权事实并作废受影响的 digest。
 * 完全尽力:任何错误(含快照占线)都吞掉,不改变 worker 的结果;没有 `digests/` 目录时零写入(`invalidateDigests` 先做只读存在性检查)。
 */
export async function invalidateAllAgents(
  io: IoContext,
  env: Readonly<Record<string, string | undefined>> | undefined,
  now: Date,
  deps: SlotDeps = {},
): Promise<number> {
  let n = 0;
  try {
    const today = utcToday(now);
    for (const agent of RSI_AGENT_IDS) {
      const f = await observeSessionFacts(io, env, agent, today);
      n += await invalidateForFacts(io, f, agent, deps);
    }
  } catch {
    // 尽力
  }
  return n;
}
