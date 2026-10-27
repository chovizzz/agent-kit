/**
 * R20-A2 B5b:STOP 的 lstat 失败(非 ENOENT)——B5a 的 `observeStop` 对此返回「全零身份 + sha256:null 并当作在场」。
 * 两次这样的观测得到**相同**的假指纹;confirm 不得把它当作「STOP 没变」而放行(否则会走到写 state)。
 * 单独成文件:`vi.mock` 包住 read-fs 的 lstat,只对以 `/rsi/STOP` 结尾的路径、且开关打开时抛 EIO,其余原样转发。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { chmod, remove, writeFile } from '../../src/io/safe-fs.js';
import { runConfirm } from '../../src/rsi/confirm.js';
import { displayFingerprint, observeRsi } from '../../src/rsi/services/observe.js';
import { treeOf } from './rsi-fixture.js';
import { makeTickFx, runCmd, type TickFx } from './b5a-fixture.js';

const inject = vi.hoisted(() => ({
  on: false,
  /** 武装后:先放行 `skip` 次对 STOP 的 lstat,下一次先执行 `hook`(可真的删掉 STOP)再抛 ENOENT(模拟「观测之后 STOP 恰好被删」) */
  arm: null as null | { skip: number; hook: () => Promise<void> },
}));
vi.mock('../../src/io/read-fs.js', async (orig) => {
  const m = await orig<typeof import('../../src/io/read-fs.js')>();
  return {
    ...m,
    lstat: (async (p: string) => {
      if (inject.arm !== null && p.endsWith('/rsi/STOP')) {
        if (inject.arm.skip > 0) inject.arm.skip--;
        else {
          const { hook } = inject.arm;
          inject.arm = null;
          await hook();
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      }
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

describe('STOP 在观测之后恰好被用户删掉(lstat 遇 ENOENT)——固定结果,没有未映射异常', () => {
  it('锁前(commit 之前):形状检查的 lstat 遇 ENOENT 且 STOP 真被删了 → 按 absent 重观测:旧确认记录有效 → 0 `confirm already`,零写入,不是 3 internal', async () => {
    const f = await stoppedFx('cfs-gone-pre-');
    const stop = path.join(f.rsiDir, 'STOP');
    inject.arm = { skip: 1, hook: () => remove(f.fx, stop) }; // obs0:observeStop 放行,形状 lstat 时 STOP 消失
    try {
      const r = await runCmd(f, runConfirm, [], {}, { isTty: true, readLine: async () => 'yes' });
      expect([r.code, r.err, r.out]).toEqual([0, '', 'confirm already\n']);
    } finally {
      inject.arm = null;
    }
    expect(f.audit).toEqual([]);
  });

  it('锁前:ENOENT 是瞬时的(STOP 仍在)→ 重观测后正常通过,confirm 成功', async () => {
    const f = await stoppedFx('cfs-gone-blip-');
    inject.arm = { skip: 1, hook: async () => undefined };
    try {
      const r = await runCmd(f, runConfirm, [], {}, { isTty: true, readLine: async () => 'yes' });
      expect([r.code, r.err]).toEqual([0, '']);
    } finally {
      inject.arm = null;
    }
    expect(await exists(path.join(f.rsiDir, 'STOP'))).toBe(false);
  });

  it('commit 之后:删除前的再次 lstat 遇 ENOENT(STOP 已被删)→ 视为已删:0 `confirm ok`,STOP 不在,记录已写入,快照一致;stdout / 退出码固定', async () => {
    const f = await stoppedFx('cfs-gone-post-');
    const stop = path.join(f.rsiDir, 'STOP');
    const r = await runCmd(
      f,
      runConfirm,
      [],
      {
        beforeWrite: async (op) => {
          // snapshot-rename 之后的第一次 STOP lstat 是 removeStopIfSame 里的 observeStop(放行),第二次才是形状 lstat
          if (op === 'snapshot-rename') inject.arm = { skip: 1, hook: () => remove(f.fx, stop) };
        },
      },
      { isTty: true, readLine: async () => 'yes' },
    );
    inject.arm = null;
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out.endsWith('confirm ok\n')).toBe(true);
    expect(r.out).not.toContain('confirm recorded');
    expect(await exists(stop)).toBe(false);
    const st = JSON.parse(await readText(path.join(f.rsiDir, 'state.json'))) as {
      confirm: { baseline_pending: boolean };
    };
    expect(st.confirm.baseline_pending).toBe(true);
    expect((await inspectSnapshot(f.io, productionSnapshotValidator)) === 'consistent').toBe(true);
  });
});
