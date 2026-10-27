/**
 * taint 恢复与 purge journal 探测(契约 R20-4.7、R20-3.8.4 ~ R20-3.8.5;R20-A2 B3c)。
 *
 * 动作顺序固定(每个 run / promote 目录):① 独占创建 `TAINTED`(先落标记,崩溃在中途时读路径照样拒)→ ② 清空全部摘录(run)/ 删 `promote.patch`、`pr-body.md`(promote)
 * → ③ 删 `apply.patch`(及其它非白名单条目,见 `staging.ts`)。`report.json`、目录、提案文件名保留。每个写操作前 `lock.assertHeld()`(经 `Writer.op`),
 * 数据文件一律临时文件 + rename。全部幂等:重跑只补没做完的。
 *
 * 与 `purge` 命令(B5)的分工:这里只做 journal `taint_targets` 的**标记与清理**;journal 的阶段机(planned → tainted → signals_rewritten → indexed → done)
 * 与信号库重写由 purge 命令推进,本文件**不写 journal**。journal 读不出(`unreadable`)/ 不合规(`invalid`)时,`resumeTaint` 抛 fail-closed:
 * 已授权删除的目标集合不可知,继续让写入方跑可能扩大泄漏(要求 B5 的 `purge --resume` 能处理这两种状态)。
 *
 * 已知残余(如实写明):
 *  - 只覆盖崩溃(进程死亡)模型,不含断电后的 fsync 持久化屏障;
 *  - `assertHeld()` 是检测不是 fencing:assert 与紧随其后的那一次写之间锁仍可能被夺走(A1 已写明);
 *  - 清不到已合进 git / 发成 PR / `git apply` 到工作树的内容(R20-4.7);失败运行遗留的 `.tmp-<id>` 暂存目录不是 run,不在扫描范围;
 *  - journal 存在期间新建的暂存 run 不在 journal 记下的集合里,续做不会认它:会新建暂存内容的写入方(reflect `--run-llm`)必须先过 {@link assertNoPurgeInProgress}(B3b / B5 接线)。
 */
import { RsiPurgeJournalSchema, type RsiPurgeJournal } from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import { readFileSafe } from '../../io/read-fs.js';
import { loadRsiConfig } from '../config.js';
import { privacyGate } from '../gate.js';
import { RSI_FILE_OWNER, rsiDirReadonly, type RsiLockHandle } from '../lock.js';
import {
  RsiFailClosedError,
  type PurgeJournalProbe,
  type RsiServiceCtx,
  type TaintResumeOutcome,
  type TaintScanOutcome,
  type TaintScanSource,
} from '../types.js';
import { classifierFor, loadSigKeys, readIndex } from './attribution.js';
import { assertLockBelongs } from './lock-scope.js';
import {
  RsiStagingBlockedError,
  Writer,
  assertCleanable,
  cleanPromoteDir,
  cleanRunDir,
  createMark,
  isStagingId,
  listStaging,
  probeStagingDir,
  promoteRunId,
  readMark,
  readRunEvidence,
  type ServiceHooks,
  type StagingKind,
  type TaintReason,
} from './staging.js';
import * as path from 'node:path';

const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const JOURNAL_FILE = 'purge-journal.json';

type JournalRead =
  | { state: 'absent' }
  | { state: 'present'; journal: RsiPurgeJournal }
  | { state: 'invalid' }
  | { state: 'unreadable' };

async function readJournal(io: IoContext): Promise<JournalRead> {
  let d;
  try {
    d = await rsiDirReadonly(io);
  } catch {
    return { state: 'unreadable' };
  }
  if (d.kind === 'missing') return { state: 'absent' };
  if (d.kind === 'unsafe') return { state: 'unreadable' };
  let r;
  try {
    r = await readFileSafe(path.join(d.dir, JOURNAL_FILE), {
      maxBytes: JOURNAL_MAX_BYTES,
      owner: RSI_FILE_OWNER,
    });
  } catch {
    return { state: 'unreadable' };
  }
  if (r.kind === 'missing') return { state: 'absent' };
  if (r.kind === 'unsafe') return { state: r.why === 'too_large' ? 'invalid' : 'unreadable' };
  try {
    const p = RsiPurgeJournalSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
    return p.success ? { state: 'present', journal: p.data } : { state: 'invalid' };
  } catch {
    return { state: 'invalid' };
  }
}

/**
 * 只读探测 purge journal(不拿锁、不写、不建目录)。给即时闸(R20-4.8 第 3 条)、`rsi status` 的 `purge.journal`、hint 用。
 * 「读不出」返回 `unreadable`,**不得**当 `absent`。
 */
export async function detectPurgeJournal(
  ctx: Pick<RsiServiceCtx, 'io'>,
): Promise<PurgeJournalProbe> {
  const j = await readJournal(ctx.io);
  return j.state === 'present' ? { state: 'present', phase: j.journal.phase } : { state: j.state };
}

/**
 * 会新建暂存内容的写入方(reflect `--run-llm` 等)在锁内先调:journal 存在 / 不合规 / 读不出 → 抛 fail-closed(`purge_incomplete` / `journal_invalid`)。
 * 原因:purge 进行中新建的 run 不在 journal 的目标集合里,信号被删后再也映射不到,taint 补不回来。
 */
export async function assertNoPurgeInProgress(ctx: Pick<RsiServiceCtx, 'io'>): Promise<void> {
  const j = await readJournal(ctx.io);
  if (j.state === 'absent') return;
  throw new RsiFailClosedError(j.state === 'invalid' ? 'journal_invalid' : 'purge_incomplete');
}

const nowOf = (ctx: RsiServiceCtx): Date => (ctx.now ?? ((): Date => new Date()))();

/** 一个待处理的暂存目录:`reason` 给了 = 本次要先落 `TAINTED`;`null` = 标记已在,只补清理 */
interface Target {
  kind: StagingKind;
  id: string;
  reason: TaintReason | null;
}

/**
 * 只读规划 promote 产物的 taint 闭包:自带标记的补清理;`report.json.run_id` 指向任一已 taint 的 run 的补标并清理(原因随该 run);
 * `report.json` 读不出 / 无法关联时,只要存在已 taint 的 run 就保守地一并 taint(opus 咨询);journal 记下的 promote 目标补标(`purge`)。
 */
async function planPromotes(
  io: IoContext,
  taintedRuns: ReadonlyMap<string, TaintReason>,
  journalPromotes: readonly string[],
): Promise<Target[]> {
  const ids = new Set(await listStaging(io, 'promote'));
  for (const id of journalPromotes) {
    if ((await probeStagingDir(io, 'promote', id)) === 'dir') ids.add(id);
  }
  const fallback = [...taintedRuns.values()][0];
  const out: Target[] = [];
  for (const id of [...ids].sort()) {
    const own = await readMark(io, 'promote', id);
    if (own.present) {
      out.push({ kind: 'promote', id, reason: null });
      continue;
    }
    const linked = await promoteRunId(io, id);
    let reason: TaintReason | null = null;
    if (linked !== undefined && taintedRuns.has(linked))
      reason = taintedRuns.get(linked) ?? 'exclude';
    else if (linked === undefined && fallback !== undefined) reason = fallback;
    else if (journalPromotes.includes(id)) reason = 'purge';
    if (reason !== null) out.push({ kind: 'promote', id, reason });
  }
  return out;
}

interface Executed {
  runsCreated: number;
  promotesCreated: number;
  runsDone: number;
  promotesDone: number;
}

/**
 * 执行计划。**先全部预检、后动手**:对所有目标先做 {@link assertCleanable}(只读)——硬链接 / 根外或悬空符号链接这类 safe-fs 一定会拒绝的条目
 * 是「需人工修复的阻断状态」:此时只给还没有标记的目标补落 `TAINTED`(读路径随即拒绝),然后抛 {@link RsiStagingBlockedError}(`staging_unsafe_entry`),
 * **不做任何摘录清空 / 删除**,不会清理到一半才失败。通过预检后再逐目录:① 标记 → ② 摘录 → ③ 删 patch。
 */
async function execute(w: Writer, targets: readonly Target[], now: Date): Promise<Executed> {
  const live: Target[] = [];
  for (const t of targets) {
    if ((await probeStagingDir(w.io, t.kind, t.id)) === 'dir') live.push(t);
  }
  let blocked: RsiStagingBlockedError | undefined;
  for (const t of live) {
    try {
      await assertCleanable(w.io, t.kind, t.id);
    } catch (e) {
      if (!(e instanceof RsiStagingBlockedError)) throw e;
      blocked = e;
      break;
    }
  }
  if (blocked !== undefined) {
    for (const t of live) if (t.reason !== null) await createMark(w, t.kind, t.id, t.reason, now);
    throw blocked;
  }
  const out: Executed = { runsCreated: 0, promotesCreated: 0, runsDone: 0, promotesDone: 0 };
  for (const t of live) {
    const created = t.reason === null ? false : await createMark(w, t.kind, t.id, t.reason, now);
    const changed = t.kind === 'run' ? await cleanRunDir(w, t.id) : await cleanPromoteDir(w, t.id);
    if (t.kind === 'run') {
      if (created) out.runsCreated++;
      if (created || changed) out.runsDone++;
    } else {
      if (created) out.promotesCreated++;
      if (created || changed) out.promotesDone++;
    }
  }
  return out;
}

/** R20-6.7:run / promote 目录数各不得超过 5000;**先查 promote 再查 run**,且先于任何标记 / 清理写入(`listStaging` 超限即抛 `staging_too_large`) */
async function assertStagingCounts(io: IoContext): Promise<void> {
  await listStaging(io, 'promote');
  await listStaging(io, 'run');
}

/**
 * 锁内先于业务的 taint 续做(R20-4.7「续做」)。必须传锁句柄。
 * 扫描所有带 `TAINTED` 的暂存 run,把 ②③ 补到完成(不因标记已存在而跳过,不依赖信号库映射);journal 在则对其 `taint_targets` 补标记(`purge`)并清理;
 * 最后做 promote 闭包。journal 不合规 / 读不出 → 抛 fail-closed。不推进 journal 阶段。
 * 目录数超限 → `staging_too_large`;存在 safe-fs 无法处理的条目 → `staging_unsafe_entry`(见 {@link execute}):两者都发生在任何清理动作之前。
 */
export async function resumeTaint(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
): Promise<TaintResumeOutcome> {
  return resumeTaintWith(ctx, lock);
}

/** `resumeTaint` + 测试缝(崩溃 / 丢锁注入点) */
export async function resumeTaintWith(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  hooks: ServiceHooks = {},
): Promise<TaintResumeOutcome> {
  await assertLockBelongs(ctx, lock);
  await assertStagingCounts(ctx.io);
  const j = await readJournal(ctx.io);
  if (j.state === 'invalid') throw new RsiFailClosedError('journal_invalid');
  if (j.state === 'unreadable') throw new RsiFailClosedError('purge_incomplete');
  const journal = j.state === 'present' ? j.journal : undefined;
  const w = new Writer(ctx.io, lock, hooks);
  const tainted = new Map<string, TaintReason>();
  const runs: Target[] = [];
  for (const id of await listStaging(ctx.io, 'run')) {
    const m = await readMark(ctx.io, 'run', id);
    if (!m.present) continue;
    tainted.set(id, m.reason);
    runs.push({ kind: 'run', id, reason: null });
  }
  for (const id of journal?.taint_targets.runs ?? []) {
    if (tainted.has(id)) continue;
    if ((await probeStagingDir(ctx.io, 'run', id)) === 'missing') continue;
    tainted.set(id, 'purge');
    runs.push({ kind: 'run', id, reason: 'purge' });
  }
  const promotes = await planPromotes(ctx.io, tainted, journal?.taint_targets.promotes ?? []);
  const done = await execute(w, [...runs, ...promotes], nowOf(ctx));
  return {
    runsCompleted: done.runsDone,
    promotesCompleted: done.promotesDone,
    journalResumedFrom: journal?.phase ?? null,
  };
}

/**
 * 锁内「发现并标记新 taint」(R20-4.7 时机 / 动作):按 `source` 现算命中已排除 key(或 purge journal 已记下的集合)的暂存 run 与 promote 产物,
 * 先独占创建 `TAINTED`,再清摘录 / 删 patch。`resumeTaint` 只补完**已有**标记的清理,本函数负责**新**命中的目标(调用点:先 resumeTaint 再本函数)。
 * `exclude`:重读配置(不用 `ctx.config` 的快照);配置不可用抛对应 fail-closed;索引缺失 / 损坏则算不出 X,零结果(归属闸另管 U);映射不到的证据不触发 taint。
 * 同 {@link resumeTaint}:目录数超限 / 阻断条目都在任何清理动作之前报。
 */
export async function taintNewlyExcluded(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  source: TaintScanSource,
): Promise<TaintScanOutcome> {
  return taintNewlyExcludedWith(ctx, lock, source);
}

export async function taintNewlyExcludedWith(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  source: TaintScanSource,
  hooks: ServiceHooks = {},
): Promise<TaintScanOutcome> {
  await assertLockBelongs(ctx, lock);
  await assertStagingCounts(ctx.io);
  const w = new Writer(ctx.io, lock, hooks);
  const tainted = new Map<string, TaintReason>();
  for (const id of await listStaging(ctx.io, 'run')) {
    const m = await readMark(ctx.io, 'run', id);
    if (m.present) tainted.set(id, m.reason);
  }
  const fresh: Target[] = [];
  let journalPromotes: readonly string[] = [];
  if (source.source === 'purge') {
    journalPromotes = source.journal.taint_targets.promotes;
    for (const id of source.journal.taint_targets.runs) {
      if (!isStagingId(id, 'run')) throw new RsiFailClosedError('journal_invalid');
      if (tainted.has(id)) continue;
      if ((await probeStagingDir(ctx.io, 'run', id)) === 'missing') continue;
      tainted.set(id, 'purge');
      fresh.push({ kind: 'run', id, reason: 'purge' });
    }
  } else {
    for (const id of await findExcludedRuns(ctx, tainted)) {
      tainted.set(id, 'exclude');
      fresh.push({ kind: 'run', id, reason: 'exclude' });
    }
  }
  const promotes = (await planPromotes(ctx.io, tainted, journalPromotes)).filter(
    (t) => t.reason !== null,
  );
  const done = await execute(w, [...fresh, ...promotes], nowOf(ctx));
  return { runsMarked: done.runsCreated, promotesMarked: done.promotesCreated };
}

/** 只读:命中 X 的、还没标记的 run id(升序) */
async function findExcludedRuns(
  ctx: RsiServiceCtx,
  tainted: ReadonlyMap<string, TaintReason>,
): Promise<string[]> {
  const cfg = await loadRsiConfig({ home: ctx.io.hostEnv['HOME'] });
  if (cfg.status === 'off') {
    const g = privacyGate(cfg);
    if (g.kind === 'deny') throw new RsiFailClosedError(g.reason);
    return []; // 没有 [rsi]:没有排除可言
  }
  if (cfg.block !== null) throw new RsiFailClosedError(cfg.block);
  const index = await readIndex(ctx.io);
  if (index.kind !== 'ok') return [];
  const classify = await classifierFor(ctx.io, cfg);
  const evidence = new Map<string, Set<string>>();
  const needed = new Set<string>();
  for (const id of await listStaging(ctx.io, 'run')) {
    if (tainted.has(id)) continue;
    const ev = await readRunEvidence(ctx.io, id);
    if (!ev.exists) continue;
    evidence.set(id, ev.sigs);
    for (const s of ev.sigs) needed.add(s);
  }
  const keys = await loadSigKeys(ctx.io, needed);
  const hits: string[] = [];
  for (const [id, sigs] of [...evidence].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const s of sigs) {
      const key = keys.get(s);
      if (key !== undefined && (await classify(key)) === 'X') {
        hits.push(id);
        break;
      }
    }
  }
  return hits;
}
