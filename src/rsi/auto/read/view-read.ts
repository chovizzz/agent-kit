/**
 * `AutoView`(物化视图 `.state/rsi/auto-view.json`)的读取语义(contracts §21.24 W0-22 第 7 条;写入方归部署组装块,本期只读):
 *   - 缺失 → `missing`(派生键为 `null`,绝不显示成全零 / 正常);
 *   - 读不出 / 不是 JSON / 过不了 `AutoViewSchema` → `corrupt`(`rsi auto status` 退 0;只有 `state.json` 过不了 schema 才退 3);
 *   - `now - as_of > RSI_AUTO_VIEW_STALE_HOURS` → `stale`(数据照出并带 `as_of`);
 *   - `as_of` 晚于 `now` 超过时钟容差 → `corrupt`(未来时间戳会让视图永远显得新鲜,fail-closed)。
 * 纯函数,无 I/O。
 */
import { RSI_AUTO_VIEW_STALE_HOURS } from '../../../contracts/rsi.js';
import { AutoViewSchema, type AutoView } from '../../../contracts/rsi-personal.js';
import type { RawRead } from './ports.js';

export type ViewState = 'fresh' | 'stale' | 'missing' | 'corrupt';
export type ViewResult =
  { state: 'missing' | 'corrupt' } | { state: 'fresh' | 'stale'; view: AutoView };

/** 容许的时钟偏差(毫秒):`as_of` 晚于 now 超过它就不可信 */
export const VIEW_CLOCK_SKEW_MS = 5 * 60_000;

export function interpretView(raw: RawRead, now: Date): ViewResult {
  if (raw.kind === 'absent') return { state: 'missing' };
  if (raw.kind === 'unreadable') return { state: 'corrupt' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return { state: 'corrupt' };
  }
  const r = AutoViewSchema.safeParse(parsed);
  if (!r.success) return { state: 'corrupt' };
  const asOf = Date.parse(r.data.as_of);
  if (Number.isNaN(asOf)) return { state: 'corrupt' };
  const age = now.getTime() - asOf;
  if (age < -VIEW_CLOCK_SKEW_MS) return { state: 'corrupt' };
  return { state: age > RSI_AUTO_VIEW_STALE_HOURS * 3_600_000 ? 'stale' : 'fresh', view: r.data };
}
