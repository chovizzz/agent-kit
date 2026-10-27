/**
 * R20-A2 B5c 验收返工:tick 路径的稳定码(`staging_unsafe_entry` / `write_denied` 不被吞成 internal / purge_incomplete)、
 * 月文件重写崩溃遗留的 `<yyyymm>.jsonl.tmp` 对快照协议无害且可恢复。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists } from '../../src/io/read-fs.js';
import { hardlink, mkdirp, symlink } from '../../src/io/safe-fs.js';
import { stableOf } from '../../src/rsi/exit.js';
import { recoverUnderLock } from '../../src/rsi/services/commit.js';
import { readPurgeJournal } from '../../src/rsi/services/purge-journal.js';
import { RsiStagingBlockedError } from '../../src/rsi/services/staging.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { runTick } from '../../src/rsi/tick.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { runCmd } from './b5a-fixture.js';
import { CrashError, withLock } from './services-fixture.js';
import { consistent, dataFingerprint, fixedNow, makeSc, purge, type Sc } from './b5c-fixture.js';

const tick = (sc: Sc): ReturnType<typeof runCmd> =>
  runCmd(sc.cf, runTick, ['--write'], { now: fixedNow });

async function crashedAt(sc: Sc, stage: string): Promise<void> {
  const c = await purge(sc, ['--excluded', '--write'], {
    beforePhase: (st) => {
      if (st === stage) throw new CrashError('x');
    },
  });
  expect(c.code).toBe(3);
}

describe('M1:RsiStagingBlockedError 的稳定码', () => {
  it('stableOf 把它映射成 RSI_FAIL_CLOSED reason=staging_unsafe_entry(退 3);其它未识别异常仍是 internal(不改变既有退出码)', () => {
    expect(stableOf(new RsiStagingBlockedError())).toEqual({
      line: 'RSI_FAIL_CLOSED reason=staging_unsafe_entry',
      exit: 3,
    });
    expect(stableOf(new Error('x'))).toEqual({ line: 'RSI_FAIL_CLOSED reason=internal', exit: 3 });
    // 形状相近但不是它(reason 不同)→ 不冒充
    expect(
      stableOf({ code: 'RSI_FAIL_CLOSED', reason: 'whatever', toStable: () => ({}) }).line,
    ).toBe('RSI_FAIL_CLOSED reason=internal');
  });

  it('tick 续做遇到暗藏硬链接的暂存条目 → 3 staging_unsafe_entry(不是 internal / purge_incomplete),journal 保留', async () => {
    const sc = await makeSc('rw-tick-blocked-', { state: 'confirmed' });
    await crashedAt(sc, 'tainted');
    const run = path.join(sc.s.state, 'reflect', 'run-ex');
    await hardlink(sc.s.f.fx, path.join(run, 'report.json'), path.join(run, 'stray.bin'));
    const r = await tick(sc);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=staging_unsafe_entry\n']);
    expect((await readPurgeJournal(sc.s.io)).state).toBe('present');
  });

  it('armed 的 tick(只补 taint)遇到同样的条目也是 staging_unsafe_entry', async () => {
    const sc = await makeSc('rw-tick-blocked-armed-');
    await crashedAt(sc, 'tainted');
    const run = path.join(sc.s.state, 'reflect', 'run-ex');
    await hardlink(sc.s.f.fx, path.join(run, 'report.json'), path.join(run, 'stray.bin'));
    const r = await tick(sc);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=staging_unsafe_entry\n']);
  });
});

describe('M2:tick 续做失败的报码', () => {
  async function withDeniedTmp(prefix: string): Promise<Sc> {
    const sc = await makeSc(prefix, { state: 'confirmed' });
    await crashedAt(sc, 'tainted');
    // 月文件的旧临时文件位置放一条悬空符号链接:safe-fs 守卫拒绝 → write_denied
    const tmp = path.join(sc.s.state, 'signals', 'claude', '202609.jsonl.tmp');
    await symlink(sc.s.f.fx, path.join(sc.s.f.dir, 'nowhere-at-all'), tmp);
    return sc;
  }

  it('safe-fs 守卫拒绝 → tick 3 write_denied(不吞成 purge_incomplete);purge --resume --write 同样 write_denied', async () => {
    const sc = await withDeniedTmp('rw-denied-');
    const r = await tick(sc);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=write_denied\n']);
    const p = await purge(sc, ['--resume', '--write']);
    expect([p.code, p.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=write_denied\n']);
    expect((await readPurgeJournal(sc.s.io)).state).toBe('present');
  });
});

describe('M3:月文件重写崩溃遗留的 .tmp', () => {
  for (const op of ['tmp-append', 'rename'] as const) {
    it(`崩在 month 写点「${op}」之前:遗留 <yyyymm>.jsonl.tmp,快照协议不判 invalid;--resume 完成、tmp 被清理、结果与不崩溃一致、第二遍零写入`, async () => {
      const ref = await makeSc('rw-tmp-ref-');
      expect((await purge(ref, ['--excluded', '--write'])).code).toBe(0);
      const refFp = await dataFingerprint(ref.s);

      const sc = await makeSc(`rw-tmp-${op}-`);
      // tmp-append 的写点路径是临时文件本身,rename 的是目标月文件
      const target = `month:signals/claude/202610.jsonl${op === 'rename' ? '' : '.tmp'}:${op}`;
      const c = await purge(sc, ['--excluded', '--write'], {
        beforeWrite: (name) =>
          name === target ? Promise.reject(new CrashError('x')) : Promise.resolve(),
      });
      expect(c.code, c.err).toBe(3);
      const tmp = path.join(sc.s.state, 'signals', 'claude', '202610.jsonl.tmp');
      expect(await exists(tmp), '正向前提:崩溃留下了 tmp').toBe(true);
      // (a) 快照协议容忍:inspect 不抛 snapshot_invalid;recover 通过
      await expect(inspectSnapshot(sc.s.io, productionSnapshotValidator)).resolves.toBeDefined();
      await withLock(sc.s, (lock) => recoverUnderLock(sc.s.ctx, lock));
      expect(await exists(tmp), 'recover 不碰它').toBe(true);
      // (b) 续做完成
      const r = await purge(sc, ['--resume', '--write']);
      expect(r.code, r.err).toBe(0);
      expect(await exists(tmp)).toBe(false);
      expect(await dataFingerprint(sc.s)).toEqual(refFp);
      expect(await consistent(sc.s)).toBe(true);
      sc.cf.audit.length = 0;
      const again = await purge(sc, ['--resume', '--write']);
      expect([again.code, again.err]).toEqual([4, 'RSI_NOT_RUN reason=no_journal\n']);
      expect(sc.cf.audit).toEqual([]);
    });
  }

  it('崩溃遗留 tmp 时,其它写入方(tick armed)也不被锁死', async () => {
    const sc = await makeSc('rw-tmp-tick-');
    await purge(sc, ['--excluded', '--write'], {
      beforeWrite: (name) =>
        name === 'month:signals/claude/202610.jsonl:rename'
          ? Promise.reject(new CrashError('x'))
          : Promise.resolve(),
    });
    await mkdirp(sc.s.f.fx, sc.s.rsi, 0o700);
    const r = await tick(sc);
    expect(r.code, r.err).toBe(0);
  });
});
