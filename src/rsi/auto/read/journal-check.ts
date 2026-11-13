/**
 * 回滚 journal 的只读合规检查(`rsi show` 的 `journal=` 行;纯函数,无 I/O)。
 * 只做**绑定与相容性**的最小判定:`txn_id` = `rollbackTxnId(id, content_sha256)`、文件名一致、`candidate_id` 一致、`content_sha256`(若有)一致、
 * `by` 与 `reason` 在 W0-17 的来源表里相容、`kind=clear` 必须 `by=clear`。不合规 → `invalid`(输出只写 `journal=invalid` 与「按运行手册处置」,不含路径,
 * 不写「删除即可恢复」)。journal 不存在只表示「该次读取下不存在」,不推出「丢失」。
 */
import { RSI_REVOCATION_BY, RSI_REVOCATION_REASONS_BY } from '../../../contracts/rsi.js';
import { PersonalTxnSchema } from '../../../contracts/rsi-personal.js';
import { journalNameOf } from './stall.js';

/**
 * 来源 / kind / 原因的相容性(读侧镜像,**与写侧 `rollback-journal.ts::sourceProblem` 逐组合相等**,`port-contract` 测试对全部 (by, kind, reason) 组合钉住):
 *   reason ∈ 该 by 的 W0-17 来源表(`identity_changed` 除外);`by = rollback_to` ⇔ (`kind = rollback` ∧ `reason = cleared`);`kind = clear` ⇒ `by = clear` ∧ `reason = cleared`。
 * 读侧不 import 写侧模块(它的闭包带 `revoke-write.ts`),所以镜像而不复用。
 */
export function sourceCompatible(
  by: (typeof RSI_REVOCATION_BY)[number],
  kind: string,
  reason: string,
): boolean {
  if (reason !== 'identity_changed' && !RSI_REVOCATION_REASONS_BY[by].includes(reason))
    return false;
  if ((by === 'rollback_to') !== (kind === 'rollback' && reason === 'cleared')) return false;
  if (kind === 'clear' && (by !== 'clear' || reason !== 'cleared')) return false;
  return true;
}

export type JournalStatus = 'absent' | 'ok' | 'invalid';

export function checkJournal(
  text: string | undefined,
  id: string,
  contentSha256: string,
): JournalStatus {
  if (text === undefined) return 'absent';
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'invalid';
  }
  const p = PersonalTxnSchema.safeParse(raw);
  if (!p.success) return 'invalid';
  const t = p.data;
  if (t.txn_id !== journalNameOf(id, contentSha256) || t.candidate_id !== id) return 'invalid';
  if (t.content_sha256 !== undefined && t.content_sha256 !== contentSha256) return 'invalid';
  if (t.by !== undefined && !sourceCompatible(t.by, t.kind, t.reason)) return 'invalid';
  return 'ok';
}
