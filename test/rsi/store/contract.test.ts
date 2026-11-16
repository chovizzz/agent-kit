/**
 * B1a:契约与 schema(§21.24 W0-26;`src/contracts/rsi-store.ts`)——schema 的负向用例、码表、冷却谓词、文档落地。
 */
import { describe, expect, it } from 'vitest';
import { RSI_FAIL_CLOSED_REASONS, RSI_AUTO_PHASE } from '../../../src/contracts/rsi.js';
import { RsiAuditLineSchema } from '../../../src/contracts/rsi-personal.js';
import {
  RSI_STORE_CAUSES,
  RsiAuditCompactionSchema,
  RsiEffectsLedgerSchema,
  failClosedReasonOf,
} from '../../../src/contracts/rsi-store.js';
import { readText } from '../../../src/io/read-fs.js';
import { AT1, FP, ID, SHA } from './store-fixture.js';

const base = {
  schema_version: 1,
  gen: 3,
  blacklist: [],
  tombstones: [],
  cooldowns: [],
  applied: [],
};
const item = {
  candidate_id: ID,
  content_sha256: SHA,
  fp_hmac: FP,
  near_fp: [],
  at: AT1,
  vetoed_gen: 1,
};
const msgs = (v: unknown): string[] => {
  const r = RsiEffectsLedgerSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('RsiEffectsLedger schema', () => {
  it('合法账通过;strictObject 拒绝多余键 / 缺键 / schema_version≠1', () => {
    expect(RsiEffectsLedgerSchema.safeParse(base).success).toBe(true);
    expect(RsiEffectsLedgerSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(RsiEffectsLedgerSchema.safeParse({ ...base, schema_version: 2 }).success).toBe(false);
    const { applied: _a, ...less } = base;
    void _a;
    expect(RsiEffectsLedgerSchema.safeParse(less).success).toBe(false);
  });

  it('lifted_at 与 lifted_gen 同在同缺;lifted_gen 必须 > vetoed_gen 且 ≤ gen;vetoed_gen ≤ gen', () => {
    const ok = { ...item, vetoed_gen: 1, lifted_at: AT1, lifted_gen: 2 };
    expect(RsiEffectsLedgerSchema.safeParse({ ...base, blacklist: [ok] }).success).toBe(true);
    expect(msgs({ ...base, blacklist: [{ ...item, lifted_at: AT1 }] })).toContain('lifted_pair');
    expect(msgs({ ...base, blacklist: [{ ...item, lifted_gen: 2 }] })).toContain('lifted_pair');
    expect(msgs({ ...base, blacklist: [{ ...ok, lifted_gen: 1 }] })).toContain('gen_relation');
    expect(msgs({ ...base, gen: 1, blacklist: [ok] })).toContain('gen_relation');
    expect(msgs({ ...base, gen: 0, blacklist: [item] })).toContain('gen_relation');
  });

  it('重复:黑名单 (id,sha)、墓碑 id、冷却 (cluster,kind)、applied key 各自重复 = duplicate;对照:不同键不算', () => {
    const t = { id: ID, terminal: 'rejected', reason: 'vetoed', at: AT1 };
    const c = { cluster_id: 'c', kind: 'expired', days: 30, at: AT1 };
    const a = { key: 'k', event_at: AT1, batch_sha256: SHA };
    for (const v of [
      { blacklist: [item, item] },
      { tombstones: [t, t] },
      { cooldowns: [c, c] },
      { applied: [a, a] },
    ]) {
      expect(msgs({ ...base, ...v })).toContain('duplicate');
    }
    expect(
      RsiEffectsLedgerSchema.safeParse({ ...base, cooldowns: [c, { ...c, kind: 'auto_rollback' }] })
        .success,
    ).toBe(true);
  });

  it('gen 上限 Number.MAX_SAFE_INTEGER(超过 = 不合规);容量上限由 schema 钉住', () => {
    expect(
      RsiEffectsLedgerSchema.safeParse({ ...base, gen: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(true);
    expect(
      RsiEffectsLedgerSchema.safeParse({ ...base, gen: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
    const many = Array.from({ length: 1001 }, (_, i) => ({
      ...item,
      candidate_id: `ra_${i.toString(16).padStart(12, '0')}`,
    }));
    expect(RsiEffectsLedgerSchema.safeParse({ ...base, blacklist: many }).success).toBe(false);
    expect(
      RsiEffectsLedgerSchema.safeParse({
        ...base,
        blacklist: [{ ...item, near_fp: Array(65).fill('abcdef01') }],
      }).success,
    ).toBe(false);
  });
});

describe('RsiAuditCompaction schema', () => {
  const month = {
    lines: 3,
    deleted: 2,
    derived_missing: 1,
    by_kind: { transition: 3 },
    transition_by_to: { shadow: 3 },
  };
  const doc = { schema_version: 1, gen: 1, through: '2026-10-31', months: { '2026-10': month } };
  const m = (v: unknown): string[] => {
    const r = RsiAuditCompactionSchema.safeParse(v);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };
  it('合法通过;through 可为 null;lines ≠ deleted + derived_missing / by_kind 和 ≠ lines = 不合规;月键格式;gen ≥ 1;非真实日期', () => {
    expect(m(doc)).toEqual([]);
    expect(m({ ...doc, through: null })).toEqual([]);
    expect(m({ ...doc, months: { '2026-10': { ...month, lines: 4 } } })).toContain('lines_sum');
    expect(
      m({ ...doc, months: { '2026-10': { ...month, by_kind: { transition: 2 } } } }),
    ).toContain('by_kind_sum');
    expect(
      m({ ...doc, months: { '2026-10': { ...month, transition_by_to: { shadow: 2 } } } }),
    ).toContain('transition_sum');
    expect(m({ ...doc, months: { '2026-1': month } }).length).toBeGreaterThan(0);
    expect(m({ ...doc, gen: 0 }).length).toBeGreaterThan(0);
    expect(m({ ...doc, through: '2026-02-30' }).length).toBeGreaterThan(0);
  });
});

describe('审计行 idem_key', () => {
  const row = { at: AT1, kind: 'transition', id: ID };
  it('可选:无键行(存量形状)仍合法;带键须为 16 位十六进制', () => {
    expect(RsiAuditLineSchema.safeParse(row).success).toBe(true);
    expect(RsiAuditLineSchema.safeParse({ ...row, idem_key: 'a'.repeat(16) }).success).toBe(true);
    expect(RsiAuditLineSchema.safeParse({ ...row, idem_key: 'a'.repeat(15) }).success).toBe(false);
    expect(RsiAuditLineSchema.safeParse({ ...row, idem_key: 'G'.repeat(16) }).success).toBe(false);
  });
});

describe('码表(§E 第 9 项)', () => {
  it('每个 cause 映射到的稳定码都在 RSI_FAIL_CLOSED_REASONS 里;effects_full / audit_full 已入枚举', () => {
    for (const [cause, reason] of Object.entries(RSI_STORE_CAUSES)) {
      expect((RSI_FAIL_CLOSED_REASONS as readonly string[]).includes(reason), cause).toBe(true);
    }
    expect(RSI_FAIL_CLOSED_REASONS).toContain('effects_full');
    expect(RSI_FAIL_CLOSED_REASONS).toContain('audit_full');
  });
  it('设计稿 §E 第 9 项列出的 cause 全部登记;关键映射钉死', () => {
    for (const c of [
      'sealed_interval',
      'sealed_unknown_event',
      'region_closed',
      'clock_regressed',
      'compaction_unsupported',
      'compaction_unreadable',
      'compaction_vanished',
      'region_open',
      'out_of_range',
      'effects_full',
      'audit_full',
      'gen_overflow',
      'compact_blocked',
      'observation_row_sealed',
    ]) {
      expect(Object.keys(RSI_STORE_CAUSES), c).toContain(c);
    }
    expect(failClosedReasonOf('effects_full')).toBe('effects_full');
    expect(failClosedReasonOf('audit_full')).toBe('audit_full');
    expect(failClosedReasonOf('gen_overflow')).toBe('state_invalid');
    expect(failClosedReasonOf('sealed_interval')).toBe('audit_invalid');
  });
});

describe('W0-26 文档落地与相位', () => {
  it('RSI_AUTO_PHASE 仍为 0(B1a 不提相位)', () => {
    expect(RSI_AUTO_PHASE).toBe(0);
  });
  it('§21.24 W0-26 正文存在,写明取代关系、无存量与三个文件、水位线保证', async () => {
    const md = await readText(new URL('../../../docs/contracts.md', import.meta.url).pathname);
    expect(md).toContain('#### W0-26 装配块 B 段存储核订正');
    for (const needle of [
      'effects.json',
      'audit-compaction.json',
      'idem_key',
      '取代关系',
      '无存量',
      '缺行只计入汇总',
      'effects_full',
      'audit_full',
      'user_veto',
      'gen_overflow',
      '账原子、审计最终一致',
    ]) {
      expect(md, needle).toContain(needle);
    }
    expect(md).toContain('冻结后订正 W0-26(2026-11-15,owner 选择框「批准单账」)');
  });
});
