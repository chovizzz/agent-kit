/**
 * 装配块 B2:`SealGuard` 在 `applyEvent` 挂点(`candidate-apply.ts`)的行为(设计稿 v3 §C.2 / §C.4 / §C.5 的命令侧用例;存储核的区域注册表用 B1a 的真实现)。
 * 断言钉具体结果:`halt` / `sealed_interval`、区域一定关闭、封存拒绝时**零写入**(仓库无提交、无审计、无效果);每条规则带正向对照(同一夹具放行)。
 */
import { describe, expect, it } from 'vitest';
import type { RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import { RSI_VETO_EVIDENCE } from '../../../src/rsi/auto/write/evidence.js';
import { applyEvent, type ApplyDeps } from '../../../src/rsi/personal/candidate-apply.js';
import type { EntrySeal } from '../../../src/rsi/personal/entry-stamp.js';
import type { TransitionEffect } from '../../../src/rsi/personal/transition.js';
import type { TransitionEvent } from '../../../src/rsi/personal/transition-table.js';
import { SealRegistry, createSealGuard } from '../../../src/rsi/store/seal.js';
import { ID, SHA, rec } from '../personal/transition-fixture.js';
import { MemStore } from '../personal/w3-fixture.js';

const V1B = 2;
const VETO: TransitionEvent = { kind: 'veto', evidence: RSI_VETO_EVIDENCE };
const CLEAR: TransitionEvent = { kind: 'clear', evidence: 'rsi auto clear' };

interface World {
  d: ApplyDeps;
  store: MemStore;
  registry: SealRegistry;
  audits: RsiAuditLine[];
  effects: TransitionEffect[];
  /** `seal.open` 被调用的次数 */
  opens: { n: number };
}

/** `through` = 水位线 W(UTC 日;null = 尚未压缩);`clock` = 注入的时钟 */
function world(through: string | null, clock: () => Date, r = rec('shadow')): World {
  const store = new MemStore();
  store.put(r);
  const registry = new SealRegistry();
  const guard = createSealGuard({ registry, readWatermark: async () => ({ through, gen: 1 }) });
  const opens = { n: 0 };
  const seal: EntrySeal = {
    open: async () => {
      opens.n += 1;
      return guard.open({ assertHeld: async () => undefined });
    },
  };
  const audits: RsiAuditLine[] = [];
  const effects: TransitionEffect[] = [];
  const d: ApplyDeps = {
    store,
    working: { list: async () => [], put: async () => undefined },
    revocations: { read: async () => ({ kind: 'ok', lines: [] }) },
    audit: {
      append: async (lines) => {
        audits.push(...lines);
      },
    },
    effects: {
      apply: async (e) => {
        effects.push(...e);
      },
    },
    env: {
      read: async () => ({
        phase: V1B,
        autoLoopEffective: false,
        autoPaused: false,
        marks: { enabled: false, paused: false, policyFp: '', resetGen: 0 },
      }),
    },
    now: clock,
    seal,
  };
  return { d, store, registry, audits, effects, opens };
}

const at = (iso: string) => (): Date => new Date(iso);

describe('SealGuard 挂点:applyEvent 的取时与封存校验', () => {
  it('正向对照:时刻在水位线之后 → 转移提交,条目 at = 注入时钟,区域已关闭', async () => {
    const w = world('2026-11-09', at('2026-11-10T12:00:00.000Z'));
    const r = await applyEvent(w.d, rec('shadow'), VETO);
    expect(r.kind).toBe('transitioned');
    expect(w.store.commits).toHaveLength(1);
    expect(w.opens.n).toBe(1);
    expect(w.registry.hasOpenRegion()).toBe(false);
    const saved = w.store.records.get(ID);
    expect(saved?.transitions.at(-1)?.at).toBe('2026-11-10T12:00:00.000Z');
  });

  it('transition_entry_under_watermark_refused_before_commit:时刻 ≤ W → halt sealed_interval,仓库零提交、零审计、零效果', async () => {
    const w = world('2026-11-10', at('2026-11-10T12:00:00.000Z'));
    const r = await applyEvent(w.d, rec('shadow'), VETO);
    expect(r).toEqual({ kind: 'halt', halt: 'sealed_interval', why: 'stamp' });
    expect(w.store.commits).toEqual([]);
    expect(w.audits).toEqual([]);
    expect(w.effects).toEqual([]);
    expect(w.registry.hasOpenRegion()).toBe(false);
    expect(w.store.records.get(ID)?.lifecycle).toBe('shadow');
  });

  it('create_boundary_W_vs_W_plus_1:W 当日拒、W+1 日过', async () => {
    const onW = world('2026-11-09', at('2026-11-09T23:59:59.999Z'));
    expect((await applyEvent(onW.d, rec('shadow'), VETO)).kind).toBe('halt');
    const next = world('2026-11-09', at('2026-11-10T00:00:00.000Z'));
    expect((await applyEvent(next.d, rec('shadow'), VETO)).kind).toBe('transitioned');
  });

  it('stale_now_captured_before_lock_refused:传入「锁外预取」的旧时刻(压缩推进后落在 ≤ W)也被拒,仓库不变', async () => {
    const captured = new Date('2026-11-08T08:00:00.000Z');
    const w = world('2026-11-09', () => captured);
    const r = await applyEvent(w.d, rec('shadow'), VETO);
    expect(r).toMatchObject({ kind: 'halt', halt: 'sealed_interval' });
    expect(w.store.commits).toEqual([]);
  });

  it('compaction_between_stamp_and_commit_refused:stamp 之后、源提交期间压缩被 region_open 拒绝;结束后可压缩', async () => {
    const w = world(null, at('2026-11-10T12:00:00.000Z'));
    let during: unknown = null;
    const commit = w.store.commit.bind(w.store);
    w.store.commit = async (spec) => {
      try {
        w.registry.assertNoOpenRegion();
      } catch (e) {
        during = e;
      }
      return commit(spec);
    };
    const r = await applyEvent(w.d, rec('shadow'), VETO);
    expect(r.kind).toBe('transitioned');
    expect(during).toMatchObject({ code: 'region_open' });
    expect(() => w.registry.assertNoOpenRegion()).not.toThrow();
  });

  it.each([
    [
      '提交后抛错(commit 拒绝)',
      (w: World) => (w.store.throwOnCommit = new Error('boom')),
      'throws',
    ],
    [
      '提交失败(commit_failed)',
      (w: World) => (w.store.failCommit = { status: 'cas_failed' } as never),
      'halt',
    ],
  ])('每个分支之后区域都已关闭:%s', async (_n, arm, shape) => {
    const w = world(null, at('2026-11-10T12:00:00.000Z'));
    arm(w);
    if (shape === 'throws') {
      await expect(applyEvent(w.d, rec('shadow'), VETO)).rejects.toThrow('boom');
    } else {
      expect((await applyEvent(w.d, rec('shadow'), VETO)).kind).toBe('halt');
    }
    expect(w.registry.hasOpenRegion()).toBe(false);
  });

  it('每个分支之后区域都已关闭:引擎拒绝 / 记录已变(stale)', async () => {
    const refused = world(null, at('2026-11-10T12:00:00.000Z'), rec('proposed'));
    // proposed 上的 rollback_advance 不合法 → refused
    const ev: TransitionEvent = {
      kind: 'rollback_advance',
      evidence: 'x',
      to: 'rollback_complete',
      current_completed: true,
    };
    expect((await applyEvent(refused.d, rec('proposed'), ev)).kind).toBe('refused');
    expect(refused.registry.hasOpenRegion()).toBe(false);
    const stale = world(null, at('2026-11-10T12:00:00.000Z'));
    expect((await applyEvent(stale.d, rec('proposed'), VETO)).kind).toBe('stale');
    expect(stale.registry.hasOpenRegion()).toBe(false);
  });

  it('记录读不出(repo_invalid)时不开区域(取时之前就返回,没有占用)', async () => {
    const w = world(null, at('2026-11-10T12:00:00.000Z'));
    w.store.mode = 'invalid';
    expect((await applyEvent(w.d, rec('shadow'), VETO)).kind).toBe('halt');
    expect(w.opens.n).toBe(0);
    expect(w.registry.hasOpenRegion()).toBe(false);
  });
});

describe('终态记录上的空操作 × 封存区间:保护写不被阻断', () => {
  const terminal = (): ReturnType<typeof rec> => rec('rejected');

  it('protective_veto_lands_under_sealed_clock(引擎层):终态 veto 在封存时钟下仍产出 E1,无审计行,结果 noop', async () => {
    const w = world('2026-11-10', at('2026-11-10T12:00:00.000Z'), terminal());
    const r = await applyEvent(w.d, terminal(), VETO);
    expect(r).toEqual({ kind: 'noop', observationRowSealed: true });
    expect(w.effects).toEqual([{ type: 'blacklist_veto', id: ID, content_sha256: SHA }]);
    expect(w.store.commits).toEqual([]);
    expect(w.registry.hasOpenRegion()).toBe(false);
  });

  it('noop_row_sealed_dropped_with_report:终态记录上的 clear 空操作:封存时丢弃无键审计行并报 observationRowSealed', async () => {
    const sealed = world('2026-11-10', at('2026-11-10T12:00:00.000Z'), terminal());
    const r = await applyEvent(sealed.d, terminal(), CLEAR);
    expect(r).toEqual({ kind: 'noop', observationRowSealed: true });
    expect(sealed.audits).toEqual([]);
    // 正向对照:同一夹具、水位线之前 → 空操作审计行照常落地
    const open = world('2026-11-09', at('2026-11-10T12:00:00.000Z'), terminal());
    expect(await applyEvent(open.d, terminal(), CLEAR)).toEqual({ kind: 'noop' });
    expect(open.audits).toHaveLength(1);
    expect(open.audits[0]).toMatchObject({
      id: ID,
      kind: 'transition',
      at: '2026-11-10T12:00:00.000Z',
    });
  });

  it('封存拒绝只对终态记录降级为 noop;非终态仍整体拒绝(不会因降级产生条目)', async () => {
    const w = world('2026-11-10', at('2026-11-10T12:00:00.000Z'), rec('canary'));
    const r = await applyEvent(w.d, rec('canary'), VETO);
    expect(r).toMatchObject({ kind: 'halt', halt: 'sealed_interval' });
    expect(w.store.commits).toEqual([]);
  });
});

describe('无封存端口(缩减入口 / 既有单测):行为不变', () => {
  it('不给 seal:直接用注入时钟,不查水位线', async () => {
    const w = world('2099-01-01', at('2026-11-10T12:00:00.000Z'));
    const { seal: _s, ...noSeal } = w.d;
    void _s;
    const r = await applyEvent(noSeal, rec('shadow'), VETO);
    expect(r.kind).toBe('transitioned');
    expect(w.opens.n).toBe(0);
  });
});
