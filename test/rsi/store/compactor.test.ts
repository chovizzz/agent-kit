/**
 * B1b:`Compactor` 编排(真 Compactor + 真 `ReconcileSource` 适配器 + 假记录;内存与真文件系统同跑):
 * 审计满 + 终态账待补仍可推进、`compact_blocked` 返回形状、`region_open` / `compact_unwired` / 压缩不受支持 / 坏审计一律零写入拒绝、
 * `months` 去重与区间不交、同键冲突拒推进、旧批次重放安全(冷却不复活、lift 不复活、≤ W 的审计 replay 经权威源才 `compacted`)。
 * 崩溃矩阵见 `compactor-crash.test.ts`;纯规划见 `compact-plan.test.ts`。
 */
import { describe, expect, it, vi } from 'vitest';
import type { RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import {
  RsiAuditCompactionSchema,
  type RsiEffectsLedger,
} from '../../../src/contracts/rsi-store.js';
import { decodeLedger } from '../../../src/rsi/store/backend.js';
import { createCompactor } from '../../../src/rsi/store/compactor.js';
import { StoreError } from '../../../src/rsi/store/errors.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import type {
  LedgerRecoveryPort,
  ReconcileSource,
  TxnPorts,
} from '../../../src/rsi/store/ports.js';
import { compactionPortOf } from '../../../src/rsi/store/txn.js';
import {
  T_CREATE_AT,
  T_TERM_AT,
  emptyLedger,
  fullOldAuditText,
  gateCommit,
  makeCWorld,
  rec,
  rowOfEntry,
  seedAudit,
  seedCompaction,
  seedLedger,
  snap,
  terminalRecord,
  type CWorld,
} from './b1b-fixture.js';
import {
  FILES,
  ID,
  SHA,
  auditEffect,
  cool,
  hex16,
  jsonLine,
  meta,
  obsRow,
  rawAppend,
  seed,
  trow,
  veto,
  type FsKind,
} from './store-fixture.js';

vi.setConfig({ testTimeout: 120_000 });

const KINDS: readonly FsKind[] = ['mem', 'real'];
const W = '2026-10-31';
const OBS_AT = '2026-10-05T08:00:00.000Z';
const RECENT = trow(hex16(9), '2026-11-10T08:00:00.000Z');
const rejects = async (p: Promise<unknown>): Promise<StoreError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected rejection');
};
const ledgerOf = async (w: CWorld): Promise<RsiEffectsLedger> => {
  const b = await w.bytes(FILES.effects);
  if (b === null) throw new Error('no ledger');
  return decodeLedger(b);
};
const compactionOf = async (w: CWorld) => {
  const b = await w.bytes(FILES.compaction);
  if (b === null) throw new Error('no compaction file');
  return RsiAuditCompactionSchema.parse(JSON.parse(b.toString('utf8')));
};
/** 基本世界:终态记录(两个条目)+ 审计里只有创建行、一条 2026-10 的无键观察行、一条 11-10 的新行 */
async function basic(kind: FsKind): Promise<CWorld> {
  const r = terminalRecord();
  const w = await makeCWorld(kind, { records: [r] });
  await seedAudit(w, [rowOfEntry(ID, r.transitions[0] as never), obsRow(OBS_AT), RECENT]);
  return w;
}

describe.each(KINDS)('Compactor 推进(%s)', (kind) => {
  it('P1–P4 端到端:恢复补账 → 区间计数(文件行 deleted、缺失 derived_missing)→ 压缩文件 gen 1 → 审计去掉 ≤ W 行 → 账裁键;恢复在事务外只调一次', async () => {
    const w = await basic(kind);
    const res = await w.compactor.compact({ through: W });
    expect(res).toEqual({
      kind: 'advanced',
      from: null,
      through: W,
      gen: 1,
      counted: { deleted: 2, derived_missing: 1 },
      cleanup: { audit: 'done', ledger: 'done' },
    });
    expect(w.recoveryCalls).toEqual([[`terminal:${ID}:${SHA}`]]);
    const c = await compactionOf(w);
    expect([c.gen, c.through]).toEqual([1, W]);
    expect(c.months).toEqual({
      '2026-10': {
        lines: 3,
        deleted: 2,
        derived_missing: 1,
        by_kind: { transition: 2, evaluation: 1 },
        transition_by_to: { proposed: 1, rejected: 1 },
      },
    });
    expect((await w.bytes(FILES.audit))?.toString('utf8')).toBe(jsonLine(RECENT));
    const l = await ledgerOf(w);
    expect(l.gen).toBe(2); // 恢复 +1,P4 裁键 +1
    expect(l.applied).toEqual([]);
    expect(l.blacklist.map((b) => b.candidate_id)).toEqual([ID]);
    expect(l.tombstones.map((t) => t.id)).toEqual([ID]);
    expect(await w.tmpFiles()).toEqual([]);
  });

  it('已满足的批次不调恢复端口(只对 P1 判据未满足者调);再跑一次 = noop 且字节不变', async () => {
    const w = await basic(kind);
    await w.compactor.compact({ through: W });
    const before = await snap(w);
    const calls = w.recoveryCalls.length;
    const again = await w.compactor.compact({ through: W });
    expect(again).toEqual({
      kind: 'noop',
      through: W,
      cleanup: { audit: 'none', ledger: 'none' },
    });
    expect(await w.compactor.compact()).toMatchObject({ kind: 'noop' });
    expect(w.recoveryCalls.length).toBe(calls);
    expect(await snap(w)).toEqual(before);
    // 更早的显式目标 = 不推进(水位线不回退)
    expect(await w.compactor.compact({ through: '2026-10-15' })).toMatchObject({ kind: 'noop' });
    expect(await snap(w)).toEqual(before);
  });

  it('年龄触发:不给显式目标,存在日 ≤ 今日 − 365 → 推进到今日 − 365;无批次时不调恢复', async () => {
    const w = await makeCWorld(kind);
    await seedAudit(w, [trow(hex16(1), '2025-11-10T00:00:00.000Z'), RECENT]);
    const res = await w.compactor.compact();
    expect(res).toMatchObject({ kind: 'advanced', through: '2025-11-15', counted: { deleted: 1 } });
    expect(w.recoveryCalls).toEqual([]);
    expect((await w.bytes(FILES.audit))?.toString('utf8')).toBe(jsonLine(RECENT));
  });

  it('显式目标 ≥ 今日 = out_of_range(零写入);无任何触发 = noop', async () => {
    const w = await basic(kind);
    const before = await snap(w);
    expect((await rejects(w.compactor.compact({ through: '2026-11-15' }))).code).toBe(
      'out_of_range',
    );
    expect(await w.compactor.compact()).toMatchObject({ kind: 'noop', through: null });
    expect(await snap(w)).toEqual(before);
  });

  it('months_interval_disjoint_across_runs:第二次只数 (W_old, W_new],第一次已计的缺失事件与残留不重复', async () => {
    const w = await makeCWorld(kind, { records: [terminalRecord()] });
    await seedAudit(w, [obsRow(OBS_AT), obsRow('2026-10-20T08:00:00.000Z'), RECENT]);
    const r1 = await w.compactor.compact({ through: '2026-10-15' });
    expect(r1).toMatchObject({ kind: 'advanced', counted: { deleted: 1, derived_missing: 2 } });
    const r2 = await w.compactor.compact({ through: W });
    expect(r2).toMatchObject({
      kind: 'advanced',
      gen: 2,
      counted: { deleted: 1, derived_missing: 0 },
    });
    const m = (await compactionOf(w)).months['2026-10'];
    expect([m?.lines, m?.deleted, m?.derived_missing]).toEqual([4, 2, 2]);
  });

  it('truncated_entry_exempt_not_in_derived_missing:截断丢失的条目不在权威源,不计 derived_missing(只数留存条目)', async () => {
    const r = { ...terminalRecord(), transitions_dropped: 5 };
    const w = await makeCWorld(kind, { records: [r] });
    await seedAudit(w, [RECENT]);
    const res = await w.compactor.compact({ through: W });
    expect(res).toMatchObject({ kind: 'advanced', counted: { deleted: 0, derived_missing: 2 } });
  });

  it('r5_r8_lost_never_counted:无权威源的行(R5 / R8)在文件里才按行计 deleted,丢了就永不计入', async () => {
    const r5 = trow(hex16(0x55), OBS_AT, {
      from: 'rejected',
      to: 'rejected',
      reason: 'noop:vetoed',
    });
    const withRows = await makeCWorld(kind, { records: [terminalRecord()] });
    await seedAudit(withRows, [r5, obsRow(OBS_AT), RECENT]);
    const a = await withRows.compactor.compact({ through: W });
    expect(a).toMatchObject({ counted: { deleted: 2, derived_missing: 2 } });
    const lost = await makeCWorld(kind, { records: [terminalRecord()] });
    await seedAudit(lost, [RECENT]);
    const b = await lost.compactor.compact({ through: W });
    expect(b).toMatchObject({ counted: { deleted: 0, derived_missing: 2 } });
  });

  it('months_dedup:文件里已有创建行时只计一次(deleted),缺失的终态行计 derived_missing;二者不同时计入', async () => {
    const w = await basic(kind);
    await w.compactor.compact({ through: W });
    const m = (await compactionOf(w)).months['2026-10'];
    expect((m?.deleted ?? 0) + (m?.derived_missing ?? 0)).toBe(m?.lines);
    expect(m?.by_kind?.['transition']).toBe(2); // 两个条目各一次,不是三次
  });
});

describe.each(KINDS)('compact_blocked 与零写入拒绝(%s)', (kind) => {
  it('compact_recovery_ledger_not_committed_blocks:账里同键异内容 → 返回 compact_blocked{cause, batches}(不抛),W 不推进,审计与账字节不变', async () => {
    const w = await basic(kind);
    await seedLedger(w, {
      ...emptyLedger(1),
      applied: [
        { key: `terminal:${ID}:${SHA}`, event_at: T_TERM_AT, batch_sha256: 'f'.repeat(64) },
      ],
    });
    const before = await snap(w);
    const res = await w.compactor.compact({ through: W });
    expect(res).toEqual({
      kind: 'compact_blocked',
      cause: 'effects_key_conflict',
      batches: [{ batch_id: `terminal:${ID}:${SHA}`, cause: 'effects_key_conflict' }],
    });
    expect(await snap(w)).toEqual(before);
    expect(await w.tmpFiles()).toEqual([]);
  });

  it('账永久硬线满(5000 墓碑)→ 恢复 effects_full → compact_blocked{effects_full}:压缩不是无条件逃生口', async () => {
    const w = await basic(kind);
    const tombs = Array.from({ length: 5000 }, (_, i) => ({
      id: `ra_${(i + 1).toString(16).padStart(12, '0')}`,
      terminal: 'rejected',
      reason: 'vetoed',
      at: T_TERM_AT,
    }));
    await seedLedger(w, { ...emptyLedger(1), tombstones: tombs } as never);
    const before = await snap(w);
    const res = await w.compactor.compact({ through: W });
    expect(res).toMatchObject({ kind: 'compact_blocked', cause: 'effects_full' });
    expect(await snap(w)).toEqual(before);
  });

  it('compact_unwired:未接线 = 抛 compact_unwired,三个文件字节不变、无 tmp(正向对照:接线后同一世界可推进)', async () => {
    const w = await makeCWorld(kind, { unwired: true, records: [terminalRecord()] });
    await seedAudit(w, [obsRow(OBS_AT), RECENT]);
    await seedLedger(w, emptyLedger(1));
    const before = await snap(w);
    expect((await rejects(w.compactor.compact({ through: W }))).code).toBe('compact_unwired');
    expect((await rejects(w.compactor.compact())).code).toBe('compact_unwired');
    expect(await snap(w)).toEqual(before);
    expect(await w.tmpFiles()).toEqual([]);
    // 对照:同样的输入,接线后推进
    const wired = await makeCWorld(kind, { records: [terminalRecord()] });
    await seedAudit(wired, [obsRow(OBS_AT), RECENT]);
    expect(await wired.compactor.compact({ through: W })).toMatchObject({ kind: 'advanced' });
  });

  it('region_open:有未关闭的区域 = 抛 region_open,三个文件字节不变;区域关闭后可推进', async () => {
    const w = await basic(kind);
    const before = await snap(w);
    const region = await w.s.seal.open(w.personal);
    const e = await rejects(w.compactor.compact({ through: W }));
    expect(e.code).toBe('region_open');
    expect(await snap(w)).toEqual(before);
    region.close();
    expect(await w.compactor.compact({ through: W })).toMatchObject({ kind: 'advanced' });
  });

  it('compaction_unsupported_refuses_all_writes:schema_version 2 / through ≥ 今日 → 拒绝,账与审计字节不变', async () => {
    for (const bad of [
      { schema_version: 2, gen: 1, through: null, months: {} },
      { schema_version: 1, gen: 1, through: '2026-11-15', months: {} },
    ]) {
      const w = await basic(kind);
      await seedCompaction(w, bad);
      const before = await snap(w);
      expect((await rejects(w.compactor.compact({ through: W }))).code).toBe(
        'compaction_unsupported',
      );
      expect(await snap(w)).toEqual(before);
    }
  });

  it('P0:中间坏行 = audit_bad_line,重复键 = audit_dup_key(零写入);撕裂尾可恢复:推进后尾巴随 P3 重写被去掉', async () => {
    const w1 = await makeCWorld(kind, { records: [terminalRecord()] });
    await seed(w1, FILES.audit, `${jsonLine(RECENT)}garbage\n${jsonLine(RECENT)}`);
    const b1 = await snap(w1);
    expect((await rejects(w1.compactor.compact({ through: W }))).code).toBe('audit_bad_line');
    expect(await snap(w1)).toEqual(b1);

    const w2 = await makeCWorld(kind, { records: [terminalRecord()] });
    const dup = trow(hex16(0x77), OBS_AT);
    await seedAudit(w2, [dup, dup]);
    const b2 = await snap(w2);
    expect((await rejects(w2.compactor.compact({ through: W }))).code).toBe('audit_dup_key');
    expect(await snap(w2)).toEqual(b2);

    const w3 = await makeCWorld(kind, { records: [terminalRecord()] });
    await seedAudit(w3, [trow(hex16(0x78), OBS_AT), RECENT]);
    await rawAppend(w3, FILES.audit, '{"at":"2026-11-1');
    expect(await w3.compactor.compact({ through: W })).toMatchObject({
      kind: 'advanced',
      cleanup: { audit: 'done' },
    });
    expect((await w3.bytes(FILES.audit))?.toString('utf8')).toBe(jsonLine(RECENT));
  });

  it('权威源读失败 / 记录不合规 = 抛(store_io / state_invalid),在任何写之前;不得以空扫描通过', async () => {
    const w = await basic(kind);
    const before = await snap(w);
    w.records.failKind = 'unreadable';
    expect((await rejects(w.compactor.compact({ through: W }))).code).toBe('store_io');
    w.records.failKind = null;
    w.records.list = [{ ...terminalRecord(), schema_version: 2 } as never];
    expect((await rejects(w.compactor.compact({ through: W }))).code).toBe('state_invalid');
    expect(await snap(w)).toEqual(before);
    w.records.list = [terminalRecord()];
    expect(await w.compactor.compact({ through: W })).toMatchObject({ kind: 'advanced' });
  });

  it('权威源不自洽:条目没有对应派生行 = compact_blocked(抛);批次事件日 > 目标 = out_of_range;均零写入', async () => {
    const w = await basic(kind);
    const before = await snap(w);
    const base: ReconcileSource = {
      entriesThrough: async () => [],
      batchesThrough: async () => [],
      derivedThrough: async () => [],
      resolve: async () => null,
    };
    const run = (over: Partial<ReconcileSource>) =>
      createCompactor({
        held: w.s.held,
        registry: w.s.registry,
        recovery: w.s.recovery,
        clock: () => new Date(w.clock.iso),
        reconcile: { ...base, ...over },
      }).compact({ through: W });
    const e1 = await rejects(
      run({ entriesThrough: async () => [{ id: ID, idem_key: hex16(0xee), at: T_CREATE_AT }] }),
    );
    expect(e1.code).toBe('compact_blocked');
    const e2 = await rejects(
      run({
        batchesThrough: async () => [
          {
            key: 'late',
            effects: [{ type: 'write_tombstone', id: ID, terminal: 'rejected', reason: 'vetoed' }],
            meta: meta('2026-11-02T00:00:00.000Z'),
          },
        ],
      }),
    );
    expect(e2.code).toBe('out_of_range');
    expect(await snap(w)).toEqual(before);
    await expect(run({})).resolves.toMatchObject({ kind: 'advanced' }); // 对照
  });

  it('同键内容不等 = audit_key_conflict,拒推进(压缩文件不创建、审计字节不变)', async () => {
    const r = terminalRecord();
    const w = await makeCWorld(kind, { records: [r] });
    await seedAudit(w, [{ ...rowOfEntry(ID, r.transitions[0] as never), to: 'canary' }, RECENT]);
    const before = (await snap(w)).audit;
    expect((await rejects(w.compactor.compact({ through: W }))).code).toBe('audit_key_conflict');
    const after = await snap(w);
    expect([after.audit, after.compaction]).toEqual([before, null]);
  });

  it('same_key_file_and_source_on_opposite_sides_of_old_W_refuses:文件行 ≤ W_old、权威源 > W_old,同键异 at = 拒绝', async () => {
    const e = (at: string) => ({
      dim: 'lifecycle' as const,
      from: 'none',
      to: 'proposed',
      at,
      reason: 'ingested' as const,
      idem_key: hex16(0xd1),
    });
    const r = rec('proposed', { transitions: [e('2026-10-20T08:00:00.000Z')] });
    const w = await makeCWorld(kind, { records: [r] });
    await seedCompaction(w, { schema_version: 1, gen: 1, through: '2026-10-10', months: {} });
    await seedAudit(w, [rowOfEntry(ID, e('2026-10-02T08:00:00.000Z') as never)]);
    const before = await snap(w);
    expect((await rejects(w.compactor.compact({ through: W }))).code).toBe('audit_key_conflict');
    expect(await snap(w)).toEqual(before);
  });

  it('same_key_file_and_source_on_opposite_sides_of_new_W_refuses:文件行 > W_new、权威源 ≤ W_new = 拒绝', async () => {
    const e = (at: string) => ({
      dim: 'lifecycle' as const,
      from: 'none',
      to: 'proposed',
      at,
      reason: 'ingested' as const,
      idem_key: hex16(0xd2),
    });
    const r = rec('proposed', { transitions: [e('2026-10-20T08:00:00.000Z')] });
    const w = await makeCWorld(kind, { records: [r] });
    await seedAudit(w, [rowOfEntry(ID, e('2026-11-05T08:00:00.000Z') as never)]);
    const before = await snap(w);
    expect((await rejects(w.compactor.compact({ through: W }))).code).toBe('audit_key_conflict');
    expect(await snap(w)).toEqual(before);
  });

  it('p1_recheck_after_recovery_blocks_lying_recovery:恢复端口谎报「已提交」而账没变 → txn2 复核不满足 → compact_blocked,不写压缩文件', async () => {
    const w = await basic(kind);
    const lying: LedgerRecoveryPort = {
      recoverThrough: async (_W, batches) =>
        batches.map((b) => ({ batch_id: b.key, state: 'ledger_committed' as const })),
    };
    const c = createCompactor({
      held: w.s.held,
      registry: w.s.registry,
      recovery: lying,
      clock: () => new Date(w.clock.iso),
      reconcile: w.source,
    });
    const before = await snap(w);
    expect(await c.compact({ through: W })).toEqual({
      kind: 'compact_blocked',
      cause: 'compact_blocked',
      batches: [{ batch_id: `terminal:${ID}:${SHA}`, cause: 'compact_blocked' }],
    });
    expect(await snap(w)).toEqual(before);
  });

  it('compaction_port_escape_after_txn_refused:事务结束后再用压缩端口 = txn_closed(token 绑定);不是本协调器造的端口对象 = txn_closed;文件不变', async () => {
    const w = await basic(kind);
    const before = await snap(w);
    const esc: { p?: TxnPorts } = {};
    await w.s.held.transaction(async (p) => {
      esc.p = p;
    });
    const cp = compactionPortOf(esc.p as TxnPorts);
    const next = { schema_version: 1 as const, gen: 1, through: W, months: {} };
    expect((await rejects(cp.commit(next))).code).toBe('txn_closed');
    expect((await rejects(cp.read())).code).toBe('txn_closed');
    expect(() => compactionPortOf({} as TxnPorts)).toThrow(StoreError);
    expect(await snap(w)).toEqual(before);
  });

  it('assembleRsiStore 装配的 compactor 接 source,且与 seal 共用区域注册表', async () => {
    const w = await basic(kind);
    const region = await w.s.seal.open(w.personal);
    expect((await rejects(w.s.compactor.compact({ through: W }))).code).toBe('region_open');
    region.close();
    expect(await w.s.compactor.compact({ through: W })).toMatchObject({ kind: 'advanced' });
  });

  it('torn_tail_resume_without_residual:W 已推进、审计里只有 W 之后的行 + 撕裂尾 → 续做路径去掉尾巴(noop + cleanup.audit=done)', async () => {
    const w = await makeCWorld(kind);
    await seedCompaction(w, { schema_version: 1, gen: 1, through: W, months: {} });
    await seedAudit(w, [RECENT], '{"at":"2026-11-1');
    expect(await w.compactor.compact()).toEqual({
      kind: 'noop',
      through: W,
      cleanup: { audit: 'done', ledger: 'none' },
    });
    expect((await w.bytes(FILES.audit))?.toString('utf8')).toBe(jsonLine(RECENT));
  });

  it('Compactor 只有 compact:拿不到 applyOnce / recoverThrough 等写入口', async () => {
    const w = await makeCWorld(kind);
    expect(Object.keys(w.s.compactor)).toEqual(['compact']);
  });
});

describe('压缩租约(P2 期间不许新开区域)', () => {
  it('compaction_lease_blocks_region_open_during_p2:P2 的 rename 挂起时 SealGuard.open = region_open(compacting),并发第二个压缩 = compact_blocked;完成后可开', async () => {
    const holder: { g?: ReturnType<typeof gateCommit> } = {};
    const w = await makeCWorld('mem', {
      records: [terminalRecord()],
      wrap: (inner) => {
        holder.g = gateCommit(inner, FILES.compaction);
        return holder.g.fs;
      },
    });
    await seedAudit(w, [obsRow(OBS_AT), RECENT]);
    const gate = holder.g as ReturnType<typeof gateCommit>;
    const running = w.compactor.compact({ through: W });
    await gate.reached;
    const e = await rejects(w.s.seal.open(w.personal));
    expect([e.code, e.detail]).toEqual(['region_open', 'compacting']);
    const e2 = await rejects(w.compactor.compact({ through: W }));
    expect([e2.code, e2.detail]).toEqual(['compact_blocked', 'concurrent_compaction']);
    gate.release();
    expect(await running).toMatchObject({ kind: 'advanced' });
    const r = await w.s.seal.open(w.personal); // 租约已释放
    expect(r.watermark).toBe(W);
    r.close();
  });

  it('lock_lost_after_p2_propagates:提交点之后锁丢失 = 抛 RsiLockError(不被当作 P3 / P4 的待续做吞掉);P2 已落', async () => {
    const holder: { g?: ReturnType<typeof gateCommit> } = {};
    const w = await makeCWorld('mem', {
      records: [terminalRecord()],
      wrap: (inner) => {
        holder.g = gateCommit(inner, FILES.compaction);
        return holder.g.fs;
      },
    });
    await seedAudit(w, [obsRow(OBS_AT), RECENT]);
    const gate = holder.g as ReturnType<typeof gateCommit>;
    const settled = w.compactor.compact({ through: W }).then(
      () => null,
      (e: unknown) => e,
    );
    await gate.reached;
    w.rsi.held = false;
    gate.release();
    const e = await settled;
    expect(e).toBeInstanceOf(RsiLockError);
    expect((e as RsiLockError).kind).toBe('lock_lost');
    expect((await w.bytes(FILES.compaction)) === null).toBe(false);
  });

  it('压缩失败时租约也释放(下一次 open 不被卡住)', async () => {
    const w = await makeCWorld('mem', { unwired: true });
    await rejects(w.compactor.compact({ through: W }));
    const r = await w.s.seal.open(w.personal);
    r.close();
    const w2 = await basic('mem');
    w2.records.failKind = 'unreadable';
    await rejects(w2.compactor.compact({ through: W }));
    const r2 = await w2.s.seal.open(w2.personal);
    r2.close();
  });
});

describe('compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)', () => {
  it('审计 20000 行(满)+ 终态账未写 → 恢复补账不需要审计空间 → 推进成功;之后审计有空间,追加正常', async () => {
    const w = await makeCWorld('mem', { records: [terminalRecord()] });
    await seed(w, FILES.audit, fullOldAuditText());
    const full = await w.s.sink.applyOnce('audit:probe', [
      auditEffect(trow(hex16(1), '2026-11-10T08:00:00.000Z')),
    ]);
    expect([full.audit, full.cause]).toEqual(['pending', 'audit_full']); // 对照:确实满了
    const res = await w.compactor.compact({ through: W });
    expect(res).toMatchObject({
      kind: 'advanced',
      counted: { deleted: 20000, derived_missing: 2 },
      cleanup: { audit: 'done', ledger: 'done' },
    });
    const c = await compactionOf(w);
    expect(c.months['2026-09']?.lines).toBe(20000);
    expect(c.months['2026-10']).toMatchObject({ lines: 2, derived_missing: 2, deleted: 0 });
    expect((await ledgerOf(w)).tombstones.map((t) => t.id)).toEqual([ID]);
    expect((await w.bytes(FILES.audit))?.toString('utf8')).toBe('');
    const ok = await w.s.sink.applyOnce('audit:probe', [
      auditEffect(trow(hex16(1), '2026-11-10T08:00:00.000Z')),
    ]);
    expect(ok.audit).toBe('appended');
  });
});

describe.each(KINDS)('旧批次重放安全(%s)', (kind) => {
  it('cold_replay_cooldown_not_restarted:压缩裁掉键与过期冷却后,旧批次重放不重启冷却、账字节不变', async () => {
    const w = await makeCWorld(kind);
    w.clock.iso = '2026-10-10T12:00:00.000Z';
    const at = '2026-10-01T08:00:00.000Z';
    const first = await w.s.sink.applyOnce('terminal:x', [cool('cl-1', 'expired', 30)], meta(at));
    expect(first.ledger).toBe('committed');
    await w.compactor.compact({ through: '2026-10-05' });
    expect((await ledgerOf(w)).applied).toEqual([]); // 键(事件日 ≤ W)已裁
    expect((await ledgerOf(w)).cooldowns).toHaveLength(1); // 10-10 时冷却仍生效
    w.clock.iso = '2026-11-20T12:00:00.000Z';
    expect(await w.compactor.compact()).toMatchObject({
      kind: 'noop',
      cleanup: { ledger: 'done', audit: 'none' },
    });
    expect((await ledgerOf(w)).cooldowns).toEqual([]); // 11-01 到期被裁
    const before = await snap(w);
    const replay = await w.s.sink.applyOnce('terminal:x', [cool('cl-1', 'expired', 30)], meta(at));
    expect(replay).toEqual({ ledger: 'satisfied', audit: 'not_applicable' });
    expect(await snap(w)).toEqual(before);
  });

  it('lift_not_resurrected_after_prune:键被裁后,旧 veto 的 replay 不复活已解除的否决', async () => {
    const w = await makeCWorld(kind);
    w.clock.iso = '2026-10-10T12:00:00.000Z';
    const at = '2026-10-01T08:00:00.000Z';
    await w.s.userVeto.veto(ID, SHA, meta(at));
    expect(await w.s.userVeto.lift(ID, SHA, '2026-10-02T08:00:00.000Z')).toBe('lifted');
    await w.compactor.compact({ through: '2026-10-05' });
    expect((await ledgerOf(w)).applied).toEqual([]);
    const before = await snap(w);
    const replay = await w.s.sink.applyOnce(`veto:${ID}:${SHA}`, [veto(ID, SHA)], meta(at));
    expect(replay.ledger).toBe('satisfied');
    expect(await snap(w)).toEqual(before);
    const item = (await ledgerOf(w)).blacklist[0];
    expect(item?.lifted_gen).toBeDefined();
  });

  it('compacted_requires_replay_source:压缩后 ≤ W 的 replay 仅当权威源取回的事件逐字段相等才 compacted;否则 sealed_unknown_event', async () => {
    const r = terminalRecord();
    const w = await makeCWorld(kind, { records: [r] });
    await seedAudit(w, [RECENT]);
    await w.compactor.compact({ through: W });
    const before = await snap(w);
    const e1 = r.transitions[1] as never;
    const row = rowOfEntry(ID, e1);
    const src = { kind: 'entry', ref: `${ID}:${hex16(0xa2)}` };
    expect(await w.s.appender.appendKeyed([row], { kind: 'replay', source: src })).toEqual([
      'compacted',
    ]);
    expect(await snap(w)).toEqual(before);
    for (const bad of [
      { ...row, to: 'expired' },
      { ...row, at: '2026-10-02T09:00:00.000Z' },
      { ...row, idem_key: hex16(0xbeef) },
    ] as RsiAuditLine[]) {
      const e = await rejects(w.s.appender.appendKeyed([bad], { kind: 'replay', source: src }));
      expect(e.code).toBe('sealed_unknown_event');
    }
    expect(await snap(w)).toEqual(before);
  });
});
