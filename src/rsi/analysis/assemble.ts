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
 *  - 有观测会话还要求开始时刻 ≤ 采集覆盖时刻(M2)。依据:`session-stats.ts` 的计数行是**首次采集即落盘**、之后随会话增长就地替换(`ts` 首写钉死为会话开始时刻),
 *    信号库另行追加;全仓没有「会话已结束」的标志,所以「有计数行」不能证明该会话的信号已读全。过滤只能挡住「根本还没读到」的会话;
 *    读取时仍在进行中的会话可能少计(只增不减),这是残余风险,汇报「问题」里登记。
 *  - C6 的分母按 ITT(R21-6.7):已关联且资格不成立的账行 `eligible=false`,不进 C6;未关联 / 项目不在采集中的资格不可知,保留。
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
    beyond_collected_through: 0,
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
  const eligibleOf = new Map<string, boolean | null>();
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
      // 项目不在采集中:资格不可知(命中只在采集中项目里统计),C6 分母保留
      eligibleOf.set(m, null);
      audit.not_collecting_project += 1;
      continue;
    }
    const eligible = input.eligible(it.stat.project_key, tsMs);
    eligibleOf.set(m, eligible);
    if (!eligible) audit.not_eligible += 1;
    // M2:计数行落盘 ≠ 会话信号完整(见文件头注)。会话开始晚于采集覆盖时刻的,L0 还没读到,不当作有观测会话
    if (tsMs > throughMs) {
      audit.beyond_collected_through += 1;
      continue;
    }
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
      eligible: eligibleOf.get(marker) ?? null,
      session_ts_ms: complete.get(marker) ?? null,
      at_ms: atMs,
    });
  }
  return { lines, observed, audit };
}
