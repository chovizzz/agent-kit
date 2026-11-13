/**
 * `rsi auto clear`(及复用同一归并的 veto / rollback --to)的退出码映射(contracts R21-12.4、§21.24 W0-22 第 3 条、W0-22 第 12 条;纯函数,无 I/O)。
 *
 * 分两步,**先分类、后归并**:
 *   ① journal 完整性错误(`refused` 且 `txn: null` 带 `journal`)与命令级失败(`refused`、`txn: null`、无 `journal`)的身份各自独立(序号 / 命令),**不被任何 `complete` 消除**;
 *   ② 逻辑事务身份 = `txn`(= `rollbackTxnId(id, content_sha256)`);只有「同一身份」的后续 `complete` / `revocation_complete` 才消除该身份此前的失败(同 id 不同 sha = 不同 txn,互不消除)。
 * 整体 = 各未解决身份取最小优先级号(匹配对象是 `cause`,不是 `why` 文案):
 *   1 `not_wired` → 3 internal;2 `credentials_invalid` → 3 revocations_invalid;3 `txn_invalid` / `txn_absent` / 完整性错误 → 3 txn_invalid;4 `candidate_invalid` → 3 candidate_invalid;
 *   5 `repo_unreadable` / 候选枚举失败 → 3 personal_repo_invalid;6 失败 variant 上缺失 / 未识别的 cause → 3 internal;7 命令级前置(锁 `locked` / `off` / `not_diverged`)→ 4;
 *   8 快照协议用尽 → 4 `RSI_SNAPSHOT_BUSY`;9 `manual_event_required` / `manual_by_ambiguous` / `retryable` / `incomplete` 的 `static_removal_pending` → 1(信息行带身份与 cause);
 *   10 `revocation_complete`(`repo_removal=deferred`)→ 0;11 `complete` → 0。
 * **缺 cause 只在要求 cause 的失败 variant(`incomplete` / `refused`)上才是 `internal`**;成功 variant 无 cause 是正常。已完成的撤销先逐行输出(`RSI_CLEAR_DONE`),再出失败行。
 * 参数 / 环境层(`not_tty` / `unknown_id` / `bad_date` / `unknown_arg`)在拿锁前判、退 2,优先于以上全部——不在本函数内。
 */
import type { RollbackOutcome } from '../personal/rollback.js';

export type ClearPrecondition = 'locked' | 'off' | 'not_diverged' | 'snapshot_busy';

export interface ClearExitInput {
  outcomes: readonly RollbackOutcome[];
  /** 候选枚举失败(含部分成功后) */
  enumerationFailed?: boolean;
  /** 命令级前置状态 */
  precondition?: ClearPrecondition;
  /** txn → 候选 id(`RSI_CLEAR_DONE` 行用;缺省以 `txn=` 代替) */
  candidateOf?: (txn: string) => string | undefined;
}

export interface ClearExit {
  exit: 0 | 1 | 3 | 4;
  /** 命中的最小优先级号(1..11);全部成功 = 10 / 11 */
  row: number;
  /** stdout 信息行(已完成的撤销在前) */
  info: string[];
  /** stderr 稳定码行 */
  errors: string[];
}

const CAUSE_ROW: Readonly<Record<string, number>> = Object.freeze({
  not_wired: 1,
  credentials_invalid: 2,
  txn_invalid: 3,
  txn_absent: 3,
  candidate_invalid: 4,
  repo_unreadable: 5,
  manual_event_required: 9,
  manual_by_ambiguous: 9,
  retryable: 9,
});
const ROW_REASON: Readonly<Record<number, string>> = Object.freeze({
  1: 'internal',
  2: 'revocations_invalid',
  3: 'txn_invalid',
  4: 'candidate_invalid',
  5: 'personal_repo_invalid',
  6: 'internal',
});

interface Pending {
  row: number;
  txn: string | null;
  cause: string;
}

export function mapClearExit(i: ClearExitInput): ClearExit {
  const info: string[] = [];
  const pending = new Map<string, Pending>();
  let unique = 0;
  let sawDeferred = false;
  for (const o of i.outcomes) {
    if (o.status === 'complete' || o.status === 'revocation_complete') {
      pending.delete(`txn:${o.txn}`);
      const cand = o.status === 'revocation_complete' ? o.candidate_id : i.candidateOf?.(o.txn);
      const who = cand === undefined ? `txn=${o.txn}` : `id=${cand}`;
      info.push(
        o.status === 'revocation_complete'
          ? `RSI_CLEAR_DONE ${who} revoked=yes repo_removal=deferred`
          : `RSI_CLEAR_DONE ${who} revoked=yes`,
      );
      if (o.status === 'revocation_complete') sawDeferred = true;
      continue;
    }
    // 失败 variant:缺失 / 未识别的 cause → 第 6 行(internal)
    const raw = (o as { cause?: unknown }).cause;
    const cause = typeof raw === 'string' && Object.hasOwn(CAUSE_ROW, raw) ? raw : '';
    let row = cause === '' ? 6 : (CAUSE_ROW[cause] as number);
    if (o.status === 'incomplete' && o.phase === 'static_removal_pending' && row >= 9) row = 9;
    // 身份:有 txn → 事务身份(可被同身份的 complete 消除);无 txn → 完整性错误 / 命令级失败(各自独立,永不被消除)
    const key =
      o.status === 'refused' && o.txn === null ? `uniq:${(unique += 1)}` : `txn:${o.txn as string}`;
    pending.set(key, {
      row,
      txn: o.txn,
      cause: cause === '' ? 'missing' : cause,
    });
  }
  const rows: number[] = [...pending.values()].map((p) => p.row);
  if (i.enumerationFailed === true) rows.push(5);
  if (i.precondition === 'snapshot_busy') rows.push(8);
  else if (i.precondition !== undefined) rows.push(7);
  if (rows.length === 0) {
    return { exit: 0, row: sawDeferred ? 10 : 11, info, errors: [] };
  }
  const row = Math.min(...rows);
  if (row <= 6) {
    return { exit: 3, row, info, errors: [`RSI_FAIL_CLOSED reason=${ROW_REASON[row] as string}`] };
  }
  if (row === 7) {
    const reason =
      i.precondition === 'off' ? 'off' : i.precondition === 'locked' ? 'locked' : 'not_diverged';
    return { exit: 4, row, info, errors: [`RSI_NOT_RUN reason=${reason}`] };
  }
  if (row === 8) return { exit: 4, row, info, errors: ['RSI_SNAPSHOT_BUSY'] };
  // 第 9 行:信息行带身份与 cause(只列第 9 行的失败身份)
  for (const p of pending.values()) {
    if (p.row === 9) info.push(`RSI_MANUAL txn=${p.txn ?? 'none'} cause=${p.cause}`);
  }
  return { exit: 1, row, info, errors: [] };
}
