/**
 * 回滚 journal 的只读合规检查(`rsi show` 的 `journal=` 行;纯函数,无 I/O)。
 * 只做**绑定与相容性**的最小判定:`txn_id` = `rollbackTxnId(id, content_sha256)`、文件名一致、`candidate_id` 一致、`content_sha256`(若有)一致、
 * `by` 与 `reason` 在 W0-17 的来源表里相容、`kind=clear` 必须 `by=clear`。不合规 → `invalid`(输出只写 `journal=invalid` 与「按运行手册处置」,不含路径,
 * 不写「删除即可恢复」)。journal 不存在只表示「该次读取下不存在」,不推出「丢失」。
 */
import { RSI_REVOCATION_REASONS_BY } from '../../../contracts/rsi.js';
import { PersonalTxnSchema } from '../../../contracts/rsi-personal.js';
import { journalNameOf } from './stall.js';

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
  if (t.by !== undefined) {
    if (t.reason !== 'identity_changed' && !RSI_REVOCATION_REASONS_BY[t.by].includes(t.reason)) {
      return 'invalid';
    }
    if (t.kind === 'clear' && t.by !== 'clear') return 'invalid';
  }
  return 'ok';
}
