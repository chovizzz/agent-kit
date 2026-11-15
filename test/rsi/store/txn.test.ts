/**
 * B1a:事务协调器(设计稿 v3 §D.1 / 第 2 版 §3):token 绑定的窄写端口、在途写追踪、`closing` / `release()` 语义、AsyncLocalStorage 事务上下文、串行队列。
 * 内存后端足以证明协调器语义(协调器只依赖 `StoreBackend`);真文件系统路径由 apply-once / audit 套件覆盖。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { StoreError } from '../../../src/rsi/store/errors.js';
import type { LockOrder as W8LockOrder } from '../../../src/rsi/auto/write/ports.js';
import type { HeldStore, LockOrder, TxnPorts } from '../../../src/rsi/store/ports.js';
import { FILES, makeWorld, type World } from './store-fixture.js';

const rejects = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
};
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
};
const held = (w: World): HeldStore => w.store.held;
const auditText = async (w: World): Promise<string> =>
  (await w.bytes(FILES.audit))?.toString('utf8') ?? '';

describe('事务协调器', () => {
  it('事务先 assertHeld(rsi 与 personal 都复核),再跑 fn;fn 的返回值透传', async () => {
    const w = await makeWorld('mem');
    const out = await held(w).transaction(async (p) => {
      expect(Object.keys(p).sort()).toEqual(['auditAppend', 'ledgerWrite']);
      return 42;
    });
    expect(out).toBe(42);
    expect(w.rsi.asserts).toBeGreaterThanOrEqual(1);
    expect(w.personal.asserts).toBeGreaterThanOrEqual(1);
  });

  it('stale_handle:锁已丢 / 已释放 = RsiLockError(lock_lost),fn 不被调用', async () => {
    const w = await makeWorld('mem');
    w.rsi.held = false;
    let ran = false;
    const e = await rejects(
      held(w).transaction(async () => {
        ran = true;
      }),
    );
    expect(e).toBeInstanceOf(RsiLockError);
    expect((e as RsiLockError).kind).toBe('lock_lost');
    expect(ran).toBe(false);
  });

  it('port_escaped_after_txn_before_release:事务结束后捕获的端口再用 = txn_closed(与 nonce 无关,锁仍持有)', async () => {
    const w = await makeWorld('mem');
    let captured: TxnPorts | undefined;
    await held(w).transaction(async (p) => {
      captured = p;
    });
    expect(w.rsi.held).toBe(true);
    for (const call of [
      () => (captured as TxnPorts).ledgerWrite.read(),
      () => (captured as TxnPorts).auditAppend.append('x\n'),
      () => (captured as TxnPorts).auditAppend.readWatermark(),
    ]) {
      expect(await rejects(call())).toMatchObject({ code: 'txn_closed' });
    }
    expect(await auditText(w)).toBe('');
  });

  it('unawaited_write_release_race:回调里没 await 的写在事务收尾前落定,不漂到事务 / release 之外', async () => {
    const w = await makeWorld('mem');
    await held(w).transaction(async (p) => {
      void p.auditAppend.append('line-a\n'); // 故意不 await
    });
    expect(await auditText(w)).toBe('line-a\n'); // 事务 promise 返回时已落盘
    const rel = held(w).release();
    await rel;
    expect(w.rsi.held).toBe(false);
  });

  it('未 await 的写失败不抛向事务外、也不造成未处理拒绝(发起者持有该 promise)', async () => {
    const w = await makeWorld('mem');
    let writeP: Promise<void> | undefined;
    await held(w).transaction(async (p) => {
      writeP = p.auditAppend.rewrite('x'); // 先让它在途
      w.rsi.held = false; // 复核锁时失败
      writeP.catch(() => undefined);
    });
    expect(await rejects(writeP as Promise<void>)).toBeInstanceOf(RsiLockError);
  });

  it('release_waits_inflight_txn / external_release_waits_not_rejected:事务外 release 等在途事务完成,再逆序释放 personal → rsi', async () => {
    const w = await makeWorld('mem');
    const g = gate();
    const order: string[] = [];
    const txn = held(w).transaction(async () => {
      await g.promise;
      order.push('txn-done');
    });
    const rel = held(w)
      .release()
      .then(() => order.push('released'));
    expect(held(w).closing).toBe(true); // 同步置位
    await Promise.resolve();
    expect(w.log).toEqual([]); // 事务未完成,锁未释放
    g.open();
    await txn;
    await rel;
    expect(order).toEqual(['txn-done', 'released']);
    expect(w.log).toEqual(['release:personal', 'release:rsi']);
  });

  it('release_inside_own_txn_rejected:本把锁事务回调内调用 release = release_inside_transaction(否则自锁)', async () => {
    const w = await makeWorld('mem');
    let inner: unknown;
    await held(w).transaction(async () => {
      inner = await rejects(held(w).release());
    });
    expect(inner).toMatchObject({ code: 'release_inside_transaction', reason: 'internal' });
    expect(w.log).toEqual([]); // 没有任何锁被释放
    await held(w).release(); // 事务外正常
    expect(w.log).toEqual(['release:personal', 'release:rsi']);
  });

  it('release_inside_other_lock_txn_not_rejected:别的锁的事务回调内调用本把锁的 release 照常等待并完成', async () => {
    const a = await makeWorld('mem');
    const b = await makeWorld('mem');
    await held(a).transaction(async () => {
      await held(b).release();
    });
    expect(b.log).toEqual(['release:personal', 'release:rsi']);
    expect(a.log).toEqual([]);
  });

  it('事务回调结束后(ALS 上下文不外泄):同一调用链随后 release 不被当作「事务内」', async () => {
    const w = await makeWorld('mem');
    await held(w).transaction(async () => undefined);
    await expect(held(w).release()).resolves.toBeUndefined();
  });

  it('txn_after_closing_rejected:release 开始后新事务 = txn_closing;对照:release 前的事务正常', async () => {
    const w = await makeWorld('mem');
    expect(await held(w).transaction(async () => 'before')).toBe('before');
    const rel = held(w).release();
    expect(await rejects(held(w).transaction(async () => 'after'))).toMatchObject({
      code: 'txn_closing',
    });
    await rel;
  });

  it('release 开始前已排队的事务照常执行(不是 closing 之后才进来的)', async () => {
    const w = await makeWorld('mem');
    const g = gate();
    const t1 = held(w).transaction(async () => {
      await g.promise;
      return 1;
    });
    const t2 = held(w).transaction(async () => 2);
    const rel = held(w).release();
    g.open();
    expect([await t1, await t2]).toEqual([1, 2]);
    await rel;
    expect(w.log).toEqual(['release:personal', 'release:rsi']);
  });

  it('txn_reject_queue_continues:fn 拒绝后队列照常继续;事务串行不重叠', async () => {
    const w = await makeWorld('mem');
    let running = 0;
    let maxRunning = 0;
    const run = async (fail: boolean): Promise<string> => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (fail) throw new Error('boom');
      return 'ok';
    };
    const r1 = held(w).transaction(() => run(true));
    const r2 = held(w).transaction(() => run(false));
    const r3 = held(w).transaction(() => run(false));
    await expect(r1).rejects.toThrow('boom');
    expect([await r2, await r3]).toEqual(['ok', 'ok']);
    expect(maxRunning).toBe(1);
  });

  it('concurrent_release_single_promise:并发多次 release 共享同一个 promise,底层各释放一次', async () => {
    const w = await makeWorld('mem');
    const p1 = held(w).release();
    const p2 = held(w).release();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    await held(w).release();
    expect(w.rsi.releases).toBe(1);
    expect(w.personal.releases).toBe(1);
  });

  it('txn_nested:事务内再开本把锁的事务 = txn_nested(不会自锁)', async () => {
    const w = await makeWorld('mem');
    let inner: unknown;
    await held(w).transaction(async () => {
      inner = await rejects(held(w).transaction(async () => 1));
    });
    expect(inner).toMatchObject({ code: 'txn_nested' });
    expect(inner).toBeInstanceOf(StoreError);
  });

  it('personal 释放失败时 rsi 仍被释放(finally)', async () => {
    const w = await makeWorld('mem');
    w.personal.release = async () => {
      throw new Error('personal release failed');
    };
    await expect(held(w).release()).rejects.toThrow('personal release failed');
    expect(w.rsi.releases).toBe(1);
  });

  it('lock_order_out_of_order_not_expressible:LockOrder 只含有序组合,与命令层同一字面量集合;存储核不导出单独取锁函数', async () => {
    expectTypeOf<LockOrder>().toEqualTypeOf<W8LockOrder>();
    expectTypeOf<LockOrder>().toEqualTypeOf<'personal_sync' | 'rsi_personal_sync'>();
    const mod = await import('../../../src/rsi/store/txn.js');
    expect(Object.keys(mod)).toEqual(['createHeldStore']);
    const names = [
      ...Object.keys(mod),
      ...Object.keys(await import('../../../src/rsi/store/store.js')),
    ];
    expect(names.filter((n) => /acquire|withLock|lockRsi|lockPersonal/i.test(n))).toEqual([]);
  });
});
