/**
 * purge 的只读规划(R20-3.8;R20-A2 B5 方案 §6.1;**B5-0 只放签名桩,B5c 实装**)。干跑、锁前预检、锁内规划共用。
 */
import type { RsiConfigOn } from '../config.js';
import type { IoContext } from '../../io/paths.js';
import { notImplemented } from './not-implemented.js';

export type PurgeMode =
  { kind: 'project'; path: string } | { kind: 'excluded' } | { kind: 'resume' };

/** 全部升序去重 */
export interface PurgeTargets {
  keys: string[];
  runs: string[];
  promotes: string[];
}

export interface PurgeCounts {
  signals: number;
  sessionRows: number;
  cursorEntries: number;
  indexEntries: number;
  runs: number;
  promotes: number;
}

/**
 * K:`--excluded` = 当前判为 X 的全部 key;`--project` = 任一索引根落在 `p` 之内(R20-4.4 口径)的 key,且每个都必须是 X,否则 `notExcluded: true`。
 * 索引 absent / invalid / 盐不符 → 抛 `RsiFailClosedError('index_invalid')`。
 */
export async function resolvePurgeKeys(
  io: IoContext,
  config: RsiConfigOn,
  mode: PurgeMode,
): Promise<{ keys: string[]; notExcluded: boolean }> {
  return notImplemented('resolvePurgeKeys', io, config, mode);
}

/** 待 taint 的目标:run 的任一证据 sig 映射到 K;promote 的 `report.json.run_id` 指向这些 run(与 `taint.ts` 的 `planPromotes` 同口径) */
export async function planPurgeTargets(
  io: IoContext,
  keys: readonly string[],
): Promise<PurgeTargets> {
  return notImplemented('planPurgeTargets', io, keys);
}

/** 流式数信号库 / 会话计数行(`openStreamSafe`),数 cursor / 索引条目 */
export async function countPurge(io: IoContext, keys: readonly string[]): Promise<PurgeCounts> {
  return notImplemented('countPurge', io, keys);
}
