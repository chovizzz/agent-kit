/**
 * R20-A2 B5b:STOP 的 lstat 失败(非 ENOENT)——B5a 的 `observeStop` 对此返回「全零身份 + sha256:null 并当作在场」。
 * 两次这样的观测得到**相同**的假指纹;confirm 不得把它当作「STOP 没变」而放行(否则会走到写 state)。
 * 单独成文件:`vi.mock` 包住 read-fs 的 lstat,只对以 `/rsi/STOP` 结尾的路径、且开关打开时抛 EIO,其余原样转发。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { exists } from '../../src/io/read-fs.js';
import { chmod, writeFile } from '../../src/io/safe-fs.js';
import { runConfirm } from '../../src/rsi/confirm.js';
import { displayFingerprint, observeRsi } from '../../src/rsi/services/observe.js';
import { treeOf } from './rsi-fixture.js';
import { makeTickFx, runCmd, type TickFx } from './b5a-fixture.js';

const inject = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/io/read-fs.js', async (orig) => {
  const m = await orig<typeof import('../../src/io/read-fs.js')>();
  return {
    ...m,
    lstat: (async (p: string) => {
      if (inject.on && p.endsWith('/rsi/STOP')) {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return m.lstat(p);
    }) as typeof m.lstat,
  };
});

async function stoppedFx(prefix: string): Promise<TickFx> {
  const f = await makeTickFx(prefix, { confirmed: true });
  const stop = path.join(f.rsiDir, 'STOP');
  await writeFile(f.io, stop, '{"at":"2026-10-26T00:00:00.000Z","by":"user"}', { mode: 0o600 });
  await chmod(f.io, stop, 0o600);
  return f;
}

describe('STOP lstat 失败(假身份)', () => {
  it('正向前提:两次「读失败」的展示指纹逐字节相同(这正是不能放行的原因);与真实身份的指纹不同', async () => {
    const f = await stoppedFx('cfs-fp-');
    inject.on = false;
    const real = displayFingerprint(await observeRsi(f.io, f.env));
    inject.on = true;
    try {
      const o1 = await observeRsi(f.io, f.env);
      const o2 = await observeRsi(f.io, f.env);
      expect(o1.stop).toEqual({ dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0, sha256: null });
      expect(displayFingerprint(o1)).toBe(displayFingerprint(o2));
      expect(displayFingerprint(o1)).not.toBe(real);
    } finally {
      inject.on = false;
    }
  });

  it('STOP lstat 一直失败(每个观测点都是同一个假指纹)→ 3 state_dir_unsafe,零写入,不读输入,状态与 STOP 不动', async () => {
    const f = await stoppedFx('cfs-all-');
    const before = await treeOf(f.dir);
    inject.on = true;
    let reads = 0;
    try {
      const r = await runCmd(
        f,
        runConfirm,
        [],
        {},
        { isTty: true, readLine: async () => (reads++, 'yes') },
      );
      expect([r.code, r.err, r.out]).toEqual([3, 'RSI_FAIL_CLOSED reason=state_dir_unsafe\n', '']);
    } finally {
      inject.on = false;
    }
    expect(reads).toBe(0);
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
    expect(await exists(path.join(f.rsiDir, 'STOP'))).toBe(true);
  });

  it('展示之后才开始失败:等待输入期间(锁前)与拿锁之后各一次 → 都是 3(不是 1 STALE,也不是成功);拿锁之后的拒绝只有锁文件写', async () => {
    const a = await stoppedFx('cfs-wait-');
    let flip = false;
    try {
      const r = await runCmd(
        a,
        runConfirm,
        [],
        {},
        { isTty: true, readLine: async () => ((inject.on = true), (flip = true), 'yes') },
      );
      expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=state_dir_unsafe\n']);
    } finally {
      inject.on = false;
    }
    expect(flip).toBe(true);
    expect(a.audit).toEqual([]);
    const b = await stoppedFx('cfs-lock-');
    try {
      const r = await runCmd(
        b,
        runConfirm,
        [],
        { afterLock: () => void (inject.on = true) },
        { isTty: true, readLine: async () => 'yes' },
      );
      expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=state_dir_unsafe\n']);
    } finally {
      inject.on = false;
    }
    expect(b.audit.filter((c) => c.op !== 'mkdirp').map((c) => c.op)).toEqual([
      'createExclusive',
      'remove',
    ]);
  });
});
