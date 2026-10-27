/**
 * `rsi projects --rebuild-index` 的规划(R20-3.5.5、D11 / D12;B4-0 冻结签名,B4c1 实现)。零写入:盐不存在 → 调用方报 `not_confirmed`;
 * 列举 + 头部读取(按 `parseHead` 的统一口径)至多 `RSI_REBUILD_MAX_FILES` 个文件、mtime 降序,读库计数;旧索引有效时合并(可信旧条目保留,新观测更新,
 * 保留 `first_indexed_generation`);算不出 key 的仍计 U;超出报 `RSI_LIMIT_FILES` 与 `remainingFiles`。
 */
import type { IoContext } from '../../io/paths.js';
import type { RsiConfigOn } from '../config.js';
import type { L0Deps, RebuildPlan } from './types.js';

export async function planRebuildIndex(
  io: IoContext,
  config: RsiConfigOn,
  deps?: L0Deps,
): Promise<RebuildPlan> {
  void [io, config, deps];
  throw new Error('not implemented');
}
