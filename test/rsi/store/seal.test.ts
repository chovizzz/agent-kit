/**
 * B1a:`SealGuard` 区域注册表与 `stampFirst`(设计稿 v3 §C.2 / §C.5)。内存假件与真文件系统同跑。
 */
import { describe, expect, it } from 'vitest';
import { StoreError } from '../../../src/rsi/store/errors.js';
import { FILES, compactionDoc, faulty, makeWorld, seed, type FsKind } from './store-fixture.js';

const KINDS: readonly FsKind[] = ['mem', 'real'];
const rejects = async (p: Promise<unknown>): Promise<StoreError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected rejection');
};

describe.each(KINDS)('SealGuard(%s)', (kind) => {
  it('open 要求持有 personal 锁;丢锁 = lock_lost 且不登记区域', async () => {
    const w = await makeWorld(kind);
    w.personal.held = false;
    await expect(w.store.seal.open(w.personal)).rejects.toMatchObject({ kind: 'lock_lost' });
    expect(w.store.registry.hasOpenRegion()).toBe(false);
  });

  it('压缩状态不受支持:open 拒绝(compaction_unsupported),不登记区域', async () => {
    const w = await makeWorld(kind);
    await seed(w, FILES.compaction, 'bad');
    expect((await rejects(w.store.seal.open(w.personal))).code).toBe('compaction_unsupported');
    expect(w.store.registry.hasOpenRegion()).toBe(false);
  });

  it('stampFirst 在 open 已读好 W 之后才调用 now();取值时不再读 compaction 文件', async () => {
    let calls: string[] = [];
    const w = await makeWorld(kind, {
      wrap: (i) => {
        const f = faulty(i, []);
        calls = f.calls;
        return f;
      },
    });
    const r = await w.store.seal.open(w.personal);
    const readsBefore = calls.filter((c) => c === `read:${FILES.compaction}`).length;
    expect(readsBefore).toBe(1);
    let readsAtNow = -1;
    r.stampFirst(() => {
      readsAtNow = calls.filter((c) => c === `read:${FILES.compaction}`).length;
      return new Date('2026-11-15T08:00:00.000Z');
    });
    expect(readsAtNow).toBe(1);
    expect(calls.filter((c) => c === `read:${FILES.compaction}`)).toHaveLength(1);
  });

  it('create_boundary_W_vs_W_plus_1:W 当日拒绝(sealed_interval),W+1 日通过', async () => {
    const w = await makeWorld(kind);
    await seed(w, FILES.compaction, JSON.stringify(compactionDoc('2026-11-14')));
    const r1 = await w.store.seal.open(w.personal);
    expect(() => r1.stampFirst(() => new Date('2026-11-14T23:59:59.999Z'))).toThrowError(
      /sealed_interval/,
    );
    expect(r1.state).toBe('open');
    const r2 = await w.store.seal.open(w.personal);
    expect(r2.watermark).toBe('2026-11-14');
    expect(r2.stampFirst(() => new Date('2026-11-15T00:00:00.000Z'))).toBe(
      '2026-11-15T00:00:00.000Z',
    );
    expect(r2.state).toBe('stamped');
  });

  it('stale_now_captured_before_lock_refused:函数形式不是安全依据——预取旧值落在 ≤ W 照样被拒', async () => {
    const w = await makeWorld(kind);
    const captured = new Date('2026-11-10T08:00:00.000Z');
    await seed(w, FILES.compaction, JSON.stringify(compactionDoc('2026-11-14')));
    const r = await w.store.seal.open(w.personal);
    let err: unknown;
    try {
      r.stampFirst(() => captured);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'sealed_interval', reason: 'audit_invalid' });
  });

  it('stampFirst 每个区域只取一次时:再次调用返回同一时刻、不再调用 now;无效 now = clock_regressed', async () => {
    const w = await makeWorld(kind);
    const r = await w.store.seal.open(w.personal);
    let n = 0;
    const now = (): Date => {
      n++;
      return new Date('2026-11-15T08:00:00.000Z');
    };
    const a = r.stampFirst(now);
    const b = r.stampFirst(() => new Date('2026-11-15T09:00:00.000Z'));
    expect([a, b, n]).toEqual([a, a, 1]);
    const r2 = await w.store.seal.open(w.personal);
    expect(() => r2.stampFirst(() => new Date('nope'))).toThrowError(/clock_regressed/);
  });

  it('状态机:open → stamped → source_committed → closed;顺序错误 = region_closed;close 幂等', async () => {
    const w = await makeWorld(kind);
    const r = await w.store.seal.open(w.personal);
    expect(() => r.markSourceCommitted()).toThrowError(/region_closed/);
    r.stampFirst(() => new Date('2026-11-15T08:00:00.000Z'));
    r.markSourceCommitted();
    expect(r.state).toBe('source_committed');
    r.close();
    r.close();
    expect(r.state).toBe('closed');
    expect(() => r.stampFirst(() => new Date())).toThrowError(/region_closed/);
  });

  it('compact_refused_until_first_audit_attempt_ends:区域存续期间 assertNoOpenRegion = region_open;追加尝试结束(成功或失败)后放行', async () => {
    const w = await makeWorld(kind);
    expect(() => w.store.registry.assertNoOpenRegion()).not.toThrow();
    const r = await w.store.seal.open(w.personal);
    expect(() => w.store.registry.assertNoOpenRegion()).toThrowError(/region_open/);
    r.stampFirst(() => new Date('2026-11-15T08:00:00.000Z'));
    expect(w.store.registry.hasOpenRegion()).toBe(true);
    const row = {
      at: '2026-11-15T08:00:00.000Z',
      kind: 'transition' as const,
      id: 'ra_0123456789ab',
      idem_key: 'a'.repeat(16),
    };
    await w.store.appender.appendKeyed([row], { kind: 'first', region: r });
    expect(w.store.registry.hasOpenRegion()).toBe(false);
    // 失败路径同样结束区域
    const r2 = await w.store.seal.open(w.personal);
    r2.stampFirst(() => new Date('2026-11-15T08:00:00.000Z'));
    await rejects(
      w.store.appender.appendKeyed([{ ...row, at: '2026-11-15T09:00:00.000Z' }], {
        kind: 'first',
        region: r2,
      }),
    );
    expect(w.store.registry.hasOpenRegion()).toBe(false);
  });

  it('source_commit_crash_then_compact_then_replay_converges:区域随进程消失(新注册表无区域),源已提交审计未落由 replay 收敛', async () => {
    const w = await makeWorld(kind);
    const r = await w.store.seal.open(w.personal);
    r.stampFirst(() => new Date('2026-11-15T08:00:00.000Z'));
    r.markSourceCommitted(); // 随后进程崩溃:审计没落
    const w2 = await makeWorld(kind); // 「重启」:全新装配
    expect(w2.store.registry.hasOpenRegion()).toBe(false);
    const row = {
      at: '2026-11-15T08:00:00.000Z',
      kind: 'transition' as const,
      id: 'ra_0123456789ab',
      idem_key: 'b'.repeat(16),
    };
    expect(
      await w2.store.appender.appendKeyed([row], {
        kind: 'replay',
        source: { kind: 'k', ref: 'r' },
      }),
    ).toEqual(['appended']);
  });
});
