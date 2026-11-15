/**
 * B1b:真 `ReconcileSource` 适配器(`reconcile-source.ts`):数据来源(权威记录)、日期过滤、与即时落地行逐字节一致、读失败 / 记录不合规 fail-closed、`resolve` 每次重读。
 * 记录是内存里的假记录(`RecordsPort`),适配器是真的。期望值由测试手写,不调用被测函数。
 */
import { describe, expect, it } from 'vitest';
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import { canonicalJson } from '../../../src/io/canonical-json.js';
import { creationAudit } from '../../../src/rsi/personal/candidate-record.js';
import { auditItemsOf } from '../../../src/rsi/personal/effects-recover.js';
import { idemKey } from '../../../src/rsi/personal/ids.js';
import { StoreError } from '../../../src/rsi/store/errors.js';
import { createReconcileSource } from '../../../src/rsi/store/reconcile-source.js';
import {
  T_CREATE_AT,
  T_TERM_AT,
  entry,
  fakeRecords,
  rec,
  rowOfEntry,
  terminalRecord,
} from './b1b-fixture.js';
import { FP, ID, ID2, SHA, hex16 } from './store-fixture.js';

const rejects = async (p: Promise<unknown>): Promise<StoreError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected rejection');
};

/** 回滚到终态、起因条目因截断丢失:E2 = 墓碑 + 90 天冷却 + 保护标记 `protection_unknown` */
const ROLLED_AT = '2026-10-03T08:00:00.000Z';
const markedRecord = (): PersonalLifecycleRecord =>
  rec('rolled_back', {
    id: ID2,
    terminal_reason: 'cleared',
    rollback: { phase: 'rollback_complete', reason: 'cleared', target_terminal: 'rolled_back' },
    transitions_dropped: 3,
    transitions: [
      {
        dim: 'lifecycle',
        from: 'rolling_back',
        to: 'rolled_back',
        at: ROLLED_AT,
        reason: 'cleared',
        idem_key: hex16(0xb1),
      },
    ],
  });
const markKey = idemKey({
  id: ID2,
  dim: 'lifecycle',
  from: 'rolling_back',
  to: 'rolled_back',
  evidence: `protection_unknown:${SHA}`,
});

describe('derivedThrough(R1–R4 条目行 + R7 保护标记行)', () => {
  it('终态记录:每个条目一行,形状 = 即时落地的行 + idem_key;按 idem_key 排序;日期 ≤ W 才出现(边界对照)', async () => {
    const src = createReconcileSource({ records: fakeRecords([terminalRecord()]) });
    const r = terminalRecord();
    const all = await src.derivedThrough('2026-10-31');
    expect(all.map((d) => d.row)).toEqual(r.transitions.map((e) => rowOfEntry(ID, e)));
    expect(all.map((d) => d.idem_key)).toEqual([hex16(0xa1), hex16(0xa2)]);
    expect(all.every((d) => d.row.idem_key === d.idem_key)).toBe(true);
    expect((await src.derivedThrough('2026-10-01')).map((d) => d.idem_key)).toEqual([hex16(0xa1)]);
    expect((await src.derivedThrough('2026-09-30')).length).toBe(0);
  });

  it('live_row_equals_derived_row:创建行 = creationAudit;回滚路径行 = auditItemsOf 的行(逐字节)', async () => {
    const r = terminalRecord();
    const src = createReconcileSource({ records: fakeRecords([r]) });
    const derived = await src.derivedThrough('2026-10-31');
    const byKey = new Map(derived.map((d) => [d.idem_key, d.row]));
    const created = creationAudit(r, T_CREATE_AT);
    expect(canonicalJson({ ...created, idem_key: hex16(0xa1) })).toBe(
      canonicalJson(byKey.get(hex16(0xa1))),
    );
    const items = auditItemsOf(r);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(canonicalJson({ ...it.line, idem_key: it.idem_key })).toBe(
        canonicalJson(byKey.get(it.idem_key)),
      );
    }
  });

  it('R7:终态记录的保护标记行(kind=reconcile,at = 终态条目时间,带自己的 idem_key);R5 / 无权威源的行不在内', async () => {
    const src = createReconcileSource({ records: fakeRecords([markedRecord()]) });
    const d = await src.derivedThrough('2026-10-31');
    const mark = d.find((x) => x.locator.kind === 'protection');
    expect(mark?.row).toEqual({
      at: ROLLED_AT,
      kind: 'reconcile',
      id: ID2,
      dim: 'lifecycle',
      from: 'rolling_back',
      to: 'rolled_back',
      reason: 'protection_unknown',
      counts: { cooldown_days: 90 },
      idem_key: markKey,
    });
    expect(d.filter((x) => x.row.kind === 'transition')).toHaveLength(1);
    expect(d).toHaveLength(2);
    // 截断丢失的条目(transitions_dropped=3)不在派生集合里:权威源只有留存的条目
    expect(d.some((x) => x.row.to === 'canary')).toBe(false);
  });
});

describe('entriesThrough', () => {
  it('留存条目 {id, idem_key, at},日期 ≤ W;越界对照', async () => {
    const src = createReconcileSource({ records: fakeRecords([terminalRecord()]) });
    expect(await src.entriesThrough('2026-10-02')).toEqual([
      { id: ID, idem_key: hex16(0xa1), at: T_CREATE_AT },
      { id: ID, idem_key: hex16(0xa2), at: T_TERM_AT },
    ]);
    expect((await src.entriesThrough('2026-10-01')).map((e) => e.idem_key)).toEqual([hex16(0xa1)]);
    expect(await src.entriesThrough('2026-09-30')).toEqual([]);
  });
});

describe('batchesThrough(E2 终态批次 / E1 即时否决)', () => {
  it('E2:键 terminal:<id>:<sha>,账类效果(黑名单 + 墓碑),event_at = 终态条目 at,fp_hmac = 记录的;只含事件日 ≤ W', async () => {
    const src = createReconcileSource({ records: fakeRecords([terminalRecord()]) });
    expect(await src.batchesThrough('2026-10-02')).toEqual([
      {
        key: `terminal:${ID}:${SHA}`,
        effects: [
          { type: 'blacklist_veto', id: ID, content_sha256: SHA },
          { type: 'write_tombstone', id: ID, terminal: 'rejected', reason: 'vetoed' },
        ],
        meta: { event_at: T_TERM_AT, fp_hmac: FP },
      },
    ]);
    expect(await src.batchesThrough('2026-10-01')).toEqual([]); // 越界批次不出现(否则 recoverThrough 整个拒绝)
  });

  it('E2 带冷却;保护标记(审计类)不在账批次里', async () => {
    const src = createReconcileSource({ records: fakeRecords([markedRecord()]) });
    const [b] = await src.batchesThrough('2026-10-31');
    expect(b?.key).toBe(`terminal:${ID2}:${SHA}`);
    expect(b?.effects).toEqual([
      { type: 'write_tombstone', id: ID2, terminal: 'rolled_back', reason: 'cleared' },
      { type: 'start_cooldown', cluster_id: 'cluster-1', kind: 'auto_rollback', days: 90 },
    ]);
    expect(b?.meta.event_at).toBe(ROLLED_AT);
  });

  it('E1:rolling_back 且原因 vetoed → veto:<id>:<sha>,event_at = 进入 rolling_back 的条目;其它原因 / 其它状态不出批次', async () => {
    const entering = {
      dim: 'lifecycle' as const,
      from: 'canary',
      to: 'rolling_back',
      at: '2026-10-05T08:00:00.000Z',
      reason: 'vetoed' as const,
      idem_key: hex16(0xc2),
    };
    const vetoed = rec('rolling_back', {
      transitions: [entry(1), entry(2, 'canary', '2026-10-03T00:00:00.000Z'), entering],
    });
    const harm = rec('rolling_back', {
      id: ID2,
      rollback: { phase: 'rollback_requested', reason: 'harm_c1', target_terminal: 'rolled_back' },
    });
    const shadow = rec('shadow', { id: 'ra_00000000cccc' });
    const src = createReconcileSource({ records: fakeRecords([vetoed, harm, shadow]) });
    expect(await src.batchesThrough('2026-10-05')).toEqual([
      {
        key: `veto:${ID}:${SHA}`,
        effects: [{ type: 'blacklist_veto', id: ID, content_sha256: SHA }],
        meta: { event_at: '2026-10-05T08:00:00.000Z', fp_hmac: FP },
      },
    ]);
    expect(await src.batchesThrough('2026-10-04')).toEqual([]);
  });
});

describe('resolve(权威事件取回:每次重读,不缓存)', () => {
  it('按 idem_key 取回条目行与保护标记行;未知键 / 未知 locator 种类 = null', async () => {
    const records = fakeRecords([terminalRecord(), markedRecord()]);
    const src = createReconcileSource({ records });
    const e = await src.resolve({ kind: 'entry', ref: `${ID}:${hex16(0xa2)}` }, hex16(0xa2));
    expect(e).toEqual({
      idem_key: hex16(0xa2),
      row: rowOfEntry(ID, terminalRecord().transitions[1] as never),
    });
    const m = await src.resolve({ kind: 'effects', ref: `terminal:${ID2}:${SHA}` }, markKey);
    expect(m?.row.reason).toBe('protection_unknown');
    expect(await src.resolve({ kind: 'entry', ref: 'x:y' }, hex16(0xdead))).toBeNull();
    expect(await src.resolve({ kind: 'bogus', ref: 'x' }, hex16(0xa2))).toBeNull();
    expect(await src.resolve({ kind: 'entry', ref: '' }, hex16(0xa2))).toBeNull();
  });

  it('resolve_rereads_records:每次调用都读一遍,记录变化立刻可见(没有旧快照)', async () => {
    const records = fakeRecords([terminalRecord()]);
    const src = createReconcileSource({ records });
    const loc = { kind: 'entry', ref: 'x' };
    expect(await src.resolve(loc, hex16(0xa1))).not.toBeNull();
    const reads = records.reads;
    records.list = [];
    expect(await src.resolve(loc, hex16(0xa1))).toBeNull();
    expect(records.reads).toBe(reads + 1);
  });
});

describe('读失败 / 记录不合规:一律抛,不得以空集通过', () => {
  const calls: [string, (s: ReturnType<typeof createReconcileSource>) => Promise<unknown>][] = [
    ['entriesThrough', (s) => s.entriesThrough('2026-10-31')],
    ['batchesThrough', (s) => s.batchesThrough('2026-10-31')],
    ['derivedThrough', (s) => s.derivedThrough('2026-10-31')],
    ['resolve', (s) => s.resolve({ kind: 'entry', ref: 'x' }, hex16(1))],
  ];
  it.each(calls)(
    '%s:读不到(kind != ok)= store_io;抛错 = store_io;记录 schema 不合规 = state_invalid',
    async (_n, f) => {
      const a = fakeRecords([terminalRecord()]);
      a.failKind = 'unreadable';
      const e1 = await rejects(f(createReconcileSource({ records: a })));
      expect([e1.code, e1.detail]).toEqual(['store_io', 'records_unreadable']);
      const b = fakeRecords([terminalRecord()]);
      b.throws = new Error('boom');
      expect((await rejects(f(createReconcileSource({ records: b })))).code).toBe('store_io');
      const bad = fakeRecords([{ ...terminalRecord(), schema_version: 2 } as never]);
      const e3 = await rejects(f(createReconcileSource({ records: bad })));
      expect([e3.code, e3.detail]).toEqual(['state_invalid', 'record_invalid']);
      // 正向对照
      await expect(
        f(createReconcileSource({ records: fakeRecords([terminalRecord()]) })),
      ).resolves.toBeDefined();
    },
  );
});
