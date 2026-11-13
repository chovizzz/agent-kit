/**
 * 停住候选的三态判定(contracts §21.24 W0-22 第 7 条;纯函数,无 I/O)。
 * 输入 = 视图里的 `rolling_back[]` 与「journal 存在性」(`rsi auto status` 的存在性弱协议读到的结果);不解析 journal、不跑 git。
 *   - `stalled`:`origin_reason` 属不可重建类(`harm_*` / `judge_*` / `limit_reached`)、`entered_at` 距今大于 `RSI_STALL_GRACE_MINUTES`,且没有该候选的 journal;
 *   - `pending`:宽限内,或原因属可重建类(worker 的 `resumeAll` 会补 journal);
 *   - `unconfirmed:<why>`:视图陈旧 / 存在性读取在双读之间变化 / 读不出。
 * 该候选已有 journal(在途、正常推进)→ 不列入。`by_ambiguous` 需要 journal 内容,status 无此数据源,只在 `rsi show` 出现。
 */
import { RSI_STALL_GRACE_MINUTES } from '../../../contracts/rsi.js';
import type { AutoView } from '../../../contracts/rsi-personal.js';
import { txnId } from '../../personal/ids.js';

export type UnconfirmedWhy =
  'view_stale' | 'view_missing' | 'view_corrupt' | 'snapshot_moving' | 'txn_unreadable';
export type StallState = 'stalled' | 'pending' | `unconfirmed:${UnconfirmedWhy}`;
export interface StalledItem {
  id: string;
  /** `event_required` = 原因属不可重建类(缺原始证据,需人工);`recoverable` = worker 可重建 */
  stall: 'event_required' | 'recoverable';
  state: StallState;
}

/** journal 存在性读取的结果:名字集合 / 双读之间变化 / 读不出 */
export type JournalExistence =
  { kind: 'names'; names: ReadonlySet<string> } | { kind: 'moving' } | { kind: 'unreadable' };

/** 不可重建类:`harm_*` / `judge_*` / `limit_reached`(终止事件需要原始证据,journal 丢失后无法由原因码重建) */
export function isUnrecoverableOrigin(reason: string): boolean {
  return /^(harm_|judge_)/.test(reason) || reason === 'limit_reached';
}

/** 一个 `rolling_back` 候选对应的事务目录名(不含 `.json`) */
export const journalNameOf = (id: string, contentSha256: string): string =>
  txnId('rollback', [id], null, contentSha256);

export function classifyRollingBack(
  entries: AutoView['rolling_back'],
  ctx: { viewState: 'fresh' | 'stale'; now: Date; journals: JournalExistence },
): StalledItem[] {
  const out: StalledItem[] = [];
  for (const e of entries) {
    const stall = isUnrecoverableOrigin(e.origin_reason) ? 'event_required' : 'recoverable';
    if (ctx.viewState === 'stale') {
      out.push({ id: e.id, stall, state: 'unconfirmed:view_stale' });
    } else if (ctx.journals.kind === 'moving') {
      out.push({ id: e.id, stall, state: 'unconfirmed:snapshot_moving' });
    } else if (ctx.journals.kind === 'unreadable') {
      out.push({ id: e.id, stall, state: 'unconfirmed:txn_unreadable' });
    } else if (!ctx.journals.names.has(journalNameOf(e.id, e.content_sha256))) {
      const ageMs = ctx.now.getTime() - Date.parse(e.entered_at);
      const past = ageMs > RSI_STALL_GRACE_MINUTES * 60_000;
      out.push({
        id: e.id,
        stall,
        state: stall === 'event_required' && past ? 'stalled' : 'pending',
      });
    }
  }
  return out;
}
