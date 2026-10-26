/**
 * R20 A1(docs/contracts.md §20.5):`rsi/lock` 的获取、陈旧锁协议、nonce 复核、路径与权限。
 * 条款号写在用例名里(`R20-5.x`)。进程级(SIGKILL、并发写、盐并发首建)见 lock-procs.test.ts。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_LOCK_PARTIAL_GRACE_MS,
  RSI_LOCK_TTL_MINUTES,
  RSI_LOCK_TTL_MS,
} from '../../src/contracts/rsi.js';
import { createIoContext } from '../../src/io/paths.js';
import { exists, lstat, readText, realpath } from '../../src/io/read-fs.js';
import { chmod, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import {
  RsiLockError,
  acquireRsiLock,
  makeIsAlive,
  peekRsiLock,
  withRsiLock,
  type RsiLockDeps,
} from '../../src/rsi/lock.js';
import { REPO_ROOT, newWork, type Work } from '../signals/helpers.js';

const lockFile = (w: Work): string => path.join(w.state, 'rsi', 'lock');
const doc = (pid: number, nonce = 'a'.repeat(16), startedAt = new Date().toISOString()): string =>
  JSON.stringify({ pid, started_at: startedAt, nonce, kit_version: '0.1.0' });

async function plant(w: Work, text: string): Promise<void> {
  await mkdirp(w.io, path.join(w.state, 'rsi'), 0o700);
  await writeFile(w.io, lockFile(w), text, { mode: 0o600 });
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

const fixed = (over: RsiLockDeps = {}): RsiLockDeps => ({
  isAlive: () => true,
  ...over,
});

describe('R20-5.3 锁文件位置与权限', () => {
  it('锁在 <realpath(stateDir)>/rsi/lock,文件 0600、rsi 目录 0700,内容含 pid / started_at / nonce / kit_version', async () => {
    const w = await newWork('rl-basic-');
    const lock = await acquireRsiLock(w.io, { pid: 4242 });
    expect(lock.path).toBe(await realpath(lockFile(w)));
    const j = JSON.parse(await readText(lockFile(w))) as Record<string, unknown>;
    expect(j['pid']).toBe(4242);
    expect(j['nonce']).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof j['started_at']).toBe('string');
    expect(j['kit_version']).toBe('0.1.0');
    expect((await lstat(lockFile(w))).mode & 0o777).toBe(0o600);
    expect((await lstat(path.join(w.state, 'rsi'))).mode & 0o777).toBe(0o700);
    await lock.assertHeld();
    await lock.release();
    expect(await exists(lockFile(w))).toBe(false);
  });

  it('已存在且权限过宽的 rsi 目录被收紧到 0700', async () => {
    const w = await newWork('rl-dirmode-');
    await mkdirp(w.io, path.join(w.state, 'rsi'), 0o755);
    await chmod(w.io, path.join(w.state, 'rsi'), 0o755);
    const lock = await acquireRsiLock(w.io);
    expect((await lstat(path.join(w.state, 'rsi'))).mode & 0o777).toBe(0o700);
    await lock.release();
  });

  it('同一仓库经不同路径写法(符号链接的上级目录)是同一把锁', async () => {
    const w = await newWork('rl-samepath-');
    await mkdirp(w.io, path.join(w.dir, 'real'), 0o700);
    await symlink(w.io, path.join(w.dir, 'real'), path.join(w.dir, 'lnk'));
    const mk = (s: string) =>
      createIoContext({
        cwd: REPO_ROOT,
        env: { KIT_TMP: w.dir, KIT_STATE_DIR: s, PATH: '/usr/bin:/bin' },
      });
    const a = mk(path.join(w.dir, 'real', 'state'));
    const b = mk(path.join(w.dir, 'lnk', 'state'));
    const la = await acquireRsiLock(a, fixed());
    // 两种写法解析到同一个真实路径:本进程已持有 → 重入(internal),而不是各拿一把
    expect(await kind(acquireRsiLock(b, fixed()))).toBe('internal');
    expect(la.path).toBe(path.join(w.dir, 'real', 'state', 'rsi', 'lock'));
    await la.release();
  });

  it('rsi/ 是符号链接 → fail-closed state_dir_unsafe,不顺着链接建锁', async () => {
    const w = await newWork('rl-symdir-');
    await mkdirp(w.io, path.join(w.state, 'elsewhere'), 0o700);
    await symlink(w.io, path.join(w.state, 'elsewhere'), path.join(w.state, 'rsi'));
    const e = await acquireRsiLock(w.io).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RsiLockError);
    expect((e as RsiLockError).kind).toBe('state_dir_unsafe');
    expect((e as RsiLockError).toStable()).toEqual({
      code: 'RSI_FAIL_CLOSED',
      reason: 'state_dir_unsafe',
      exit: 3,
    });
    expect(await exists(path.join(w.state, 'elsewhere', 'lock'))).toBe(false);
  });

  it('rsi 是普通文件(不是目录)→ state_dir_unsafe(而不是裸的 mkdir 错误)', async () => {
    const w = await newWork('rl-rsifile-');
    await mkdirp(w.io, w.state, 0o700);
    await writeFile(w.io, path.join(w.state, 'rsi'), 'x');
    expect(await kind(acquireRsiLock(w.io))).toBe('state_dir_unsafe');
    expect(await readText(path.join(w.state, 'rsi'))).toBe('x');
  });

  it('远大于锁内容的「锁文件」不比较不回收:state_dir_unsafe,文件原样;中等大小的损坏内容满 10 秒后按真实字节复读后回收', async () => {
    const w = await newWork('rl-big-');
    const big = 'x'.repeat(200 * 1024);
    await plant(w, big);
    const m = (await lstat(lockFile(w))).mtimeMs;
    const late = { isAlive: () => true, now: () => new Date(m + 60_000) };
    expect(await kind(acquireRsiLock(w.io, late))).toBe('state_dir_unsafe');
    expect((await readText(lockFile(w))).length).toBe(big.length);
    await plant(w, 'y'.repeat(10 * 1024)); // > 4096 字节(解析不接受)但在读取上限内
    const m2 = (await lstat(lockFile(w))).mtimeMs;
    const got = await acquireRsiLock(w.io, { isAlive: () => true, now: () => new Date(m2 + 60_000) });
    await got.release();
  });

  it('peekRsiLock 与 rsiDirReadonly 零写入:状态目录不存在时返回 free,不建目录', async () => {
    const w = await newWork('rl-peek-ro-');
    expect(await peekRsiLock(w.io)).toBe('free');
    expect(await exists(w.state)).toBe(false);
  });

  it('锁文件本身是符号链接 → state_dir_unsafe(不跟随、不覆盖)', async () => {
    const w = await newWork('rl-symlock-');
    await mkdirp(w.io, path.join(w.state, 'rsi'), 0o700);
    await writeFile(w.io, path.join(w.state, 'target'), 'x');
    await symlink(w.io, path.join(w.state, 'target'), lockFile(w));
    expect(await kind(acquireRsiLock(w.io))).toBe('state_dir_unsafe');
    expect(await readText(path.join(w.state, 'target'))).toBe('x');
  });
});

describe('R20-5.4 嵌套与重入', () => {
  it('同一进程第二次获取 = 编程错误(internal),不重入;释放后可再拿', async () => {
    const w = await newWork('rl-reenter-');
    const a = await acquireRsiLock(w.io);
    const e = await acquireRsiLock(w.io).catch((x: unknown) => x);
    expect((e as RsiLockError).kind).toBe('internal');
    expect((e as RsiLockError).toStable()).toMatchObject({ reason: 'internal', exit: 3 });
    await a.release();
    await (await acquireRsiLock(w.io)).release();
  });

  it('withRsiLock:回调抛错也释放;回调拿到的是句柄', async () => {
    const w = await newWork('rl-with-');
    await expect(
      withRsiLock(w.io, async (l) => {
        await l.assertHeld();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await exists(lockFile(w))).toBe(false);
    expect(await withRsiLock(w.io, async (l) => l.nonce.length)).toBe(16);
  });
});

describe('R20-5.5 陈旧锁协议', () => {
  it('持锁 pid 存活:占用(locked);同一份锁 pid 不存在则被回收(正向对照)', async () => {
    const w = await newWork('rl-alive-');
    await plant(w, doc(99991));
    expect(await kind(acquireRsiLock(w.io, { isAlive: () => true }))).toBe('locked');
    expect(JSON.parse(await readText(lockFile(w)))['pid']).toBe(99991);
    const got = await acquireRsiLock(w.io, { isAlive: () => false, pid: 7 });
    expect(JSON.parse(await readText(lockFile(w)))['pid']).toBe(7);
    await got.release();
  });

  it('R20-5.5 假 isAlive 恒真、超过 TTL → locked_over_ttl,不杀不删(锁文件逐字节不变)', async () => {
    const w = await newWork('rl-ttl-');
    const started = Date.parse('2026-10-23T12:00:00.000Z');
    const text = doc(99991, 'b'.repeat(16), new Date(started).toISOString());
    await plant(w, text);
    expect(RSI_LOCK_TTL_MINUTES).toBe(15);
    const young = { isAlive: () => true, now: () => new Date(started + RSI_LOCK_TTL_MS - 1000) };
    expect(await kind(acquireRsiLock(w.io, young))).toBe('locked');
    const old = { isAlive: () => true, now: () => new Date(started + RSI_LOCK_TTL_MS + 1000) };
    const e = await acquireRsiLock(w.io, old).catch((x: unknown) => x);
    expect((e as RsiLockError).kind).toBe('locked_over_ttl');
    expect((e as RsiLockError).toStable()).toEqual({
      code: 'RSI_NOT_RUN',
      reason: 'locked_over_ttl',
      exit: 4,
    });
    expect(await readText(lockFile(w))).toBe(text);
  });

  it('R20-5.5 空锁文件:创建不满 10 秒 → 占用;满 10 秒 → 回收(假时钟)', async () => {
    const w = await newWork('rl-empty-');
    await plant(w, '');
    const mtime = (await lstat(lockFile(w))).mtimeMs;
    expect(RSI_LOCK_PARTIAL_GRACE_MS).toBe(10_000);
    const at = (ms: number): RsiLockDeps => ({
      isAlive: () => true,
      now: () => new Date(mtime + ms),
    });
    expect(await kind(acquireRsiLock(w.io, at(RSI_LOCK_PARTIAL_GRACE_MS - 1000)))).toBe('locked');
    expect(await readText(lockFile(w))).toBe('');
    const got = await acquireRsiLock(w.io, at(RSI_LOCK_PARTIAL_GRACE_MS + 1000));
    expect(JSON.parse(await readText(lockFile(w)))['nonce']).toBe(got.nonce);
    await got.release();
  });

  it('R20-5.5 内容损坏的锁文件:不满 10 秒占用,满 10 秒回收;pid 存活与否不影响损坏锁', async () => {
    const w = await newWork('rl-corrupt-');
    await plant(w, '{"pid": "not-a-number"');
    const mtime = (await lstat(lockFile(w))).mtimeMs;
    const at = (ms: number): RsiLockDeps => ({
      isAlive: () => true,
      now: () => new Date(mtime + ms),
    });
    expect(await kind(acquireRsiLock(w.io, at(3000)))).toBe('locked');
    expect(await readText(lockFile(w))).toBe('{"pid": "not-a-number"');
    await (await acquireRsiLock(w.io, at(11_000))).release();
    // 字段齐全但多一个键(strictObject)也算损坏
    await plant(w, JSON.stringify({ ...JSON.parse(doc(1)), extra: 1 }));
    const m2 = (await lstat(lockFile(w))).mtimeMs;
    await (
      await acquireRsiLock(w.io, { isAlive: () => true, now: () => new Date(m2 + 11_000) })
    ).release();
  });

  it('R20-5.5 回收前复读:判定陈旧后、删除前锁文件被换成活锁 → 不删、报占用(变异:不复读 → 红)', async () => {
    const w = await newWork('rl-reread-');
    await plant(w, doc(99991, 'c'.repeat(16)));
    const live = doc(88888, 'd'.repeat(16));
    let swapped = false;
    const e = await acquireRsiLock(w.io, {
      // 99991 判死、88888 判活
      isAlive: (pid) => pid === 88888,
      beforeReclaim: async () => {
        swapped = true;
        await writeFile(w.io, lockFile(w), live, { mode: 0o600 });
      },
    }).catch((x: unknown) => x);
    expect(swapped).toBe(true);
    expect((e as RsiLockError).kind).toBe('locked');
    expect(await readText(lockFile(w))).toBe(live); // 活锁没被删
  });

  it('R20-5.5 复读相同才删:没有换锁时 beforeReclaim 之后正常回收(对照)', async () => {
    const w = await newWork('rl-reread-ok-');
    await plant(w, doc(99991, 'c'.repeat(16)));
    let called = 0;
    const got = await acquireRsiLock(w.io, {
      isAlive: () => false,
      beforeReclaim: () => void called++,
    });
    expect(called).toBe(1);
    await got.release();
  });

  it('R20-5.5 EPERM 算存活、ESRCH 才算死(makeIsAlive 钉死判据)', () => {
    const err = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(makeIsAlive(() => undefined)(5)).toBe(true);
    expect(makeIsAlive(err('EPERM'))(5)).toBe(true);
    expect(makeIsAlive(err('ESRCH'))(5)).toBe(false);
    expect(makeIsAlive(err('EINVAL'))(5)).toBe(true); // 其它错误保守按存活
  });

  it('R20-5.5 EPERM 的端到端:pid 1 对非特权用户发信号得 EPERM(特权用户则成功),两种都是存活 → 不回收', async () => {
    const w = await newWork('rl-eperm-');
    await plant(w, doc(1));
    expect(await kind(acquireRsiLock(w.io))).toBe('locked');
    expect(JSON.parse(await readText(lockFile(w)))['pid']).toBe(1);
  });

  it('peekRsiLock:free / held / held_over_ttl / stale,只读', async () => {
    const w = await newWork('rl-peek-');
    expect(await peekRsiLock(w.io)).toBe('free');
    const started = Date.parse('2026-10-23T12:00:00.000Z');
    await plant(w, doc(99991, 'e'.repeat(16), new Date(started).toISOString()));
    const base = { now: () => new Date(started + 1000) };
    expect(await peekRsiLock(w.io, { ...base, isAlive: () => true })).toBe('held');
    expect(
      await peekRsiLock(w.io, {
        isAlive: () => true,
        now: () => new Date(started + RSI_LOCK_TTL_MS + 1),
      }),
    ).toBe('held_over_ttl');
    expect(await peekRsiLock(w.io, { ...base, isAlive: () => false })).toBe('stale');
    expect(await exists(lockFile(w))).toBe(true);
  });
});

describe('R20-5.5 nonce 与 assertHeld(lock_lost)', () => {
  it('锁文件被换成别人的 nonce → assertHeld 抛 lock_lost;release 不删别人的锁(变异:assertHeld 恒真 → 红)', async () => {
    const w = await newWork('rl-nonce-');
    const lock = await acquireRsiLock(w.io);
    await lock.assertHeld();
    const theirs = doc(99991, 'f'.repeat(16));
    await writeFile(w.io, lockFile(w), theirs, { mode: 0o600 });
    const e = await lock.assertHeld().catch((x: unknown) => x);
    expect((e as RsiLockError).kind).toBe('lock_lost');
    expect((e as RsiLockError).toStable()).toEqual({
      code: 'RSI_FAIL_CLOSED',
      reason: 'lock_lost',
      exit: 3,
    });
    await lock.release();
    expect(await readText(lockFile(w))).toBe(theirs);
    // release 之后同进程可再拿(本进程的占位已清),但锁文件是别人的 → 活锁占用
    expect(await kind(acquireRsiLock(w.io, { isAlive: () => true }))).toBe('locked');
  });

  it('锁文件被删 / 被换成符号链接 → assertHeld 同样 lock_lost', async () => {
    const w = await newWork('rl-gone-');
    const a = await acquireRsiLock(w.io);
    await remove(w.io, lockFile(w));
    expect(await kind(a.assertHeld())).toBe('lock_lost');
    await a.release();
    const b = await acquireRsiLock(w.io);
    await remove(w.io, lockFile(w));
    await writeFile(w.io, path.join(w.state, 'other'), 'x');
    await symlink(w.io, path.join(w.state, 'other'), lockFile(w));
    expect(await kind(b.assertHeld())).toBe('lock_lost');
    await b.release();
  });

  it('release 幂等', async () => {
    const w = await newWork('rl-idem-');
    const a = await acquireRsiLock(w.io);
    await a.release();
    await a.release();
    await (await acquireRsiLock(w.io)).release();
  });
});
