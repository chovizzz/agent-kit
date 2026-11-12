/**
 * 会话级观测的归并(docs/contracts.md R21-6.6 / R21-6.7 / R21-1.7、§21.24 W0-14「按标记去重归 W6」)。**纯函数,无 I/O**:
 * 账、计数行、信号度量都由读取层(`read.ts`)取好后传入。
 *
 * 规则:
 *  - 分析对象 = 账里本候选、窗口内的 `treat` / `control` 行(一行 = 一个被随机的会话);`excluded` 行(含探针)不进。账里任一标记出现在两行 assign 上 → 输入非法(抛)。
 *  - 同一标记出现在多个会话计数行(resume / fork 复制注入块):取 `(ts, session_ref)` 最早的一个为**主**会话;别的只带这一个标记的会话是副本,整个丢弃
 *    (审计 `duplicate_marker_sessions_dropped`)。取回 ≥ 2 个不同标记的会话 → 「多标记」,整会话排除(不进观测、其标记对应的账行不算「完整」)。
 *  - 缺 `rsi_markers`(未采集)的会话不携带任何标记:它既不关联、也不算 0 个标记。
 *  - 账行「完整」(C6)= 其标记被主会话以**唯一**标记取回,且计数行所在 agent 与账行 agent 一致;其余(无会话、多标记、agent 不符)为不完整。
 *  - 有观测会话 = 完整 ∧ 采集中项目;`eligible`(R21-6.7)由调用方的端口现算,不在这里过滤(信息时间 t 按有观测会话计,统计量只用有观测 ∩ 资格成立)。
 *  - `judgeable`:账行 `at ≤ collectedThrough`(采集尚未覆盖的账行不进 C6,避免把「还没读到」当「关联失败」)。
 */
import type { RsiCanaryLedgerLine } from '../../contracts/rsi-personal.js';
import type { StatItem } from '../canary/marker-view.js';
import {
  AnalysisInputError,
  type AnalysisAgent,
  type AssembleAudit,
  type ObservedSession,
  type RandomizedLine,
} from './types.js';

export interface SessionMeasures {
  c1: number;
  c3: number;
  primary: number;
}

export interface AssembleInput {
  candidateId: string;
  /** 本评估期(canary / adopted)的起点;更早的账行不属于本次(canary 与 adopted 信息不累计,R21-7.4) */
  windowStartIso: string;
  /** 采集已覆盖到的时刻(L0 最近一次完整读完) */
  collectedThroughIso: string;
  ledger: readonly RsiCanaryLedgerLine[];
  stats: readonly StatItem[];
  /** 项目属「采集中」(R21-1.7 ②) */
  collecting(projectKey: string): boolean;
  /** 会话的信号度量;没有信号 = 全 0 */
  measures(sessionRef: string): SessionMeasures;
  /** 资格(R21-6.7):会话开始前 30 个 UTC 日内该项目出现过目标签名 */
  eligible(projectKey: string, tsMs: number): boolean;
}

export interface Assembled {
  lines: readonly RandomizedLine[];
  observed: readonly ObservedSession[];
  audit: AssembleAudit;
}

type AssignLine = Extract<RsiCanaryLedgerLine, { kind: 'assign' }>;

function parseMs(iso: string, what: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new AnalysisInputError(`${what}_unparseable`);
  return ms;
}

export function assemble(input: AssembleInput): Assembled {
  const startMs = parseMs(input.windowStartIso, 'window_start');
  const throughMs = parseMs(input.collectedThroughIso, 'collected_through');
  const audit: AssembleAudit = {
    ledger_assign_lines: 0,
    duplicate_marker_sessions_dropped: 0,
    multi_marker_sessions: 0,
    not_collecting_project: 0,
    agent_mismatch: 0,
    not_eligible: 0,
    foreign_marker_sessions: 0,
    unjudgeable_lines: 0,
    excluded_by_reason: {},
  };

  // 账:全账内标记唯一;本候选窗口内的 treat / control 行
  const seenMarkers = new Set<string>();
  const mine = new Map<string, AssignLine>();
  for (const l of input.ledger) {
    if (l.kind !== 'assign') continue;
    if (l.marker !== null) {
      if (seenMarkers.has(l.marker)) throw new AnalysisInputError('duplicate_marker_in_ledger');
      seenMarkers.add(l.marker);
    }
    if (l.candidate_id !== input.candidateId) continue;
    if (parseMs(l.at, 'ledger_at') < startMs) continue;
    if (l.arm === 'excluded') {
      const r = l.reason ?? 'unknown';
      audit.excluded_by_reason[r] = (audit.excluded_by_reason[r] ?? 0) + 1;
      continue;
    }
    if (l.marker !== null) mine.set(l.marker, l);
  }
  audit.ledger_assign_lines = mine.size;

  // 计数行:同一 session_ref 至多一行(取第一行)
  const seenRefs = new Set<string>();
  const items: StatItem[] = [];
  for (const it of input.stats) {
    if (seenRefs.has(it.stat.session_ref)) continue;
    seenRefs.add(it.stat.session_ref);
    if (it.stat.rsi_markers !== undefined && it.stat.rsi_markers.length > 0) items.push(it);
  }
  const startOf = (it: StatItem): number => parseMs(it.stat.ts, 'session_ts');
  const order = (a: StatItem, b: StatItem): number =>
    startOf(a) - startOf(b) || (a.stat.session_ref < b.stat.session_ref ? -1 : 1);
  items.sort(order);

  // 每个标记的主会话 = 最早的携带者(含多标记会话)
  const keeper = new Map<string, StatItem>();
  for (const it of items) {
    for (const m of it.stat.rsi_markers ?? []) if (!keeper.has(m)) keeper.set(m, it);
  }

  const complete = new Map<string, number>();
  const observed: ObservedSession[] = [];
  for (const it of items) {
    const markers = it.stat.rsi_markers ?? [];
    if (markers.length >= 2) {
      audit.multi_marker_sessions += 1;
      continue;
    }
    const m = markers[0] as string;
    if (keeper.get(m) !== it) {
      audit.duplicate_marker_sessions_dropped += 1;
      continue;
    }
    const line = mine.get(m);
    if (line === undefined) {
      audit.foreign_marker_sessions += 1;
      continue;
    }
    if (it.agent !== line.agent) {
      audit.agent_mismatch += 1;
      continue;
    }
    const tsMs = startOf(it);
    complete.set(m, tsMs);
    if (!input.collecting(it.stat.project_key)) {
      audit.not_collecting_project += 1;
      continue;
    }
    const eligible = input.eligible(it.stat.project_key, tsMs);
    if (!eligible) audit.not_eligible += 1;
    const me = input.measures(it.stat.session_ref);
    observed.push({
      session_ref: it.stat.session_ref,
      marker: m,
      agent: line.agent as AnalysisAgent,
      project_key: it.stat.project_key,
      arm: line.arm as 'treat' | 'control',
      ts: it.stat.ts,
      tsMs,
      background_fp: line.background_fp,
      c1: me.c1,
      c3: me.c3,
      primary: me.primary,
      retry_chain_max: it.stat.retry_chain_max ?? null,
      eligible,
    });
  }

  const lines: RandomizedLine[] = [];
  for (const [marker, l] of mine) {
    const atMs = parseMs(l.at, 'ledger_at');
    const judgeable = atMs <= throughMs;
    if (!judgeable) audit.unjudgeable_lines += 1;
    lines.push({
      marker,
      agent: l.agent as AnalysisAgent,
      arm: l.arm as 'treat' | 'control',
      at: l.at,
      background_fp: l.background_fp,
      overlaps_preset: l.overlaps_preset,
      judgeable,
      complete: complete.has(marker),
      session_ts_ms: complete.get(marker) ?? null,
      at_ms: atMs,
    });
  }
  return { lines, observed, audit };
}
