/**
 * 信号库 / 会话计数月文件的按 key 过滤重写(R20-A2 B5 方案 §6.1;**B5-0 只放签名桩,B5c 实装**)。提交侧,信号库与会话计数共用。
 */
import type { IoContext } from '../io/paths.js';
import type { WriteGate } from './state-store.js';

/**
 * 安全打开一次、流式读;没有命中行 → `'unchanged'`(不写);有命中 → 写 `<file>.tmp` + rename(全部删光也写成空文件,**永不删除月文件**,D5)。
 * 每个写点之前 `gate(op, path)`;坏行 / 缺尾换行 / 硬链接 / 中途换链 → `SignalStoreError`(调用方映射为 `signal_store_corrupt`)。
 */
export async function rewriteMonthFileWithout(
  io: IoContext,
  absPath: string,
  keys: ReadonlySet<string>,
  keyOf: (line: unknown) => string | null,
  gate: WriteGate,
): Promise<'unchanged' | { removed: number }> {
  void [io, absPath, keys, keyOf, gate]; // 桩:形参只为固定签名
  throw new Error('not implemented: rewriteMonthFileWithout');
}
