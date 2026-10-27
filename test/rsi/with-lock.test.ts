/**
 * R20-A2 B3-0:`withRsiLockIfGated`(lockGate + withRsiLock 的组合)的 off / lock / refuse 三态。
 * 全部对着真实目录与真实配置;零写入用「写审计钩子计数」(操作发生)与「目录树前后对比」(最终状态)两类断言分开证明。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { loadRsiConfig, type RsiConfig, type RsiConfigOn } from '../../src/rsi/config.js';
import { createRsiIoContext } from '../../src/rsi/io.js';
import { RsiLockError } from '../../src/rsi/lock.js';
import { RsiFailClosedError } from '../../src/rsi/types.js';
import { withRsiLockIfGated } from '../../src/rsi/with-lock.js';
import { exists, readText, realpath } from '../../src/io/read-fs.js';
import { mkdirp, remove as rm, symlink, writeFile } from '../../src/io/safe-fs.js';
import type { IoContext } from '../../src/io/paths.js';
import { makeRsiFx, rsiToml, treeOf, writeCfg, type RsiFx } from './rsi-fixture.js';

interface Setup {
  f: RsiFx;
  cfg: RsiConfigOn;
  io: IoContext;
  audit: string[];
  lockFile: string;
}

async function setup(prefix: string): Promise<Setup> {
  const f = await makeRsiFx(prefix);
  await writeCfg(f, rsiToml(f));
  const cfg = await loadRsiConfig({ home: f.home });
  if (cfg.status !== 'on') throw new Error(`off(${cfg.reason})`);
  const audit: string[] = [];
  const io = createRsiIoContext({
    repo: f.repo,
    env: { KIT_TMP: f.dir, PATH: '/usr/bin:/bin' },
    cwd: f.repo,
    writeAudit: (op, p) => void audit.push(`${op} ${p}`),
  });
  return { f, cfg, io, audit, lockFile: path.join(f.repo, '.state', 'rsi', 'lock') };
}

describe('withRsiLockIfGated', () => {
  it('off:fn 收到 null、返回值原样传出、不建 .state / rsi/、写审计零调用', async () => {
    const s = await setup('wl-off-');
    const off: RsiConfig = { status: 'off', reason: 'disabled' };
    const before = await treeOf(s.f.dir);
    const got = await withRsiLockIfGated({ io: s.io, config: off }, async (lock) => {
      expect(lock).toBeNull();
      return 42;
    });
    expect(got).toBe(42);
    expect(s.audit).toEqual([]);
    expect(await exists(path.join(s.f.repo, '.state'))).toBe(false);
    expect(await treeOf(s.f.dir)).toEqual(before);
  });

  it('off:独立状态树(on,但现有命令的状态目录与 rsi 树确定独立)同样不拿锁', async () => {
    const s = await setup('wl-indep-');
    const other = path.join(s.f.dir, 'other-state');
    const io = { ...s.io, stateDir: other };
    const got = await withRsiLockIfGated({ io, config: s.cfg }, async (lock) => lock);
    expect(got).toBeNull();
    expect(await exists(other)).toBe(false);
    expect(await exists(path.join(s.f.repo, '.state'))).toBe(false);
    expect(s.audit).toEqual([]);
  });

  it('off:fn 抛错原样传出,不被吞', async () => {
    const s = await setup('wl-off-throw-');
    const boom = new Error('boom');
    await expect(
      withRsiLockIfGated({ io: s.io, config: { status: 'off', reason: 'absent' } }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('lock:fn 收到句柄、锁文件在持有期间存在、返回后已释放;返回值原样传出', async () => {
    const s = await setup('wl-lock-');
    const got = await withRsiLockIfGated({ io: s.io, config: s.cfg }, async (lock) => {
      expect(lock).not.toBeNull();
      expect(lock?.path).toBe(await realLockPath(s));
      expect(await exists(s.lockFile)).toBe(true);
      await lock?.assertHeld();
      return 'ok';
    });
    expect(got).toBe('ok');
    expect(await exists(s.lockFile)).toBe(false);
  });

  it('lock:fn 抛错也释放锁,错误原样传出', async () => {
    const s = await setup('wl-lock-throw-');
    const boom = new Error('boom');
    await expect(
      withRsiLockIfGated({ io: s.io, config: s.cfg }, async () => {
        expect(await exists(s.lockFile)).toBe(true);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await exists(s.lockFile)).toBe(false);
  });

  it('lock:别人持锁 → RsiLockError(locked),fn 不调用,他人的锁文件不被改动或删除', async () => {
    const s = await setup('wl-lock-busy-');
    await mkdirp(s.io, path.dirname(s.lockFile), 0o700);
    const doc = canonicalJson({
      pid: 999_999,
      started_at: new Date().toISOString(),
      nonce: 'aaaaaaaaaaaaaaaa',
      kit_version: '0.0.0',
    });
    await writeFile(s.io, s.lockFile, doc, { mode: 0o600 });
    let called = false;
    const err = await withRsiLockIfGated(
      { io: s.io, config: s.cfg },
      async () => {
        called = true;
      },
      { lock: { isAlive: () => true } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RsiLockError);
    expect((err as RsiLockError).toStable()).toEqual({
      code: 'RSI_NOT_RUN',
      reason: 'locked',
      exit: 4,
    });
    expect(called).toBe(false);
    expect(await readText(s.lockFile)).toBe(doc);
  });

  it('lock:同进程内嵌套再取同一把锁 = 编程错误(RsiLockError internal),外层的锁不受影响', async () => {
    const s = await setup('wl-lock-nested-');
    await withRsiLockIfGated({ io: s.io, config: s.cfg }, async (outer) => {
      const err = await withRsiLockIfGated({ io: s.io, config: s.cfg }, async () => 1).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RsiLockError);
      expect((err as RsiLockError).kind).toBe('internal');
      await outer?.assertHeld();
    });
    expect(await exists(s.lockFile)).toBe(false);
  });

  it('lock:持有者存活但超过 TTL → locked_over_ttl 原样上抛(RSI_NOT_RUN,退出 4),不杀不删', async () => {
    const s = await setup('wl-lock-ttl-');
    await mkdirp(s.io, path.dirname(s.lockFile), 0o700);
    const doc = canonicalJson({
      pid: 999_999,
      started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      nonce: 'bbbbbbbbbbbbbbbb',
      kit_version: '0.0.0',
    });
    await writeFile(s.io, s.lockFile, doc, { mode: 0o600 });
    const err = await withRsiLockIfGated({ io: s.io, config: s.cfg }, async () => 1, {
      lock: { isAlive: () => true },
    }).catch((e: unknown) => e);
    expect((err as RsiLockError).toStable()).toEqual({
      code: 'RSI_NOT_RUN',
      reason: 'locked_over_ttl',
      exit: 4,
    });
    expect(await readText(s.lockFile)).toBe(doc);
  });

  it('lock:持锁期间锁文件被换掉 → assertHeld 抛 lock_lost,错误原样传出,释放不删他人的锁', async () => {
    const s = await setup('wl-lock-lost-');
    const foreign = canonicalJson({
      pid: 999_999,
      started_at: new Date().toISOString(),
      nonce: 'cccccccccccccccc',
      kit_version: '0.0.0',
    });
    const err = await withRsiLockIfGated({ io: s.io, config: s.cfg }, async (lock) => {
      await writeFile(s.io, s.lockFile, foreign, { mode: 0o600 });
      await lock?.assertHeld();
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RsiLockError);
    expect((err as RsiLockError).kind).toBe('lock_lost');
    expect(await readText(s.lockFile)).toBe(foreign);
  });

  it('gate 选项(解析之间路径被换)经包装器透传:不稳定 → refuse,fn 不调用', async () => {
    const s = await setup('wl-gate-hook-');
    const link = path.join(s.f.dir, 'swap');
    await symlink(s.f.fx, path.join(s.f.dir, 'one'), link).catch(() => undefined);
    let called = false;
    let flipped = false;
    const hooks = {
      betweenResolves: async (): Promise<void> => {
        if (flipped) return;
        flipped = true;
        await mkdirp(s.io, path.join(s.f.dir, 'two'), 0o700);
        await rm(s.io, link);
        await symlink(s.f.fx, path.join(s.f.dir, 'two'), link);
      },
    };
    await mkdirp(s.io, path.join(s.f.dir, 'one'), 0o700);
    const io = { ...s.io, stateDir: path.join(link, 'st') };
    await expect(
      withRsiLockIfGated(
        { io, config: s.cfg },
        async () => {
          called = true;
        },
        { gate: { hooks } },
      ),
    ).rejects.toMatchObject({ reason: 'state_dir_unsafe' });
    expect(called).toBe(false);
  });

  it('refuse(状态目录是悬空符号链接):抛 RSI_FAIL_CLOSED state_dir_unsafe、fn 不调用、零写入', async () => {
    const s = await setup('wl-refuse-');
    const dangling = path.join(s.f.dir, 'dangling');
    await symlink(s.f.fx, path.join(s.f.dir, 'nothing-here'), dangling);
    const io = { ...s.io, stateDir: dangling };
    const before = await treeOf(s.f.dir);
    s.audit.length = 0;
    let called = false;
    const err = await withRsiLockIfGated({ io, config: s.cfg }, async () => {
      called = true;
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RsiFailClosedError);
    expect((err as RsiFailClosedError).toStable()).toEqual({
      code: 'RSI_FAIL_CLOSED',
      reason: 'state_dir_unsafe',
      exit: 3,
    });
    expect(called).toBe(false);
    expect(s.audit).toEqual([]);
    expect(await treeOf(s.f.dir)).toEqual(before);
  });

  it('refuse(状态目录是 rsi 树的父目录):同样 refuse,且已有内容不被改动', async () => {
    const s = await setup('wl-refuse-parent-');
    const marker = path.join(s.f.repo, 'keep.txt');
    await writeFile(s.io, marker, 'keep', { mode: 0o600 });
    const io = { ...s.io, stateDir: s.f.repo };
    const before = await treeOf(s.f.dir);
    s.audit.length = 0;
    await expect(withRsiLockIfGated({ io, config: s.cfg }, async () => 1)).rejects.toBeInstanceOf(
      RsiFailClosedError,
    );
    expect(s.audit).toEqual([]);
    expect(await treeOf(s.f.dir)).toEqual(before);
  });

  it('refuse(平台不支持,经 gate 选项注入):不降级为 off', async () => {
    const s = await setup('wl-refuse-platform-');
    await expect(
      withRsiLockIfGated({ io: s.io, config: s.cfg }, async () => 1, {
        gate: { platformSupported: false },
      }),
    ).rejects.toMatchObject({ code: 'RSI_FAIL_CLOSED', reason: 'state_dir_unsafe' });
    expect(await exists(path.join(s.f.repo, '.state'))).toBe(false);
  });
});

async function realLockPath(s: Setup): Promise<string> {
  return path.join(await realpath(path.join(s.f.repo, '.state')), 'rsi', 'lock');
}
