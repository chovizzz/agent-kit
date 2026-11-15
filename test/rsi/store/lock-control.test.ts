/**
 * B1a 验收评审 H1:互斥与释放屏障绑定的是**真实 acquisition**(一对 `rsi + personal` 句柄的生命周期控制块),不是某个 `HeldStore` 实例。
 * 每条负向都带正向对照;断言钉具体原因(`code` + `detail`)。真实句柄(`acquireRsiLock` / `acquirePersonalLock`)与假锁各跑一遍。
 */
import { describe, expect, it, vi } from 'vitest';
import { exists } from '../../../src/io/read-fs.js';
import { acquireRsiLock } from '../../../src/rsi/lock.js';
import { acquirePersonalLock } from '../../../src/rsi/personal/personal-lock.js';
import { rsiDir } from '../../../src/rsi/rsi-dir.js';
import { StoreError } from '../../../src/rsi/store/errors.js';
import { safeStoreFs, type StoreFs } from '../../../src/rsi/store/fs-port.js';
import type { HeldStore } from '../../../src/rsi/store/ports.js';
import { SealRegistry } from '../../../src/rsi/store/seal.js';
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
    // 种类只在真实形状(带 path)下声明:无 path 的假件保持「都不声明」,角色互换等用例仍走 acquisition 绑定检查
    const rsi = new FakeLock('rsi', log, rsiPath, rsiPath === undefined ? undefined : 'rsi');
    const personal = new FakeLock(
      'personal',
      log,
      personalPath,
      personalPath === undefined ? undefined : 'personal',
    );
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

  it('registry_foreign_first_assembly_no_binding:首次装配传入别的 acquisition 的注册表 = registry_foreign,且两把句柄都没被占用(rsi 换搭档仍可装配、personal 释放不经屏障);对照:同样的句柄不传注册表可装配', async () => {
    const a = mk();
    const storeA = assemble(a);
    const x = mk();
    expect(
      await mismatch(() =>
        assembleRsiStore({ fs: x.fs, rsi: x.rsi, personal: x.personal, registry: storeA.registry }),
      ),
    ).toBe('registry_foreign');
    await x.personal.release(); // 没被挂屏障:立即释放
    expect(x.log).toEqual(['release:personal']);
    // 没留下绑定:rsi 句柄换一个搭档可以装配(失败的那次若已占用,这里会是 acquisition_conflict)
    const other = new FakeLock('personal2', x.log);
    expect(
      await mismatch(() => assembleRsiStore({ fs: x.fs, rsi: x.rsi, personal: other })),
    ).toBeUndefined();
    // 对照:全新句柄不传注册表 = 可装配(拒绝来自注册表,不是句柄形状)
    expect(await mismatch(() => assemble(mk()))).toBeUndefined();
  });

  it('句柄已挂了别的屏障 = 拒绝(同一句柄只接受同一个屏障;预检先于占用,不静默覆盖),原因钉在 release_gate_taken;对照:屏障槽空的假件可装配', async () => {
    const x = mk();
    const foreign = { beforeRelease: async (): Promise<void> => undefined };
    x.rsi.attachReleaseGate(foreign);
    expect(await mismatch(() => assemble(x))).toBe('release_gate_taken');
    expect(x.personal.canAttachReleaseGate({ beforeRelease: async () => undefined })).toBe(true); // 另一把没被动过
    expect(await mismatch(() => assemble(mk()))).toBeUndefined();
  });
});

describe('R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享', () => {
  const detailOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      if (e instanceof StoreError && e.code === 'lock_cap_mismatch') return e.detail;
      throw e;
    }
    return undefined;
  };
  const probe = { beforeRelease: async (): Promise<void> => undefined };

  it('real_rsi_lock_cannot_pose_as_personal:另一个项目的真实 rsi 锁当 personal 装配 = personal_kind(锁种类是正向验证,不是「不在当前 root 下」);对照:真实 personal 句柄可装配;拒绝后两把句柄都没被挂屏障', async () => {
    const pwA = await makePersonalWorld('lc-kind-a-');
    const pwB = await makePersonalWorld('lc-kind-b-');
    const rsiA = await acquireRsiLock(pwA.io);
    const rsiB = await acquireRsiLock(pwB.io); // 先取两把 rsi 锁,再取 personal(反向取锁有守卫)
    const persA = await acquirePersonalLock(pwA.h);
    try {
      const fsA = safeStoreFs(pwA.io, await rsiDir(pwA.io));
      expect(rsiB.path.startsWith(`${fsA.root as string}/`)).toBe(false); // 旧的「不在 root 下」检查确实拦不住它
      expect(detailOf(() => assembleRsiStore({ fs: fsA, rsi: rsiA, personal: rsiB }))).toBe(
        'personal_kind',
      );
      expect(rsiA.canAttachReleaseGate?.(probe)).toBe(true);
      expect(rsiB.canAttachReleaseGate?.(probe)).toBe(true);
      // 角色互换(personal 句柄当 rsi)同样拒绝
      expect(detailOf(() => assembleRsiStore({ fs: fsA, rsi: persA, personal: rsiA }))).toBe(
        'rsi_kind',
      );
      // 对照:真实 rsi + 真实 personal 可装配
      expect(
        detailOf(() => assembleRsiStore({ fs: fsA, rsi: rsiA, personal: persA })),
      ).toBeUndefined();
    } finally {
      await persA.release();
      await rsiB.release();
      await rsiA.release();
    }
  });

  it('kind_must_match_role:带 path / root 的真实形状里锁种类缺失 = rsi_kind / personal_kind;声明了但与角色不符 = 同码;假件(无 path / root)声明了错的种类也拒绝', async () => {
    const ROOT = '/repo/.state/rsi';
    const PERSONAL = '/home/u/.local/state/agent-kit/rsi-personal/lock';
    const mkLocks = (rsiKind?: 'rsi' | 'personal', personalKind?: 'rsi' | 'personal') => {
      const log: string[] = [];
      return {
        fs: withRoot(new MemFs(), ROOT),
        rsi: new FakeLock('rsi', log, `${ROOT}/lock`, rsiKind),
        personal: new FakeLock('personal', log, PERSONAL, personalKind),
      };
    };
    const asm = (x: ReturnType<typeof mkLocks>) => () => assembleRsiStore(x);
    expect(detailOf(asm(mkLocks('rsi', 'personal')))).toBeUndefined(); // 对照
    expect(detailOf(asm(mkLocks('rsi', undefined)))).toBe('personal_kind'); // 真实形状必须自报
    expect(detailOf(asm(mkLocks(undefined, 'personal')))).toBe('rsi_kind');
    expect(detailOf(asm(mkLocks('rsi', 'rsi')))).toBe('personal_kind'); // 另一把 rsi 冒充
    expect(detailOf(asm(mkLocks('personal', 'personal')))).toBe('rsi_kind');
    // 假件:没声明 = 不查(对照);声明错了 = 拒绝
    const log: string[] = [];
    expect(
      detailOf(() =>
        assembleRsiStore({
          fs: new MemFs(),
          rsi: new FakeLock('r', log, undefined, 'personal'),
          personal: new FakeLock('p', log, undefined, 'personal'),
        }),
      ),
    ).toBe('rsi_kind');
  });

  it('gate_install_is_atomic:personal 句柄已被别的屏障占着 → 装配被拒(release_gate_taken)且 rsi 句柄没被动过;换一个新取的 personal 后能重新装配、事务与释放正常(对照:半绑定下重试会被 rsi 句柄拒绝)', async () => {
    const pw = await makePersonalWorld('lc-atomic-');
    const rsiH = await acquireRsiLock(pw.io);
    const persH = await acquirePersonalLock(pw.h);
    const fs = safeStoreFs(pw.io, await rsiDir(pw.io));
    let persH2: Awaited<ReturnType<typeof acquirePersonalLock>> | undefined;
    try {
      persH.attachReleaseGate?.({ beforeRelease: async () => undefined }); // 别的合法调用先占了 personal 的屏障槽
      expect(detailOf(() => assembleRsiStore({ fs, rsi: rsiH, personal: persH }))).toBe(
        'release_gate_taken',
      );
      expect(rsiH.canAttachReleaseGate?.(probe)).toBe(true); // 拒绝零副作用:rsi 句柄的屏障槽仍空
      await persH.release(); // 外来屏障放行,personal 锁释放
      persH2 = await acquirePersonalLock(pw.h);
      const store = assembleRsiStore({ fs, rsi: rsiH, personal: persH2 });
      expect(await store.held.transaction(async () => 'ok')).toBe('ok');
      await store.held.release();
      expect(await exists(rsiH.path)).toBe(false);
    } finally {
      await persH.release();
      await persH2?.release();
      await rsiH.release();
    }
  });

  it('registry_shared_per_acquisition:同一对句柄装配两次共用同一张区域注册表(A 开的区域 B 看得见);为同一 acquisition 配另一张表 = registry_conflict 且那张表不被绑定;别的 acquisition 互不影响', async () => {
    const w = await makeWorld('mem');
    const second = assembleOver(w);
    expect(second.registry).toBe(w.store.registry);
    const region = await w.store.seal.open(w.personal);
    const regionOpen = (): string | undefined => {
      try {
        second.registry.assertNoOpenRegion();
      } catch (e) {
        if (e instanceof StoreError) return e.code;
        throw e;
      }
      return undefined;
    };
    expect(regionOpen()).toBe('region_open');
    region.close();
    expect(regionOpen()).toBeUndefined(); // 对照:区域关闭后放行
    // 别的 acquisition 有自己的注册表:这边开区域不影响它
    const other = await makeWorld('mem');
    const r2 = await w.store.seal.open(w.personal);
    expect(() => other.store.registry.assertNoOpenRegion()).not.toThrow();
    r2.close();
    // 同一 acquisition 配另一张表 = 拒绝;被拒的表没有被绑定(还能给全新的 acquisition 用)
    const fresh = new SealRegistry();
    expect(
      detailOf(() =>
        assembleRsiStore({ fs: w.fs, rsi: w.rsi, personal: w.personal, registry: fresh }),
      ),
    ).toBe('registry_conflict');
    const log: string[] = [];
    expect(() =>
      assembleRsiStore({
        fs: new MemFs(),
        rsi: new FakeLock('r', log),
        personal: new FakeLock('p', log),
        registry: fresh,
      }),
    ).not.toThrow();
    // 对照:显式传入同一张 = 可装配
    expect(
      detailOf(() =>
        assembleRsiStore({
          fs: w.fs,
          rsi: w.rsi,
          personal: w.personal,
          registry: w.store.registry,
        }),
      ),
    ).toBeUndefined();
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
