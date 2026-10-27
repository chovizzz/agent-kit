/**
 * counts 的磁盘重算(R20-4.5,B4 方案 §3.5;B4-0 冻结签名,B4c1 实现):`per_key` / `unknown_keys_signals` 由流式读 `.state/signals/**` 与 `.state/sessions/**` 得到
 * (自己读,不 import `session-stats` / `state-store`);`signals_by_day` 按信号 `ts` 的 UTC 日、只保留最近 8 日;`staged` 只重算 `tainted`(lstat `TAINTED`)。
 * 每次提交都全量重算,不看本次是否有新增。`clusters` 由提交侧 `commit.ts` 重算(D13-A),不在这里。
 */
import type { IoContext } from '../../io/paths.js';
import type { RsiConfigOn } from '../config.js';
import type { RecomputedCounts } from './types.js';

export async function recomputeCounts(
  io: IoContext,
  config: RsiConfigOn,
  now: Date,
): Promise<RecomputedCounts> {
  void [io, config, now];
  throw new Error('not implemented');
}
