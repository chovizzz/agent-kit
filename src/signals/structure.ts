/**
 * 信号结构字段判定(R1,供 R2 reflect 使用)。
 *
 * R0/R1 之前采集的存量信号没有 `event_kind` / `event_index`,而且**不会被回填**(重采按 sig_id 去重,
 * 旧行保持原样)。reflect 用 `hasStructureFields` 把它们当 unknown 排除并计数;要让旧会话拿到字段,
 * 须清掉 `.state/signals/<agent>/` 后重采。
 */
import type { Signal, SignalEventKind } from '../contracts/signal.js';

/** 结构字段齐全的信号:`event_kind` 与 `event_index` 必有,`tool_name` 只在 tool_call 上可能出现。 */
export type StructuredSignal = Signal & {
  event_kind: SignalEventKind;
  event_index: number;
};

/**
 * 可用于分类的判据:`event_kind` 与 `event_index` 同时存在,且 `tool_name`(若有)只出现在 `tool_call` 上。
 * 后一条是一致性检查:R1 只给 tool_call 填 tool_name,别处出现说明行被改动过或来自别的写入方,不采信。
 */
export function hasStructureFields(signal: Signal): signal is StructuredSignal {
  if (signal.event_kind === undefined || signal.event_index === undefined) return false;
  if (signal.tool_name !== undefined && signal.event_kind !== 'tool_call') return false;
  return true;
}

export interface StructurePartition {
  usable: StructuredSignal[];
  /** 缺结构字段(或不一致)而按 unknown 排除的条数 */
  unknown: number;
}

export function partitionByStructure(signals: readonly Signal[]): StructurePartition {
  const usable: StructuredSignal[] = [];
  let unknown = 0;
  for (const s of signals) {
    if (hasStructureFields(s)) usable.push(s);
    else unknown++;
  }
  return { usable, unknown };
}
