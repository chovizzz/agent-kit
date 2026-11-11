/**
 * 个人层 id 派生(纯函数,无 I/O;docs/contracts.md R21-4(idem_key)、§21.24 W0-6(候选 id)、规划稿 §2.4(txn_id))。
 * 三个派生都是「同样输入得到同样输出」的哈希截断:崩溃重放得到同一个 id / 键。**不含任何时钟值**。
 *
 * 幂等的边界:键只能在 `record.transitions[]` 的 256 条窗口内去重;窗口外的重复事件不保证空操作,
 * 但引擎保证它不增加影响、不回退阶段、不降级 target_terminal(见 transition.ts 头注)。
 *
 * 编码:`JSON.stringify` 一个定长数组(契约只写了「sha256(a, b, …)」而没定字节编码;数组 JSON 无分隔符歧义,
 * 且含 `null` 的位置不会与字符串 `"null"` 混淆)。这一选择已列入 W1 汇报「问题」节。
 */
import { createHash } from 'node:crypto';
import type { RSI_COMMIT_KINDS } from '../../contracts/rsi.js';

type RsiCommitKind = (typeof RSI_COMMIT_KINDS)[number];

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface IdemKeyParts {
  id: string;
  dim: 'lifecycle' | 'deploy' | 'rollback';
  /** 仅 `dim=deploy` 带 agent;其余传 undefined(编码为 null) */
  agent?: string | undefined;
  from: string;
  to: string;
  /** 触发证据指纹(调用方给;引擎在其前面拼上事件种类,见 transition.ts) */
  evidence: string;
}

/** R21-4:`idem_key = sha256(id, dim, agent, from, to, 触发证据指纹)` 前 16 位;同一键重复执行是空操作 */
export function idemKey(p: IdemKeyParts): string {
  return sha256Hex(JSON.stringify([p.id, p.dim, p.agent ?? null, p.from, p.to, p.evidence])).slice(
    0,
    16,
  );
}

/** W0-6:候选 id = `ra_` + sha256(`"v1|" + run_id + "|" + proposal_id + "|" + content_sha256`) 前 12 位十六进制 */
export function candidateId(runId: string, proposalId: string, contentSha256: string): string {
  return `ra_${sha256Hex(`v1|${runId}|${proposalId}|${contentSha256}`).slice(0, 12)}`;
}

/** 规划稿 §2.4:`txn_id` / journal `txn_id` = sha256(kind, candidate_ids, old_head, target_tree) 前 16 位(候选 id 先排序,与调用方顺序无关) */
export function txnId(
  kind: RsiCommitKind,
  candidateIds: readonly string[],
  oldHead: string | null,
  targetTree: string,
): string {
  const ids = [...candidateIds].sort();
  return sha256Hex(JSON.stringify([kind, ids, oldHead, targetTree])).slice(0, 16);
}
