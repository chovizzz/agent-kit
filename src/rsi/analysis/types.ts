/**
 * 变差检验的数据形状(docs/contracts.md §21.6 R21-6.6 / R21-6.7、§21.7)。纯类型与常量,无 I/O。
 * 常量只放本目录(契约没有给出的数值不进 `src/contracts/rsi.ts`):见各常量的注释与汇报「问题」。
 */
import { RSI_ALPHA_WORSE_TOTAL } from '../../contracts/rsi.js';

/** 参与分组的 agent(R21-6.1);codex 不参与 */
export const ANALYSIS_AGENTS = ['claude', 'pi'] as const;
export type AnalysisAgent = (typeof ANALYSIS_AGENTS)[number];
export type Arm = 'treat' | 'control';

/** 判变差的四项(R21-7.4;C4 是绝对上限,不在此列) */
export const HARM_P_METRICS = ['c1', 'c2', 'c3', 'c6'] as const;
export type HarmPMetric = (typeof HARM_P_METRICS)[number];

/** 每项的 α:总 α 在四项间平分(Bonferroni)。分母是上面这张表,不是 `RSI_HARM_METRICS`(后者含 c4) */
export const ALPHA_PER_METRIC = RSI_ALPHA_WORSE_TOTAL / HARM_P_METRICS.length;

/** C2 只在有工具名的 agent 之间可比(claude / pi;codex / kimi 无 `retry_chain_max`,W0-14) */
export const C2_COMPARABLE_AGENTS: readonly AnalysisAgent[] = ['claude', 'pi'];

/** 资格窗口(R21-6.7「30 个 UTC 日」):命中日 ≥ 会话开始日 − 30 天,且命中会话开始于本会话之前(契约未给边界,见「问题」) */
export const ELIGIBILITY_DAYS = 30;
/** 分层里每组至少要有的会话数(R21-7.2) */
export const MIN_ARM_PER_STRATUM = 2;

/** 账里一行 treat / control = 一个被随机的会话(C6 的分母单位) */
export interface RandomizedLine {
  marker: string;
  agent: AnalysisAgent;
  arm: Arm;
  at: string;
  background_fp: string;
  overlaps_preset: boolean;
  /** 采集已覆盖到该行(`at ≤ collectedThrough`);否则尚不可判,不进 C6 */
  judgeable: boolean;
  /** 经标记关联到恰 1 个标记的会话(同 agent) */
  complete: boolean;
  /** 关联到的会话的开始时刻(毫秒);不完整 = `null` */
  session_ts_ms: number | null;
  at_ms: number;
}

/** 「有观测会话」(R21-1.7):完整读完、采集中项目、已关联且非多标记。`eligible` 另算(R21-6.7) */
export interface ObservedSession {
  session_ref: string;
  marker: string;
  agent: AnalysisAgent;
  project_key: string;
  arm: Arm;
  ts: string;
  tsMs: number;
  background_fp: string;
  /** C1:`tool_result_failed` 信号数 */
  c1: number;
  /** C3:显式教训 ∪ 用户纠正的信号数 */
  c3: number;
  /** 主判据:命中候选签名的事件数(只出报告) */
  primary: number;
  /** C2 的会话标量 `retry_chain_max`;`null` = 未测 / 不可比(不是 0) */
  retry_chain_max: number | null;
  eligible: boolean;
}

export interface AssembleAudit {
  ledger_assign_lines: number;
  duplicate_marker_sessions_dropped: number;
  multi_marker_sessions: number;
  not_collecting_project: number;
  agent_mismatch: number;
  not_eligible: number;
  /** 不在本候选账行里的标记(别的候选 / 探针 / 未知)所属会话,不计 */
  foreign_marker_sessions: number;
  unjudgeable_lines: number;
}

/** 一个 unit(统计的最小观测):分层键 + 组别 + 值 */
export interface Unit {
  agent: string;
  project: string;
  arm: Arm;
  v: number;
}

export class AnalysisInputError extends Error {
  readonly code = 'RSI_ANALYSIS_INPUT';
  constructor(readonly why: string) {
    super(`analysis input: ${why}`);
  }
}
