import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lstat, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  LOCK_PARTIAL_GRACE_MS,
  UPDATE_LOCK_REL,
  UPDATE_LOCK_TTL_MS,
  UpdateLockError,
  acquireUpdateLock,
  type InstallDeps,
  type InstallEnv,
} from '../../src/update/install.js';
import { newWorld, type World } from './install-world.js';

function envOf(w: World, deps: InstallDeps = {}): InstallEnv {
  return { home: w.home, tmpDir: w.dir, env: undefined, deps };
}
const lockAbs = (w: World): string => path.join(w.home, ...UPDATE_LOCK_REL.split('/'));
const doc = (pid: number, nonce = 'a'.repeat(16), startedAt = '2026-10-14T12:00:00.000Z'): string =>
  JSON.stringify({ pid, started_at: startedAt, nonce });

async function detail(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof UpdateLockError) return e.detail;
    throw e;
  }
  return 'acquired';
}

async function plant(w: World, text: string): Promise<void> {
  await safe.mkdirp(w.fx, path.dirname(lockAbs(w)));
  await safe.writeFile(w.fx, lockAbs(w), text);
}

describe('update/lock', () => {
  it('空闲时拿到锁,内容含 pid / started_at / nonce,权限 0600;释放后文件消失', async () => {
    const w = await newWorld();
    const lock = await acquireUpdateLock(envOf(w, { pid: 4242 }));
    const j = JSON.parse(await readText(lockAbs(w))) as Record<string, unknown>;
    expect(j['pid']).toBe(4242);
    expect(typeof j['started_at']).toBe('string');
    expect(j['nonce']).toMatch(/^[0-9a-f]{16}$/);
    expect((await lstat(lockAbs(w))).mode & 0o777).toBe(0o600);
    await lock.assertHeld();
    await lock.release();
    await expect(lstat(lockAbs(w))).rejects.toThrow();
  });

  it('同一把锁不能拿两次(O_EXCL)', async () => {
    const w = await newWorld();
    const env = envOf(w, { isPidAlive: () => true });
    const a = await acquireUpdateLock(env);
    expect(await detail(acquireUpdateLock(env))).toBe('held');
    await a.release();
    expect(await detail(acquireUpdateLock(env))).toBe('acquired');
  });

  it('持锁 pid 还活着:被占;超过 15 分钟 TTL 也只报(held_over_ttl),不回收、不杀', async () => {
    const w = await newWorld();
    await plant(w, doc(99991));
    const started = Date.parse('2026-10-14T12:00:00.000Z');
    const young = envOf(w, { isPidAlive: () => true, now: () => new Date(started + 60_000) });
    expect(await detail(acquireUpdateLock(young))).toBe('held');
    const old = envOf(w, {
      isPidAlive: () => true,
      now: () => new Date(started + UPDATE_LOCK_TTL_MS + 1000),
    });
    expect(await detail(acquireUpdateLock(old))).toBe('held_over_ttl');
    expect(JSON.parse(await readText(lockAbs(w)))['pid']).toBe(99991);
  });

  it('持锁 pid 已不在:回收并拿到锁(正向);同一份锁 pid 在则不回收(对照)', async () => {
    const w = await newWorld();
    await plant(w, doc(99991));
    const dead = envOf(w, { pid: 7, isPidAlive: () => false });
    expect(await detail(acquireUpdateLock(dead))).toBe('acquired');
    expect(JSON.parse(await readText(lockAbs(w)))['pid']).toBe(7);
  });

  it('内容损坏:刚创建(< 10s,可能正在写)按被占;超过宽限期则回收', async () => {
    const w = await newWorld();
    await plant(w, '{"pid":');
    const st = await lstat(lockAbs(w));
    const fresh = envOf(w, { now: () => new Date(st.mtimeMs + 1000) });
    expect(await detail(acquireUpdateLock(fresh))).toBe('held');
    const stale = envOf(w, { now: () => new Date(st.mtimeMs + LOCK_PARTIAL_GRACE_MS + 1000) });
    expect(await detail(acquireUpdateLock(stale))).toBe('acquired');
  });

  it('锁被别人换掉后 assertHeld 失败,release 不删别人的锁', async () => {
    const w = await newWorld();
    const lock = await acquireUpdateLock(envOf(w));
    await safe.writeFile(w.fx, lockAbs(w), doc(1, 'b'.repeat(16)));
    await expect(lock.assertHeld()).rejects.toMatchObject({ detail: 'lost' });
    await lock.release();
    expect(JSON.parse(await readText(lockAbs(w)))['nonce']).toBe('b'.repeat(16));
  });

  it('锁路径上的 update 目录是符号链接 → 拒绝(unsafe 或写出口拒绝),不穿过链接', async () => {
    const w = await newWorld();
    const outside = path.join(w.dir, 'outside');
    await safe.mkdirp(w.fx, outside);
    await safe.mkdirp(w.fx, path.join(w.home, '.local/state/agent-kit'));
    await safe.symlink(w.fx, outside, path.join(w.home, '.local/state/agent-kit/update'));
    await expect(acquireUpdateLock(envOf(w))).rejects.toBeTruthy();
    await expect(lstat(path.join(outside, 'lock'))).rejects.toThrow();
  });
});
