/* eslint-disable @typescript-eslint/no-unused-vars -- 桩:参数是冻结的签名,由实装块使用 */
/**
 * 持锁提交 / 快照服务(契约 R20-5.6、R20-4.5;v2 §3)。**B3c 实装**;所有 `counts.json` 写入方(reflect / judge / taint / purge / tick …)共用。
 */
import type { RsiLockHandle } from '../lock.js';
import type {
  CountsProjectionInput,
  RsiCommitPlan,
  RsiCommitResult,
  RsiServiceCtx,
} from '../types.js';

/**
 * 提交义务:**锁句柄是必填的第二个位置参数**,不传 / 传 `null` 编译不过(`test/rsi/services.test.ts` 用 `@ts-expect-error` 固定)。
 * 实装契约:①任何访问磁盘之前先 `lock.assertHeld()`;②句柄必须属于 `ctx.io` 的 rsi 状态目录(不得「持 A 的锁写 B 的状态」);
 * ③只做「追加日志(若给)→ `commitSnapshot`」,`commitSnapshot` 为最后一步;counts / state / cursor 由调用方按 R20-6.9 的顺序先写
 * (counts 经 {@link writeCountsProjection});④失败一律抛,不返回部分完成。
 * 已知限制:`RsiLockHandle` 是结构类型,伪造对象能过类型检查,安全边界是运行时的 `assertHeld()`。负责块:B3c。
 */
export async function commitUnderLock(
  _ctx: RsiServiceCtx,
  _lock: RsiLockHandle,
  _plan: RsiCommitPlan,
): Promise<RsiCommitResult> {
  throw new Error('not implemented');
}

/**
 * 所有 `counts.json` 写入方共用的投影写入(R20-4.5、R20-6.9 第 4 位:在索引之后、state / cursor 之前)。目标值语义,见 `CountsProjectionInput`。
 * 实装契约同 {@link commitUnderLock}:先 `assertHeld()`,句柄属于 `ctx.io` 的 rsi 状态目录;只写 `counts.json`(临时文件 + rename),
 * 不更新快照清单(清单由随后的 `commitUnderLock` 一次覆盖)。负责块:B3c。
 */
export async function writeCountsProjection(
  _ctx: RsiServiceCtx,
  _lock: RsiLockHandle,
  _input: CountsProjectionInput,
): Promise<void> {
  throw new Error('not implemented');
}
