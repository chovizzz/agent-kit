/**
 * 压缩的**纯规划**(无 I/O;设计稿 v3 §B.2 / §A.2、第 2 版 §1;§21.24 W0-26 第 8 条):目标选择、区间完备证明里的审计侧计数与去重、P1 的账判据、P3 / P4 的纯结果。
 * `Compactor`(`compactor.ts`)只负责编排(事务 / 恢复 / 提交顺序),所有「算什么」在这里,便于逐条变异。
 *
 * 去重规则(**身份先于日期**):
 *  1. 权威派生行(`derivedThrough(W_new)`,全部键、不限区间)按 `idem_key` 与**文件里同键行**(不论文件行的日期落在哪)整行比较(含 `at`;终态空操作行除外,见 `sameRowForKey`),
 *     不等 = `AuditKeyConflict`,拒推进;
 *  2. 通过比较后才按**日期**归桶:只数日期落在 `(W_old, W_new]` 的事件;文件行(有键 / 无键)各计一行 `deleted`,派生事件里文件没有同键行的计一行 `derived_missing`;
 *  3. ≤ `W_old` 的残留行已在更早的运行里计入,**不再计数**(P3 续删不重复)。区间两两不交,故跨运行不重不漏。
 */
import type { RsiAuditLine } from '../../contracts/rsi-personal.js';
import {
  addUtcDays,
  cooldownActive,
  utcDay,
  type RsiAuditCompaction,
  type RsiAuditMonth,
  type RsiEffectsLedger,
  type StoreCause,
  type UtcDay,
} from '../../contracts/rsi-store.js';
import { RsiAuditLineSchema } from '../../contracts/rsi-personal.js';
import { sameRowForKey } from './audit-classify.js';
import { AuditKeyConflict, StoreError } from './errors.js';
import {
  beginWorking,
  checkMeta,
  finalize,
  partitionEffects,
  type CheckedMeta,
  type LedgerEffect,
} from './ledger-merge.js';
import type { DerivedRow, ReconcileEntry, RecoveryBatch } from './ports.js';

/** 触发参数(第 2 版 §1;契约原无,W0-26 定):年龄 365 天;条数 > 18000 时推进到剩余 ≤ 15000 */
export const RSI_COMPACT_POLICY = Object.freeze({
  ageDays: 365,
  highLines: 18000,
  lowLines: 15000,
} as const);

const dayOf = (r: RsiAuditLine): UtcDay => utcDay(r.at);

/**
 * 目标选择:只看日期 > `wOld` 的行(≤ `wOld` 的是待删残留,不参与)。年龄触发 = 存在日 ≤ 今日 − 365 → 目标今日 − 365;
 * 容量触发 = 行数 > 18000 → 使剩余 ≤ 15000 的最小日(且 < 今日);两者取较大者。**目标必须严格大于现有 W 且严格早于今日**,否则 `null`(本次不推进)。
 * `explicit`(测试 / C 的运维入口)直接给目标:同样须 < 今日(否则 `out_of_range`),且须 > `wOld`。
 */
export function pickTarget(
  rows: readonly RsiAuditLine[],
  wOld: UtcDay | null,
  today: UtcDay,
  explicit?: UtcDay,
): UtcDay | null {
  const beyondW = (d: UtcDay): boolean => wOld === null || d > wOld;
  if (explicit !== undefined) {
    if (!(explicit < today)) throw new StoreError('out_of_range', `target:${explicit}`);
    return beyondW(explicit) ? explicit : null;
  }
  const days = rows.map(dayOf).filter(beyondW).sort();
  let target: UtcDay | null = null;
  const cutoff = addUtcDays(today, -RSI_COMPACT_POLICY.ageDays);
  if (days.length > 0 && (days[0] as string) <= cutoff) target = cutoff;
  if (days.length > RSI_COMPACT_POLICY.highLines) {
    // 剩余 = 日期 > D 的行数;取使剩余 ≤ lowLines 的最小 D(升序扫描的行下标)
    const idx = days.length - RSI_COMPACT_POLICY.lowLines - 1;
    const d = days[idx] as string;
    if (target === null || d > target) target = d;
  }
  if (target === null || !(target < today) || !beyondW(target)) return null;
  return target;
}

// ---------- P1:账判据(只读) ----------
export type BatchCheck = { ok: true } | { ok: false; cause: StoreCause };

/**
 * 逐批纯判据「效果已被满足或被合法后继状态覆盖」:**只看账里的状态,不看 `applied` 键**(键只作冲突检测,可被裁 / 可被丢;键在不在与「保护是否成立」无关)。
 *  - 黑名单:同 `(id, sha)` 的项存在(**含已 lifted**:lifted 即历史 veto 已处理,不复活);
 *  - 墓碑:同 id 的项存在且 `(terminal, reason)` 相同;存在但不同 = 冲突(`effects_key_conflict`);
 *  - 冷却:该批的事件时间 `at + days` 已不生效(`!cooldownActive`,已过期被裁),**或**同 `(cluster_id, kind)` 项 `at` ≥ 批内 `at` 且 `days` ≥ 批内 `days`;
 *  元信息 / 效果形状不合规照样抛的 `StoreError` 在这里转成「不满足 + cause」(交给恢复端口复核并上报,绝不当作满足)。
 */
export function checkBatch(ledger: RsiEffectsLedger, b: RecoveryBatch, today: UtcDay): BatchCheck {
  try {
    const effects = partitionEffects(b.effects).ledger;
    const m = checkMeta(effects, b.meta);
    for (const e of effects) {
      const c = effectState(ledger, e, m, today);
      if (c !== 'ok') return { ok: false, cause: c };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof StoreError) return { ok: false, cause: e.code };
    throw e;
  }
}

function effectState(
  l: RsiEffectsLedger,
  e: LedgerEffect,
  m: CheckedMeta,
  today: UtcDay,
): 'ok' | StoreCause {
  switch (e.type) {
    case 'blacklist_veto':
      return l.blacklist.some(
        (x) => x.candidate_id === e.id && x.content_sha256 === e.content_sha256,
      )
        ? 'ok'
        : 'compact_blocked';
    case 'write_tombstone': {
      const t = l.tombstones.find((x) => x.id === e.id);
      if (t === undefined) return 'compact_blocked';
      return t.terminal === e.terminal && t.reason === e.reason ? 'ok' : 'effects_key_conflict';
    }
    case 'start_cooldown': {
      if (!cooldownActive({ at: m.event_at, days: e.days }, today)) return 'ok';
      const c = l.cooldowns.find((x) => x.cluster_id === e.cluster_id && x.kind === e.kind);
      return c !== undefined && Date.parse(c.at) >= Date.parse(m.event_at) && c.days >= e.days
        ? 'ok'
        : 'compact_blocked';
    }
  }
}

// ---------- 审计侧计数 ----------
export interface MonthDelta {
  deleted: number;
  derived_missing: number;
  by_kind: Record<string, number>;
  transition_by_to: Record<string, number>;
}
export interface IntervalCount {
  months: Record<string, MonthDelta>;
  deleted: number;
  derived_missing: number;
}

const monthOf = (d: UtcDay): string => d.slice(0, 7);

export interface IntervalInput {
  /** 文件里的全部行(含 ≤ `wOld` 的残留与无键行) */
  rows: readonly RsiAuditLine[];
  byKey: ReadonlyMap<string, RsiAuditLine>;
  derived: readonly DerivedRow[];
  entries: readonly ReconcileEntry[];
  wOld: UtcDay | null;
  wNew: UtcDay;
}

/** 校验权威侧(跨信任边界):行合规、键与行内键一致、键唯一、日期 ≤ `wNew`;每个 lifecycle 条目都有对应的派生行 */
function checkSource(i: IntervalInput): Map<string, DerivedRow> {
  const byKey = new Map<string, DerivedRow>();
  for (const d of i.derived) {
    const p = RsiAuditLineSchema.safeParse(d.row);
    if (!p.success || p.data.idem_key !== d.idem_key) {
      throw new StoreError('audit_bad_line', 'derived_row');
    }
    if (dayOf(p.data) > i.wNew) throw new StoreError('out_of_range', `derived:${d.idem_key}`);
    if (byKey.has(d.idem_key)) throw new StoreError('audit_dup_key', `derived:${d.idem_key}`);
    byKey.set(d.idem_key, { ...d, row: p.data });
  }
  for (const e of i.entries) {
    if (utcDay(e.at) > i.wNew) throw new StoreError('out_of_range', `entry:${e.idem_key}`);
    if (!byKey.has(e.idem_key))
      throw new StoreError('compact_blocked', `entry_not_derived:${e.id}`);
  }
  return byKey;
}

export function countInterval(i: IntervalInput): IntervalCount {
  const derived = checkSource(i);
  // ① 身份先于日期:派生行与文件同键行整行比较(不论落在 W_old / W_new 的哪一边)
  for (const [key, d] of derived) {
    const have = i.byKey.get(key);
    if (have !== undefined && !sameRowForKey(have, d.row)) throw new AuditKeyConflict(key);
  }
  const inInterval = (d: UtcDay): boolean => d <= i.wNew && (i.wOld === null || d > i.wOld);
  const months: Record<string, MonthDelta> = {};
  let deleted = 0;
  let derivedMissing = 0;
  const bump = (r: RsiAuditLine, kind: 'deleted' | 'derived_missing'): void => {
    const m = (months[monthOf(dayOf(r))] ??= {
      deleted: 0,
      derived_missing: 0,
      by_kind: {},
      transition_by_to: {},
    });
    m[kind] += 1;
    m.by_kind[r.kind] = (m.by_kind[r.kind] ?? 0) + 1;
    // 缺 `to` 的 transition 行落入固定桶 `unknown`,保证 `transition_by_to` 之和 = `by_kind.transition`
    if (r.kind === 'transition') {
      const to = r.to ?? 'unknown';
      m.transition_by_to[to] = (m.transition_by_to[to] ?? 0) + 1;
    }
    if (kind === 'deleted') deleted += 1;
    else derivedMissing += 1;
  };
  // ② 文件行(有键 / 无键):日期落在 (W_old, W_new] 的各计一行 deleted
  for (const r of i.rows) if (inInterval(dayOf(r))) bump(r, 'deleted');
  // ③ 派生事件:文件里没有同键行、日期落在区间的计 derived_missing(同键已在文件 → 已按文件行计,不再计)
  for (const [key, d] of derived) {
    if (i.byKey.has(key)) continue;
    if (inInterval(dayOf(d.row))) bump(d.row, 'derived_missing');
  }
  return { months, deleted, derived_missing: derivedMissing };
}

/** 把区间增量并入既有汇总(纯):`lines = deleted + derived_missing`;不改入参 */
export function mergeMonths(
  prev: RsiAuditCompaction['months'],
  delta: Record<string, MonthDelta>,
): RsiAuditCompaction['months'] {
  const out: Record<string, RsiAuditMonth> = {};
  for (const [k, m] of Object.entries(prev)) {
    out[k] = { ...m, by_kind: { ...m.by_kind }, transition_by_to: { ...m.transition_by_to } };
  }
  const add = (a: Record<string, number>, b: Record<string, number>): void => {
    for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v;
  };
  for (const [k, d] of Object.entries(delta)) {
    const m = (out[k] ??= {
      lines: 0,
      deleted: 0,
      derived_missing: 0,
      by_kind: {},
      transition_by_to: {},
    });
    m.deleted += d.deleted;
    m.derived_missing += d.derived_missing;
    m.lines = m.deleted + m.derived_missing;
    add(m.by_kind, d.by_kind);
    add(m.transition_by_to, d.transition_by_to);
  }
  return out;
}

// ---------- P3 / P4 的纯结果 ----------
/** P3:去掉日期 ≤ W 的行后的审计文本(保留原行字节;`lines` 与 `rows` 一一对应) */
export function keepAfter(
  lines: readonly string[],
  rows: readonly RsiAuditLine[],
  w: UtcDay,
): string {
  const kept = lines.filter((_, i) => dayOf(rows[i] as RsiAuditLine) > w);
  return kept.map((l) => `${l}\n`).join('');
}

/**
 * P4:裁过期冷却与日期 ≤ W 的 `applied` 键。**复用 `finalize`(账合并的唯一收尾路径)**,不另写第二套规则;没有可裁的东西返回 `null`(不提交)。
 * 只比较条数:`finalize` 只会删,不会加。
 */
export function pruneLedger(
  base: RsiEffectsLedger,
  today: UtcDay,
  w: UtcDay,
): RsiEffectsLedger | null {
  const r = finalize(beginWorking(base), { today, watermark: w });
  if (r.kind !== 'commit') return null;
  const pruned =
    r.next.cooldowns.length !== base.cooldowns.length ||
    r.next.applied.length !== base.applied.length;
  return pruned ? r.next : null;
}
