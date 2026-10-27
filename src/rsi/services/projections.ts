/**
 * counts 投影的提交侧服务(R20-A2 B5 方案 §2;**B5-0 只放签名桩,B5a 实装**)。可以 import `l0/commit.ts` 的 `recomputeClusters` 与 `counts-recompute`。
 */
import type { RsiCounts } from '../../contracts/rsi.js';
import type { Redactor } from '../../contracts/redact.js';
import type { RsiLockHandle } from '../lock.js';
import type { CountsProjectionInput, RsiServiceCtx } from '../types.js';
import { notImplemented } from './not-implemented.js';
import type { ServiceHooks } from './staging.js';

/**
 * 全量扫描暂存区得出 `staged`(≤ 5000 个 run,超限 `staging_too_large`,先于任何写)。只列含 `proposals/` 的 run:
 * `proposals` = `proposals/*.yaml` 个数;`evidence_keys` = sig 经信号库映射成 key(映射不到或 `ev.unknown` 时加 `"?"`),升序去重;
 * `tainted` = `TAINTED` 是否在场(只认文件事实)。
 */
export async function stagedProjection(io: RsiServiceCtx['io']): Promise<RsiCounts['staged']> {
  return notImplemented('stagedProjection', io);
}

/** 四段全量重算:`perKey` / `unknownKeysSignals`(`recomputeCounts`)、`clusters`(`recomputeClusters`)、`staged`(`stagedProjection`) */
export async function recomputeAllCounts(
  ctx: RsiServiceCtx,
  redactor: Pick<Redactor, 'pass2'>,
): Promise<Required<CountsProjectionInput>> {
  return notImplemented('recomputeAllCounts', ctx, redactor);
}

/** 从 `l0/commit.ts` 抽出的 D7 判定(B5a 让 commit.ts 改为调用它,行为不变):索引是否可写 */
export function indexWritable(
  prev: { status: 'ok'; saltFp: string } | { status: 'absent' | 'invalid' },
  cursorPresent: boolean,
  saltFp: string,
): boolean {
  return notImplemented('indexWritable', prev, cursorPresent, saltFp);
}

/**
 * 暂存写入方(reflect / judge / confirm / taint 之后)用:盐缺失 → `'skipped_no_salt'`(不写);counts 存在且 `salt_fp` 相符 → 只写 `staged`;
 * counts 缺失或 `salt_fp` 不符 → 写四段(只写 `staged` 会让 counts「权威但残缺」)。
 */
export async function refreshStagedUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  redactor: Pick<Redactor, 'pass2'>,
  hooks?: ServiceHooks,
): Promise<'written_staged' | 'written_full' | 'skipped_no_salt'> {
  return notImplemented('refreshStagedUnderLock', ctx, lock, redactor, hooks);
}

/** purge / rebuild 用:四段全量写 */
export async function writeAllCountsUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  redactor: Pick<Redactor, 'pass2'>,
  hooks?: ServiceHooks,
): Promise<void> {
  return notImplemented('writeAllCountsUnderLock', ctx, lock, redactor, hooks);
}
