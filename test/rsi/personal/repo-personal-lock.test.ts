/**
 * R21-3.2 / R21-3.3 `personal/lock`:协议同 R20-5.5(复用 A1 `lock.test.ts` 的夹具形状),文件在假 HOME 的 rsi-personal/lock,写经 home-fs。
 * locked、locked_over_ttl、过期回收(含回收竞态)、lock_lost、不重入、状态目录不安全。变异:回收前不复读、assertHeld 恒真、超 TTL 也回收。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_LOCK_PARTIAL_GRACE_MS,
  RSI_LOCK_TTL_MS,
} from '../../../src/contracts/rsi.js';
import { KIT_VERSION } from '../../../src/contracts/meta.js';
import { exists, lstat, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import type { RsiLockDeps } from '../../../src/rsi/lock-read.js';
import {
  acquirePersonalLock,
  withPersonalLock,
} from '../../../src/rsi/personal/personal-lock.js';
import { makeWorld, type World } from './repo-helpers.js';

const lockFile = (w: World): string => path.join(w.h.stateDir, 'lock');
const doc = (pid: number, nonce = 'a'.repeat(16), startedAt = new Date().toISOString()): string =>
  JSON.stringify({ pid, started_at: startedAt, nonce, kit_version: '0.1.0' });

async function plant(w: World, text: string): Promise<void> {
  await safe.mkdirp(w.io, w.h.stateDir, 0o700);
  await safe.writeFile(w.io, lockFile(w), text, { mode: 0o600 });
}

async function kind(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RsiLockError) return e.kind;
    throw e;
  }
  return 'acquired';
}

const alive = (over: RsiLockDeps = {}): RsiLockDeps => ({ isAlive: () => true, ...over });

describe('R21-3.2 personal/lock 位置与权限', () => {
  it('锁在 <HOME>/.local/state/agent-kit/rsi-personal/lock,文件 0600、目录 0700,内容含 pid / started_at / nonce / kit_version;释放后消失', async () => {
    const w = await makeWorld('pl-basic-');
    const lock = await acquirePersonalLock(w.h, { pid: 4242 });
    expect(lock.path).toBe(lockFile(w));
    expect(w.h.stateDir.endsWith('/.local/state/agent-kit/rsi-personal')).toBe(true);
    const j = JSON.parse(await readText(lockFile(w))) as Record<string, unknown>;
    expect(j['pid']).toBe(4242);
    expect(j['nonce']).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof j['started_at']).toBe('string');
    expect(j['kit_version']).toBe(KIT_VERSION);
    expect((await lstat(lockFile(w))).mode & 0o777).toBe(0o600);
    expect((await lstat(w.h.stateDir)).mode & 0o777).toBe(0o700);
    await lock.assertHeld();
    await lock.release();
    expect(await exists(lockFile(w))).toBe(false);
    await lock.release(); // 幂等
  });

  it('withPersonalLock:回调抛错也释放', async () => {
    const w = await makeWorld('pl-with-');
    await expect(
      withPersonalLock(w.h, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await exists(lockFile(w))).toBe(false);
    await (await acquirePersonalLock(w.h)).release(); // 能再拿
  });
});

describe('R20-5.5 协议(personal/lock)', () => {
  it('locked:持有者进程存活且未超 TTL → locked,锁文件不动', async () => {
    const w = await makeWorld('pl-locked-');
    const text = doc(31337);
    await plant(w, text);
    expect(await kind(acquirePersonalLock(w.h, alive()))).toBe('locked');
    expect(await readText(lockFile(w))).toBe(text);
    expect(new RsiLockError('locked').toStable()).toMatchObject({ code: 'RSI_NOT_RUN', reason: 'locked' });
  });

  it('locked_over_ttl:持有者存活但超过 15 分钟 → 只报 locked_over_ttl,不杀、不删', async () => {
    const w = await makeWorld('pl-ttl-');
    const old = new Date(Date.now() - RSI_LOCK_TTL_MS - 60_000).toISOString();
    const text = doc(31337, 'b'.repeat(16), old);
    await plant(w, text);
    expect(await kind(acquirePersonalLock(w.h, alive()))).toBe('locked_over_ttl');
    expect(await readText(lockFile(w))).toBe(text);
  });

  it('过期回收:持有者 pid 不存在(ESRCH)→ 回收并成功获取,新 nonce 是自己的', async () => {
    const w = await makeWorld('pl-stale-');
    await plant(w, doc(99999, 'c'.repeat(16)));
    const lock = await acquirePersonalLock(w.h, { isAlive: (pid) => pid !== 99999 });
    expect(lock.nonce).not.toBe('c'.repeat(16));
    expect((JSON.parse(await readText(lockFile(w))) as { nonce: string }).nonce).toBe(lock.nonce);
    await lock.release();
  });

  it('空文件 / 损坏:不满 10 秒 → locked(可能正在写);满 10 秒 → 回收', async () => {
    const w = await makeWorld('pl-partial-');
    await plant(w, '');
    expect(await kind(acquirePersonalLock(w.h, alive()))).toBe('locked');
    const later = (): Date => new Date(Date.now() + RSI_LOCK_PARTIAL_GRACE_MS + 5_000);
    const lock = await acquirePersonalLock(w.h, alive({ now: later }));
    await lock.release();
    await plant(w, '{not json');
    expect(await kind(acquirePersonalLock(w.h, alive()))).toBe('locked');
    const lock2 = await acquirePersonalLock(w.h, alive({ now: later }));
    await lock2.release();
  });

  it('回收前复读:判定陈旧之后锁文件被别人换掉 → 不删(逐字节相同才删)', async () => {
    const w = await makeWorld('pl-race-');
    await plant(w, doc(111, 'd'.repeat(16)));
    const foreign = doc(222, 'e'.repeat(16));
    const r = await kind(
      acquirePersonalLock(w.h, {
        isAlive: (pid) => pid !== 111,
        beforeReclaim: async () => {
          await safe.remove(w.io, lockFile(w));
          await safe.writeFile(w.io, lockFile(w), foreign, { mode: 0o600 });
        },
      }),
    );
    expect(r).toBe('locked');
    expect(await readText(lockFile(w))).toBe(foreign); // 新持有者的锁完好
  });

  it('lock_lost:nonce 被换(或锁被删)→ assertHeld 抛 lock_lost;release 不删别人的锁', async () => {
    const w = await makeWorld('pl-lost-');
    const lock = await acquirePersonalLock(w.h);
    const foreign = doc(555, 'f'.repeat(16));
    await safe.remove(w.io, lockFile(w));
    await safe.writeFile(w.io, lockFile(w), foreign, { mode: 0o600 });
    expect(await kind(lock.assertHeld())).toBe('lock_lost');
    await lock.release();
    expect(await readText(lockFile(w))).toBe(foreign);

    const lock2 = await acquirePersonalLock(w.h, alive({ isAlive: () => false }));
    await safe.remove(w.io, lockFile(w));
    expect(await kind(lock2.assertHeld())).toBe('lock_lost');
    await lock2.release();
  });

  it('同一进程第二次获取 = 编程错误(internal),不重入;释放后可再拿', async () => {
    const w = await makeWorld('pl-reenter-');
    const lock = await acquirePersonalLock(w.h);
    expect(await kind(acquirePersonalLock(w.h))).toBe('internal');
    await lock.release();
    await (await acquirePersonalLock(w.h)).release();
  });

  it('状态目录权限宽于 0700 → state_dir_unsafe(fail-closed,不自动收紧);目录是符号链接 → write_denied', async () => {
    const w = await makeWorld('pl-unsafe-');
    await safe.mkdirp(w.io, w.h.stateDir, 0o700);
    await safe.chmod(w.io, w.h.stateDir, 0o755);
    expect(await kind(acquirePersonalLock(w.h))).toBe('state_dir_unsafe');
    expect((await lstat(w.h.stateDir)).mode & 0o777).toBe(0o755);

    const w2 = await makeWorld('pl-symlink-');
    await safe.mkdirp(w2.io, path.dirname(w2.h.stateDir), 0o700);
    await safe.mkdirp(w2.io, path.join(w2.dir, 'elsewhere'), 0o700);
    await safe.symlink(w2.io, path.join(w2.dir, 'elsewhere'), w2.h.stateDir);
    expect(await kind(acquirePersonalLock(w2.h))).toBe('write_denied');
    expect(await exists(path.join(w2.dir, 'elsewhere', 'lock'))).toBe(false);
  });
});
