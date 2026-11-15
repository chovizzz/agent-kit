/**
 * `AutoView`(物化视图 `.state/rsi/auto-view.json`)的**纯构造**(契约 §21.24 W0-22 第 7 条 / W0-24;D4)。
 *
 * 纯函数:不读盘、不读 HEAD、不起子进程。输入是写入方(worker,在 `rsi/lock` 内)**一次读出**的快照;输出前跑 `AutoViewSchema`,不过就不产出
 * (宁可让旧视图变陈旧——陈旧 / 缺失视图的读侧语义见 `auto/read/view-read.ts`,它从不恢复任何授权)。
 *
 * 口径(逐项等同 R21-13.1 原文;**契约没写死的取舍**在此登记,装配 C 段 / owner 可订正):
 *  - `pipeline.states`:每个 `lifecycle` 状态一个键(含 0),值 = 该状态的记录数;
 *  - `pipeline.last30d`:近 30 个 UTC 日(今天及前 29 天)内「进入四个终态」的转移数(按 `transitions[]` 里 `dim=lifecycle`、`to=终态` 的 `at` 的 UTC 日;终态不可再出,故每个候选每个终态至多计一次);
 *    历史不可见时**拒绝重建**(`history_incomplete`,保留旧视图):任一记录 `transitions_dropped > 0`(256 条上限截掉了更早的转移,近 30 日的终态转移 / 最近一次回滚可能就在被截部分),
 *    或终态记录里找不到进入该终态的 lifecycle 转移 → 不输出「新鲜的确定计数」(AutoView 没有「未知」的表达,写 0 / null 就是编造确定事实);
 *  - 输入的快照里候选 id 必须唯一(重复 = `input_invalid`):重复记录会把状态计数与 last30d 放大,单条记录各自过 schema 并不能证明集合没有重复;
 *  - `canary`:`lifecycle=canary` 的记录(至多一条;多于一条 = 不变量被破坏 → 不产出),`treat` / `control` 取调用方给的分组计数,**缺则不产出**(不把「不知道」写成 0);
 *  - `last_rollback`:最近一次进入 `rolled_back` 的转移(`at` 最晚,同刻取 id 最小)的 `{id, at, reason(=该转移的原因码)}`,没有 = `null`;
 *  - `rolling_back`:`lifecycle ∈ {rolling_back, retiring}` 的记录,`entered_at` = 该记录进入当前状态的最后一次 lifecycle 转移的 `at`
 *    (找不到 = 历史被截断 → 不产出,因为随便编一个时间会让「停住」判定偏晚或偏早);按 `entered_at` 升序(最久的在前)、同刻按 id,至多 64 条,超出置 `rolling_back_truncated`;
 *  - `protection_marks`:调用方从审计行取出的标记;自 `at` 起 90 个 UTC 日后移除(`utcDay(at) + 90 > today` 才保留,与冷却同一日历口径);同 `(id, mark)` 只留最新;
 *    按 `at` 降序(最新在前)、同刻按 id,至多 64 条,超出置 `protection_marks_truncated`;
 *  - `budget.used_pct` / `cost` 由调用方给(预算与注入字节的采集适配器归装配 C 段);`cost.injected_bytes_mean` 取整(四舍五入)。
 */
import {
  AutoViewSchema,
  type AutoView,
  type PersonalLifecycleRecord,
} from '../../contracts/rsi-personal.js';
import { RSI_LIFECYCLE_STATES } from '../../contracts/rsi.js';

export const VIEW_LIST_MAX = 64;
export const VIEW_LAST_DAYS = 30;
export const VIEW_MARK_DAYS = 90;

type Mark = AutoView['protection_marks'][number];

export interface AutoViewSnapshot {
  now: Date;
  /** 权威记录的 HEAD(40 位十六进制);与 `records` 必须来自同一次读 */
  recordOid: string;
  records: readonly PersonalLifecycleRecord[];
  /** 候选 id → 分组计数(处理组 / 对照组会话数) */
  groupCounts: ReadonlyMap<string, { treat: number; control: number }>;
  /** 自动配额占用百分比(0–100) */
  budgetUsedPct: number;
  cost: { injectedBytesMean: number; s2Count: number };
  /** 审计里的保护标记(`at` 为标记落盘时间;未去重 / 未过期过滤) */
  protectionMarks: readonly Mark[];
}

export type ViewBuildWhy =
  | 'schema_invalid'
  | 'input_invalid'
  | 'history_incomplete'
  | 'canary_ambiguous'
  | 'canary_stats_missing'
  | 'rolling_back_entry_unknown';

export type ViewBuild = { ok: true; view: AutoView } | { ok: false; why: ViewBuildWhy };

const TERMINALS = ['rejected', 'rolled_back', 'expired', 'retired'] as const;

/** `YYYY-MM-DD`(UTC) */
const dayOf = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const byStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 该记录进入当前 `lifecycle` 状态的最后一次转移的 `at`;找不到 → `null` */
function enteredAt(rec: PersonalLifecycleRecord): string | null {
  let best: string | null = null;
  for (const t of rec.transitions) {
    if (t.dim !== 'lifecycle' || t.to !== rec.lifecycle) continue;
    if (best === null || Date.parse(t.at) >= Date.parse(best)) best = t.at;
  }
  return best;
}

function build(s: AutoViewSnapshot): ViewBuild {
  const asOf = s.now.toISOString();
  const today = dayOf(asOf);
  const windowStart = addDays(today, -(VIEW_LAST_DAYS - 1)); // 含

  // 集合不变量:候选 id 唯一(重复会放大 states / last30d;纯函数,不引入 I/O)
  if (new Set(s.records.map((r) => r.id)).size !== s.records.length) {
    throw new Error('duplicate_candidate_id'); // 由 buildAutoView 统一映射为 input_invalid
  }
  let historyIncomplete = false;

  const states: Record<string, number> = {};
  for (const st of RSI_LIFECYCLE_STATES) states[st] = 0;
  const last30d = { rejected: 0, rolled_back: 0, expired: 0, retired: 0 };
  let lastRollback: { id: string; at: string; reason: string } | null = null;
  const canaries: PersonalLifecycleRecord[] = [];
  const rolling: AutoView['rolling_back'] = [];

  for (const rec of s.records) {
    states[rec.lifecycle] = (states[rec.lifecycle] ?? 0) + 1;
    if (rec.transitions_dropped > 0) historyIncomplete = true;
    if ((TERMINALS as readonly string[]).includes(rec.lifecycle) && enteredAt(rec) === null) {
      historyIncomplete = true; // 终态记录里看不到进入该终态的转移:无法证明它不在近 30 日 / 不是最近一次回滚
    }
    for (const term of TERMINALS) {
      const hit = rec.transitions.find(
        (t) =>
          t.dim === 'lifecycle' &&
          t.to === term &&
          dayOf(t.at) >= windowStart &&
          dayOf(t.at) <= today,
      );
      if (hit !== undefined) last30d[term]++;
    }
    for (const t of rec.transitions) {
      if (t.dim !== 'lifecycle' || t.to !== 'rolled_back') continue;
      const later =
        lastRollback === null ||
        Date.parse(t.at) > Date.parse(lastRollback.at) ||
        (Date.parse(t.at) === Date.parse(lastRollback.at) && rec.id < lastRollback.id);
      if (later) lastRollback = { id: rec.id, at: t.at, reason: t.reason };
    }
    if (rec.lifecycle === 'canary') canaries.push(rec);
    if (
      (rec.lifecycle === 'rolling_back' || rec.lifecycle === 'retiring') &&
      rec.rollback !== null
    ) {
      const at = enteredAt(rec);
      if (at === null) return { ok: false, why: 'rolling_back_entry_unknown' };
      rolling.push({
        id: rec.id,
        content_sha256: rec.content_sha256,
        origin_reason: rec.rollback.reason,
        target_terminal: rec.rollback.target_terminal,
        entered_at: at,
      });
    }
  }

  if (historyIncomplete) return { ok: false, why: 'history_incomplete' };
  if (canaries.length > 1) return { ok: false, why: 'canary_ambiguous' };
  let canary: AutoView['canary'] = null;
  const c = canaries[0];
  if (c !== undefined) {
    const g = s.groupCounts.get(c.id);
    if (g === undefined) return { ok: false, why: 'canary_stats_missing' };
    canary = { id: c.id, treat: g.treat, control: g.control };
  }

  rolling.sort((a, b) => Date.parse(a.entered_at) - Date.parse(b.entered_at) || byStr(a.id, b.id));
  const rollingKept = rolling.slice(0, VIEW_LIST_MAX);

  const latest = new Map<string, Mark>();
  for (const m of s.protectionMarks) {
    if (addDays(dayOf(m.at), VIEW_MARK_DAYS) <= today) continue; // 满 90 个 UTC 日:移除
    const k = `${m.id}|${m.mark}`;
    const cur = latest.get(k);
    if (cur === undefined || Date.parse(m.at) > Date.parse(cur.at)) latest.set(k, m);
  }
  const marks = [...latest.values()].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at) || byStr(a.id, b.id) || byStr(a.mark, b.mark),
  );

  const candidate: unknown = {
    schema_version: 1,
    as_of: asOf,
    record_oid: s.recordOid,
    pipeline: { states, last30d },
    budget: { used_pct: s.budgetUsedPct },
    cost: { injected_bytes_mean: Math.round(s.cost.injectedBytesMean), s2_count: s.cost.s2Count },
    canary,
    last_rollback: lastRollback,
    rolling_back: rollingKept,
    rolling_back_truncated: rolling.length > VIEW_LIST_MAX,
    protection_marks: marks.slice(0, VIEW_LIST_MAX),
    protection_marks_truncated: marks.length > VIEW_LIST_MAX,
  };
  const parsed = AutoViewSchema.safeParse(candidate);
  return parsed.success ? { ok: true, view: parsed.data } : { ok: false, why: 'schema_invalid' };
}

/**
 * 构造视图。输入应已是校验过的快照(记录过 `PersonalLifecycleRecordSchema`、标记来自审计行);
 * 即便时间戳等字段仍然坏了(日期运算抛错),也只返回 `input_invalid`,不外抛——写入方据此保留旧视图。
 */
export function buildAutoView(s: AutoViewSnapshot): ViewBuild {
  try {
    return build(s);
  } catch {
    return { ok: false, why: 'input_invalid' };
  }
}
