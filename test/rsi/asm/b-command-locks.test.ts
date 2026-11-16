/**
 * B2 ⑤:`CommandLocks` 真实现的顺序 / 试锁 / 逆序释放(假取锁器,逐条钉具体行为)与锁绑定断言(`assertInsideLocks`)。
 */
import { describe, expect, it } from 'vitest';
import {
  assertInsideLocks,
  makeCommandLocks,
  type AcquiredLock,
  type LockAcquirers,
} from '../../../src/rsi/auto/write/command-locks.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';

function fixture(opts: { denied?: 'rsi' | 'personal' | 'sync'; releaseFails?: string } = {}) {
  const log: string[] = [];
  const mk =
    (n: 'rsi' | 'personal' | 'sync'): (() => Promise<AcquiredLock>) =>
    async () => {
      if (opts.denied === n) throw new RsiLockError('locked');
      log.push(`acquire:${n}`);
      return {
        assertHeld: async () => {
          log.push(`assert:${n}`);
        },
        release: async () => {
          log.push(`release:${n}`);
          if (opts.releaseFails === n) throw new Error(`release_failed:${n}`);
        },
      };
    };
  const acq: LockAcquirers = { rsi: mk('rsi'), personal: mk('personal'), sync: mk('sync') };
  return { log, locks: makeCommandLocks(acq) };
}

describe('CommandLocks:顺序 / 试锁 / 逆序释放', () => {
  it('rsi_personal_sync:rsi → personal → sync 取,sync → personal → rsi 放', async () => {
    const f = fixture();
    await f.locks.withLocks('rsi_personal_sync', async () => undefined);
    expect(f.log).toEqual([
      'acquire:rsi',
      'acquire:personal',
      'acquire:sync',
      'release:sync',
      'release:personal',
      'release:rsi',
    ]);
  });

  it('personal_sync(缩减入口)不取 rsi;held.rsi = null', async () => {
    const f = fixture();
    let rsi: unknown = 'unset';
    await f.locks.withLocks('personal_sync', async (h) => {
      rsi = h.rsi;
    });
    expect(rsi).toBeNull();
    expect(f.log).toEqual(['acquire:personal', 'acquire:sync', 'release:sync', 'release:personal']);
  });

  it.each([
    ['rsi', ['release:']],
    ['personal', ['acquire:rsi', 'release:rsi']],
    ['sync', ['acquire:rsi', 'acquire:personal', 'release:personal', 'release:rsi']],
  ] as const)(
    '试锁失败(%s):fn 不执行,已拿到的逆序释放,错误原样抛出(RsiLockError locked)',
    async (denied, rest) => {
      const f = fixture({ denied });
      let ran = false;
      await expect(
        f.locks.withLocks('rsi_personal_sync', async () => {
          ran = true;
        }),
      ).rejects.toMatchObject({ code: 'RSI_LOCK', kind: 'locked' });
      expect(ran).toBe(false);
      expect(f.log.filter((l) => !l.startsWith('acquire:' + denied))).toEqual(
        denied === 'rsi' ? [] : [...rest],
      );
    },
  );

  it('fn 抛错也逆序释放;释放失败不遮盖 fn 的错误(三把都尝试)', async () => {
    const f = fixture({ releaseFails: 'sync' });
    await expect(
      f.locks.withLocks('rsi_personal_sync', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(f.log.slice(-3)).toEqual(['release:sync', 'release:personal', 'release:rsi']);
  });

  it('fn 成功而释放失败:抛释放错误(不假装干净),其余仍释放', async () => {
    const f = fixture({ releaseFails: 'personal' });
    await expect(f.locks.withLocks('rsi_personal_sync', async () => 1)).rejects.toThrow(
      'release_failed:personal',
    );
    expect(f.log.slice(-3)).toEqual(['release:sync', 'release:personal', 'release:rsi']);
  });

  it('syncLock.withLock 复核仍持有后执行,不再取第二次', async () => {
    const f = fixture();
    const out = await f.locks.withLocks('personal_sync', (h) => h.syncLock.withLock(async () => 7));
    expect(out).toBe(7);
    expect(f.log.filter((l) => l === 'acquire:sync')).toHaveLength(1);
    expect(f.log).toContain('assert:sync');
  });
});

describe('锁绑定断言:assertInsideLocks', () => {
  it('锁外 = 抛 RsiLockError internal;持锁期内(含 await 之后)可见当前持有者并复核两把锁', async () => {
    const f = fixture();
    await expect(assertInsideLocks(f.locks, true)).rejects.toMatchObject({
      code: 'RSI_LOCK',
      kind: 'internal',
    });
    await f.locks.withLocks('rsi_personal_sync', async (h) => {
      await Promise.resolve();
      expect(await assertInsideLocks(f.locks, true)).toBe(h);
    });
    expect(f.log).toContain('assert:rsi');
    expect(f.locks.current()).toBeUndefined();
  });

  it('需要 rsi 而本次是缩减入口(personal_sync)= 拒绝;不需要 rsi 则放行(对照)', async () => {
    const f = fixture();
    await f.locks.withLocks('personal_sync', async () => {
      await expect(assertInsideLocks(f.locks, true)).rejects.toMatchObject({ kind: 'internal' });
      await expect(assertInsideLocks(f.locks, false)).resolves.toBeDefined();
    });
  });
});
