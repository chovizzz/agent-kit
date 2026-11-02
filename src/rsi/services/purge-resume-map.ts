/**
 * purge journal 续做失败的错误归并(R20-3.8.5:其它写入方遇到无法完成的 journal → `purge_incomplete`,熔断按 safety)。
 * `rsi tick --write` 与后台 worker 共用(A3 从 `tick.ts` 原样抽出,行为不变)。
 */
import { RsiLockError } from '../lock-error.js';
import { RsiFailClosedError } from '../types.js';
import { RsiStagingBlockedError } from './staging.js';

/** 返回要抛的错误:失锁与更具体的阻断保留原码,其余一律 `purge_incomplete` */
export function mapPurgeResumeError(e: unknown): unknown {
  // 失锁与更具体的阻断(暂存目录数超限 / 暂存区里有 safe-fs 无法处理的条目)保留原码
  if (e instanceof RsiLockError || e instanceof RsiStagingBlockedError) return e;
  // write_denied:续做中 safe-fs 守卫拒绝,是排障线索,不吞;signal_store_corrupt 按契约原文(续做失败 → purge_incomplete)仍归并
  if (
    e instanceof RsiFailClosedError &&
    (e.reason === 'staging_too_large' || e.reason === 'write_denied')
  )
    return e;
  return new RsiFailClosedError('purge_incomplete');
}
