/**
 * `rsi rollback --to <日期>` 的候选选取(纯函数,无 I/O;干跑与执行共用,contracts §21.24 W0-22 第 4 条;R21-12.7):
 *   - 「该 UTC 日之后」读作**严格大于**:候选「进入 `canary` 的 UTC 日」> D(不含当日);
 *   - 范围 = 进入过 `canary` 的非终态候选(`canary` / `adopted` / `stable` / `retiring` / `rolling_back`;已在 `rolling_back` 的在途候选沿用其 journal 与 R21-4.4a);
 *   - **日期不可知**(`transitions_dropped > 0` 且找不到进入 `canary` 的记录)按保守方向**纳入**并**单列**(`dateUnknown`),不得静默纳入也不得静默排除;
 *   - 找不到进入记录而 `transitions_dropped === 0` = 记录自相矛盾 → `invalid`(调用方按 `candidate_invalid` 退 3,不静默排除);
 *   - 顺序:按生效逆序(进入 `canary` 的时刻晚者在前,同刻按 id);日期不可知的按 id。
 */
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';

const SCOPE = new Set(['canary', 'adopted', 'stable', 'retiring', 'rolling_back']);

export interface RollbackCandidate {
  id: string;
  lifecycle: string;
  content_sha256: string;
  /** 进入 `canary` 的 UTC 日(`YYYY-MM-DD`);日期不可知 = null */
  entered_on: string | null;
  entered_at: string | null;
}
export interface RollbackSelection {
  candidates: RollbackCandidate[];
  dateUnknown: RollbackCandidate[];
  invalid: string[];
}

/** 严格 `YYYY-MM-DD` 且是真实日历日;否则 `null`(调用方退 2 `bad_date`) */
export function parseUtcDate(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

export function selectRollbackTo(
  records: readonly PersonalLifecycleRecord[],
  date: string,
): RollbackSelection {
  const out: RollbackSelection = { candidates: [], dateUnknown: [], invalid: [] };
  for (const r of records) {
    if (!SCOPE.has(r.lifecycle)) continue;
    const entry = r.transitions.find((t) => t.dim === 'lifecycle' && t.to === 'canary');
    const base = { id: r.id, lifecycle: r.lifecycle, content_sha256: r.content_sha256 };
    if (entry === undefined) {
      if (r.transitions_dropped > 0) {
        out.dateUnknown.push({ ...base, entered_on: null, entered_at: null });
      } else {
        out.invalid.push(r.id);
      }
      continue;
    }
    // `at` 可带时区偏移:一律换算成 UTC 再取日期
    const atUtc = new Date(Date.parse(entry.at)).toISOString();
    const day = atUtc.slice(0, 10);
    if (day > date) out.candidates.push({ ...base, entered_on: day, entered_at: atUtc });
  }
  out.candidates.sort((a, b) =>
    a.entered_at === b.entered_at
      ? a.id < b.id
        ? -1
        : 1
      : (b.entered_at as string) < (a.entered_at as string)
        ? -1
        : 1,
  );
  out.dateUnknown.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  out.invalid.sort();
  return out;
}
