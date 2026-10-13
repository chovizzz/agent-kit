import type { Signal } from '../contracts/signal.js';

/** 装载后的信号:结构字段已确认存在,摘录已按规则清洗(外部内容/失败结果的摘录一定是空串)。 */
export interface LoadedSignal extends Signal {
  readonly event_kind: NonNullable<Signal['event_kind']>;
  readonly event_index: number;
}

export interface LoadStats {
  /** 通过全部装载检查、进入分类的信号数 */
  loaded: number;
  /** SignalSchema 再校验失败的行 */
  dropped_schema: number;
  /** 摘录过 pass2 仍命中(或扫描失败)而整条丢弃的信号 */
  dropped_residual: number;
  /** 外部内容信号里库中摘录非空、被强制清空的条数 */
  external_excerpt_forced: number;
  /** 缺 event_kind/event_index(旧信号),按 unknown 排除 */
  structure_unknown: number;
  /** 失败工具结果的摘录被清空的条数(只计数,不进提示) */
  failed_excerpt_dropped: number;
  /** 被 since/agents 过滤掉的条数 */
  filtered_out: number;
}

export interface LoadResult {
  signals: LoadedSignal[];
  stats: LoadStats;
}

export type ClusterKind = 'explicit_lesson' | 'tool_fail_retry';

export interface Cluster {
  /** 稳定 id:`c<序号>`,序号按排序后位置 */
  id: string;
  kind: ClusterKind;
  /** tool_fail_retry 的工具名 */
  tool: string | undefined;
  /** 可作证据的成员(非外部、非失败结果、摘录非空) */
  members: LoadedSignal[];
  /** 全部成员(含失败结果),仅用于计数 */
  allSignals: LoadedSignal[];
  sessions: number;
  projects: number;
  failures: number;
  /** 聚类是否跨 ≥2 个项目且 ≥2 个会话(决定其证据能否进团队层) */
  teamEligible: boolean;
}

export interface EvidenceItem {
  alias: string;
  signal: LoadedSignal;
  clusterId: string;
  projectAlias: string;
}

export interface ExistingAtomInfo {
  id: string;
  title: string;
  layer: string;
  status: string;
  signatureType: string | undefined;
  signaturePattern: string | undefined;
  /** 用于相似度去重的正文(做/为什么);只在进程内使用,不进提示 */
  do: string;
  why: string;
}

export class ReflectUsageError extends Error {
  readonly code = 'REFLECT_USAGE';
}
export class ReflectFailClosedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export class ReflectCallLimitError extends Error {
  readonly code = 'REFLECT_CALL_LIMIT';
}
