/**
 * L0 提交(R20-6.9、R20-4.5、D10 / D13 / D16;R20-A2 B4c2)——**提交侧**(写出口在这里,不在 `l0-closure` 的规划侧清单里)。
 *
 * 顺序(R20-6.9,固定):C1 信号库 → C2 会话计数 → R 重算 counts → C3 索引 → C4 counts → C5 state → C6 cursor → C7 `commitUnderLock`(日志 + 快照清单,最后一步)。
 * 每个提交步骤之间调 `checkpoint('commit')`(#1 在 C1 后、#2 在 C2 + R 后、#3 在 C3 后、#4 在 C4 后、#5 在 C5 后;#0 是 `run.ts` 在 C1 之前的权威复检)。
 *
 * 中止规则(冻结,B4 方案 §4.1):
 *  - **[A0] 首次数据提交之前中止**(读阶段 abort 或 #0 abort):不写信号库 / 会话计数 / 索引 / cursor(四类数据文件字节不变)。仍然执行:
 *    C4' 只校正 `counts.staged[].tainted`(其余段保持现值;没有变化就不写)→ C5 state → C7。验收口径是「零**数据**提交」,不是零写入(盐首建、taint 可能已发生)。
 *  - **[A1] C1 之后中止**(#1..#5 返回 abort):跳过剩下的**数据**步骤(C2 / C3 / C6),执行 R → C4(三段)→ C5 → C7。cursor 不推进;已入库的信号靠 `sig_id` 去重。
 *    #5(state 已写之后)abort:state.json 里的 `last_tick.outcome` 是 abort 之前算出的结果,日志(C7)记真实 outcome——残余,已登记。
 *  - **墙钟**:`checkpoint('commit')` 永不返回 `time_limit`;万一返回,这里按 `continue` 处理,已经开始的有序提交一定走完。
 *  - **抛错**(`lock_lost`、fail-closed 等)不调 StateMutator、不收尾,attempt 残留,下次记 `crashed`。
 *
 * 成本:每次提交都全量载入会话计数库(`planSessionStats` 的 `where` 表,每个 agent 一次),即使 `signals_new = 0`——O(会话计数库) 的内存 / 时间,这是有意的顺序
 * (库内容带病要在写信号之前 fail-closed),已登记为残余。
 * [A0] 的 `signals_new` / `sessions_new` 一律是 0(不是 null):本次提交确实没有新信号 / 新会话计数,与「读阶段没跑所以不知道」的 null 不同。
 *
 * 每次提交都从磁盘重算(任意提交点崩溃之后,下一次提交都能把投影校正回来):`per_key` / `unknown_keys_signals`(`recomputeCounts`)、`clusters`(D13-A,每次都重算,不看本次是否有新信号)、
 * `staged[].tainted`(**只取 `TAINTED` 文件的实际在场事实**,不掺入「证据属 X」的推导;每次都核对,不看本次新增了多少 taint)。
 *
 * 写点复核(B3b-4 / D16):每个写操作之前先调 `deps.beforeWrite`(测试的故障注入点),再 `lock.assertHeld()`;失锁 → `lock_lost`,之后零写入。信号库 / 会话计数 / 盐首建经
 * `WriteGate` 钩子,固定文件与 counts / 日志经 `Writer.op`,清单 rename 前 `commitSnapshot` 自己再复核。残余:`commitSnapshot` 内 `snapshot.json.tmp` 的 remove / 写入(B3 的文件)
 * 只在进入时复核一次,两次写之间失锁会留下一个未 rename 的临时文件(不被清单管辖,下一次 recover 首行就删除)。
 * 其内容(文件名 + sha256,没有会话内容)也不构成泄漏。
 */
import {
  RSI_AGENT_IDS,
  RSI_COUNTS_MAX_CLUSTERS,
  RSI_UNKNOWN_KEY,
  RsiCountsSchema,
  RsiCursorSchema,
  RsiProjectIndexSchema,
  RsiProjectKeySchema,
  type RsiAgentId,
  type RsiCounts,
  type RsiCursor,
  type RsiOutcome,
  type RsiProjectIndex,
  type RsiState,
} from '../../contracts/rsi.js';
import type { Redactor } from '../../contracts/redact.js';
import { WriteDeniedError } from '../../io/safe-fs.js';
import { classifySignals } from '../../reflect/classify.js';
import { buildClusters } from '../../reflect/cluster.js';
import { loadSignals } from '../../reflect/load.js';
import {
  buildSessionStat,
  applySessionStats,
  planSessionStats,
} from '../../signals/session-stats.js';
import type { StatPlan } from '../../signals/session-stats.js';
import { SignalStoreError, writeSignals } from '../../signals/state-store.js';
import { attribute } from '../attribution.js';
import { inspectSnapshot } from '../snapshot.js';
import { productionSnapshotValidator } from '../validators.js';
import { readRsiFixed } from '../services/attribution.js';
import {
  commitUnderLockWith,
  recoverUnderLock,
  writeCountsProjectionWith,
} from '../services/commit.js';
import {
  hooksFromGate,
  readStateForWrite,
  writeCursorFile,
  writeIndexFile,
  writeStateFile,
} from '../services/fixed-write.js';
import type { RsiLockHandle } from '../lock.js';
import { RsiFailClosedError, type RsiServiceCtx } from '../types.js';
import { recomputeCounts, recomputeStagedTainted } from './counts-recompute.js';
import { updateIndex } from './index-update.js';
import { ackBaseline, carryConfirm } from './state-mutate.js';
import type {
  BeforeWrite,
  CheckpointVerdict,
  CollectBatch,
  Checkpoint,
  L0Summary,
  RunL0Input,
  StateMutator,
} from './types.js';

export type AbortVerdict = Extract<CheckpointVerdict, { kind: 'abort' }>;

export interface CommitL0Deps {
  /** 测试的故障注入点:每个写操作之前调用(之后生产路径再 `assertHeld`);抛错 = 在该写点之前崩溃,换掉锁 nonce = 在该写点之前失锁 */
  beforeWrite?: BeforeWrite;
}

export interface CommitL0Input {
  trigger: RunL0Input['trigger'];
  /** 读阶段的结果;**只有 [A0] 且读阶段还没开始**(`#pre` 检查点就 abort,盐可能都还没建)时可以是 null */
  batch: CollectBatch | null;
  /** 真实盐的指纹(已建好、已读过);null = 盐还没建(只能配合 `batch === null` 的 [A0]) */
  salt: { saltFp: string } | null;
  /** [A0]:读阶段 abort 或 #0 复检的 abort;非 null 则走 [A0] */
  a0: AbortVerdict | null;
  checkpoint: Checkpoint;
  stateMutator: StateMutator;
  /** `loadSignals` 的残留扫描(pass2);clusters 重算用 */
  redactor: Pick<Redactor, 'pass2'>;
}

export interface CommitL0Result {
  /** 真实 outcome(含 #1..#5 的 abort) */
  outcome: RsiOutcome;
  /** `summary.outcome` 同样是真实 outcome;**`state.json` 的 `last_tick.outcome` 在 #5(state 已写)之后才 abort 时可能陈旧**(是 abort 之前算出的值),熔断等以这里和日志为准 */
  summary: L0Summary;
  stage: 'a0' | 'a1' | 'full';
  /** 快照清单提交后的 generation */
  generation: number;
  indexWritten: boolean;
  /** `updateIndex.full`:**本次**有 key 因索引满而没入索引(与 `rsi status` 的 `index_full`——当前已满——不同,不要混用) */
  indexFullDropped: boolean;
  cursorWritten: boolean;
  signalsNew: number;
  sessionsNew: number;
}

/** 每个写点之前:先调测试的故障注入钩子,再 `assertHeld()`(失锁 → `lock_lost`,之后零写入) */
export function makeGate(lock: RsiLockHandle, beforeWrite?: BeforeWrite): BeforeWrite {
  return async (op, p) => {
    await beforeWrite?.(op, p);
    await lock.assertHeld();
  };
}

const nowOf = (ctx: RsiServiceCtx): Date => (ctx.now ?? ((): Date => new Date()))();

export function mapWriteError(e: unknown): never {
  if (e instanceof SignalStoreError) throw new RsiFailClosedError('signal_store_corrupt');
  if (e instanceof WriteDeniedError) throw new RsiFailClosedError('write_denied');
  throw e;
}

/** D13-A:每个聚类的证据按 key 计「去重会话数」(不同 key 的会话不相交;状态读侧剔除 X / U 后再与 `cluster_min` 比) */
function evidenceByKey(
  signals: readonly { project_key: string; session_ref: string }[],
): Record<string, number> {
  const sessions = new Map<string, Set<string>>();
  for (const s of signals) {
    const key = RsiProjectKeySchema.safeParse(s.project_key).success
      ? s.project_key
      : RSI_UNKNOWN_KEY;
    const set = sessions.get(key) ?? new Set<string>();
    set.add(s.session_ref);
    sessions.set(key, set);
  }
  const out: Record<string, number> = {};
  for (const k of [...sessions.keys()].sort()) out[k] = (sessions.get(k) as Set<string>).size;
  return out;
}

export async function recomputeClusters(
  io: RsiServiceCtx['io'],
  redactor: Pick<Redactor, 'pass2'>,
): Promise<RsiCounts['clusters']> {
  let loaded;
  try {
    loaded = await loadSignals(io, redactor);
  } catch (e) {
    return mapWriteError(e);
  }
  return (
    buildClusters(classifySignals(loaded.signals))
      // 截断 = 上限(counts.json schema 限 RSI_COUNTS_MAX_CLUSTERS 条),不是过滤:buildClusters 已排好序,超出的只是放不下
      .slice(0, RSI_COUNTS_MAX_CLUSTERS)
      .map((c) => ({ cluster_id: c.id, evidence_by_key: evidenceByKey(c.allSignals) }))
  );
}

type IndexDoc = { status: 'ok'; value: RsiProjectIndex } | { status: 'absent' | 'invalid' };

async function readIndexDoc(io: RsiServiceCtx['io']): Promise<IndexDoc> {
  const r = await readRsiFixed(io, 'projects.json');
  if (r.kind === 'missing') return { status: 'absent' };
  try {
    const p = RsiProjectIndexSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
    return p.success ? { status: 'ok', value: p.data } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

async function readCountsDoc(io: RsiServiceCtx['io']): Promise<RsiCounts | null> {
  const r = await readRsiFixed(io, 'counts.json');
  if (r.kind === 'missing') return null;
  try {
    return RsiCountsSchema.parse(JSON.parse(r.bytes.toString('utf8')));
  } catch {
    throw new RsiFailClosedError('counts_invalid');
  }
}

export async function readCursorDoc(io: RsiServiceCtx['io']): Promise<RsiCursor | null> {
  const r = await readRsiFixed(io, 'cursor.json');
  if (r.kind === 'missing') return null;
  try {
    return RsiCursorSchema.parse(JSON.parse(r.bytes.toString('utf8')));
  } catch {
    throw new RsiFailClosedError('cursor_invalid');
  }
}

/** 读阶段没跑(`#pre` 就 abort)时的汇总:全零,outcome 取 abort 的结果 */
export function zeroSummary(outcome: RsiOutcome): L0Summary {
  return {
    outcome,
    files_planned: 0,
    files_read: 0,
    bytes_read: 0,
    signals_new: null,
    sessions_new: null,
    projects: null,
    unknown_signals: null,
    skipped: {
      not_regular: 0,
      too_large: 0,
      unchanged: 0,
      excluded: 0,
      self_state: 0,
      unknown_project: 0,
    },
    limits_hit: [],
    cursor: { fingerprint_match: null, full_scan: { epoch: 0, done: false } },
    duration_ms: 0,
  };
}

export function logOf(outcome: RsiOutcome): {
  action: 'completed' | 'stopped' | 'skipped';
  code: string;
} {
  if (outcome === 'ok' || outcome === 'ok_partial') return { action: 'completed', code: outcome };
  if (outcome === 'stopped') return { action: 'stopped', code: outcome };
  return { action: 'skipped', code: outcome };
}

export async function commitL0(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  input: CommitL0Input,
  deps: CommitL0Deps = {},
): Promise<CommitL0Result> {
  const { io } = ctx;
  const batch = input.batch;
  if (batch === null && input.a0 === null) throw new RsiFailClosedError('internal');
  const gate = makeGate(lock, deps.beforeWrite);
  const hooks = hooksFromGate(gate);
  const now = nowOf(ctx);
  const today = now.toISOString().slice(0, 10);

  // ---- 读现状(锁内,写入方都持锁,直接读固定文件)
  const stateDoc = await readStateForWrite(io);
  const prevCounts = await readCountsDoc(io);
  const prevIndex = await readIndexDoc(io);
  const prevCursor = await readCursorDoc(io);
  const sfp: string | null = input.salt === null ? null : input.salt.saltFp;

  let abort: AbortVerdict | null = input.a0;
  const stage0: 'a0' | 'a1' | 'full' = abort !== null ? 'a0' : 'full';
  let signalsNew = 0;
  let sessionsNew = 0;
  let indexWritten = false;
  let indexFullDropped = false;
  let cursorWritten = false;
  let indexGeneration = 0;
  let writtenIndex: RsiProjectIndex | null = null;
  let counts: {
    perKey: RsiCounts['per_key'];
    unknownKeysSignals: number;
    clusters: RsiCounts['clusters'];
    staged: RsiCounts['staged'];
  } | null = null;
  const checkAbort = async (): Promise<void> => {
    if (abort !== null) return;
    const v = await input.checkpoint('commit');
    if (v.kind === 'abort') abort = v; // time_limit 在提交阶段不阻断(冻结规则);其它一律继续
  };

  if (stage0 === 'full') {
    if (batch === null || sfp === null) throw new RsiFailClosedError('internal');
    // 提交前的无副作用复检(坏数据在写任何东西之前就抛);未完成的上一次提交 → 先按当前文件重建清单(经 recoverUnderLock)
    const inspected = await inspectSnapshot(io, productionSnapshotValidator);
    if (inspected === 'needs_rebuild') await recoverUnderLock(ctx, lock, hooks);

    // 会话计数先 plan(库内容带病在写信号之前 fail-closed)
    const agents = RSI_AGENT_IDS.filter((a) => batch.results.has(a));
    const plans = new Map<RsiAgentId, StatPlan>();
    const signalsBy = new Map<RsiAgentId, Parameters<typeof writeSignals>[2]>();
    try {
      for (const agent of agents) {
        const processed = (batch.results.get(agent) ?? []).filter((r) => r.status === 'processed');
        signalsBy.set(
          agent,
          processed.flatMap((r) => r.signals),
        );
        const stats = processed
          .map((r) => buildSessionStat(r))
          .filter((s): s is NonNullable<typeof s> => s !== undefined);
        plans.set(agent, await planSessionStats(io, agent, stats));
      }

      // C1 信号库
      for (const agent of agents) {
        const r = await writeSignals(io, agent, signalsBy.get(agent) ?? [], { beforeWrite: gate });
        signalsNew += r.written;
      }
      await checkAbort(); // #1

      // C2 会话计数
      if (abort === null) {
        for (const agent of agents) {
          const r = await applySessionStats(io, plans.get(agent) as StatPlan, {
            beforeWrite: gate,
          });
          sessionsNew += r.written;
        }
      }
    } catch (e) {
      mapWriteError(e);
    }

    // R 重算(从磁盘,不看本次新增了多少):abort 之后同样要重算,让 C4 把三段校正回来
    const rc = await recomputeCounts(io, ctx.config, now);
    const clusters = await recomputeClusters(io, input.redactor);
    const staged = (prevCounts?.staged ?? []).map((e) => ({
      ...e,
      tainted: rc.stagedTainted.get(e.run_id) ?? e.tainted, // 只取 TAINTED 文件的事实
    }));
    counts = { perKey: rc.perKey, unknownKeysSignals: rc.unknownKeysSignals, clusters, staged };
    await checkAbort(); // #2

    // C3 索引(D7:索引 ok 且盐指纹一致,或索引缺失且 cursor 也缺失)
    if (abort === null) {
      const idxOk = prevIndex.status === 'ok' && prevIndex.value.salt_fp === sfp;
      const writable = idxOk || (prevIndex.status === 'absent' && prevCursor === null);
      if (writable) {
        indexGeneration = (prevIndex.status === 'ok' ? prevIndex.value.generation : 0) + 1;
        const res = updateIndex({
          prev: idxOk && prevIndex.status === 'ok' ? prevIndex.value : null,
          observations: batch.observations,
          perKey: rc.perKey,
          saltFp: sfp,
          generation: indexGeneration,
          today,
        });
        await writeIndexFile(ctx, lock, res.index, hooks);
        indexWritten = true;
        indexFullDropped = res.full;
        writtenIndex = res.index;
      }
    }
    await checkAbort(); // #3
  } else {
    // [A0]:只校正 staged(其余段保持现值)
    if (prevCounts !== null && sfp !== null && prevCounts.salt_fp === sfp) {
      const tainted = await recomputeStagedTainted(io);
      const next = prevCounts.staged.map((e) => ({
        ...e,
        tainted: tainted.get(e.run_id) ?? e.tainted,
      }));
      const changed = next.some(
        (e, i) => e.tainted !== (prevCounts.staged[i] as { tainted: boolean }).tainted,
      );
      if (changed) await writeCountsProjectionWith(ctx, lock, { staged: next }, hooks);
    }
  }

  // C4 counts(三段 + staged;[A0] 已在上面只写 staged)
  if (stage0 === 'full') {
    const c = counts as NonNullable<typeof counts>;
    await writeCountsProjectionWith(
      ctx,
      lock,
      {
        perKey: c.perKey,
        unknownKeysSignals: c.unknownKeysSignals,
        clusters: c.clusters,
        staged: c.staged,
      },
      hooks,
    );
    await checkAbort(); // #4
  }

  // 汇总(state 与日志用)
  const base = batch?.summary ?? zeroSummary((input.a0 as AbortVerdict).outcome);
  const outcome: RsiOutcome = abort !== null ? abort.outcome : base.outcome;
  const stage: 'a0' | 'a1' | 'full' = stage0 === 'a0' ? 'a0' : abort !== null ? 'a1' : 'full';
  const indexForSummary =
    writtenIndex ??
    (prevIndex.status === 'ok' && sfp !== null && prevIndex.value.salt_fp === sfp
      ? prevIndex.value
      : null);
  const att = await attribute({
    config: ctx.config,
    indexStatus: indexForSummary === null ? 'invalid' : 'ok',
    index: indexForSummary,
    counts: sfp === null ? null : { salt_fp: sfp },
  });
  const ack = stateDoc.prev?.projects_ack_generation ?? 0;
  let collecting = 0;
  let excluded = 0;
  let fresh = 0;
  for (const en of indexForSummary?.entries ?? []) {
    const c = att.byKey.get(en.key);
    if (c === 'P') {
      collecting++;
      if (en.first_indexed_generation > ack) fresh++;
    } else if (c === 'X') excluded++;
  }
  const perKeyForU = counts?.perKey ?? prevCounts?.per_key ?? {};
  let unknownSignals = counts?.unknownKeysSignals ?? prevCounts?.unknown_keys_signals ?? 0;
  for (const [k, v] of Object.entries(perKeyForU)) {
    if (att.classify(k) === 'U') unknownSignals += v.signals_total;
  }
  const cursorShown = stage === 'full' && batch !== null ? batch.cursorNext : prevCursor;
  const summary: L0Summary = {
    ...base,
    outcome,
    signals_new: stage0 === 'a0' ? 0 : signalsNew,
    sessions_new: stage0 === 'a0' ? 0 : sessionsNew,
    projects: { collecting, excluded, new: fresh },
    unknown_signals: unknownSignals,
    cursor: {
      fingerprint_match: base.cursor.fingerprint_match,
      full_scan: {
        epoch: cursorShown?.full_scan.epoch ?? 0,
        done: cursorShown?.full_scan.done ?? false,
      },
    },
  };

  // C5 state(StateMutator;confirm 记录由磁盘决定,baseline 只许 true → false)
  let nextState: RsiState = carryConfirm(stateDoc.prev, input.stateMutator(stateDoc.prev, summary));
  // 「确认后第一次成功 L0」才 ack:成功(含 ok_partial)且本次写了索引;中止 / 索引不可写都不 ack
  if ((outcome === 'ok' || outcome === 'ok_partial') && indexWritten) {
    nextState = ackBaseline(nextState, indexGeneration);
  }
  await writeStateFile(ctx, lock, nextState, stateDoc.rawConfirm, hooks);
  if (stage0 === 'full') await checkAbort(); // #5

  // C6 cursor(前面全部成功才推进)
  if (stage0 === 'full' && abort === null) {
    await writeCursorFile(ctx, lock, (batch as CollectBatch).cursorNext, hooks);
    cursorWritten = true;
  }

  // C7 日志 + 快照清单(最后一步)
  const finalOutcome: RsiOutcome = abort !== null ? (abort as AbortVerdict).outcome : outcome;
  const lg = logOf(finalOutcome);
  const incomplete = (batch?.outcomes ?? []).filter((o) => !o.complete).length;
  const committed = await commitUnderLockWith(
    ctx,
    lock,
    {
      trigger: input.trigger,
      log: {
        action: lg.action,
        code: lg.code,
        duration_ms: summary.duration_ms,
        counts: {
          files_planned: summary.files_planned,
          files_read: summary.files_read,
          bytes_read: summary.bytes_read,
          signals_new: summary.signals_new ?? 0,
          sessions_new: summary.sessions_new ?? 0,
          sessions_incomplete: incomplete,
          index_full_dropped: indexFullDropped ? 1 : 0,
        },
      },
    },
    hooks,
  );
  return {
    outcome: finalOutcome,
    summary: { ...summary, outcome: finalOutcome },
    stage: stage0 === 'a0' ? 'a0' : abort !== null ? 'a1' : 'full', // #5 之后才 abort 的也算 [A1]
    generation: committed.generation,
    indexWritten,
    indexFullDropped,
    cursorWritten,
    signalsNew: summary.signals_new ?? 0,
    sessionsNew: summary.sessions_new ?? 0,
  };
}
