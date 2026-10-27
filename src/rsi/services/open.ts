/* eslint-disable @typescript-eslint/no-unused-vars -- 桩:参数是冻结的签名,由实装块使用 */
/**
 * rsi 子命令的上下文入口(契约 R20-2.5、§20.9 第 17、18 条;v2 §5)。**B3a 实装**,B3b / B3c 复用结果类型。
 */
import type { RsiEarlyContext, RsiOpenResult } from '../types.js';

export type { RsiOpenResult };

/**
 * `loadRsiConfig`(只读)→ off 则返回 `off`(不建任何上下文)→ on 才 `createRsiIoContext`(`explicitRoot` 不符 → `usage`/`root_mismatch`)。
 * **不创建目录、不拿锁、不恢复快照**:那些由调用方在拿到 `ready` 之后经 `withRsiLockIfGated` 做。负责块:B3a。
 */
export async function openRsiIo(_early: RsiEarlyContext): Promise<RsiOpenResult> {
  throw new Error('not implemented');
}
