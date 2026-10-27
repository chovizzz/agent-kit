/**
 * purge journal 的写 / 删(R20-A2 B5 方案 §6.1;**B5-0 只放签名桩,B5c 实装**)。tmp + rename,0600,经 `Writer.op` 过 `assertHeld`。
 * 全仓库**唯一**允许对 `purge-journal.json` 调写出口的文件(B5a 的静态用例以此为白名单,方案 §0.5 R7)。
 */
import type { RsiPurgeJournal } from '../../contracts/rsi.js';
import type { RsiLockHandle } from '../lock.js';
import type { RsiServiceCtx } from '../types.js';
import { notImplemented } from './not-implemented.js';
import type { ServiceHooks } from './staging.js';

export async function writePurgeJournal(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  journal: RsiPurgeJournal,
  hooks?: ServiceHooks,
): Promise<void> {
  return notImplemented('writePurgeJournal', ctx, lock, journal, hooks);
}

export async function removePurgeJournal(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  hooks?: ServiceHooks,
): Promise<void> {
  return notImplemented('removePurgeJournal', ctx, lock, hooks);
}
