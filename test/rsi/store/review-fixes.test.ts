/**
 * B1a 验收评审(H2 / H3 / M1 / M2 / M3 / L1)的回归套件。内存假件与真文件系统同跑;每条负向带正向对照,断言钉具体原因(`code` + `detail`)。
 * H1(acquisition 生命周期控制块)见 `lock-control.test.ts`。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_EFFECTS_LEDGER,
  RSI_EFFECTS_LIMITS,
  type RsiEffectsLedger,
} from '../../../src/contracts/rsi-store.js';
import { canonicalJson } from '../../../src/io/canonical-json.js';
import { readText } from '../../../src/io/read-fs.js';
import { classifyAuditFile } from '../../../src/rsi/store/audit-classify.js';
import { decodeLedger } from '../../../src/rsi/store/backend.js';
import { StoreError } from '../../../src/rsi/store/errors.js';
import { planLedgerBatch } from '../../../src/rsi/store/ledger-plan.js';
import { assembleRsiStore } from '../../../src/rsi/store/store.js';
import {
  AT1,
  AT_OLD,
  FILES,
  FP,
  ID,
  ID2,
  SHA,
  SHA2,
  auditEffect,
  compactionDoc,
  cool,
  hex16,
  jsonLine,
  makeWorld,
  meta,
  rawAppendBytes,
  seed,
  seedBytes,
  tomb,
  trow,
  veto,
  type FsKind,
  type World,
} from './store-fixture.js';

vi.setConfig({ testTimeout: 120_000 });

const KINDS: readonly FsKind[] = ['mem', 'real'];
const TODAY = '2026-11-15';
const rejects = async (p: Promise<unknown>): Promise<StoreError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected rejection');
};
const ledgerOf = async (w: World): Promise<RsiEffectsLedger> => {
  const b = await w.bytes(FILES.effects);
  if (b === null) throw new Error('no ledger file');
  return decodeLedger(b);
};
const ledger = (over: Partial<RsiEffectsLedger> = {}): RsiEffectsLedger => ({
  ...structuredClone(EMPTY_EFFECTS_LEDGER),
  ...over,
});
const REPLAY = { kind: 'replay', source: { kind: 'test', ref: 'r' } } as const;

// ---------- H2:短写停在多字节字符中间 ----------
describe('H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部)', () => {
  const cjkRow = (idem: string) => trow(idem, AT1, { reason: '中文原因' });
  /** 返回 `line` 在第一个「中」的第 n 个字节处被截断的字节序列(n = 1 / 2:3 字节字符的中间) */
  const cutInsideChar = (line: string, n: number): Buffer => {
    const lead = Buffer.byteLength(line.slice(0, line.indexOf('中')), 'utf8');
    return Buffer.from(line, 'utf8').subarray(0, lead + n);
  };

  it('classifyAuditFile(text, tornTail):后端确认有尾部字节时,完整行之后即撕裂尾(goodText = 完整行);默认仍为 ok', () => {
    const good = jsonLine(trow(hex16(1)));
    expect(classifyAuditFile(good, true)).toMatchObject({ kind: 'torn_tail', goodText: good });
    expect(classifyAuditFile(good, false).kind).toBe('ok');
    expect(classifyAuditFile('', true)).toMatchObject({ kind: 'torn_tail', goodText: '' });
  });

  describe.each(KINDS)('(%s)', (kind) => {
    it.each([1, 2])(
      'short_write_mid_multibyte_char_recovers:尾部停在字符第 %i 个字节,读侧报撕裂尾(不整文件解码失败),下一次追加先修尾再写,旧行不丢',
      async (n) => {
        const w = await makeWorld(kind);
        const good = jsonLine(trow(hex16(1)));
        const torn = cutInsideChar(jsonLine(cjkRow(hex16(2))), n);
        await seedBytes(w, FILES.audit, Buffer.from(good, 'utf8'));
        await rawAppendBytes(w, FILES.audit, torn);
        // 尾部字节不是合法 UTF-8,但读侧只解码完整行
        expect(await w.backend.readAudit()).toEqual({ kind: 'ok', text: good, torn: true });
        expect(await w.store.appender.appendKeyed([cjkRow(hex16(2))], REPLAY)).toEqual([
          'appended',
        ]);
        expect((await w.bytes(FILES.audit))?.toString('utf8')).toBe(
          good + jsonLine(cjkRow(hex16(2))),
        );
        // 对照:同一行已完整落盘后重试 = already,不重复
        expect(await w.store.appender.appendKeyed([cjkRow(hex16(2))], REPLAY)).toEqual(['already']);
      },
    );

    it('对照:完整文件(含多字节字符、以换行结尾)不报撕裂尾;只有尾部字节(无任何完整行)也是撕裂尾,goodText 为空', async () => {
      const w = await makeWorld(kind);
      const full = jsonLine(cjkRow(hex16(1)));
      await seedBytes(w, FILES.audit, Buffer.from(full, 'utf8'));
      expect(await w.backend.readAudit()).toEqual({ kind: 'ok', text: full });
      await seedBytes(w, FILES.audit, cutInsideChar(full, 1));
      expect(await w.backend.readAudit()).toEqual({ kind: 'ok', text: '', torn: true });
      expect(await w.store.appender.appendKeyed([trow(hex16(3))], REPLAY)).toEqual(['appended']);
      expect((await w.bytes(FILES.audit))?.toString('utf8')).toBe(jsonLine(trow(hex16(3))));
    });

    it('complete_line_invalid_utf8_still_fail_closed:完整行里的非法 UTF-8 仍 fail-closed(audit_bad_line / utf8),即使末尾同时有撕裂尾;文件字节不动', async () => {
      const w = await makeWorld(kind);
      const bytes = Buffer.concat([
        Buffer.from(jsonLine(trow(hex16(1))), 'utf8'),
        Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), // 完整行(以 LF 结尾),内含 0xff
        Buffer.from('{"at":"2026', 'utf8'),
      ]);
      await seedBytes(w, FILES.audit, bytes);
      const e = await rejects(w.store.appender.appendKeyed([trow(hex16(2))], REPLAY));
      expect([e.code, e.detail]).toEqual(['audit_bad_line', 'utf8']);
      expect(await w.bytes(FILES.audit)).toEqual(bytes);
    });
  });
});

// ---------- H3:状态已满足但身份未登记 ----------
describe('H3 状态无变化的批登记身份', () => {
  const OPTS = { today: TODAY };

  it('planLedgerBatch:registerSatisfiedKey=true 时「状态已满足、键未登记」= commit 且键入 applied;缺省(恢复路径)= satisfied 零写', () => {
    const expired = [cool('c-old', 'expired', 30)];
    const reg = planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'K', expired, meta(AT_OLD), {
      ...OPTS,
      registerSatisfiedKey: true,
    });
    if (reg.kind !== 'commit') throw new Error(`expected commit, got ${reg.kind}`);
    expect(reg.next.gen).toBe(1);
    expect(reg.next.cooldowns).toEqual([]);
    expect(reg.next.applied.map((a) => a.key)).toEqual(['K']);
    expect(planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'K', expired, meta(AT_OLD), OPTS)).toEqual({
      kind: 'satisfied',
    });
    // 键已登记(同内容)时不再重复登记:registerSatisfiedKey 下也是 satisfied
    expect(
      planLedgerBatch(reg.next, 'K', expired, meta(AT_OLD), {
        ...OPTS,
        registerSatisfiedKey: true,
      }),
    ).toEqual({ kind: 'satisfied' });
  });

  describe.each(KINDS)('applyOnce(%s)', (kind) => {
    it('noop_then_conflicting_content:空操作(已过期冷却不插入)也登记键;同键异内容随后 = effects_key_conflict 且零写入;对照:同键同内容 = satisfied', async () => {
      const w = await makeWorld(kind);
      const expired = [cool('c-old', 'expired', 30)];
      expect(await w.store.sink.applyOnce('K', expired, meta(AT_OLD))).toEqual({
        ledger: 'committed',
        audit: 'not_applicable',
      });
      const l = await ledgerOf(w);
      expect([l.gen, l.cooldowns, l.applied.map((a) => a.key)]).toEqual([1, [], ['K']]);
      const before = await w.bytes(FILES.effects);
      const e = await rejects(w.store.sink.applyOnce('K', [tomb()], meta(AT_OLD)));
      expect([e.code, e.detail]).toEqual(['effects_key_conflict', 'key:K']);
      expect(await w.bytes(FILES.effects)).toEqual(before);
      expect(await w.store.sink.applyOnce('K', expired, meta(AT_OLD))).toEqual({
        ledger: 'satisfied',
        audit: 'not_applicable',
      });
      expect(await w.bytes(FILES.effects)).toEqual(before);
    });

    it('established_by_other_key_registers_identity:对象已由别的键建立,本批状态空操作 → 登记并提交;随后同键异内容 = 冲突', async () => {
      const w = await makeWorld(kind);
      await w.store.sink.applyOnce('A', [tomb()], meta());
      expect(await w.store.sink.applyOnce('B', [tomb()], meta())).toEqual({
        ledger: 'committed',
        audit: 'not_applicable',
      });
      expect((await ledgerOf(w)).applied.map((a) => a.key).sort()).toEqual(['A', 'B']);
      const e = await rejects(w.store.sink.applyOnce('B', [veto(ID2, SHA2)], meta()));
      expect([e.code, e.detail]).toEqual(['effects_key_conflict', 'key:B']);
      expect((await ledgerOf(w)).blacklist).toEqual([]); // 冲突批零写入
    });

    it('registration_under_watermark_not_committed:事件日 ≤ 水位线的空操作批不登记(键本就会被裁)= satisfied 零写;对照:无水位线时登记', async () => {
      const w = await makeWorld(kind);
      await seed(w, FILES.compaction, JSON.stringify(compactionDoc('2026-11-14')));
      expect(
        await w.store.sink.applyOnce('W', [cool('c-old', 'expired', 30)], meta(AT_OLD)),
      ).toEqual({ ledger: 'satisfied', audit: 'not_applicable' });
      expect(await w.bytes(FILES.effects)).toBeNull();
      const w2 = await makeWorld(kind);
      expect(
        await w2.store.sink.applyOnce('W', [cool('c-old', 'expired', 30)], meta(AT_OLD)),
      ).toMatchObject({ ledger: 'committed' });
    });

    it('user_veto_noop_registers_key:否决项已由别的键建立时,用户否决登记 veto: 键并提交;再否决 = satisfied 零写', async () => {
      const w = await makeWorld(kind);
      await w.store.sink.applyOnce('terminal:x', [veto()], meta());
      expect(await w.store.userVeto.veto(ID, SHA, meta())).toEqual({
        ledger: 'committed',
        audit: 'not_applicable',
      });
      expect((await ledgerOf(w)).applied.map((a) => a.key).sort()).toEqual([
        'terminal:x',
        `veto:${ID}:${SHA}`,
      ]);
      const before = await w.bytes(FILES.effects);
      expect(await w.store.userVeto.veto(ID, SHA, meta())).toEqual({
        ledger: 'satisfied',
        audit: 'not_applicable',
      });
      expect(await w.bytes(FILES.effects)).toEqual(before);
    });

    it('recover_through_does_not_register:压缩前恢复只按状态判 satisfied、不登记身份(事件日 ≤ 即将推进的 W);账字节不变', async () => {
      const w = await makeWorld(kind);
      await w.store.sink.applyOnce('A', [tomb()], meta());
      const before = await w.bytes(FILES.effects);
      expect(
        await w.store.recovery.recoverThrough('2026-11-14', [
          { key: 'B', effects: [tomb()], meta: meta('2026-11-10T08:00:00.000Z') },
        ]),
      ).toEqual([{ batch_id: 'B', state: 'satisfied' }]);
      expect(await w.bytes(FILES.effects)).toEqual(before);
    });
  });
});

// ---------- M1:验证先于容量 ----------
describe.each(KINDS)('M1 审计内容校验先于容量结果(%s)', (kind) => {
  const fullBlacklistLedger = (): string =>
    JSON.stringify({
      schema_version: 1,
      gen: 1,
      blacklist: Array.from({ length: RSI_EFFECTS_LIMITS.blacklist }, (_, i) => ({
        candidate_id: `ra_${i.toString(16).padStart(12, '0')}`,
        content_sha256: SHA,
        fp_hmac: FP,
        near_fp: [],
        at: AT1,
        vetoed_gen: 1,
      })),
      tombstones: [],
      cooldowns: [],
      applied: [],
    });
  const K = hex16(5);
  const batch = (row = trow(K)) => [veto(ID2, SHA2), auditEffect(row)]; // 新永久对象(账满 → effects_full)+ 审计行

  it('capacity_masks_audit_conflict_fixed:账满时,与文件内同键异内容的审计行 = audit_key_conflict(不被 effects_full 掩盖);对照:无冲突时才返回 effects_full', async () => {
    const w = await makeWorld(kind);
    await seed(w, FILES.effects, fullBlacklistLedger());
    await seed(w, FILES.audit, jsonLine(trow(K)));
    const ledgerBefore = await w.bytes(FILES.effects);
    const e = await rejects(
      w.store.sink.applyOnce('terminal:full', batch(trow(K, '2026-11-15T09:00:00.000Z')), meta()),
    );
    expect([e.code, e.detail]).toEqual(['audit_key_conflict', K]);
    expect(await w.bytes(FILES.effects)).toEqual(ledgerBefore);
    expect(await w.store.sink.applyOnce('terminal:full', batch(), meta())).toEqual({
      ledger: 'not_committed',
      audit: 'not_applicable',
      cause: 'effects_full',
    });
  });

  it('账满时,审计文件有坏行 / 重复键也先报完整性错误(audit_bad_line / audit_dup_key);对照:干净文件 → effects_full', async () => {
    const w = await makeWorld(kind);
    await seed(w, FILES.effects, fullBlacklistLedger());
    await seed(w, FILES.audit, 'garbage\n');
    const e1 = await rejects(w.store.sink.applyOnce('terminal:full', batch(), meta()));
    expect([e1.code, e1.detail]).toEqual(['audit_bad_line', 'line:1:json']);
    await seed(w, FILES.audit, jsonLine(trow(K)) + jsonLine(trow(K)));
    const e2 = await rejects(w.store.sink.applyOnce('terminal:full', batch(), meta()));
    expect(e2.code).toBe('audit_dup_key');
    await seed(w, FILES.audit, jsonLine(trow(K)));
    expect(await w.store.sink.applyOnce('terminal:full', batch(), meta())).toMatchObject({
      ledger: 'not_committed',
      cause: 'effects_full',
    });
  });
});

// ---------- M2:区域归属与 stamp 绑定 ----------
describe.each(KINDS)('M2 SealRegion 绑定 acquisition 与 stamp(%s)', (kind) => {
  const stamped = async (w: World, at = AT1) => {
    const r = await w.store.seal.open(w.personal);
    r.stampFirst(() => new Date(at));
    return r;
  };

  it('first_rows_must_use_stamp_time:行 at 与区域 stamp 不一致 = stamp_mismatch,零写入、区域仍被关闭;对照:一致则 appended', async () => {
    const w = await makeWorld(kind);
    const region = await stamped(w, AT1);
    const e = await rejects(
      w.store.appender.appendKeyed([trow(hex16(1), '2026-11-15T09:00:00.000Z')], {
        kind: 'first',
        region,
      }),
    );
    expect(e.code).toBe('stamp_mismatch');
    expect(await w.bytes(FILES.audit)).toBeNull();
    expect(region.state).toBe('closed');
    // 一批里只要有一行不一致就整批拒绝
    const r2 = await stamped(w, AT1);
    const e2 = await rejects(
      w.store.appender.appendKeyed([trow(hex16(1), AT1), trow(hex16(2), AT_OLD)], {
        kind: 'first',
        region: r2,
      }),
    );
    expect(e2.code).toBe('stamp_mismatch');
    expect(await w.bytes(FILES.audit)).toBeNull();
    const r3 = await stamped(w, AT1);
    expect(
      await w.store.appender.appendKeyed([trow(hex16(1), AT1), trow(hex16(2), AT1)], {
        kind: 'first',
        region: r3,
      }),
    ).toEqual(['appended', 'appended']);
  });

  it('foreign_store_region_rejected:别的存储域(另一 acquisition)创建的区域 = region_closed(foreign_region),该区域状态不被改动;对照:本域区域可用', async () => {
    const a = await makeWorld(kind);
    const b = await makeWorld(kind);
    const regionB = await stamped(b);
    const e = await rejects(
      a.store.appender.appendKeyed([trow(hex16(1))], { kind: 'first', region: regionB }),
    );
    expect([e.code, e.detail]).toEqual(['region_closed', 'foreign_region']);
    expect(regionB.state).toBe('stamped'); // 没被本域追加器推进或关闭
    expect(await a.bytes(FILES.audit)).toBeNull();
    expect(
      await b.store.appender.appendKeyed([trow(hex16(1))], { kind: 'first', region: regionB }),
    ).toEqual(['appended']);
  });

  it('registry_bound_to_acquisition:别的 acquisition 的注册表不能用于本域装配(lock_cap_mismatch / registry_foreign);对照:同一 acquisition 共享注册表可装配', async () => {
    const a = await makeWorld(kind);
    const b = await makeWorld(kind);
    let err: unknown;
    try {
      assembleRsiStore({
        fs: b.fs,
        rsi: b.rsi,
        personal: b.personal,
        registry: a.store.registry,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect([(err as StoreError).code, (err as StoreError).detail]).toEqual([
      'lock_cap_mismatch',
      'registry_foreign',
    ]);
    expect(() =>
      assembleRsiStore({
        fs: b.fs,
        rsi: b.rsi,
        personal: b.personal,
        registry: b.store.registry,
      }),
    ).not.toThrow();
  });
});

// ---------- M3:维护性提交 ----------
describe('M3 没有新状态的批也能裁过期冷却 / 水位线覆盖的 applied', () => {
  const OPTS = { today: TODAY };
  const expiredCool = { cluster_id: 'old', kind: 'expired', days: 30, at: AT_OLD } as const;
  const liveCool = {
    cluster_id: 'live',
    kind: 'expired',
    days: 30,
    at: '2026-11-10T00:00:00.000Z',
  } as const;
  const T = { id: ID, terminal: 'rejected', reason: 'vetoed', at: AT1 } as const;

  it('expired_cooldown_pruned_by_noop_batch:状态已满足的批提交时裁掉过期冷却(gen +1,其余字段不变);对照:冷却仍 active 时 = satisfied 零写', () => {
    const state = ledger({ gen: 3, tombstones: [T], cooldowns: [expiredCool] });
    const r = planLedgerBatch(state, 'k', [tomb()], meta(), OPTS);
    if (r.kind !== 'commit') throw new Error(`expected commit, got ${r.kind}`);
    expect(r.next).toEqual({ ...state, gen: 4, cooldowns: [] });
    const live = ledger({ gen: 3, tombstones: [T], cooldowns: [liveCool] });
    expect(planLedgerBatch(live, 'k', [tomb()], meta(), OPTS)).toEqual({ kind: 'satisfied' });
  });

  it('满账(2000 条过期冷却)上的空操作批也能腾出条数;对照:全部仍 active 则不动', () => {
    const many = (c: { at: string }): RsiEffectsLedger['cooldowns'] =>
      Array.from({ length: RSI_EFFECTS_LIMITS.cooldowns }, (_, i) => ({
        cluster_id: `c${i}`,
        kind: 'expired' as const,
        days: 30,
        at: c.at,
      }));
    const full = ledger({ gen: 1, tombstones: [T], cooldowns: many({ at: AT_OLD }) });
    const r = planLedgerBatch(full, 'k', [tomb()], meta(), OPTS);
    if (r.kind !== 'commit') throw new Error(`expected commit, got ${r.kind}`);
    expect(r.next.cooldowns).toHaveLength(0);
    const alive = ledger({
      gen: 1,
      tombstones: [T],
      cooldowns: many({ at: '2026-11-10T00:00:00.000Z' }),
    });
    expect(planLedgerBatch(alive, 'k', [tomb()], meta(), OPTS)).toEqual({ kind: 'satisfied' });
  });

  it('watermark_covered_applied_pruned_by_noop_batch:被水位线覆盖的 applied 键在空操作批里删除;对照:无水位线 = satisfied', () => {
    const state = ledger({
      gen: 2,
      tombstones: [T],
      applied: [
        { key: 'old', event_at: '2026-10-01T00:00:00.000Z', batch_sha256: SHA },
        { key: 'recent', event_at: '2026-11-10T00:00:00.000Z', batch_sha256: SHA },
      ],
    });
    const r = planLedgerBatch(state, 'k', [tomb()], meta(), { ...OPTS, watermark: '2026-10-31' });
    if (r.kind !== 'commit') throw new Error(`expected commit, got ${r.kind}`);
    expect(r.next.applied.map((a) => a.key)).toEqual(['recent']);
    expect(r.next.gen).toBe(3);
    expect(r.droppedKeys).toBe(1);
    expect(planLedgerBatch(state, 'k', [tomb()], meta(), OPTS)).toEqual({ kind: 'satisfied' });
  });

  describe.each(KINDS)('经 applyOnce / recoverThrough(%s)', (kind) => {
    const withExpiredCooldown = async (w: World): Promise<void> => {
      await w.store.sink.applyOnce('K', [tomb()], meta());
      const l = await ledgerOf(w);
      await seed(w, FILES.effects, canonicalJson({ ...l, cooldowns: [expiredCool] }));
    };

    it('applyOnce 同键重放(already)也做维护提交:过期冷却被裁、gen +1,结果仍报批次自己的结论 satisfied(与 recoverThrough 一致);随后再重放 = satisfied 零写', async () => {
      const w = await makeWorld(kind);
      await withExpiredCooldown(w);
      expect(await w.store.sink.applyOnce('K', [tomb()], meta())).toEqual({
        ledger: 'satisfied',
        audit: 'not_applicable',
      });
      const l = await ledgerOf(w);
      expect([l.gen, l.cooldowns]).toEqual([2, []]);
      const before = await w.bytes(FILES.effects);
      expect(await w.store.sink.applyOnce('K', [tomb()], meta())).toEqual({
        ledger: 'satisfied',
        audit: 'not_applicable',
      });
      expect(await w.bytes(FILES.effects)).toEqual(before);
    });

    it('recoverThrough 全部 satisfied 时也提交维护性变化(结果仍是 satisfied);对照:无过期冷却 = 账字节不变', async () => {
      const w = await makeWorld(kind);
      await w.store.sink.applyOnce('K', [tomb()], meta());
      const clean = await w.bytes(FILES.effects);
      const batches = [{ key: 'K', effects: [tomb()], meta: meta('2026-11-10T08:00:00.000Z') }];
      expect(await w.store.recovery.recoverThrough('2026-11-14', batches)).toEqual([
        { batch_id: 'K', state: 'satisfied' },
      ]);
      expect(await w.bytes(FILES.effects)).toEqual(clean);
      await seed(
        w,
        FILES.effects,
        canonicalJson({ ...(await ledgerOf(w)), cooldowns: [expiredCool] }),
      );
      expect(await w.store.recovery.recoverThrough('2026-11-14', batches)).toEqual([
        { batch_id: 'K', state: 'satisfied' },
      ]);
      const l = await ledgerOf(w);
      expect([l.gen, l.cooldowns]).toEqual([2, []]);
    });
  });
});

// ---------- 第 2 轮验收评审:recoverThrough 本次调用内的身份表 / userVeto 的 maintenanceOnly ----------
describe.each(KINDS)('R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(%s)', (kind) => {
  const EV = '2026-11-10T08:00:00.000Z';
  const W = '2026-11-14';
  const expiredCool = { cluster_id: 'old', kind: 'expired', days: 30, at: AT_OLD } as const;

  it('recover_same_call_key_conflict_after_satisfied:同一次恢复里第一批(键 K,状态已满足)之后同键异内容的第二批 = 该批 effects_key_conflict,账字节不变;对照:同键同内容 / 异键异内容都正常', async () => {
    const w = await makeWorld(kind);
    await w.store.sink.applyOnce('base', [tomb()], meta()); // ID 的墓碑已存在:K 的第一批状态已满足
    const before = await w.bytes(FILES.effects);
    const A = { key: 'K', effects: [tomb(ID)], meta: meta(EV) };
    const B = { key: 'K', effects: [tomb(ID2)], meta: meta(EV) };
    expect(await w.store.recovery.recoverThrough(W, [A, B])).toEqual([
      { batch_id: 'K', state: 'satisfied' },
      { batch_id: 'K', state: 'ledger_not_committed', cause: 'effects_key_conflict' },
    ]);
    expect(await w.bytes(FILES.effects)).toEqual(before); // 零写入:冲突的批没有悄悄建立 ID2 的墓碑
    // 对照 1:同键同内容两次 = 都 satisfied,仍零写
    expect(await w.store.recovery.recoverThrough(W, [A, { ...A }])).toEqual([
      { batch_id: 'K', state: 'satisfied' },
      { batch_id: 'K', state: 'satisfied' },
    ]);
    expect(await w.bytes(FILES.effects)).toEqual(before);
    // 对照 2:换一个键(同样的内容 B)= 正常提交,说明上面的拒绝来自同键冲突而不是 B 本身
    expect(await w.store.recovery.recoverThrough(W, [A, { ...B, key: 'K2' }])).toEqual([
      { batch_id: 'K', state: 'satisfied' },
      { batch_id: 'K2', state: 'ledger_committed' },
    ]);
  });

  it('recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常', async () => {
    const w = await makeWorld(kind);
    await w.store.sink.applyOnce('base', [tomb()], meta()); // ID 的墓碑已存在
    const before = await w.bytes(FILES.effects);
    const E = { key: 'K', effects: [], meta: meta(EV) };
    const A = { key: 'K', effects: [tomb(ID)], meta: meta(EV) }; // 状态已满足的非空批
    const B = { key: 'K', effects: [tomb(ID2)], meta: meta(EV) };
    expect(await w.store.recovery.recoverThrough(W, [E, B])).toEqual([
      { batch_id: 'K', state: 'satisfied' },
      { batch_id: 'K', state: 'ledger_not_committed', cause: 'effects_key_conflict' },
    ]);
    expect(await w.bytes(FILES.effects)).toEqual(before); // 零写入:ID2 的墓碑没有被悄悄建立
    expect(await w.store.recovery.recoverThrough(W, [A, E])).toEqual([
      { batch_id: 'K', state: 'satisfied' },
      { batch_id: 'K', state: 'ledger_not_committed', cause: 'effects_key_conflict' },
    ]);
    expect(await w.bytes(FILES.effects)).toEqual(before);
    // 对照 1:同键两个空批 = 都 satisfied,零写
    expect(await w.store.recovery.recoverThrough(W, [E, { ...E }])).toEqual([
      { batch_id: 'K', state: 'satisfied' },
      { batch_id: 'K', state: 'satisfied' },
    ]);
    expect(await w.bytes(FILES.effects)).toEqual(before);
    // 对照 2:空批之后换一个键的非空批 = 正常提交(拒绝来自同键,不是 B 本身)
    expect(await w.store.recovery.recoverThrough(W, [E, { ...B, key: 'K2' }])).toEqual([
      { batch_id: 'K', state: 'satisfied' },
      { batch_id: 'K2', state: 'ledger_committed' },
    ]);
  });

  it('user_veto_maintenance_only_reports_satisfied:否决自身已满足、只有维护性写入(过期冷却被裁)= ledger:satisfied 但账确实被写(satisfied ≠ 零写盘);对照:全新否决 = committed', async () => {
    const w = await makeWorld(kind);
    expect(await w.store.userVeto.veto(ID, SHA, meta())).toEqual({
      ledger: 'committed',
      audit: 'not_applicable',
    });
    const l = await ledgerOf(w);
    await seed(w, FILES.effects, canonicalJson({ ...l, cooldowns: [expiredCool] }));
    const before = await w.bytes(FILES.effects);
    expect(await w.store.userVeto.veto(ID, SHA, meta())).toEqual({
      ledger: 'satisfied',
      audit: 'not_applicable',
    });
    const after = await ledgerOf(w);
    expect([after.gen, after.cooldowns]).toEqual([l.gen + 1, []]); // 维护性提交确实落盘
    expect(await w.bytes(FILES.effects)).not.toEqual(before);
    const settled = await w.bytes(FILES.effects);
    expect((await w.store.userVeto.veto(ID, SHA, meta())).ledger).toBe('satisfied'); // 再来一次:零写
    expect(await w.bytes(FILES.effects)).toEqual(settled);
  });
});

// ---------- L1:契约文字 ----------
describe('L1 W0-26 第 14 条对 R20-5.1 锁矩阵的扩展已落到原表', () => {
  it('§21.18 第 41 条的写入方清单含 effects.json / audit-compaction.json;W0-26 第 14 条用条款名引用、不再用行号', async () => {
    const md = await readText(new URL('../../../docs/contracts.md', import.meta.url).pathname);
    const row = md.split('\n').find((l) => l.startsWith('| 41  | R20-5.1 锁矩阵'));
    expect(row).toBeDefined();
    expect(row).toContain('{candidates,canary.json,effects.json,audit-compaction.json}');
    expect(row).not.toContain('veto.json,tombstones.json}');
    expect(md).toContain('§21.18 第 41 条「R20-5.1 锁矩阵」');
    expect(md).not.toContain('R20-5.1 第 41 行');
  });
});
