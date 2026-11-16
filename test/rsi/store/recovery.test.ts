/**
 * B1a:`LedgerRecoveryPort.recoverThrough` 的端口契约(设计稿 v3 §A.5「B1a 用例」;内存假件与真文件系统同跑)。
 * **只证端口,不计作压缩编排已通过**:`Compactor` 缺席,审计满的情形用真追加器 + 满的审计文件(假 appender 的等价物)。
 */
import { describe, expect, it, vi } from 'vitest';
import { RSI_EFFECTS_LIMITS } from '../../../src/contracts/rsi-store.js';
import { decodeLedger } from '../../../src/rsi/store/backend.js';
import { StoreError } from '../../../src/rsi/store/errors.js';
import type { RecoveryBatch } from '../../../src/rsi/store/ports.js';
import {
  AT1,
  FILES,
  FP,
  ID,
  ID2,
  SHA,
  SHA2,
  cool,
  faulty,
  expectSameBytes,
  fullAuditText,
  hex16,
  jsonLine,
  makeWorld,
  markEffect,
  meta,
  seed,
  tomb,
  trow,
  veto,
  type FsKind,
  type World,
} from './store-fixture.js';

// 20000 行审计文件的播种 / 分类在真文件系统上较慢
vi.setConfig({ testTimeout: 120_000 });

const KINDS: readonly FsKind[] = ['mem', 'real'];
const W = '2026-11-14';
const E1 = '2026-11-10T08:00:00.000Z';
const batch = (key: string, effects: RecoveryBatch['effects'], at = E1): RecoveryBatch => ({
  key,
  effects,
  meta: meta(at),
});
const ledgerOf = async (w: World) => {
  const b = await w.bytes(FILES.effects);
  if (b === null) throw new Error('no ledger');
  return decodeLedger(b);
};
const rejects = async (p: Promise<unknown>): Promise<StoreError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected rejection');
};
const fullAudit = (): string => fullAuditText();

describe.each(KINDS)('recoverThrough 契约(%s)', (kind) => {
  it('recover_through_rejects_event_after_W:任一批事件日 > W → 整个调用 out_of_range,零写入;事件日 == W 通过(边界对照)', async () => {
    const w = await makeWorld(kind);
    const e = await rejects(
      w.store.recovery.recoverThrough(W, [
        batch('ok', [tomb()], E1),
        batch('late', [tomb(ID2)], '2026-11-15T00:00:00.000Z'),
      ]),
    );
    expect([e.code, e.detail]).toEqual(['out_of_range', 'late']);
    expect(await w.bytes(FILES.effects)).toBeNull();
    const edge = await w.store.recovery.recoverThrough(W, [
      batch('edge', [tomb()], '2026-11-14T23:59:59.999Z'),
    ]);
    expect(edge).toEqual([{ batch_id: 'edge', state: 'ledger_committed' }]);
  });

  it('event_at 不是 ISO 时间戳 = effects_meta_missing(先于一切写)', async () => {
    const w = await makeWorld(kind);
    const bad = { key: 'k', effects: [tomb()], meta: { event_at: 'x' } } as RecoveryBatch;
    expect((await rejects(w.store.recovery.recoverThrough(W, [bad]))).code).toBe(
      'effects_meta_missing',
    );
    expect(await w.bytes(FILES.effects)).toBeNull();
  });

  it('recover_through_atomic_single_rename:多批一次 rename,gen 只 +1,结果与输入同序', async () => {
    let calls: string[] = [];
    const w = await makeWorld(kind, {
      wrap: (inner) => {
        const f = faulty(inner, []);
        calls = f.calls;
        return f;
      },
    });
    const res = await w.store.recovery.recoverThrough(W, [
      batch('b1', [tomb(ID)]),
      batch('b2', [tomb(ID2), cool()]),
      batch('b3', [veto(ID, SHA)]),
    ]);
    expect(res).toEqual([
      { batch_id: 'b1', state: 'ledger_committed' },
      { batch_id: 'b2', state: 'ledger_committed' },
      { batch_id: 'b3', state: 'ledger_committed' },
    ]);
    expect(calls.filter((c) => c === `commitTmp:${FILES.effects}`)).toHaveLength(1);
    expect(calls.filter((c) => c === `writeTmp:${FILES.effects}`)).toHaveLength(1);
    const l = await ledgerOf(w);
    expect(l.gen).toBe(1);
    expect(l.applied.map((a) => a.key).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(l.blacklist[0]?.vetoed_gen).toBe(1);
  });

  it('没有批次 / 全部已满足 = 零写入(不创建账文件、不 rename)', async () => {
    let calls: string[] = [];
    const w = await makeWorld(kind, {
      wrap: (inner) => {
        const f = faulty(inner, []);
        calls = f.calls;
        return f;
      },
    });
    expect(await w.store.recovery.recoverThrough(W, [])).toEqual([]);
    await w.store.sink.applyOnce('b1', [tomb()], meta(E1));
    const writes = calls.filter((c) => c.startsWith('writeTmp')).length;
    expect(await w.store.recovery.recoverThrough(W, [batch('b1', [tomb()])])).toEqual([
      { batch_id: 'b1', state: 'satisfied' },
    ]);
    expect(calls.filter((c) => c.startsWith('writeTmp'))).toHaveLength(writes);
  });

  it('recover_through_satisfied_preserved_on_failure:提交失败时只把需要提交的批标 not_committed,调用前已满足的保持 satisfied;账字节不变、无 tmp', async () => {
    const w = await makeWorld(kind, {
      wrap: (inner) =>
        faulty(inner, [{ op: 'writeTmp', name: FILES.effects, code: 'ENOSPC', skip: 1 }]),
    });
    await w.store.sink.applyOnce('b1', [tomb(ID)], meta(E1)); // 第一次 writeTmp 被放过
    const before = await w.bytes(FILES.effects);
    const res = await w.store.recovery.recoverThrough(W, [
      batch('b1', [tomb(ID)]),
      batch('b2', [tomb(ID2)]),
    ]);
    expect(res).toEqual([
      { batch_id: 'b1', state: 'satisfied' },
      { batch_id: 'b2', state: 'ledger_not_committed', cause: 'store_io' },
    ]);
    expect(await w.bytes(FILES.effects)).toEqual(before);
    expect(await w.tmpFiles()).toEqual([]);
  });

  it('compact_recovery_conflict_blocks:冲突批 = ledger_not_committed(effects_key_conflict),其余批照常提交;对照:无冲突全部提交', async () => {
    const w = await makeWorld(kind);
    await w.store.sink.applyOnce('b1', [veto()], meta(E1));
    const res = await w.store.recovery.recoverThrough(W, [
      { key: 'b1', effects: [veto()], meta: meta(E1, { fp_hmac: 'f'.repeat(16) }) }, // 同键异内容
      batch('b2', [tomb(ID2)]),
    ]);
    expect(res).toEqual([
      { batch_id: 'b1', state: 'ledger_not_committed', cause: 'effects_key_conflict' },
      { batch_id: 'b2', state: 'ledger_committed' },
    ]);
    const l = await ledgerOf(w);
    expect(l.tombstones.map((t) => t.id)).toEqual([ID2]);
    expect(l.blacklist).toHaveLength(1);
  });

  it('非账类效果的批 = ledger_not_committed(unsupported_effect),不拖累别的批', async () => {
    const w = await makeWorld(kind);
    const res = await w.store.recovery.recoverThrough(W, [
      batch('bad', [{ type: 'commit_lifecycle', id: ID }]),
      batch('good', [tomb()]),
    ]);
    expect(res).toEqual([
      { batch_id: 'bad', state: 'ledger_not_committed', cause: 'unsupported_effect' },
      { batch_id: 'good', state: 'ledger_committed' },
    ]);
  });

  it('账容量满:需要提交的批全部 ledger_not_committed(effects_full),账不变;已满足的批保持 satisfied', async () => {
    const w = await makeWorld(kind);
    const items = Array.from({ length: RSI_EFFECTS_LIMITS.blacklist }, (_, i) => ({
      candidate_id: `ra_${i.toString(16).padStart(12, '0')}`,
      content_sha256: SHA,
      fp_hmac: FP,
      near_fp: [],
      at: AT1,
      vetoed_gen: 1,
    }));
    await seed(
      w,
      FILES.effects,
      JSON.stringify({
        schema_version: 1,
        gen: 1,
        blacklist: items,
        tombstones: [],
        cooldowns: [],
        applied: [],
      }),
    );
    const before = await w.bytes(FILES.effects);
    const res = await w.store.recovery.recoverThrough(W, [
      batch('full', [veto(ID2, SHA2)]),
      batch('have', [veto('ra_000000000003', SHA)]),
    ]);
    expect(res).toEqual([
      { batch_id: 'full', state: 'ledger_not_committed', cause: 'effects_full' },
      { batch_id: 'have', state: 'satisfied' },
    ]);
    expect(await w.bytes(FILES.effects)).toEqual(before);
  });

  it('compact_recovery_no_audit_write:带保护标记的终态批只补账,审计文件字节不变、从不调用 append / rewrite', async () => {
    let calls: string[] = [];
    const w = await makeWorld(kind, {
      wrap: (inner) => {
        const f = faulty(inner, []);
        calls = f.calls;
        return f;
      },
    });
    await seed(w, FILES.audit, jsonLine(trow(hex16(1))));
    const before = await w.bytes(FILES.audit);
    const res = await w.store.recovery.recoverThrough(W, [
      batch('terminal:t', [tomb(), cool(), markEffect(hex16(8))]),
    ]);
    expect(res).toEqual([{ batch_id: 'terminal:t', state: 'ledger_committed' }]);
    expect(await w.bytes(FILES.audit)).toEqual(before);
    expect(calls.filter((c) => c.endsWith(FILES.audit) && !c.startsWith('read'))).toEqual([]);
  });

  it('recover_through_same_ledger_result_as_apply_once:同输入同账字节(账语义只有一份)', async () => {
    const eff = [veto(), tomb(), cool('cl-9', 'auto_rollback', 90), markEffect(hex16(3))];
    const a = await makeWorld(kind);
    const b = await makeWorld(kind);
    await a.store.sink.applyOnce('terminal:same', eff, meta(E1));
    await b.store.recovery.recoverThrough(W, [batch('terminal:same', eff, E1)]);
    const aBytes = await a.bytes(FILES.effects);
    expect(aBytes).not.toBeNull();
    expect(await b.bytes(FILES.effects)).toEqual(aBytes);
  });

  it('recover_through_audit_full_still_commits_ledger:审计满(20000 行)时账照样提交——不存在循环依赖', async () => {
    const w = await makeWorld(kind);
    await seed(w, FILES.audit, fullAudit());
    const auditBefore = await w.bytes(FILES.audit);
    const res = await w.store.recovery.recoverThrough(W, [
      batch('terminal:t', [tomb(), markEffect(hex16(8))]),
    ]);
    expect(res).toEqual([{ batch_id: 'terminal:t', state: 'ledger_committed' }]);
    expectSameBytes(await w.bytes(FILES.audit), auditBefore);
    // 对照:同一输入经 applyOnce 在审计满时账不提交(预检失败)
    const w2 = await makeWorld(kind);
    await seed(w2, FILES.audit, fullAudit());
    expect(
      await w2.store.sink.applyOnce('terminal:t', [tomb(), markEffect(hex16(8))], meta(E1)),
    ).toMatchObject({
      ledger: 'not_committed',
      cause: 'audit_full',
    });
  });

  it('账文件不合规 / 压缩不受支持:整个调用抛(无法判定,不降级为逐批结果)', async () => {
    const w = await makeWorld(kind);
    await seed(w, FILES.effects, '{bad');
    expect((await rejects(w.store.recovery.recoverThrough(W, [batch('k', [tomb()])]))).code).toBe(
      'state_invalid',
    );
    const w2 = await makeWorld(kind);
    await seed(w2, FILES.compaction, 'bad');
    expect((await rejects(w2.store.recovery.recoverThrough(W, [batch('k', [tomb()])]))).code).toBe(
      'compaction_unsupported',
    );
  });

  it('recover_dependent_satisfied_not_reported:依赖本次未提交修改的「满足」不得报成 satisfied;提交成功时同批一起 committed(对照)', async () => {
    const w = await makeWorld(kind, {
      wrap: (inner) => faulty(inner, [{ op: 'commitTmp', name: FILES.effects, code: 'EXDEV' }]),
    });
    const two = [batch('k1', [tomb(ID)]), batch('k2', [tomb(ID)])];
    expect(await w.store.recovery.recoverThrough(W, two)).toEqual([
      { batch_id: 'k1', state: 'ledger_not_committed', cause: 'store_io' },
      { batch_id: 'k2', state: 'ledger_not_committed', cause: 'store_io' },
    ]);
    expect(await w.bytes(FILES.effects)).toBeNull();
    // 对照:故障只注入一次,重试后两批都在这一次提交里
    expect(await w.store.recovery.recoverThrough(W, two)).toEqual([
      { batch_id: 'k1', state: 'ledger_committed' },
      { batch_id: 'k2', state: 'ledger_committed' },
    ]);
    // 真正调用前已满足的批,提交失败时保持 satisfied(见 recover_through_satisfied_preserved_on_failure)
  });

  it('提交时 rename 失败(commitTmp EXDEV):批标 not_committed(store_io),tmp 已清', async () => {
    const w = await makeWorld(kind, {
      wrap: (inner) => faulty(inner, [{ op: 'commitTmp', name: FILES.effects, code: 'EXDEV' }]),
    });
    const res = await w.store.recovery.recoverThrough(W, [batch('b', [tomb()])]);
    expect(res).toEqual([{ batch_id: 'b', state: 'ledger_not_committed', cause: 'store_io' }]);
    expect(await w.bytes(FILES.effects)).toBeNull();
    expect(await w.tmpFiles()).toEqual([]);
  });
});
