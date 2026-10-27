/**
 * purge 阶段机(R20-3.8.4;R20-A2 B5 方案 §6.1 / §6.2 / §0.5 R1 / R5;B5c 实装;tick 也调它)。
 *
 * `resumePurgeUnderLock` 按 journal `mode` 分派:`'purge'` → 五阶段 `planned → tainted → signals_rewritten → indexed → done`;
 * `'salvage'` → 三阶段 `planned → tainted → done`(Q-A:journal 不合规时的可重入出路)。两者 `phase === 'done'` 都**只** `commitUnderLock` 加删 journal(R5):
 * 不重写月文件、不碰 cursor / 索引 / counts,所以续做第二遍、以及 journal 已删之后再续做都零写入。
 *
 * 每阶段幂等,每个写点之前 `assertHeld`(经 `Writer.op`;月文件重写经 {@link monthGate},同样是「钩子 → `assertHeld`」):
 *  - tainted:`taintNewlyExcludedWith({source:'purge', journal})`(只读 journal 里**已记下**的目标,不重新推导)+ `resumeTaintWith`(补已有标记但没清完的目录);
 *  - signals_rewritten:信号库与会话计数的**全部**月文件逐个 `rewriteMonthFileWithout`(只重写,永不删;没命中的文件不动);
 *  - indexed:cursor 删 `project_key ∈ K` 的条目(有变化才写)→ 索引删 K 的条目(generation + 1;索引无效 / 缺失不动,留给 rebuild)→ counts 四段全量重算;
 *  - done:`commitUnderLock`(日志 + 快照清单,**最后一步**)→ journal 写 `done` → 删 journal。journal 不在清单名字白名单里,所以它在 commit 之后写 / 删合规。
 * 每个阶段结束、写 journal 之前调 `deps.beforeWrite(stage)`(故障注入点)。续做一律以 journal 记下的集合为准:**不**从信号库重推(信号可能已删)。
 *
 * salvage 残余(如实写明):invalid journal 的 K 不可知,salvage 只 taint + 刷新 staged + 提交,**不清** cursor / 索引里 K 的条目,`counts.per_key` 也保留已删 key 的计数
 * (如果被 salvage 的那次 purge 已经删了信号);靠下一次 L0 提交的全量重算与下一次 `purge --excluded`(索引里的 key 仍判 X)自愈。S1 的目标集合是列目录那一刻的快照,
 * 列目录与写 journal 之间新建的暂存目录不在其内,由下一次 purge 兜底。
 * 已知残余(如实写明):汇总计数只反映**本次调用**做了什么(续做时已完成的阶段计 0);崩在 commit 之后、journal 写 `done` 之前,重跑会多追加一行日志。
 */
import * as path from 'node:path';
import { RSI_PURGE_PHASES, type RsiCursor, type RsiPurgeJournal } from '../../contracts/rsi.js';
import type { Redactor } from '../../contracts/redact.js';
import { lstat } from '../../io/read-fs.js';
import { projectKeyOf, listMonthFiles } from '../../signals/store-scan.js';
import { rewriteMonthFileWithout } from '../../signals/store-rewrite.js';
import type { WriteGate } from '../../signals/state-store.js';
import { mapWriteError, readCursorDoc } from '../l0/commit.js';
import { buildRedactor } from '../l0/run.js';
import type { RsiLockHandle } from '../lock.js';
import { RsiFailClosedError, type RsiServiceCtx } from '../types.js';
import { readIndex } from './attribution.js';
import { commitUnderLockWith } from './commit.js';
import { writeCursorFile, writeIndexFile } from './fixed-write.js';
import { refreshStagedUnderLock, writeAllCountsUnderLock } from './projections.js';
import { readPurgeJournal, removePurgeJournal, writePurgeJournal } from './purge-journal.js';
import type { PurgeTargets } from './purge-plan.js';
import { listStaging, type ServiceHooks } from './staging.js';
import { assertNoPurgeInProgress, resumeTaintWith, taintNewlyExcludedWith } from './taint.js';

/** 测试缝:`hooks.point` 同其它服务;`beforeWrite` 在每个阶段结束、写 journal 之前调用(故障注入点) */
export interface PurgeDeps {
  hooks?: ServiceHooks;
  beforeWrite?: (stage: string) => Promise<void> | void;
}

export interface PurgeResult {
  keys: number;
  signalsRemoved: number;
  sessionRowsRemoved: number;
  cursorRemoved: number;
  indexRemoved: number;
  runsTainted: number;
  promotesTainted: number;
}

export interface SalvageResult {
  runsTainted: number;
  promotesTainted: number;
}

type PurgeJournal = Extract<RsiPurgeJournal, { mode: 'purge' }>;
type SalvageJournal = Extract<RsiPurgeJournal, { mode: 'salvage' }>;
type PurgePhase = (typeof RSI_PURGE_PHASES)[number];

const nowOf = (ctx: RsiServiceCtx): Date => (ctx.now ?? ((): Date => new Date()))();
const rank = (p: PurgePhase): number => RSI_PURGE_PHASES.indexOf(p);

/** 月文件重写的写点闸:测试钩子(`before:month:<相对 .state 的路径>:<op>`)→ `assertHeld`;钩子抛错 = 该写点之后零写入 */
function monthGate(ctx: RsiServiceCtx, lock: RsiLockHandle, hooks: ServiceHooks): WriteGate {
  return async (op, p) => {
    await hooks.point?.(`before:month:${path.relative(ctx.io.stateDir, p)}:${op}`);
    await lock.assertHeld();
  };
}

/** P1 才会有的 `.state/rsi/digests/`:P0 下出现 = 未知条目,fail-closed `internal`(R20-3.8.3 要求删它,但 P0 没有它的清理实现,不假装删过) */
async function assertNoDigests(ctx: RsiServiceCtx): Promise<void> {
  try {
    await lstat(path.join(ctx.io.stateDir, 'rsi', 'digests'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new RsiFailClosedError('state_dir_unsafe');
  }
  throw new RsiFailClosedError('internal');
}

async function rewriteStores(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  kset: ReadonlySet<string>,
  hooks: ServiceHooks,
): Promise<{ signals: number; sessions: number }> {
  const gate = monthGate(ctx, lock, hooks);
  const out = { signals: 0, sessions: 0 };
  try {
    for (const kind of ['signals', 'sessions'] as const) {
      for (const file of await listMonthFiles(ctx.io, kind)) {
        const r = await rewriteMonthFileWithout(ctx.io, file, kset, projectKeyOf, gate);
        if (r !== 'unchanged') out[kind] += r.removed;
      }
    }
  } catch (e) {
    return mapWriteError(e);
  }
  return out;
}

/** cursor 删 K 的条目,返回删掉的个数(没有变化不写) */
async function pruneCursor(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  kset: ReadonlySet<string>,
  hooks: ServiceHooks,
): Promise<number> {
  const cursor = await readCursorDoc(ctx.io);
  if (cursor === null) return 0;
  const keep: RsiCursor['files'] = {};
  let removed = 0;
  for (const [ref, f] of Object.entries(cursor.files)) {
    if (f.project_key !== null && kset.has(f.project_key)) removed++;
    else keep[ref] = f;
  }
  if (removed > 0) await writeCursorFile(ctx, lock, { ...cursor, files: keep }, hooks);
  return removed;
}

/** 索引删 K 的条目(generation + 1),返回删掉的个数;索引缺失 / 无效不动(留给 `projects --rebuild-index`) */
async function pruneIndex(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  kset: ReadonlySet<string>,
  hooks: ServiceHooks,
): Promise<number> {
  const idx = await readIndex(ctx.io);
  if (idx.kind !== 'ok') return 0;
  const entries = idx.index.entries.filter((e) => !kset.has(e.key));
  const removed = idx.index.entries.length - entries.length;
  if (removed > 0) {
    await writeIndexFile(
      ctx,
      lock,
      { ...idx.index, generation: idx.index.generation + 1, entries },
      hooks,
    );
  }
  return removed;
}

async function tainted(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  journal: RsiPurgeJournal,
  hooks: ServiceHooks,
): Promise<{ runs: number; promotes: number }> {
  const t = await taintNewlyExcludedWith(ctx, lock, { source: 'purge', journal }, hooks);
  const r = await resumeTaintWith(ctx, lock, hooks);
  return { runs: t.runsMarked + r.runsCompleted, promotes: t.promotesMarked + r.promotesCompleted };
}

async function advancePurge(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  start: PurgeJournal,
  deps: PurgeDeps,
  redactor?: Pick<Redactor, 'pass2'>,
): Promise<PurgeResult> {
  const hooks = deps.hooks ?? {};
  let j = start;
  const res: PurgeResult = {
    keys: j.keys.length,
    signalsRemoved: 0,
    sessionRowsRemoved: 0,
    cursorRemoved: 0,
    indexRemoved: 0,
    runsTainted: 0,
    promotesTainted: 0,
  };
  const kset = new Set(j.keys);
  const setPhase = async (next: PurgePhase): Promise<void> => {
    await deps.beforeWrite?.(next);
    j = { ...j, phase: next };
    await writePurgeJournal(ctx, lock, j, hooks);
  };
  // done:不重做任何前序阶段(R5)
  if (rank(j.phase) < rank('tainted')) {
    const t = await tainted(ctx, lock, j, hooks);
    res.runsTainted = t.runs;
    res.promotesTainted = t.promotes;
    await setPhase('tainted');
  }
  if (rank(j.phase) < rank('signals_rewritten')) {
    const s = await rewriteStores(ctx, lock, kset, hooks);
    res.signalsRemoved = s.signals;
    res.sessionRowsRemoved = s.sessions;
    await setPhase('signals_rewritten');
  }
  if (rank(j.phase) < rank('indexed')) {
    res.cursorRemoved = await pruneCursor(ctx, lock, kset, hooks);
    res.indexRemoved = await pruneIndex(ctx, lock, kset, hooks);
    await writeAllCountsUnderLock(ctx, lock, redactor ?? (await buildRedactor(ctx.config)), hooks);
    await setPhase('indexed');
  }
  await commitUnderLockWith(
    ctx,
    lock,
    {
      trigger: 'purge',
      log: {
        action: 'purged',
        code: 'ok',
        counts: {
          keys: res.keys,
          signals_removed: res.signalsRemoved,
          session_rows_removed: res.sessionRowsRemoved,
          cursor_removed: res.cursorRemoved,
          index_removed: res.indexRemoved,
          runs_tainted: res.runsTainted,
          promotes_tainted: res.promotesTainted,
        },
      },
    },
    hooks,
  );
  if (j.phase !== 'done') await setPhase('done');
  await removePurgeJournal(ctx, lock, hooks);
  return res;
}

async function advanceSalvage(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  start: SalvageJournal,
  deps: PurgeDeps,
): Promise<SalvageResult> {
  const hooks = deps.hooks ?? {};
  let j = start;
  const res: SalvageResult = { runsTainted: 0, promotesTainted: 0 };
  const setPhase = async (next: SalvageJournal['phase']): Promise<void> => {
    await deps.beforeWrite?.(`salvage_${next}`);
    j = { ...j, phase: next };
    await writePurgeJournal(ctx, lock, j, hooks);
  };
  if (j.phase === 'planned') {
    const t = await tainted(ctx, lock, j, hooks); // S2
    res.runsTainted = t.runs;
    res.promotesTainted = t.promotes;
    await setPhase('tainted');
  }
  if (j.phase !== 'done') {
    // S3:投影 + 提交。盐缺失时 refresh 跳过(没有 counts 可写)
    await refreshStagedUnderLock(ctx, lock, await buildRedactor(ctx.config), hooks);
  }
  await commitUnderLockWith(
    ctx,
    lock,
    {
      trigger: 'purge',
      log: {
        action: 'purged',
        code: 'journal_salvaged',
        counts: { runs_tainted: res.runsTainted, promotes_tainted: res.promotesTainted },
      },
    },
    hooks,
  );
  if (j.phase !== 'done') await setPhase('done');
  await removePurgeJournal(ctx, lock, hooks); // S4
  return res;
}

/** 新 purge:写 journal(`planned`)之后走续做。已有任何 journal(含 invalid / unreadable)→ fail-closed(Q-J:必须先 `--resume`) */
export async function runPurgeUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  plan: { keys: readonly string[]; targets: PurgeTargets },
  deps: PurgeDeps = {},
): Promise<PurgeResult> {
  await assertNoPurgeInProgress(ctx);
  await assertNoDigests(ctx);
  // 预检:counts 重算要用脱敏器(overlay 不合规 → overlay_invalid)。放在写 journal 之前,免得删完信号才发现算不了 counts、留下一个卡死的 journal
  const redactor = await buildRedactor(ctx.config);
  const journal: PurgeJournal = {
    schema_version: 1,
    created_at: nowOf(ctx).toISOString(),
    mode: 'purge',
    phase: 'planned',
    keys: [...plan.keys].sort(),
    taint_targets: {
      runs: [...plan.targets.runs].sort(),
      promotes: [...plan.targets.promotes].sort(),
    },
  };
  await deps.beforeWrite?.('planned');
  await writePurgeJournal(ctx, lock, journal, deps.hooks);
  return advancePurge(ctx, lock, journal, deps, redactor);
}

/** 按 journal 已记下的集合续做(不重新从信号库推导) */
export async function resumePurgeUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  deps: PurgeDeps = {},
): Promise<PurgeResult> {
  const r = await readPurgeJournal(ctx.io);
  if (r.state === 'invalid') throw new RsiFailClosedError('journal_invalid');
  if (r.state === 'unreadable') throw new RsiFailClosedError('purge_incomplete');
  if (r.state === 'absent') throw new RsiFailClosedError('internal');
  if (r.journal.mode === 'salvage') {
    const s = await advanceSalvage(ctx, lock, r.journal, deps);
    return {
      keys: 0,
      signalsRemoved: 0,
      sessionRowsRemoved: 0,
      cursorRemoved: 0,
      indexRemoved: 0,
      runsTainted: s.runsTainted,
      promotesTainted: s.promotesTainted,
    };
  }
  if (r.journal.phase === 'done') return advancePurge(ctx, lock, r.journal, deps);
  await assertNoDigests(ctx);
  // 与 runPurgeUnderLock 同理:counts 重算要脱敏器,在动手前就确认它能建(overlay 中途失效不要等信号删完才发现)
  const redactor =
    rank(r.journal.phase) < rank('indexed') ? await buildRedactor(ctx.config) : undefined;
  return advancePurge(ctx, lock, r.journal, deps, redactor);
}

/** Q-A:S1–S4(方案 §0.5 R1);入口是 invalid 或 `mode: 'salvage'` 的 journal */
export async function salvageInvalidJournal(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  deps: PurgeDeps = {},
): Promise<SalvageResult> {
  const hooks = deps.hooks ?? {};
  const r = await readPurgeJournal(ctx.io);
  if (r.state === 'unreadable') throw new RsiFailClosedError('purge_incomplete');
  if (r.state === 'present' && r.journal.mode === 'salvage') {
    return advanceSalvage(ctx, lock, r.journal, deps);
  }
  if (r.state !== 'invalid') throw new RsiFailClosedError('internal');
  // S1:先列全部暂存目录(超过 5000 → staging_too_large,先于任何写;先 promote 后 run,与 taint 同序),再原子替换 invalid 文件
  const promotes = (await listStaging(ctx.io, 'promote')).sort();
  const runs = (await listStaging(ctx.io, 'run')).sort();
  const journal: SalvageJournal = {
    schema_version: 1,
    created_at: nowOf(ctx).toISOString(),
    mode: 'salvage',
    phase: 'planned',
    keys: [],
    taint_targets: { runs, promotes },
  };
  await deps.beforeWrite?.('salvage_planned');
  await writePurgeJournal(ctx, lock, journal, hooks);
  return advanceSalvage(ctx, lock, journal, deps);
}
