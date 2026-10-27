/**
 * 手动 `signals collect` 的 rsi 提交(契约 §20.9 第 8 条;R20-A2 B5d,方案 §7.1)——**提交侧**(写出口在这里,不在规划侧闭包清单里)。
 *
 * 前提:调用方已持 `rsi/lock`,且已按锁内顺序做完 复检 → `recoverUnderLock` → `assertNoPurgeInProgress` → `resumeTaintWith`,盐已在锁内建好,
 * 信号库(C1)与会话计数(C2)已由 `collect()` 经同一个写点钩子写完。本函数只做剩下的提交步骤,**顺序与 L0 的 `commitL0` 一致**:
 *   R 重算(磁盘全量)→ C3 索引(D7 判可写;观测 = 本次 processed 会话的项目根,`stat` 失败的根不更新)→ C4 counts 四段 → C7 `commitUnderLockWith`(**最后一步**)。
 *
 * 与 tick / L0 的区别(拍板 Q-E / Q-L,**不是疏漏**):
 *  - **不写 cursor**:手动 collect 用 allow / overlay 策略,盖上当前 epoch 的 cursor 会让 tick 永远跳过这些文件,而它们的 key 与 rsi 口径不同;
 *  - **不写 state.json、不 `ackBaseline`**(手动 collect 不是 L0,没有「确认后第一次成功采集」的语义);
 *  - **不追加日志行**(`RSI_TRIGGERS` 里没有 collect,不为它改冻结枚举)。
 * 与 `commitL0` 共用:`recomputeCounts` / `recomputeClusters` / `indexWritable` / `updateIndex` / `writeIndexFile` / `writeCountsProjectionWith` / `commitUnderLockWith`。
 * `staged[].tainted` 只取 `TAINTED` 文件的实际在场事实,不掺「证据属 X」的推导(与 `commitL0` 同口径)。
 *
 * 写点复核:每个写操作之前先调 `gate`(测试的故障注入点,之后 `assertHeld()`;失锁抛 `RsiLockError`,之后零写入),经 `hooksFromGate` 适配给服务层。
 * 崩溃语义:任一提交步骤之后崩溃,下一个持锁写入方的 `recoverUnderLock` / 下一次 collect 的全量重算会把 counts / 索引 / 清单校正回来(目标值语义,幂等)。
 */
import {
  RsiCountsSchema,
  RsiProjectIndexSchema,
  type RsiCounts,
  type RsiProjectIndex,
} from '../../contracts/rsi.js';
import type { Redactor } from '../../contracts/redact.js';
import { stat } from '../../io/read-fs.js';
import type { SessionResult } from '../../signals/pipeline.js';
import type { RsiLockHandle } from '../lock.js';
import { readRsiFixed } from '../services/attribution.js';
import {
  commitUnderLockWith,
  recoverUnderLock,
  writeCountsProjectionWith,
} from '../services/commit.js';
import { hooksFromGate, readStateForWrite, writeIndexFile } from '../services/fixed-write.js';
import { indexWritable } from '../services/index-writable.js';
import { stagedProjection } from '../services/projections.js';
import { RsiFailClosedError, type RsiServiceCtx } from '../types.js';
import { inspectSnapshot } from '../snapshot.js';
import { productionSnapshotValidator } from '../validators.js';
import { readCursorDoc, recomputeClusters } from './commit.js';
import { recomputeCounts } from './counts-recompute.js';
import { updateIndex } from './index-update.js';
import type { BeforeWrite, IndexObservation } from './types.js';

export interface CommitCollectInput {
  /** `collect()` 的逐会话结果(只用 processed 且带 `projectKey` 的) */
  results: readonly SessionResult[];
  /** `projectKey → 项目根`:策略决定处理时记下的(allow 路径作为根原样保留,R20-4.1) */
  roots: ReadonlyMap<string, string>;
  /** 真实盐的指纹(已在锁内建好 / 读过) */
  saltFp: string;
  /** clusters 重算用的复扫器(只需 `pass2`) */
  redactor: Pick<Redactor, 'pass2'>;
  /** 写点钩子(命令传 `makeGate(lock, deps.beforeWrite)`:每次写之前先测试注入,再 `assertHeld()`) */
  gate: BeforeWrite;
}

export interface CommitCollectResult {
  /** 快照清单提交后的 generation */
  generation: number;
  indexWritten: boolean;
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

/** 本次 processed 会话的项目根观测(同一 (key, root) 去重;`stat` 失败的根不更新,R20-4.2) */
async function observationsOf(
  results: readonly SessionResult[],
  roots: ReadonlyMap<string, string>,
): Promise<IndexObservation[]> {
  const out: IndexObservation[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== 'processed' || r.projectKey === undefined) continue;
    const root = roots.get(r.projectKey);
    if (root === undefined) continue;
    const id = `${r.projectKey}\0${root}`;
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const st = await stat(root);
      out.push({ key: r.projectKey, path: root, dev: st.dev, ino: st.ino });
    } catch {
      // stat 失败 = 不更新这个根
    }
  }
  return out;
}

export async function commitCollectUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  input: CommitCollectInput,
): Promise<CommitCollectResult> {
  const { io } = ctx;
  const hooks = hooksFromGate(input.gate);
  const now = (ctx.now ?? ((): Date => new Date()))();
  const today = now.toISOString().slice(0, 10);

  // 读现状(锁内,直接读固定文件)
  const stateDoc = await readStateForWrite(io);
  const prevCounts = await readCountsDoc(io);
  const prevIndex = await readIndexDoc(io);
  const prevCursor = await readCursorDoc(io);

  // 提交前的无副作用复检:带病数据不得被清单背书;未完成的上一次提交先按当前文件重建清单
  if ((await inspectSnapshot(io, productionSnapshotValidator)) === 'needs_rebuild') {
    await recoverUnderLock(ctx, lock, hooks);
  }

  // R 重算(从磁盘,不看本次新增了多少)
  const rc = await recomputeCounts(io, ctx.config, now);
  const clusters = await recomputeClusters(io, input.redactor);
  // counts 在且盐相符:沿用现有 staged 条目,只按 TAINTED 文件事实校正 `tainted`(不掺「证据属 X」的推导,与 commitL0 同口径);
  // counts 缺失 / 盐不符:现有 staged 不可信(甚至不存在),按磁盘全量重建(与 `refreshStagedUnderLock` 同口径),免得把已暂存的 run 漏出 counts
  const staged =
    prevCounts !== null && prevCounts.salt_fp === input.saltFp
      ? prevCounts.staged.map((e) => ({
          ...e,
          tainted: rc.stagedTainted.get(e.run_id) ?? e.tainted,
        }))
      : await stagedProjection(io);

  // C3 索引(D7:索引 ok 且盐指纹一致,或索引缺失且 cursor 也缺失)
  let indexWritten = false;
  const idxOk = prevIndex.status === 'ok' && prevIndex.value.salt_fp === input.saltFp;
  const writable = indexWritable(
    prevIndex.status === 'ok'
      ? { status: 'ok', saltFp: prevIndex.value.salt_fp }
      : { status: prevIndex.status },
    prevCursor !== null,
    input.saltFp,
  );
  if (writable) {
    // 三套 generation 互不比对:新索引 generation = max(旧索引 generation 或 0, projects_ack_generation) + 1(与 L0 / rebuild 同口径)
    const generation =
      Math.max(
        prevIndex.status === 'ok' ? prevIndex.value.generation : 0,
        stateDoc.prev?.projects_ack_generation ?? 0,
      ) + 1;
    const res = updateIndex({
      prev: idxOk && prevIndex.status === 'ok' ? prevIndex.value : null,
      observations: await observationsOf(input.results, input.roots),
      perKey: rc.perKey,
      saltFp: input.saltFp,
      generation,
      today,
    });
    await writeIndexFile(ctx, lock, res.index, hooks);
    indexWritten = true;
  }

  // C4 counts(四段全量)
  await writeCountsProjectionWith(
    ctx,
    lock,
    {
      perKey: rc.perKey,
      unknownKeysSignals: rc.unknownKeysSignals,
      clusters,
      staged,
    },
    hooks,
  );

  // C7 快照清单(最后一步;不给 log:手动 collect 不追加日志行,Q-L)。trigger 是必填的合法枚举值,只在有 log 时才会落盘——这里没有 log,这个值不会出现在任何文件里
  const committed = await commitUnderLockWith(ctx, lock, { trigger: 'kit' }, hooks);
  return { generation: committed.generation, indexWritten };
}
