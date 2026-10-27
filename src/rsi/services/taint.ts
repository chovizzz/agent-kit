/* eslint-disable @typescript-eslint/no-unused-vars -- 桩:参数是冻结的签名,由实装块使用 */
/**
 * taint 恢复与 purge journal 探测(契约 R20-4.7、R20-3.8.4 ~ R20-3.8.5)。**B3c 实装**;本块只冻结签名。
 */
import type { RsiLockHandle } from '../lock.js';
import type {
  PurgeJournalProbe,
  RsiServiceCtx,
  TaintResumeOutcome,
  TaintScanOutcome,
  TaintScanSource,
} from '../types.js';

/**
 * 锁内先于业务的 taint 续做(R20-4.7「续做」):扫描所有带 `TAINTED` 的暂存 run 与 promote 产物,把「全部摘录置空、删 `apply.patch` /
 * `promote.patch` / `pr-body.md`」补到完成(不因标记已存在而跳过,不依赖信号库映射);`confirmed` 下并续做 purge journal。
 * 必须传锁句柄:内部每个提交点前 `lock.assertHeld()`。负责块:B3c。
 */
export async function resumeTaint(
  _ctx: RsiServiceCtx,
  _lock: RsiLockHandle,
): Promise<TaintResumeOutcome> {
  throw new Error('not implemented');
}

/**
 * 锁内「发现并标记新 taint」(R20-4.7 时机 / 动作):按 `source` 现算命中已排除 key(或 purge journal 已记下的集合)的暂存 run 与 promote 产物,
 * 先独占创建 `TAINTED`,再清摘录 / 删 patch。与 {@link resumeTaint} 的分工:`resumeTaint` 只补完**已有**标记的清理,本函数负责**新**命中的目标。
 * 调用点(各持锁写入方在提交前,**先 resumeTaint 再本函数**):worker / `tick --write`、`purge --write`(在删信号之前、按 journal)、
 * `--rebuild-index --write`、`confirm`。必须传锁句柄。负责块:B3c;B3a 的 `projects --rebuild-index --write` 经它完成 taint,不自己实现。
 */
export async function taintNewlyExcluded(
  _ctx: RsiServiceCtx,
  _lock: RsiLockHandle,
  _source: TaintScanSource,
): Promise<TaintScanOutcome> {
  throw new Error('not implemented');
}

/**
 * 只读探测 purge journal(不拿锁、不写、不建目录)。给即时闸(R20-4.8 第 3 条)、`rsi status` 的 `purge.journal`、hint 用。
 * 「读不出」返回 `unreadable`,**不得**当 `absent`。负责块:B3c(B3a 的 status 调用它)。
 */
export async function detectPurgeJournal(
  _ctx: Pick<RsiServiceCtx, 'io'>,
): Promise<PurgeJournalProbe> {
  throw new Error('not implemented');
}
