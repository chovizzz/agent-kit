/**
 * 项目索引更新(R20-4.2,B4 方案 §3.4;B4-0 冻结签名,B4c1 实现)。**纯函数**:是否可写(D7:索引 ok 且 `salt_fp` 与真实盐一致,或索引与 cursor 都缺失)由调用方判。
 * 合并:同 key 同 path 只更新 `last_seen`;roots 超 8 条保留最早一条加 `last_seen` 最近的 7 条;新 key 的 `first_indexed_generation` = `generation`;
 * 满 `RSI_INDEX_MAX_ENTRIES` 后新 key 不入索引;条目 `sessions` / `signals` 取 `perKey` 的重算结果;entries 按 key 升序。
 */
import type { UpdateIndexInput, UpdateIndexResult } from './types.js';

export function updateIndex(input: UpdateIndexInput): UpdateIndexResult {
  void [input];
  throw new Error('not implemented');
}
