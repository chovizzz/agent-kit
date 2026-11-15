/**
 * B1b:压缩的纯规划(`compact-plan.ts`):目标选择、P1 账判据、区间计数与去重、汇总合并、P3 / P4 的纯结果。无 I/O,每条规则带正向对照。
 */
import { describe, expect, it } from 'vitest';
import type { RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import { RsiAuditMonthSchema } from '../../../src/contracts/rsi-store.js';
import {
  RSI_COMPACT_POLICY,
  checkBatch,
  countInterval,
  keepAfter,
  mergeMonths,
  pickTarget,
  pruneLedger,
} from '../../../src/rsi/store/compact-plan.js';
import { AuditKeyConflict, StoreError } from '../../../src/rsi/store/errors.js';
import type { DerivedRow, RecoveryBatch } from '../../../src/rsi/store/ports.js';
import { emptyLedger } from './b1b-fixture.js';
import { ID, SHA, cool, hex16, meta, tomb, trow, veto } from './store-fixture.js';

const TODAY = '2026-11-15';
const evalRow = (at: string): RsiAuditLine => ({ at, kind: 'evaluation', id: ID });
const many = (n: number, at: string): RsiAuditLine[] =>
  Array.from({ length: n }, () => evalRow(at));
const rejects = (f: () => unknown): StoreError => {
  try {
    f();
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected throw');
};

describe('pickTarget(目标选择)', () => {
  it('年龄触发:存在日 ≤ 今日 − 365 → 目标今日 − 365(边界当日触发,晚一天不触发)', () => {
    expect(RSI_COMPACT_POLICY.ageDays).toBe(365);
    expect(pickTarget([evalRow('2025-11-15T00:00:00.000Z')], null, TODAY)).toBe('2025-11-15');
    expect(pickTarget([evalRow('2025-11-10T00:00:00.000Z')], null, TODAY)).toBe('2025-11-15');
    expect(pickTarget([evalRow('2025-11-16T00:00:00.000Z')], null, TODAY)).toBeNull();
  });

  it('容量触发:恰好 18000 行不触发,18001 行推进到使剩余 ≤ 15000 的最小日', () => {
    const rows = [
      ...many(3001, '2026-10-01T00:00:00.000Z'),
      ...many(15000, '2026-11-01T00:00:00.000Z'),
    ];
    expect(rows.length).toBe(18001);
    expect(pickTarget(rows, null, TODAY)).toBe('2026-10-01');
    expect(pickTarget(rows.slice(1), null, TODAY)).toBeNull(); // 18000 行
  });

  it('目标须严格早于今日:行都落在今日 → 不推进', () => {
    expect(pickTarget(many(18001, '2026-11-15T00:00:00.000Z'), null, TODAY)).toBeNull();
  });

  it('目标须严格大于现有 W;≤ W 的行是待删残留,不参与选择', () => {
    const old = [evalRow('2025-11-10T00:00:00.000Z')];
    expect(pickTarget(old, '2025-12-01', TODAY)).toBeNull();
    expect(pickTarget(old, '2025-11-09', TODAY)).toBe('2025-11-15'); // 对照:行在 W 之后才触发
    expect(pickTarget(old, '2025-11-15', TODAY)).toBeNull(); // 目标 == W 不推进
    // ≤ W 的残留行不触发新目标(年龄触发只看 W 之后的行)
    expect(pickTarget([evalRow('2025-11-01T00:00:00.000Z')], '2025-11-09', TODAY)).toBeNull();
  });

  it('显式目标:≥ 今日 = out_of_range;≤ W = null;> W 原样返回', () => {
    expect(rejects(() => pickTarget([], null, TODAY, '2026-11-15')).code).toBe('out_of_range');
    expect(rejects(() => pickTarget([], null, TODAY, '2026-12-01')).code).toBe('out_of_range');
    expect(pickTarget([], '2026-10-10', TODAY, '2026-10-10')).toBeNull();
    expect(pickTarget([], '2026-10-10', TODAY, '2026-10-11')).toBe('2026-10-11');
    expect(pickTarget([], null, TODAY, '2026-11-14')).toBe('2026-11-14');
  });
});

describe('checkBatch(P1 账判据:按状态判,不按键判)', () => {
  const batch = (
    effects: RecoveryBatch['effects'],
    at = '2026-10-02T08:00:00.000Z',
  ): RecoveryBatch => ({
    key: 'terminal:x',
    effects,
    meta: meta(at),
  });
  const tombLedger = (terminal = 'rejected') => ({
    ...emptyLedger(1),
    tombstones: [{ id: ID, terminal, reason: 'vetoed', at: '2026-10-02T08:00:00.000Z' }],
  });

  it('同 id 墓碑已在 = 满足;不在 = 不满足(正向对照)', () => {
    expect(checkBatch(tombLedger() as never, batch([tomb()]), TODAY, null)).toEqual({ ok: true });
    expect(checkBatch(emptyLedger(), batch([tomb()]), TODAY, null)).toEqual({
      ok: false,
      cause: 'compact_blocked',
    });
  });

  it('黑名单:已 lifted 的项也算满足(历史 veto 已处理),不复活', () => {
    const l = {
      ...emptyLedger(3),
      blacklist: [
        {
          candidate_id: ID,
          content_sha256: SHA,
          fp_hmac: '0123456789abcdef',
          near_fp: [],
          at: '2026-10-02T08:00:00.000Z',
          vetoed_gen: 1,
          lifted_at: '2026-10-03T08:00:00.000Z',
          lifted_gen: 2,
        },
      ],
    };
    expect(checkBatch(l, batch([veto(ID, SHA)]), TODAY, null)).toEqual({ ok: true });
    expect(checkBatch(emptyLedger(), batch([veto(ID, SHA)]), TODAY, null).ok).toBe(false);
  });

  it('冷却:at + days ≤ 今日(已过期被裁)= 满足;仍生效而账里没有 = 不满足', () => {
    const expired = batch([cool('cl-1', 'expired', 30)], '2026-10-16T00:00:00.000Z'); // 10-16 + 30 = 11-15 == 今日
    expect(checkBatch(emptyLedger(), expired, TODAY, null)).toEqual({ ok: true });
    const active = batch([cool('cl-1', 'expired', 30)], '2026-10-17T00:00:00.000Z'); // + 30 = 11-16 > 今日
    expect(checkBatch(emptyLedger(), active, TODAY, null).ok).toBe(false);
  });

  it('同 id 异内容的墓碑 = 不满足并带 effects_key_conflict(不抛)', () => {
    expect(checkBatch(tombLedger('expired') as never, batch([tomb()]), TODAY, null)).toEqual({
      ok: false,
      cause: 'effects_key_conflict',
    });
  });
});

describe('countInterval(区间完备证明里的计数与去重)', () => {
  const idx = (rows: readonly RsiAuditLine[]): Map<string, RsiAuditLine> =>
    new Map(rows.flatMap((r) => (r.idem_key === undefined ? [] : [[r.idem_key, r] as const])));
  const drow = (row: RsiAuditLine): DerivedRow => ({
    idem_key: row.idem_key as string,
    row,
    locator: { kind: 'entry', ref: `${row.id}:${row.idem_key}` },
  });
  const run = (
    rows: RsiAuditLine[],
    derived: RsiAuditLine[],
    wOld: string | null,
    wNew: string,
    entries = derived.map((r) => ({ id: r.id, idem_key: r.idem_key as string, at: r.at })),
  ) => countInterval({ rows, byKey: idx(rows), derived: derived.map(drow), entries, wOld, wNew });
  const K1 = trow(hex16(1), '2026-10-05T00:00:00.000Z');
  const K2 = trow(hex16(2), '2026-10-06T00:00:00.000Z', { to: 'canary' });

  it('months_dedup_file_row_and_derived_same_key_counts_once:同键在文件与权威源里只计一次(deleted,以文件行为准)', () => {
    const c = run([K1], [K1], null, '2026-10-31');
    expect([c.deleted, c.derived_missing]).toEqual([1, 0]);
    expect(c.months['2026-10']?.by_kind).toEqual({ transition: 1 });
  });

  it('months_derived_missing_not_double_with_deleted:文件没有的派生事件计 derived_missing;已有的不会同时计入两者', () => {
    const c = run([K1], [K1, K2], null, '2026-10-31');
    expect([c.deleted, c.derived_missing]).toEqual([1, 1]);
    const m = c.months['2026-10'];
    expect(m).toMatchObject({ deleted: 1, derived_missing: 1 });
    expect(m?.transition_by_to).toEqual({ shadow: 1, canary: 1 });
  });

  it('months_interval_disjoint_across_runs:只数 (W_old, W_new];≤ W_old 的残留行与派生事件不再计数', () => {
    const early = trow(hex16(3), '2026-10-01T00:00:00.000Z');
    const c = run([early, K1], [early, K1, K2], '2026-10-03', '2026-10-31');
    expect([c.deleted, c.derived_missing]).toEqual([1, 1]); // early 不计;K1 deleted;K2 derived_missing
    // 区间 > W_new 的行不计
    const late = trow(hex16(4), '2026-11-01T00:00:00.000Z');
    expect(run([late], [], null, '2026-10-31').deleted).toBe(0);
    // 边界:W 当日(含当日最后一刻)计入
    const onW = trow(hex16(0x41), '2026-10-31T23:59:59.000Z');
    expect(run([onW], [], null, '2026-10-31').deleted).toBe(1);
  });

  it('无键行(R8)只属文件侧:区间内各计一行 deleted;文件里没有的永不计入(r5_r8_lost_never_counted)', () => {
    const obs1 = evalRow('2026-10-05T00:00:00.000Z');
    const obs2 = evalRow('2026-10-05T00:00:00.000Z'); // 内容相同也各算一行(无去重承诺)
    expect(run([obs1, obs2], [], null, '2026-10-31').deleted).toBe(2);
    expect(run([], [], null, '2026-10-31')).toMatchObject({ deleted: 0, derived_missing: 0 });
  });

  it('e_d_content_mismatch_refuses_advance:同键文件行与权威行内容不等(to 不同)= AuditKeyConflict', () => {
    const bad = { ...K1, to: 'canary' };
    expect(() => run([bad], [K1], null, '2026-10-31')).toThrow(AuditKeyConflict);
    const e = (() => {
      try {
        run([bad], [K1], null, '2026-10-31');
      } catch (x) {
        return x as StoreError;
      }
      return null;
    })();
    expect(e?.code).toBe('audit_key_conflict');
  });

  it('同键文件行与权威源在 W_old 两侧(文件 ≤ W_old,源 > W_old)= 拒绝,不会再计一次', () => {
    const fileSide = { ...K1, at: '2026-10-02T00:00:00.000Z' }; // ≤ W_old
    const srcSide = { ...K1, at: '2026-10-20T00:00:00.000Z' }; // > W_old
    expect(() => run([fileSide], [srcSide], '2026-10-10', '2026-10-31')).toThrow(AuditKeyConflict);
    // 对照:at 相同则通过且不计(残留行已计入)
    expect(run([fileSide], [fileSide], '2026-10-10', '2026-10-31')).toMatchObject({
      deleted: 0,
      derived_missing: 0,
    });
  });

  it('同键文件行与权威源在 W_new 两侧(文件 > W_new,源 ≤ W_new)= 拒绝', () => {
    const fileSide = { ...K1, at: '2026-11-05T00:00:00.000Z' };
    const srcSide = { ...K1, at: '2026-10-20T00:00:00.000Z' };
    expect(() => run([fileSide], [srcSide], null, '2026-10-31')).toThrow(AuditKeyConflict);
  });

  it('终态空操作行(R5)同键只比较除 at 外的字段:at 不同仍通过;其余字段不同仍拒绝', () => {
    const noop = (at: string, reason = 'noop:vetoed'): RsiAuditLine =>
      trow(hex16(5), at, { from: 'rejected', to: 'rejected', reason });
    expect(() =>
      run(
        [noop('2026-10-05T00:00:00.000Z')],
        [noop('2026-10-06T00:00:00.000Z')],
        null,
        '2026-10-31',
      ),
    ).not.toThrow();
    expect(() =>
      run(
        [noop('2026-10-05T00:00:00.000Z')],
        [noop('2026-10-05T00:00:00.000Z', 'noop:other')],
        null,
        '2026-10-31',
      ),
    ).toThrow(AuditKeyConflict);
  });

  it('权威侧跨信任边界:行不合规 / 键与行内键不一致 / 键重复 / 日期 > W_new / 条目没有派生行 = 抛,不静默', () => {
    const base = { rows: [], byKey: new Map(), entries: [], wOld: null, wNew: '2026-10-31' };
    const d = (over: Partial<DerivedRow>): DerivedRow => ({ ...drow(K1), ...over });
    expect(
      rejects(() => countInterval({ ...base, derived: [d({ idem_key: hex16(9) })] })).code,
    ).toBe('audit_bad_line');
    expect(
      rejects(() =>
        countInterval({ ...base, derived: [d({ row: { ...K1, kind: 'bogus' } as never })] }),
      ).code,
    ).toBe('audit_bad_line');
    expect(rejects(() => countInterval({ ...base, derived: [d({}), d({})] })).code).toBe(
      'audit_dup_key',
    );
    const late = trow(hex16(6), '2026-11-02T00:00:00.000Z');
    expect(rejects(() => countInterval({ ...base, derived: [drow(late)] })).code).toBe(
      'out_of_range',
    );
    expect(
      rejects(() =>
        countInterval({
          ...base,
          derived: [],
          entries: [{ id: ID, idem_key: hex16(7), at: '2026-10-05T00:00:00.000Z' }],
        }),
      ).code,
    ).toBe('compact_blocked');
    // 正向对照:合规输入不抛
    expect(() => countInterval({ ...base, derived: [drow(K1)] })).not.toThrow();
  });

  it('缺 to 的 transition 行落入固定桶 unknown,保证 transition_by_to 之和 = by_kind.transition(汇总过自己的 schema)', () => {
    const noTo = { ...trow(hex16(8), '2026-10-05T00:00:00.000Z') } as RsiAuditLine;
    delete (noTo as Partial<RsiAuditLine>).to;
    const c = run([noTo, K1], [], null, '2026-10-31');
    const m = c.months['2026-10'];
    expect(m?.transition_by_to).toEqual({ unknown: 1, shadow: 1 });
    const merged = mergeMonths({}, c.months)['2026-10'];
    expect(RsiAuditMonthSchema.safeParse(merged).success).toBe(true);
  });
});

describe('mergeMonths / keepAfter / pruneLedger', () => {
  it('mergeMonths:逐月累加,lines = deleted + derived_missing;不改入参', () => {
    const prev = {
      '2026-09': {
        lines: 2,
        deleted: 2,
        derived_missing: 0,
        by_kind: { transition: 2 },
        transition_by_to: { shadow: 2 },
      },
    };
    const before = JSON.stringify(prev);
    const out = mergeMonths(prev, {
      '2026-09': {
        deleted: 1,
        derived_missing: 2,
        by_kind: { transition: 3 },
        transition_by_to: { shadow: 3 },
      },
      '2026-10': {
        deleted: 0,
        derived_missing: 1,
        by_kind: { transition: 1 },
        transition_by_to: { canary: 1 },
      },
    });
    expect(out['2026-09']).toEqual({
      lines: 5,
      deleted: 3,
      derived_missing: 2,
      by_kind: { transition: 5 },
      transition_by_to: { shadow: 5 },
    });
    expect(out['2026-10']?.lines).toBe(1);
    expect(JSON.stringify(prev)).toBe(before);
  });

  it('keepAfter:日 == W 的行被删,W + 1 日的保留,保留原行字节;全删 = 空串(不留空行)', () => {
    const rows = [
      trow(hex16(1), '2026-10-31T23:59:59.000Z'),
      trow(hex16(2), '2026-11-01T00:00:00.000Z'),
    ];
    const lines = ['L1', 'L2'];
    expect(keepAfter(lines, rows, '2026-10-31')).toBe('L2\n');
    expect(keepAfter(lines, rows, '2026-11-01')).toBe('');
    expect(keepAfter(lines, rows, '2026-10-30')).toBe('L1\nL2\n');
  });

  it('pruneLedger:裁过期冷却(== 今日 也裁)与日 ≤ W 的键;没有可裁 = null', () => {
    const key = (k: string, at: string) => ({ key: k, event_at: at, batch_sha256: 'a'.repeat(64) });
    const l = {
      ...emptyLedger(5),
      cooldowns: [
        { cluster_id: 'c1', kind: 'expired' as const, days: 30, at: '2026-10-16T00:00:00.000Z' }, // == 今日:裁
        { cluster_id: 'c2', kind: 'expired' as const, days: 30, at: '2026-10-17T00:00:00.000Z' }, // 前一天:留
      ],
      applied: [key('k-new', '2026-11-10T00:00:00.000Z'), key('k-old', '2026-10-01T00:00:00.000Z')],
    };
    const out = pruneLedger(l, TODAY, '2026-10-31');
    expect(out?.cooldowns.map((c) => c.cluster_id)).toEqual(['c2']);
    expect(out?.applied.map((a) => a.key)).toEqual(['k-new']);
    expect(out?.gen).toBe(6);
    // 正向对照:没有东西可裁
    const clean = {
      ...l,
      cooldowns: [l.cooldowns[1] as (typeof l.cooldowns)[number]],
      applied: [l.applied[0] as (typeof l.applied)[number]],
    };
    expect(pruneLedger(clean, TODAY, '2026-10-31')).toBeNull();
  });

  it('pruneLedger 的 gen 到顶 = gen_overflow(不回绕)', () => {
    const l = {
      ...emptyLedger(Number.MAX_SAFE_INTEGER),
      applied: [{ key: 'k', event_at: '2026-10-01T00:00:00.000Z', batch_sha256: 'a'.repeat(64) }],
    };
    expect(rejects(() => pruneLedger(l, TODAY, '2026-10-31')).code).toBe('gen_overflow');
  });
});
