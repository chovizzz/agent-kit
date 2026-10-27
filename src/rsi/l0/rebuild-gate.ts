/**
 * `rsi projects --rebuild-index --write` 的写入判定(R20-A2 B4c2,给 B5 调用;规划侧,只读)。
 * 规则:列举 / 头部读取**不完整**(`RebuildPlanDetailed.complete === false`:根不可评估、目录读不了、触发目录项上限、根被换)且**旧索引无效**(缺失 / 损坏 / 盐不符)时,
 * 重建出的索引会缺项、又没有可信的旧条目兜底 → **不应 `--write`**(整体替换会把一个残缺的索引当成「重建完成」)。旧索引有效时合并保留旧条目,残缺不会丢信息,允许写。
 */
import { RsiProjectIndexSchema } from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import { readSaltFile } from '../../signals/salt-read.js';
import type { RsiConfigOn } from '../config.js';
import { RsiSnapshotBusyError } from '../exit.js';
import { RsiSnapshotError, readVerified } from '../snapshot-read.js';
import { planRebuildIndex, type RebuildPlanDetailed } from './rebuild-plan.js';
import type { L0Deps } from './types.js';

export type RebuildWriteVerdict =
  { write: true } | { write: false; reason: 'listing_incomplete_no_valid_index' };

export function rebuildWriteVerdict(
  plan: Pick<RebuildPlanDetailed, 'complete'>,
  oldIndexValid: boolean,
): RebuildWriteVerdict {
  if (!plan.complete && !oldIndexValid) {
    return { write: false, reason: 'listing_incomplete_no_valid_index' };
  }
  return { write: true };
}

/** 旧索引是否「有效」(与 `planRebuildIndex` 内部同口径):`projects.json` 经快照协议读到、过 schema、`salt_fp` 与真实盐一致 */
export async function oldIndexIsValid(io: IoContext): Promise<boolean> {
  const salt = await readSaltFile(io.stateDir);
  if (salt.kind !== 'ok') return false;
  const v = await readVerified(io, ['projects.json']);
  if (v.status === 'busy') throw new RsiSnapshotBusyError();
  if (v.status === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  if (v.status === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  const bytes = v.status === 'ok' ? (v.files.get('projects.json') ?? null) : null;
  if (bytes === null) return false;
  try {
    const p = RsiProjectIndexSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return p.success && p.data.salt_fp === salt.saltFp;
  } catch {
    return false;
  }
}

export async function planRebuildForWrite(
  io: IoContext,
  config: RsiConfigOn,
  deps?: L0Deps,
): Promise<{ plan: RebuildPlanDetailed; oldIndexValid: boolean; verdict: RebuildWriteVerdict }> {
  const oldIndexValid = await oldIndexIsValid(io);
  const plan = await planRebuildIndex(io, config, deps);
  return { plan, oldIndexValid, verdict: rebuildWriteVerdict(plan, oldIndexValid) };
}
