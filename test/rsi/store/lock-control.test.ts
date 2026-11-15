/**
 * B1a 验收评审 H1:互斥与释放屏障绑定的是**真实 acquisition**(一对 `rsi + personal` 句柄的生命周期控制块),不是某个 `HeldStore` 实例。
 * 每条负向都带正向对照;断言钉具体原因(`code` + `detail`)。真实句柄(`acquireRsiLock` / `acquirePersonalLock`)与假锁各跑一遍。
 */
import { describe, expect, it, vi } from 'vitest';
import { exists } from '../../../src/io/read-fs.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { acquireRsiLock } from '../../../src/rsi/lock.js';
import { acquirePersonalLock } from '../../../src/rsi/personal/personal-lock.js';
import { rsiDir } from '../../../src/rsi/rsi-dir.js';
import { StoreError } from '../../../src/rsi/store/errors.js';
import { safeStoreFs, type StoreFs } from '../../../src/rsi/store/fs-port.js';
import type { HeldStore } from '../../../src/rsi/store/ports.js';
import { assembleRsiStore } from '../../../src/rsi/store/store.js';
import { makeWorld as makePersonalWorld } from '../personal/repo-helpers.js';
import {
  FILES,
  FakeLock,
  MemFs,
  makeWorld,
  meta,
  tomb,
  withRoot,
  type World,
} from './store-fixture.js';

vi.setConfig({ testTimeout: 60_000 });

const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
};
const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
const storeError = async (p: Promise<unknown>): Promise<StoreError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected rejection');
};
const assembleOver = (w: World) =>
  assembleRsiStore({
    fs: w.fs,
    rsi: w.rsi,
    personal: w.personal,
    clock: () => new Date(w.clock.iso),
  });

/** 两个事务各自占住同一个 gate,统计同时在跑的最大数 */
async function overlap(a: HeldStore, b: HeldStore): Promise<number> {
  let running = 0;
  let max = 0;
  const g = gate();
  const body = async (): Promise<void> => {
    running++;
    max = Math.max(max, running);
    await g.promise;
    running--;
  };
  const t1 = a.transaction(body);
  const t2 = b.transaction(body);
  await tick();
  g.open();
  await Promise.all([t1, t2]);
  return max;
}

describe('H1 同一 acquisition 重复装配共享控制块', () => {
  it('same_acquisition_two_helds_serialized:同一组句柄装配两个 HeldStore,并发事务仍串行;对照:两个不同 acquisition 可并行', async () => {
    const w = await makeWorld('mem');
    const second = assembleOver(w);
    expect(second.held).not.toBe(w.store.held);
    expect(await overlap(w.store.held, second.held)).toBe(1);
    // 对照:不同 acquisition 各有各的队列,可以重叠(证明上面的 1 不是测试写法造成的)
    const a = await makeWorld('mem');
    const b = await makeWorld('mem');
    expect(await overlap(a.store.held, b.store.held)).toBe(2);
  });

  it('shared_closing_and_release:一个 HeldStore release 后,同一 acquisition 的另一个 HeldStore 也 closing(txn_closing),release 共享同一 promise、底层各释放一次', async () => {
    const w = await makeWorld('mem');
    const second = assembleOver(w);
    expect(second.held.closing).toBe(false);
    const rel = w.store.held.release();
    expect(second.held.closing).toBe(true);
    const e = await storeError(second.held.transaction(async () => 1));
    expect(e.code).toBe('txn_closing');
    expect(second.held.release()).toBe(rel);
    await rel;
    expect(w.log).toEqual(['release:personal', 'release:rsi']);
  });
});

describe('H1 真实句柄的 release 也经释放屏障', () => {
  const pausedCommit =
    (g: { promise: Promise<void> }) =>
    (inner: StoreFs): StoreFs => ({
      read: (n, m) => inner.read(n, m),
      writeTmp: (n, t) => inner.writeTmp(n, t),
      commitTmp: async (n) => {
        await g.promise;
        return inner.commitTmp(n);
      },
      removeTmp: (n) => inner.removeTmp(n),
      appendSynced: (n, t) => inner.appendSynced(n, t),
    });

  it('raw_release_waits_for_paused_commit:提交暂停在 commitTmp 之前,外层调用原始 rsi.release() → 等事务提交完才真正释放;之后新事务 txn_closing', async () => {
    const g = gate();
    const w = await makeWorld('mem', { wrap: pausedCommit(g) });
    const apply = w.store.sink.applyOnce('k', [tomb()], meta());
    await tick();
    expect(w.fs).not.toBe(w.raw);
    const rel = w.rsi.release(); // 原始句柄释放(绕过 HeldStore.release)
    await tick();
    expect(w.rsi.held).toBe(true); // 事务还没提交:锁不能先放
    expect(w.log).toEqual([]);
    expect(await w.bytes(FILES.effects)).toBeNull();
    g.open();
    expect(await apply).toMatchObject({ ledger: 'committed' });
    await rel;
    expect(w.log).toEqual(['release:rsi']);
    expect((await w.bytes(FILES.effects))?.length).toBeGreaterThan(0); // 提交先于释放
    const e = await storeError(w.store.held.transaction(async () => 1));
    expect(e.code).toBe('txn_closing');
  });

  it('raw_release_inside_own_txn_rejected:事务回调内调用原始 release = release_inside_transaction(锁保持);对照:事务外同一调用正常释放', async () => {
    const w = await makeWorld('mem');
    let inner: StoreError | undefined;
    await w.store.held.transaction(async () => {
      inner = await storeError(w.rsi.release());
    });
    expect([inner?.code, inner?.detail]).toEqual(['release_inside_transaction', 'raw_release']);
    expect(w.rsi.held).toBe(true);
    expect(w.log).toEqual([]);
    await w.rsi.release(); // 事务外:正常
    expect(w.rsi.held).toBe(false);
    expect(w.log).toEqual(['release:rsi']);
  });

  it('real_handles_same_acquisition_serialized_and_raw_release_gated:真实句柄:重复装配串行;原始 release 等在途事务,锁文件在事务结束后才删', async () => {
    const pw = await makePersonalWorld('lc-real-');
    const root = await rsiDir(pw.io);
    const fs = safeStoreFs(pw.io, root);
    const rsiH = await acquireRsiLock(pw.io);
    const persH = await acquirePersonalLock(pw.h);
    try {
      const first = assembleRsiStore({ fs, rsi: rsiH, personal: persH });
      const second = assembleRsiStore({ fs, rsi: rsiH, personal: persH });
      expect(await overlap(first.held, second.held)).toBe(1);
      // 原始 release 经屏障
      const g = gate();
      const txn = first.held.transaction(async () => {
        await g.promise;
      });
      await tick();
      const rel = rsiH.release();
      await tick(40);
      expect(await exists(rsiH.path)).toBe(true); // 事务在途:锁文件还在
      g.open();
      await txn;
      await rel;
      expect(await exists(rsiH.path)).toBe(false);
      expect((await storeError(second.held.transaction(async () => 1))).code).toBe('txn_closing');
    } finally {
      await persH.release();
      await rsiH.release();
    }
  });
});

describe('H1 LockCap 的 root / 锁种类 / acquisition 校验', () => {
  const ROOT = '/repo/.state/rsi';
  const RSI_LOCK = `${ROOT}/lock`;
  const PERSONAL_LOCK = '/home/u/.local/state/agent-kit/rsi-personal/lock';
  const mk = (rsiPath?: string, personalPath?: string, root?: string) => {
    const log: string[] = [];
    const fs: StoreFs = root === undefined ? new MemFs() : withRoot(new MemFs(), root);
    const rsi = new FakeLock('rsi', log, rsiPath);
    const personal = new FakeLock('personal', log, personalPath);
    return { fs, rsi, personal, log };
  };
  const assemble = (x: ReturnType<typeof mk>) =>
    assembleRsiStore({ fs: x.fs, rsi: x.rsi, personal: x.personal });
  const mismatch = async (x: () => unknown): Promise<string | undefined> => {
    try {
      x();
    } catch (e) {
      if (e instanceof StoreError && e.code === 'lock_cap_mismatch') return e.detail;
      throw e;
    }
    return undefined;
  };

  it('identity_ok:路径与 root 对得上(rsi = <root>/lock,personal 在 root 之外)= 装配成功', async () => {
    const x = mk(RSI_LOCK, PERSONAL_LOCK, ROOT);
    expect(await mismatch(() => assemble(x))).toBeUndefined();
  });

  it('rsi 路径不是 <root>/lock(例如把槽位锁 digests/lock 当 rsi 锁)= rsi_root', async () => {
    expect(await mismatch(() => assemble(mk(`${ROOT}/digests/lock`, PERSONAL_LOCK, ROOT)))).toBe(
      'rsi_root',
    );
    expect(await mismatch(() => assemble(mk('/other/.state/rsi/lock', PERSONAL_LOCK, ROOT)))).toBe(
      'rsi_root',
    );
  });

  it('角色互换(personal 句柄当 rsi 锁)= rsi_root;personal 路径落在 root 之下 / 等于 rsi 路径 = personal_kind', async () => {
    expect(await mismatch(() => assemble(mk(PERSONAL_LOCK, RSI_LOCK, ROOT)))).toBe('rsi_root');
    expect(await mismatch(() => assemble(mk(RSI_LOCK, `${ROOT}/personal-lock`, ROOT)))).toBe(
      'personal_kind',
    );
    expect(await mismatch(() => assemble(mk(RSI_LOCK, RSI_LOCK, ROOT)))).toBe('personal_kind');
  });

  it('只给一半身份 = identity_half(锁带 path 而 fs 没有 root,或相反,或只有一把锁带 path);对照:都不给(测试假件)可装配', async () => {
    expect(await mismatch(() => assemble(mk(RSI_LOCK, PERSONAL_LOCK, undefined)))).toBe(
      'identity_half',
    );
    expect(await mismatch(() => assemble(mk(undefined, undefined, ROOT)))).toBe('identity_half');
    expect(await mismatch(() => assemble(mk(RSI_LOCK, undefined, ROOT)))).toBe('identity_half');
    expect(await mismatch(() => assemble(mk(undefined, undefined, undefined)))).toBeUndefined();
  });

  it('同一个句柄同时当 rsi 与 personal = same_cap', async () => {
    const x = mk();
    expect(await mismatch(() => assembleRsiStore({ fs: x.fs, rsi: x.rsi, personal: x.rsi }))).toBe(
      'same_cap',
    );
  });

  it('acquisition_conflict:句柄已绑给别的组合(换搭档 / 角色互换)= 拒绝且不给新句柄挂屏障;对照:原组合照常可用', async () => {
    const x = mk();
    const store = assemble(x);
    const other = new FakeLock('personal2', x.log);
    expect(await mismatch(() => assembleRsiStore({ fs: x.fs, rsi: x.rsi, personal: other }))).toBe(
      'acquisition_conflict',
    );
    expect(
      await mismatch(() => assembleRsiStore({ fs: x.fs, rsi: x.personal, personal: x.rsi })),
    ).toBe('acquisition_conflict');
    await other.release(); // 没被挂屏障:立即释放,不受原 acquisition 控制
    expect(x.log).toEqual(['release:personal2']);
    expect(await store.held.transaction(async () => 'still-works')).toBe('still-works');
    // 对照:同一组合重复装配 = 复用(不抛)
    expect(await mismatch(() => assemble(x))).toBeUndefined();
  });

  it('句柄已挂了别的屏障 = 拒绝(同一句柄只接受同一个屏障),不静默覆盖', async () => {
    const x = mk();
    x.rsi.attachReleaseGate({ beforeRelease: async () => undefined });
    let err: unknown;
    try {
      assemble(x);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RsiLockError);
    expect((err as RsiLockError).kind).toBe('internal');
  });
});

describe('H1 没有释放屏障的句柄(无 path / root 的最小形状):HeldStore.release 自己等在途事务', () => {
  it('release_waits_inflight_without_gate:只有 control.release 的等待可用时仍先等事务、再逆序释放;对照:事务结束后的 release 立即完成', async () => {
    const log: string[] = [];
    const plain = (name: string) => ({
      assertHeld: async (): Promise<void> => undefined,
      release: async (): Promise<void> => {
        log.push(`release:${name}`);
      },
    });
    const store = assembleRsiStore({
      fs: new MemFs(),
      rsi: plain('rsi'),
      personal: plain('personal'),
    });
    const g = gate();
    const txn = store.held.transaction(async () => {
      await g.promise;
      log.push('txn-done');
    });
    const rel = store.held.release();
    await tick();
    expect(log).toEqual([]); // 事务在途:不得先释放
    g.open();
    await txn;
    await rel;
    expect(log).toEqual(['txn-done', 'release:personal', 'release:rsi']);
    await store.held.release(); // 对照:已释放后幂等,不再重复
    expect(log).toHaveLength(3);
  });
});
