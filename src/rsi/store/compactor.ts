/**
 * `Compactor`:审计压缩与水位线推进(设计稿 v3 §A、§B、§C.2;第 2 版 §1;§21.24 W0-26 第 7、8、9 条)。**只由持 `rsi + personal` 锁者调用**(C 的 worker 在个人步后每次持锁调用;命令不调)。
 * 它拿不到 `applyOnce`(`KeyedEffectSink` 不含恢复,`Compactor` 也不含 sink):账只经 `LedgerRecoveryPort.recoverThrough`(P1 前)与 P4 的维护性提交写。
 *
 * 一次运行(固定顺序;进程崩溃模型,不含掉电):
 *  0. **前置**:`reconcile` 未接线 → `compact_unwired`(任何读写之前);取**压缩租约**(`SealRegistry`:已有未关闭区域 → `region_open`;租约期间不允许新开区域,
 *     所以「检查之后、P2 之前」不会冒出持旧 W 的区域);今日取一次。
 *  1. **txn1(只读)**:压缩文件(不受支持 → 拒绝)、审计(**P0**:`classifyAuditFile`,坏行 / 重复键 → 拒绝,撕裂尾可恢复)、账;选目标 W'(无目标 → 只做 P3 / P4 续做)。
 *  2. **事务外**:读权威源 `batchesThrough / derivedThrough / entriesThrough(W')`;对 P1 判据「未满足」的批次调 `recoverThrough`(它自己开事务,**不能嵌在事务里**)。
 *     任一 `ledger_not_committed` → 返回 `compact_blocked`(不抛、不推进;已提交的恢复写保留——它们是既定事件的既定效果,不是半成品)。
 *  3. **txn2**:重读全部 → 再算一遍 P1 判据(同一纯函数)→ 区间计数与去重 → **P2:一次 rename 写压缩文件(`through = W'`、`months` 增量、`gen + 1`)= 提交点** →
 *     **P3**:rename 重写 `audit.jsonl` 去掉 ≤ W' 的行(同时丢撕裂尾)→ **P4**:一次 rename 裁过期冷却与 ≤ W' 的 `applied` 键。
 *     P2 之后 P3 / P4 的失败**不抛**(提交点已过),记在 `cleanup`,下一次运行按已提交的 W 续做且**不重复计数**(≤ W 的残留行已在 I2 计入)。
 *  P2 之前的失败(含 rename 失败)抛错、压缩文件字节不变。`compact_blocked` 是返回值;结构性错误(未接线、区域占用、压缩不受支持、坏审计、同键内容不等、I/O、锁丢失)是抛出。
 * 偏离第 2 版:P0 的撕裂尾修复并入 P3 的重写(一次 rename 同时去尾),不单独先修——先修会在 `reconcile` 校验与 P1 之前写盘。
 */
import { RsiLockError } from '../lock-error.js';
import type { RsiAuditLine } from '../../contracts/rsi-personal.js';
import {
  utcDay,
  type RsiAuditCompaction,
  type StoreCause,
  type UtcDay,
} from '../../contracts/rsi-store.js';
import { classifyAuditFile, type GoodAuditClass } from './audit-classify.js';
import {
  checkBatch,
  countInterval,
  keepAfter,
  mergeMonths,
  pickTarget,
  pruneLedger,
} from './compact-plan.js';
import { StoreError } from './errors.js';
import type {
  HeldStore,
  LedgerRecoveryPort,
  ReconcileSource,
  RecoveryBatch,
  TxnPorts,
} from './ports.js';
import { unwiredReconcileSource } from './reconcile.js';
import type { SealRegistry } from './seal.js';
import { compactionPortOf } from './txn.js';

export interface CompactorDeps {
  /** 注意:必须是 `createHeldStore` 造出的协调器(压缩端口经 `compactionPortOf` 取自它的事务端口);不是任意结构兼容的 `HeldStore` 都可替换——这是存储核内部装配 */
  held: HeldStore;
  registry: SealRegistry;
  /** 缺省 = 未接线(`compact_unwired`) */
  reconcile?: ReconcileSource;
  recovery: LedgerRecoveryPort;
  clock: () => Date;
}

/** P2 之后的续做状态:`none` = 无事可做;`pending` = 失败待下次(`cause` 为第一个失败原因) */
export interface CompactCleanup {
  audit: 'done' | 'pending' | 'none';
  ledger: 'done' | 'pending' | 'none';
  cause?: StoreCause;
}

export interface CompactBlocked {
  kind: 'compact_blocked';
  cause: StoreCause;
  /** 未满足的批次(`cause` = 恢复端口给的原因;P1 复核不满足而恢复未覆盖时为 `compact_blocked`) */
  batches: readonly { batch_id: string; cause: StoreCause }[];
}
export type CompactResult =
  | { kind: 'noop'; through: UtcDay | null; cleanup: CompactCleanup }
  | {
      kind: 'advanced';
      from: UtcDay | null;
      through: UtcDay;
      gen: number;
      counted: { deleted: number; derived_missing: number };
      cleanup: CompactCleanup;
    }
  | CompactBlocked;

export interface Compactor {
  /** `opts.through`:显式目标(测试 / 运维入口;须 < 今日,且 > 现有 W 才推进);缺省按年龄 / 容量触发 */
  compact(opts?: { through?: UtcDay }): Promise<CompactResult>;
}

interface AuditSnapshot {
  cls: GoodAuditClass;
  /** 与 `cls.rows` 一一对应的原行文本(不含换行) */
  lines: string[];
}

async function loadAudit(p: TxnPorts): Promise<AuditSnapshot> {
  const r = await p.auditAppend.readAudit();
  const cls = classifyAuditFile(r.kind === 'missing' ? '' : r.text);
  if (cls.kind === 'bad') throw new StoreError(cls.cause, `line:${cls.line}:${cls.detail}`);
  const good = cls.kind === 'ok' ? (r.kind === 'ok' ? r.text : '') : cls.goodText;
  return { cls, lines: good === '' ? [] : good.slice(0, -1).split('\n') };
}

const dayOf = (r: RsiAuditLine): UtcDay => utcDay(r.at);

const causeOf = (e: unknown): StoreCause => (e instanceof StoreError ? e.code : 'store_io');

/** P3 + P4(P2 之后或续做):各自独立,失败只记录不抛(锁丢失除外) */
async function cleanupSteps(p: TxnPorts, w: UtcDay, today: UtcDay): Promise<CompactCleanup> {
  const out: CompactCleanup = { audit: 'none', ledger: 'none' };
  const fail = (e: unknown): void => {
    if (e instanceof RsiLockError) throw e;
    out.cause ??= causeOf(e);
  };
  try {
    const au = await loadAudit(p);
    if (au.cls.kind === 'torn_tail' || au.cls.rows.some((r) => dayOf(r) <= w)) {
      await p.auditAppend.rewrite(keepAfter(au.lines, au.cls.rows, w));
      out.audit = 'done';
    }
  } catch (e) {
    out.audit = 'pending';
    fail(e);
  }
  try {
    const next = pruneLedger(await p.ledgerWrite.read(), today, w);
    if (next !== null) {
      await p.ledgerWrite.commit(next);
      out.ledger = 'done';
    }
  } catch (e) {
    out.ledger = 'pending';
    fail(e);
  }
  return out;
}

export function createCompactor(deps: CompactorDeps): Compactor {
  const reconcile = deps.reconcile ?? unwiredReconcileSource;

  const blocked = (
    cause: StoreCause,
    batches: readonly { batch_id: string; cause: StoreCause }[],
  ): CompactBlocked => ({ kind: 'compact_blocked', cause, batches });

  async function run(opts: { through?: UtcDay }): Promise<CompactResult> {
    const today = utcDay(deps.clock().toISOString());
    // ① txn1:只读(P0 分类、压缩状态、账快照、目标)
    const snap = await deps.held.transaction(async (p) => {
      const cmp = await compactionPortOf(p).read();
      return { cmp, au: await loadAudit(p), ledger: await p.ledgerWrite.read() };
    });
    const wOld = snap.cmp?.through ?? null;
    const target = pickTarget(snap.au.cls.rows, wOld, today, opts.through);

    if (target === null) {
      if (wOld === null) {
        return { kind: 'noop', through: null, cleanup: { audit: 'none', ledger: 'none' } };
      }
      const cleanup = await deps.held.transaction((p) => cleanupSteps(p, wOld, today));
      return { kind: 'noop', through: wOld, cleanup };
    }

    // ② 事务外:权威源 + 压缩前恢复
    const batches: readonly RecoveryBatch[] = await reconcile.batchesThrough(target);
    const derived = await reconcile.derivedThrough(target);
    const entries = await reconcile.entriesThrough(target);
    const unsatisfied = batches.filter((b) => !checkBatch(snap.ledger, b, today).ok);
    if (unsatisfied.length > 0) {
      const res = await deps.recovery.recoverThrough(target, unsatisfied);
      const bad = res.filter((r) => r.state === 'ledger_not_committed');
      if (bad.length > 0) {
        const rows = bad.map((r) => ({
          batch_id: r.batch_id,
          cause: r.cause ?? ('compact_blocked' as StoreCause),
        }));
        return blocked((rows[0] as { cause: StoreCause }).cause, rows);
      }
    }

    // ③ txn2:重读 → P1 复核 → P2 → P3 → P4
    return deps.held.transaction(async (p): Promise<CompactResult> => {
      const cp = compactionPortOf(p);
      const cur = await cp.read();
      if ((cur?.gen ?? 0) !== (snap.cmp?.gen ?? 0) || (cur?.through ?? null) !== wOld) {
        return blocked('compact_blocked', []);
      }
      const au = await loadAudit(p);
      const ledger = await p.ledgerWrite.read();
      const failed = batches
        .map((b) => ({ b, c: checkBatch(ledger, b, today) }))
        .flatMap((x) => (x.c.ok ? [] : [{ batch_id: x.b.key, cause: x.c.cause }]));
      if (failed.length > 0) return blocked((failed[0] as { cause: StoreCause }).cause, failed);
      const count = countInterval({
        rows: au.cls.rows,
        byKey: au.cls.byKey,
        derived,
        entries,
        wOld,
        wNew: target,
      });
      const next: RsiAuditCompaction = {
        schema_version: 1,
        gen: (cur?.gen ?? 0) + 1,
        through: target,
        months: mergeMonths(cur?.months ?? {}, count.months),
      };
      await cp.commit(next); // P2:提交点
      const cleanup = await cleanupSteps(p, target, today);
      return {
        kind: 'advanced',
        from: wOld,
        through: target,
        gen: next.gen,
        counted: { deleted: count.deleted, derived_missing: count.derived_missing },
        cleanup,
      };
    });
  }

  return {
    async compact(opts = {}) {
      if (reconcile === unwiredReconcileSource) throw new StoreError('compact_unwired');
      const release = deps.registry.acquireCompactionLease();
      if (release === 'busy') return blocked('compact_blocked', []); // 已有压缩在跑:返回值,不抛
      try {
        return await run(opts);
      } finally {
        release();
      }
    },
  };
}
