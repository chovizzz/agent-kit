/**
 * B1a:`planLedgerBatch`(共享纯函数)与合并内部函数的语义——同键同内容 / 异内容、墓碑与批内冲突、元信息、冷却谓词与裁剪、`applied` 保留子集与容量。
 * 无 I/O;断言钉具体原因(错误码与 detail),每条负向都有正向对照。
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_EFFECTS_LEDGER,
  RSI_EFFECTS_LIMITS,
  RsiEffectsLedgerSchema,
  addUtcDays,
  cooldownActive,
  utcDay,
  type RsiEffectsLedger,
} from '../../../src/contracts/rsi-store.js';
import { canonicalJson } from '../../../src/io/canonical-json.js';
import { EffectsKeyConflict, StoreError } from '../../../src/rsi/store/errors.js';
import { planLedgerBatch } from '../../../src/rsi/store/ledger-plan.js';
import { AT1, AT_OLD, FP, ID, ID2, SHA, SHA2, cool, meta, tomb, veto } from './store-fixture.js';

const TODAY = '2026-11-15';
const OPTS = { today: TODAY };

const ledger = (over: Partial<RsiEffectsLedger> = {}): RsiEffectsLedger => ({
  ...structuredClone(EMPTY_EFFECTS_LEDGER),
  ...over,
});
const hex12 = (n: number): string => `ra_${n.toString(16).padStart(12, '0')}`;
const bytesOf = (l: RsiEffectsLedger): number => Buffer.byteLength(canonicalJson(l), 'utf8');

function commitOf(r: ReturnType<typeof planLedgerBatch>): RsiEffectsLedger {
  if (r.kind !== 'commit') throw new Error(`expected commit, got ${r.kind}`);
  return r.next;
}
function thrown(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected throw');
}

describe('planLedgerBatch:基本提交与幂等', () => {
  it('空账 + 终态批(黑名单 + 墓碑 + 冷却)→ commit,gen=1,各项字段取自效果与元信息', () => {
    const next = commitOf(
      planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'terminal:k1', [veto(), tomb(), cool()], meta(), OPTS),
    );
    expect(next.gen).toBe(1);
    expect(next.blacklist).toEqual([
      { candidate_id: ID, content_sha256: SHA, fp_hmac: FP, near_fp: [], at: AT1, vetoed_gen: 1 },
    ]);
    expect(next.tombstones).toEqual([{ id: ID, terminal: 'rejected', reason: 'vetoed', at: AT1 }]);
    expect(next.cooldowns).toEqual([
      { cluster_id: 'cl-1', kind: 'auto_rollback', days: 90, at: AT1 },
    ]);
    expect(next.applied.map((a) => a.key)).toEqual(['terminal:k1']);
    expect(RsiEffectsLedgerSchema.safeParse(next).success).toBe(true);
  });

  it('同键同内容 = satisfied(零写);事件时间不同不算内容不同', () => {
    const first = commitOf(
      planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [veto(), tomb()], meta(AT1), OPTS),
    );
    expect(planLedgerBatch(first, 'k', [veto(), tomb()], meta(AT1), OPTS)).toEqual({
      kind: 'satisfied',
    });
    expect(
      planLedgerBatch(first, 'k', [veto(), tomb()], meta('2026-11-15T09:00:00.000Z'), OPTS),
    ).toEqual({
      kind: 'satisfied',
    });
  });

  it('同键不同内容 = effects_key_conflict(零写),detail 钉在 key;对照:换键则正常提交', () => {
    const first = commitOf(planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [veto()], meta(), OPTS));
    const e = thrown(() =>
      planLedgerBatch(first, 'k', [veto()], meta(AT1, { fp_hmac: 'f'.repeat(16) }), OPTS),
    );
    expect(e).toBeInstanceOf(EffectsKeyConflict);
    expect([e.code, e.detail]).toEqual(['effects_key_conflict', 'key:k']);
    expect(e.reason).toBe('state_invalid');
    const other = planLedgerBatch(first, 'k2', [veto(ID2, SHA2)], meta(), OPTS);
    expect(other.kind).toBe('commit');
  });

  it('墓碑同 id 异 (terminal, reason) = 冲突;同内容 = 空操作保留最早 at', () => {
    const first = commitOf(
      planLedgerBatch(
        EMPTY_EFFECTS_LEDGER,
        'k1',
        [tomb(ID, 'rejected', 'vetoed')],
        meta(AT1),
        OPTS,
      ),
    );
    const e = thrown(() =>
      planLedgerBatch(
        first,
        'k2',
        [tomb(ID, 'expired', 'auto_expired')],
        meta('2026-11-15T09:00:00.000Z'),
        OPTS,
      ),
    );
    expect([e.code, e.detail]).toEqual(['effects_key_conflict', `tombstone:${ID}`]);
    // 对照:同内容换键 → 状态已满足,零写,账里仍是最早的 at
    expect(
      planLedgerBatch(
        first,
        'k3',
        [tomb(ID, 'rejected', 'vetoed')],
        meta('2026-11-15T10:00:00.000Z'),
        OPTS,
      ),
    ).toEqual({
      kind: 'satisfied',
    });
    expect(first.tombstones[0]?.at).toBe(AT1);
  });

  it('批内同 id 异内容的墓碑 = batch_tombstone 冲突;对照:同 id 同内容合并为一项', () => {
    const e = thrown(() =>
      planLedgerBatch(
        EMPTY_EFFECTS_LEDGER,
        'k',
        [tomb(ID, 'rejected', 'vetoed'), tomb(ID, 'expired', 'auto_expired')],
        meta(),
        OPTS,
      ),
    );
    expect([e.code, e.detail]).toEqual(['effects_key_conflict', `batch_tombstone:${ID}`]);
    const ok = commitOf(planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [tomb(), tomb()], meta(), OPTS));
    expect(ok.tombstones).toHaveLength(1);
  });
});

describe('planLedgerBatch:跨信任边界的校验', () => {
  it('账类效果缺 meta = effects_meta_missing(detail=meta);纯 tombstone 批缺 fp_hmac 照常(对照)', () => {
    expect(
      thrown(() => planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [tomb()], undefined, OPTS)),
    ).toMatchObject({
      code: 'effects_meta_missing',
      detail: 'meta',
    });
    const noFp = { event_at: AT1 };
    expect(planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [tomb()], noFp, OPTS).kind).toBe('commit');
    expect(
      thrown(() => planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [veto()], noFp, OPTS)),
    ).toMatchObject({
      code: 'effects_meta_missing',
      detail: 'fp_hmac',
    });
  });

  it('event_at 不是 ISO 时间戳 / fp_hmac 不是 16 位十六进制 / near_fp 项不是 8 位 = effects_meta_missing', () => {
    const d = (m: Parameters<typeof planLedgerBatch>[3]): string | undefined =>
      thrown(() => planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [veto()], m, OPTS)).detail;
    expect(d({ event_at: 'yesterday', fp_hmac: FP })).toBe('event_at');
    expect(d({ event_at: AT1, fp_hmac: 'xyz' })).toBe('fp_hmac');
    expect(d({ event_at: AT1, fp_hmac: FP, near_fp: ['abc'] })).toBe('near_fp');
    expect(
      planLedgerBatch(
        EMPTY_EFFECTS_LEDGER,
        'k',
        [veto()],
        { event_at: AT1, fp_hmac: FP, near_fp: ['abcdef01'] },
        OPTS,
      ).kind,
    ).toBe('commit');
  });

  it('非账类 / 未知 / 形状错误的效果 = unsupported_effect(不静默忽略);审计类效果被账规划忽略(对照)', () => {
    const d = (eff: unknown): string | undefined =>
      thrown(() => planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [eff as never], meta(), OPTS)).detail;
    expect(d({ type: 'commit_lifecycle', id: ID })).toBe('type:commit_lifecycle');
    expect(d({ type: 'nope' })).toBe('type:nope');
    expect(d({ type: 'blacklist_veto', id: 'bad', content_sha256: SHA })).toBe(
      'shape:blacklist_veto',
    );
    expect(d({ type: 'start_cooldown', cluster_id: 'c', kind: 'weird', days: 3 })).toBe(
      'shape:start_cooldown',
    );
    const audit = {
      type: 'append_audit',
      idem_key: 'a'.repeat(16),
      line: { at: AT1, kind: 'transition', id: ID },
    } as const;
    expect(planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [audit as never], meta(), OPTS)).toEqual({
      kind: 'satisfied',
    });
  });
});

describe('planLedgerBatch:gen 与 lift 语义', () => {
  it('replay 不复活已解除的否决(含键被裁后);对照:未解除时 replay 为空操作', () => {
    const lifted = ledger({
      gen: 5,
      blacklist: [
        {
          candidate_id: ID,
          content_sha256: SHA,
          fp_hmac: FP,
          near_fp: [],
          at: AT1,
          vetoed_gen: 2,
          lifted_at: AT1,
          lifted_gen: 4,
        },
      ],
    });
    expect(planLedgerBatch(lifted, 'fresh-key', [veto()], meta(), OPTS)).toEqual({
      kind: 'satisfied',
    });
    const plain = ledger({
      gen: 5,
      blacklist: [
        { candidate_id: ID, content_sha256: SHA, fp_hmac: FP, near_fp: [], at: AT1, vetoed_gen: 2 },
      ],
    });
    expect(planLedgerBatch(plain, 'fresh-key', [veto()], meta(), OPTS)).toEqual({
      kind: 'satisfied',
    });
  });

  it('gen 到 Number.MAX_SAFE_INTEGER 时拒写(gen_overflow,不回绕);对照:再小一档可写', () => {
    const top = ledger({ gen: Number.MAX_SAFE_INTEGER });
    const e = thrown(() => planLedgerBatch(top, 'k', [tomb()], meta(), OPTS));
    expect([e.code, e.reason]).toEqual(['gen_overflow', 'state_invalid']);
    const below = commitOf(
      planLedgerBatch(ledger({ gen: Number.MAX_SAFE_INTEGER - 1 }), 'k', [tomb()], meta(), OPTS),
    );
    expect(below.gen).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('冷却谓词与裁剪', () => {
  it('cooldown_equal_today_inactive_and_prunable:at+days == 今日 → 非 active;前一天仍 active', () => {
    expect(addUtcDays('2026-10-16', 30)).toBe('2026-11-15');
    expect(cooldownActive({ at: '2026-10-16T23:59:59.000Z', days: 30 }, TODAY)).toBe(false);
    expect(cooldownActive({ at: '2026-10-17T00:00:00.000Z', days: 30 }, TODAY)).toBe(true);
    // 带偏移的时间戳按 UTC 折算日期
    expect(utcDay('2026-10-17T01:00:00+08:00')).toBe('2026-10-16');
  });

  it('提交时裁已过期冷却;仍 active 的保留', () => {
    const state = ledger({
      gen: 1,
      cooldowns: [
        { cluster_id: 'expired-c', kind: 'expired', days: 30, at: '2026-10-16T00:00:00.000Z' },
        { cluster_id: 'live-c', kind: 'expired', days: 30, at: '2026-10-17T00:00:00.000Z' },
      ],
    });
    const next = commitOf(planLedgerBatch(state, 'k', [tomb()], meta(), OPTS));
    expect(next.cooldowns.map((c) => c.cluster_id)).toEqual(['live-c']);
  });

  it('cold_replay_cooldown_not_restarted:已过期的事件重放不插入新冷却(zero write);对照:仍 active 则插入', () => {
    expect(
      planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [cool('c', 'expired', 30)], meta(AT_OLD), OPTS),
    ).toEqual({
      kind: 'satisfied',
    });
    const live = commitOf(
      planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k', [cool('c', 'expired', 90)], meta(AT_OLD), OPTS),
    );
    expect(live.cooldowns[0]?.at).toBe(AT_OLD);
  });

  it('同 (cluster_id, kind) 取更晚的 at;更早的重放 = 空操作', () => {
    const base = commitOf(
      planLedgerBatch(EMPTY_EFFECTS_LEDGER, 'k1', [cool()], meta('2026-11-10T00:00:00.000Z'), OPTS),
    );
    const later = commitOf(
      planLedgerBatch(base, 'k2', [cool()], meta('2026-11-12T00:00:00.000Z'), OPTS),
    );
    expect(later.cooldowns).toHaveLength(1);
    expect(later.cooldowns[0]?.at).toBe('2026-11-12T00:00:00.000Z');
    expect(planLedgerBatch(later, 'k3', [cool()], meta('2026-11-11T00:00:00.000Z'), OPTS)).toEqual({
      kind: 'satisfied',
    });
  });
});

describe('容量:非键状态硬线与 applied 保留子集', () => {
  const blackN = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      candidate_id: hex12(i),
      content_sha256: SHA,
      fp_hmac: FP,
      near_fp: [] as string[],
      at: AT1,
      vetoed_gen: 1,
    }));

  it('non_key_state_over_limit_rejected:黑名单 1000 满再加新项 = not_committed(effects_full);同一项已在则 satisfied(对照)', () => {
    const full = ledger({ gen: 1, blacklist: blackN(RSI_EFFECTS_LIMITS.blacklist) });
    expect(planLedgerBatch(full, 'k', [veto(ID2, SHA2)], meta(), OPTS)).toEqual({
      kind: 'not_committed',
      cause: 'effects_full',
    });
    expect(planLedgerBatch(full, 'k', [veto(hex12(3), SHA)], meta(), OPTS)).toEqual({
      kind: 'satisfied',
    });
  });

  it('墓碑 5000 / 冷却 2000 满同样 effects_full', () => {
    const tombs = ledger({
      gen: 1,
      tombstones: Array.from({ length: RSI_EFFECTS_LIMITS.tombstones }, (_, i) => ({
        id: hex12(i),
        terminal: 'rejected' as const,
        reason: 'vetoed' as const,
        at: AT1,
      })),
    });
    expect(planLedgerBatch(tombs, 'k', [tomb(ID2)], meta(), OPTS)).toMatchObject({
      cause: 'effects_full',
    });
    const colds = ledger({
      gen: 1,
      cooldowns: Array.from({ length: RSI_EFFECTS_LIMITS.cooldowns }, (_, i) => ({
        cluster_id: `c-${i}`,
        kind: 'auto_rollback' as const,
        days: 90,
        at: AT1,
      })),
    });
    expect(planLedgerBatch(colds, 'k', [cool('new-cluster')], meta(), OPTS)).toMatchObject({
      cause: 'effects_full',
    });
  });

  const keyAt = (i: number, key = `k${String(i).padStart(5, '0')}`) => ({
    key,
    event_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    batch_sha256: SHA,
  });

  it('applied_count_full_drops_keys_not_rejects:20000 键满仍提交,新键在前,丢最旧的旧键', () => {
    const state = ledger({
      gen: 7,
      applied: Array.from({ length: RSI_EFFECTS_LIMITS.applied }, (_, i) => keyAt(i)),
    });
    const r = planLedgerBatch(state, 'terminal:new', [tomb()], meta(), OPTS);
    expect(r.kind).toBe('commit');
    if (r.kind !== 'commit') return;
    expect(r.next.applied).toHaveLength(RSI_EFFECTS_LIMITS.applied);
    expect(r.droppedKeys).toBe(1);
    expect(r.next.applied[0]?.key).toBe('terminal:new');
    expect(r.next.applied[1]?.key).toBe('k19999'); // 旧键按 event_at 降序
    expect(r.next.applied.some((a) => a.key === 'k00000')).toBe(false); // 最旧的被丢
    expect(r.next.tombstones).toHaveLength(1); // 效果本身照落
  });

  it('applied_retention_order_deterministic:同刻旧键按键字典序升序保留,丢最后一个', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const state = ledger({
      gen: 1,
      applied: Array.from({ length: RSI_EFFECTS_LIMITS.applied }, (_, i) => ({
        key: `s${String(i).padStart(5, '0')}`,
        event_at: at,
        batch_sha256: SHA,
      })),
    });
    const r = planLedgerBatch(state, 'terminal:new', [tomb()], meta(), OPTS);
    if (r.kind !== 'commit') throw new Error('expected commit');
    expect(r.next.applied.map((a) => a.key).slice(0, 3)).toEqual([
      'terminal:new',
      's00000',
      's00001',
    ]);
    expect(r.next.applied.some((a) => a.key === 's19999')).toBe(false);
  });

  it('字节超限丢键不拒写:旧键不会把合法效果变成 effects_full,新键与新效果都保留', () => {
    const nearFull = Array.from({ length: 1000 }, (_, i) => ({
      candidate_id: hex12(i),
      content_sha256: SHA,
      fp_hmac: FP,
      near_fp: Array.from({ length: 64 }, (_, j) => (i * 64 + j).toString(16).padStart(8, '0')),
      at: AT1,
      vetoed_gen: 1,
    }));
    const longKey = (i: number): string => `${String(i).padStart(6, '0')}${'x'.repeat(250)}`;
    const mk = (n: number): RsiEffectsLedger =>
      ledger({
        gen: 1,
        blacklist: nearFull,
        applied: Array.from({ length: n }, (_, i) => keyAt(i, longKey(i))),
      });
    // 线性外推出恰好贴着 8 MiB 的键数
    const b0 = bytesOf(mk(0));
    const per = (bytesOf(mk(1000)) - b0) / 1000;
    const n = Math.min(
      RSI_EFFECTS_LIMITS.applied,
      Math.floor((RSI_EFFECTS_LIMITS.bytes - b0 - 100) / per),
    );
    const state = mk(n);
    expect(bytesOf(state)).toBeLessThanOrEqual(RSI_EFFECTS_LIMITS.bytes);
    expect(bytesOf(state)).toBeGreaterThan(RSI_EFFECTS_LIMITS.bytes - 3000);
    // 新效果(4 条墓碑 + 新键)的字节数大于贴线余量,必须靠丢旧键腾空间
    const effects = [tomb(ID2), tomb(hex12(1)), tomb(hex12(2)), tomb(hex12(3))];
    const r = planLedgerBatch(state, 'terminal:bytes-new', effects, meta(), OPTS);
    expect(r.kind).toBe('commit');
    if (r.kind !== 'commit') return;
    expect(bytesOf(r.next)).toBeLessThanOrEqual(RSI_EFFECTS_LIMITS.bytes);
    expect(r.droppedKeys).toBeGreaterThanOrEqual(1);
    expect(r.next.applied[0]?.key).toBe('terminal:bytes-new');
    expect(r.next.tombstones).toHaveLength(4);
    expect(r.next.tombstones.map((t) => t.id)).toContain(ID2);
    expect(r.next.gen).toBe(2);
  });

  it('dropped_key_replay_still_idempotent:键被丢后同批重放 = 状态已满足,零写', () => {
    const state = ledger({
      gen: 3,
      tombstones: [{ id: ID, terminal: 'rejected', reason: 'vetoed', at: AT1 }],
      blacklist: [
        { candidate_id: ID, content_sha256: SHA, fp_hmac: FP, near_fp: [], at: AT1, vetoed_gen: 1 },
      ],
    });
    expect(planLedgerBatch(state, 'terminal:dropped', [veto(), tomb()], meta(), OPTS)).toEqual({
      kind: 'satisfied',
    });
  });

  it('水位线之下的 applied 键提交时被裁、新键事件日 ≤ W 不记;之后的保留', () => {
    const state = ledger({
      gen: 1,
      applied: [
        { key: 'old', event_at: '2026-10-01T00:00:00.000Z', batch_sha256: SHA },
        { key: 'recent', event_at: '2026-11-10T00:00:00.000Z', batch_sha256: SHA },
      ],
    });
    const r = planLedgerBatch(state, 'terminal:w', [tomb()], meta('2026-10-02T00:00:00.000Z'), {
      today: TODAY,
      watermark: '2026-10-31',
    });
    if (r.kind !== 'commit') throw new Error('expected commit');
    expect(r.next.applied.map((a) => a.key)).toEqual(['recent']);
  });
});
