/**
 * counts 投影的提交侧服务(R20-A2 B5 方案 §2;B5a 实装)。可以 import `l0/commit.ts` 的 `recomputeClusters` 与 `counts-recompute`。
 */
import * as path from 'node:path';
import {
  RSI_UNKNOWN_KEY,
  RsiCountsSchema,
  RsiProjectKeySchema,
  type RsiCounts,
} from '../../contracts/rsi.js';
import type { Redactor } from '../../contracts/redact.js';
import { readDir } from '../../io/read-fs.js';
import { SaltError, readSaltFile } from '../../signals/salt-read.js';
import { recomputeClusters } from '../l0/commit.js';
import { recomputeSignalCounts } from '../l0/counts-recompute.js';
import type { RsiLockHandle } from '../lock.js';
import { RsiFailClosedError, type CountsProjectionInput, type RsiServiceCtx } from '../types.js';
import { loadSigKeys, readRsiFixed } from './attribution.js';
import { writeCountsProjectionWith } from './commit.js';
import { indexWritable } from './index-writable.js';
import {
  listStaging,
  readMark,
  readRunEvidence,
  stagingDir,
  type ServiceHooks,
} from './staging.js';

export { indexWritable };

type StagedEntry = RsiCounts['staged'][number];

/** `proposals/` 下的 `*.yaml` 个数;目录不存在 = `null`(这个 run 不进 `staged`) */
async function countProposals(io: RsiServiceCtx['io'], runId: string): Promise<number | null> {
  let entries;
  try {
    entries = await readDir(path.join(stagingDir(io, 'run', runId), 'proposals'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RsiFailClosedError('state_dir_unsafe');
  }
  return entries.filter((e) => e.isFile && e.name.endsWith('.yaml')).length;
}

/**
 * 全量扫描暂存区得出 `staged`(≤ 5000 个 run,超限 `staging_too_large`,先于任何写)。只列含 `proposals/` 的 run:
 * `proposals` = `proposals/*.yaml` 个数;`evidence_keys` = sig 经信号库映射成 key(映射不到、key 形状不合法或 `ev.unknown` 时加 `"?"`),升序去重;
 * `tainted` = `TAINTED` 是否在场(只认文件事实)。按 `run_id` 升序。
 */
export async function stagedProjection(io: RsiServiceCtx['io']): Promise<RsiCounts['staged']> {
  const ids = (await listStaging(io, 'run')).sort();
  const runs: { id: string; proposals: number; sigs: Set<string>; unknown: boolean }[] = [];
  const needed = new Set<string>();
  for (const id of ids) {
    const proposals = await countProposals(io, id);
    if (proposals === null) continue;
    const ev = await readRunEvidence(io, id);
    if (!ev.exists) continue;
    for (const s of ev.sigs) needed.add(s);
    runs.push({ id, proposals, sigs: ev.sigs, unknown: ev.unknown });
  }
  const keys = await loadSigKeys(io, needed);
  const out: StagedEntry[] = [];
  for (const r of runs) {
    const set = new Set<string>();
    if (r.unknown) set.add(RSI_UNKNOWN_KEY);
    for (const s of r.sigs) {
      const k = keys.get(s);
      set.add(k !== undefined && RsiProjectKeySchema.safeParse(k).success ? k : RSI_UNKNOWN_KEY);
    }
    const m = await readMark(io, 'run', r.id);
    out.push({
      run_id: r.id,
      proposals: r.proposals,
      evidence_keys: [...set].sort(),
      tainted: m.present,
    });
  }
  return out;
}

/** 四段全量重算:`perKey` / `unknownKeysSignals`(`recomputeSignalCounts`)、`clusters`(`recomputeClusters`)、`staged`(`stagedProjection`) */
export async function recomputeAllCounts(
  ctx: RsiServiceCtx,
  redactor: Pick<Redactor, 'pass2'>,
): Promise<Required<CountsProjectionInput>> {
  const now = (ctx.now ?? ((): Date => new Date()))();
  const sig = await recomputeSignalCounts(ctx.io, now);
  const clusters = await recomputeClusters(ctx.io, redactor);
  const staged = await stagedProjection(ctx.io);
  return { perKey: sig.perKey, unknownKeysSignals: sig.unknownKeysSignals, clusters, staged };
}

/**
 * 暂存写入方(reflect / judge / confirm / taint 之后)用:盐缺失 → `'skipped_no_salt'`(不写);counts 存在且 `salt_fp` 相符 → 只写 `staged`;
 * counts 缺失或 `salt_fp` 不符 → 写四段(只写 `staged` 会让 counts「权威但残缺」)。盐违规 → `salt_invalid`;现有 counts 损坏 → `counts_invalid`。
 */
export async function refreshStagedUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  redactor: Pick<Redactor, 'pass2'>,
  hooks: ServiceHooks = {},
): Promise<'written_staged' | 'written_full' | 'skipped_no_salt'> {
  let salt;
  try {
    salt = await readSaltFile(ctx.io.stateDir);
  } catch (e) {
    if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
    throw e;
  }
  if (salt.kind !== 'ok') return 'skipped_no_salt';
  const r = await readRsiFixed(ctx.io, 'counts.json');
  let prev: RsiCounts | null = null;
  if (r.kind === 'ok') {
    try {
      prev = RsiCountsSchema.parse(JSON.parse(r.bytes.toString('utf8')));
    } catch {
      throw new RsiFailClosedError('counts_invalid');
    }
  }
  if (prev !== null && prev.salt_fp === salt.saltFp) {
    await writeCountsProjectionWith(ctx, lock, { staged: await stagedProjection(ctx.io) }, hooks);
    return 'written_staged';
  }
  await writeCountsProjectionWith(ctx, lock, await recomputeAllCounts(ctx, redactor), hooks);
  return 'written_full';
}

/** purge / rebuild 用:四段全量写 */
export async function writeAllCountsUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  redactor: Pick<Redactor, 'pass2'>,
  hooks: ServiceHooks = {},
): Promise<void> {
  await writeCountsProjectionWith(ctx, lock, await recomputeAllCounts(ctx, redactor), hooks);
}
