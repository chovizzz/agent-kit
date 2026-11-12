/**
 * W6 测试夹具:手写的账行 / 计数行 / 会话观测构造器。**不调用被测判定**:期望值由各测试自己手写或独立计算。
 */
import type { RsiCanaryLedgerLine } from '../../../src/contracts/rsi-personal.js';
import type { SessionStat } from '../../../src/contracts/session-stat.js';
import type { StatItem } from '../../../src/rsi/canary/marker-view.js';
import type { Assembled } from '../../../src/rsi/analysis/assemble.js';
import type {
  AnalysisAgent,
  Arm,
  ObservedSession,
  RandomizedLine,
} from '../../../src/rsi/analysis/types.js';

export const CID = 'ra_0123456789ab';
export const OTHER_CID = 'ra_ba9876543210';
export const FP1 = '1'.repeat(16);
export const FP2 = '2'.repeat(16);
export const SHA = 'a'.repeat(64);
export const T_BASE = Date.parse('2026-11-01T00:00:00Z');
export const MIN = 60_000;

export const marker = (n: number): string => `rsm_${n.toString(16).padStart(16, '0')}`;
export const sessRef = (n: number): string => `s_${n.toString(16).padStart(16, '0')}`;
export const iso = (ms: number): string => new Date(ms).toISOString();
/** 账的 `at` 只到秒 */
export const ledgerAt = (ms: number): string => `${iso(ms).slice(0, 19)}Z`;

export function assign(
  n: number,
  arm: Arm | 'excluded',
  o: Partial<Extract<RsiCanaryLedgerLine, { kind: 'assign' }>> & { atMs?: number } = {},
): RsiCanaryLedgerLine {
  const { atMs, ...rest } = o;
  const excluded = arm === 'excluded';
  return {
    kind: 'assign',
    at: ledgerAt(atMs ?? T_BASE + n * MIN),
    agent: 'claude',
    marker: excluded ? null : marker(n),
    candidate_id: CID,
    arm,
    reason: excluded ? 'paused' : null,
    p: excluded ? 0 : 0.5,
    background_fp: FP1,
    background_fp_ex: FP2,
    policy_fp: SHA,
    case_set_sha256: null,
    overlaps_preset: false,
    hint_version: 1,
    probe_generation: null,
    probe_ticket: null,
    ...rest,
  } as RsiCanaryLedgerLine;
}

export function stat(
  n: number,
  o: {
    markers?: string[] | undefined;
    project?: string;
    agent?: 'claude' | 'codex' | 'pi';
    tsMs?: number;
    retry?: number;
    ref?: string;
  } = {},
): StatItem {
  const s: SessionStat = {
    session_ref: o.ref ?? sessRef(n),
    project_key: o.project ?? 'p1',
    ts: iso(o.tsMs ?? T_BASE + n * MIN),
    external_content: false,
    counts: { user_messages: 1, tool_calls: 2, tool_failures: 1, unknown_event_types: {} },
    ...('markers' in o && o.markers === undefined
      ? {}
      : { rsi_markers: o.markers ?? [marker(n)], injection_excluded: 0 }),
    ...(o.retry === undefined ? {} : { retry_chain_max: o.retry }),
  };
  return { agent: o.agent ?? 'claude', stat: s };
}

export function obsSession(n: number, arm: Arm, o: Partial<ObservedSession> = {}): ObservedSession {
  const tsMs = T_BASE + n * MIN;
  return {
    session_ref: sessRef(n),
    marker: marker(n),
    agent: 'claude' as AnalysisAgent,
    project_key: 'p1',
    arm,
    ts: iso(tsMs),
    tsMs,
    background_fp: FP1,
    c1: 0,
    c3: 0,
    primary: 0,
    retry_chain_max: null,
    eligible: true,
    ...o,
  };
}

export function lineOf(s: ObservedSession, o: Partial<RandomizedLine> = {}): RandomizedLine {
  return {
    marker: s.marker,
    agent: s.agent,
    arm: s.arm,
    at: ledgerAt(s.tsMs),
    background_fp: s.background_fp,
    overlaps_preset: false,
    judgeable: true,
    complete: true,
    session_ts_ms: s.tsMs,
    at_ms: s.tsMs,
    ...o,
  };
}

export const ZERO_AUDIT = {
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

/** 由会话观测造 `Assembled`:每个会话一个完整账行(按会话顺序),`extra` 为额外账行(例如不完整行) */
export function assembled(
  sessions: readonly ObservedSession[],
  extra: readonly RandomizedLine[] = [],
): Assembled {
  const lines = [...sessions.map((s) => lineOf(s)), ...extra].sort((a, b) => a.at_ms - b.at_ms);
  return { lines, observed: sessions, audit: { ...ZERO_AUDIT } };
}

/** 交替分组的会话序列:偶数序号 control、奇数序号 treat;`f` 给每个会话的覆盖项 */
export function alternating(
  count: number,
  f: (i: number, arm: Arm) => Partial<ObservedSession> = () => ({}),
  from = 0,
): ObservedSession[] {
  const out: ObservedSession[] = [];
  for (let i = 0; i < count; i++) {
    const arm: Arm = i % 2 === 0 ? 'control' : 'treat';
    out.push(obsSession(from + i, arm, f(i, arm)));
  }
  return out;
}
