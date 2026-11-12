/**
 * R21-3.3 锁序守卫(§21.24 W0-15「交给后续块」):`rsi/lock` → `personal/lock` → sync 锁,不可反转。
 * 本进程持有 `personal/lock` 时再取 `rsi/lock` = 编程错误(`RsiLockError('internal')`);正向顺序与释放后均可。
 */
import { describe, expect, it } from 'vitest';
import { acquireRsiLock } from '../../../src/rsi/lock.js';
import { personalLockHeldInProcess } from '../../../src/rsi/lock-order.js';
import { acquirePersonalLock } from '../../../src/rsi/personal/personal-lock.js';
import { makeWorld } from '../personal/repo-helpers.js';

describe('锁序守卫', () => {
  it('先 personal 后 rsi → internal(反向取锁);rsi 锁文件没有被创建', async () => {
    const w = await makeWorld('w7-order-');
    const p = await acquirePersonalLock(w.h);
    try {
      expect(personalLockHeldInProcess()).toBe(true);
      await expect(acquireRsiLock(w.io)).rejects.toMatchObject({ kind: 'internal' });
    } finally {
      await p.release();
    }
    expect(personalLockHeldInProcess()).toBe(false);
  });

  it('正向顺序 rsi → personal 允许;释放 personal 后再取 rsi 允许(守卫随释放解除)', async () => {
    const w = await makeWorld('w7-order2-');
    const r = await acquireRsiLock(w.io);
    const p = await acquirePersonalLock(w.h);
    await p.release();
    await r.release();
    const p2 = await acquirePersonalLock(w.h);
    await p2.release();
    const r2 = await acquireRsiLock(w.io);
    await r2.release();
  });

  it('personal 锁获取失败(已被占)不会残留登记:登记只在拿到锁之后', async () => {
    const w = await makeWorld('w7-order3-');
    const p = await acquirePersonalLock(w.h);
    await expect(acquirePersonalLock(w.h)).rejects.toBeDefined();
    await p.release();
    expect(personalLockHeldInProcess()).toBe(false);
    const r = await acquireRsiLock(w.io);
    await r.release();
  });
});
