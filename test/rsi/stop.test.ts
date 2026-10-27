/**
 * R20-A2 B3a:`rsi stop`(docs/contracts.md §20.3.7 R20-3.7.1)。不拿锁、独占创建 STOP、已存在退 0、配置不可用 `stop noop`。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RsiStopMarkSchema } from '../../src/contracts/rsi.js';
import { lstat, readText } from '../../src/io/read-fs.js';
import { chmod, hardlink, mkdirp, symlink, writeFile } from '../../src/io/safe-fs.js';
import { acquireRsiLock } from '../../src/rsi/lock.js';
import { runStop, type RsiStopDeps } from '../../src/rsi/stop.js';
import { treeOf } from './rsi-fixture.js';
import {
  NOW,
  makeRoFx,
  runDirect,
  runMain,
  seed,
  baseState,
  setExtra,
  type RoFx,
} from './ro-fixture.js';

const T = new Date(NOW);
const direct = (f: RoFx, argv: string[] = []) =>
  runDirect(f, runStop, argv, { now: () => T } satisfies RsiStopDeps);
const stopFile = (f: RoFx): string => path.join(f.io.stateDir, 'rsi', 'STOP');

describe('R20-3.7.1 rsi stop', () => {
  it('配置 off:退出 0,stdout `stop noop reason=<码>`,零写入、不建任何目录', async () => {
    const f = await makeRoFx('stop-off-');
    await setExtra(f, '');
    await writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 });
    const before = await treeOf(f.dir);
    const r = await runMain(f, ['rsi', 'stop']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('stop noop reason=disabled\n');
    expect(r.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('首次:建 STOP(0600,内容 {at, by:"user"},at 来自注入时钟);rsi/ 缺失时一并建(0700);不建锁 / 清单 / 其它文件', async () => {
    const f = await makeRoFx('stop-first-');
    const r = await direct(f);
    expect(r.code).toBe(0);
    expect(r.out).toBe('stop ok\n');
    const mark = RsiStopMarkSchema.parse(JSON.parse(await readText(stopFile(f))));
    expect(mark).toEqual({ at: NOW, by: 'user' });
    expect((await lstat(stopFile(f))).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(stopFile(f)))).mode & 0o777).toBe(0o700);
    expect((await treeOf(f.io.stateDir)).map((l) => l.split(' ')[0])).toEqual(['rsi/', 'rsi/STOP']);
    // 写调用审计:只有建目录与 STOP 的独占创建(没有 rename / remove / appendFile)
    expect(new Set(r.audit.map((a) => a.op))).toEqual(
      new Set(
        ['mkdirp', 'chmod', 'createExclusive'].filter((o) => r.audit.some((a) => a.op === o)),
      ),
    );
    expect(r.audit.some((a) => a.op === 'createExclusive' && a.path.endsWith('/rsi/STOP'))).toBe(
      true,
    );
    expect(
      r.audit.some((a) => ['rename', 'remove', 'appendFile', 'writeFile'].includes(a.op)),
    ).toBe(false);
  });

  it('已存在:退出 0、`stop ok already`,内容与时间戳不被重写', async () => {
    const f = await makeRoFx('stop-twice-');
    await direct(f);
    const before = await readText(stopFile(f));
    const m1 = (await lstat(stopFile(f))).mtimeMs;
    const r = await runDirect(f, runStop, [], { now: () => new Date('2030-01-01T00:00:00Z') });
    expect(r.code).toBe(0);
    expect(r.out).toBe('stop ok already\n');
    expect(await readText(stopFile(f))).toBe(before);
    expect((await lstat(stopFile(f))).mtimeMs).toBe(m1);
  });

  it('不拿 rsi/lock:另一个持锁方在世时 stop 照样成功,且不碰它的锁文件', async () => {
    const f = await makeRoFx('stop-nolock-');
    await seed(f, { state: baseState() });
    const lock = await acquireRsiLock(f.io);
    try {
      const lockFile = path.join(f.io.stateDir, 'rsi', 'lock');
      const before = await readText(lockFile);
      const r = await direct(f);
      expect(r.code).toBe(0);
      expect(r.out).toBe('stop ok\n');
      expect(await readText(lockFile)).toBe(before);
      await lock.assertHeld(); // 持锁方仍持有
      expect(r.audit.some((a) => a.path.endsWith('/rsi/lock'))).toBe(false);
    } finally {
      await lock.release();
    }
  });

  it('STOP 位置上已有任何对象(目录 / 指向根内或根外的符号链接 / 悬空链接 / 硬链接)→ 视为已存在:退出 0、不改、不跟随;status 同样判 stopped', async () => {
    const mk = async (): Promise<RoFx> => {
      const f = await makeRoFx('stop-odd-');
      await seed(f, { state: baseState() });
      return f;
    };
    const check = async (f: RoFx, kind: string): Promise<void> => {
      const r = await direct(f);
      expect([r.code, r.out, r.err], kind).toEqual([0, 'stop ok already\n', '']);
      expect(r.audit, kind).toEqual([]); // 零写入:不 mkdirp、不 chmod、不 createExclusive
      const st = JSON.parse((await runMain(f, ['rsi', 'status', '--json'])).out) as {
        state: string;
      };
      expect(st.state, kind).toBe('stopped');
    };
    const d = await mk();
    await mkdirp(d.io, stopFile(d), 0o700);
    await check(d, 'dir');

    const inside = await mk();
    const target = path.join(inside.io.stateDir, 'rsi', 'other.json');
    await writeFile(inside.io, target, 'x', { mode: 0o600 });
    await symlink(inside.io, target, stopFile(inside));
    await check(inside, 'symlink-inside');
    expect(await readText(target)).toBe('x'); // 目标不变

    const out = await mk();
    await writeFile(out.fx, path.join(out.dir, 'target'), 'x', { mode: 0o600 });
    await symlink(out.fx, path.join(out.dir, 'target'), stopFile(out));
    await check(out, 'symlink-outside');
    expect(await readText(path.join(out.dir, 'target'))).toBe('x');

    const dang = await mk();
    await symlink(dang.fx, path.join(dang.dir, 'nowhere'), stopFile(dang));
    await check(dang, 'dangling');

    const h = await mk();
    await writeFile(h.fx, path.join(h.dir, 'orig'), 'x', { mode: 0o600 });
    await hardlink(h.fx, path.join(h.dir, 'orig'), stopFile(h));
    await check(h, 'hardlink');
    expect(await readText(path.join(h.dir, 'orig'))).toBe('x');
  });

  it('已存在的 rsi/ 权限宽于 0700 → 3 state_dir_unsafe,不自动收紧(权限位不变),零写入', async () => {
    const f = await makeRoFx('stop-perm-');
    await seed(f, { state: baseState() });
    const dir = path.join(f.io.stateDir, 'rsi');
    await chmod(f.io, dir, 0o755);
    const r = await direct(f);
    expect([r.code, r.out, r.err]).toEqual([3, '', 'RSI_FAIL_CLOSED reason=state_dir_unsafe\n']);
    expect(r.audit).toEqual([]);
    expect((await lstat(dir)).mode & 0o777).toBe(0o755);
  });

  it('rsi/ 已存在且合规:首次 stop 的写调用审计只有 STOP 的独占创建(不 mkdirp、不 chmod);缺 rsi/ 时才多出建目录', async () => {
    const f = await makeRoFx('stop-audit-');
    await seed(f, { state: baseState() });
    const r = await direct(f);
    expect(r.audit.map((a) => a.op)).toEqual(['createExclusive']);
    const g = await makeRoFx('stop-audit-missing-');
    const r2 = await direct(g);
    expect(r2.audit.map((a) => a.op)).toEqual(['mkdirp', 'mkdirp', 'createExclusive']); // .state、.state/rsi、STOP
  });

  it('rsi/ 是符号链接 → 3 state_dir_unsafe,不顺着链接写', async () => {
    const f = await makeRoFx('stop-linkdir-');
    await mkdirp(f.io, f.io.stateDir, 0o700);
    await mkdirp(f.fx, path.join(f.dir, 'elsewhere'), 0o700);
    await symlink(f.fx, path.join(f.dir, 'elsewhere'), path.join(f.io.stateDir, 'rsi'));
    const r = await direct(f);
    expect(r.code).toBe(3);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=state_dir_unsafe\n');
    expect((await treeOf(path.join(f.dir, 'elsewhere'))).length).toBe(0);
  });

  it('参数:任何参数 → 2 unknown_arg;--root 不符 → 2 root_mismatch;均零写入', async () => {
    const f = await makeRoFx('stop-args-');
    const before = await treeOf(f.dir);
    const a = await runMain(f, ['rsi', 'stop', '--force']);
    expect([a.code, a.err]).toEqual([2, 'RSI_USAGE reason=unknown_arg\n']);
    const other = path.join(f.dir, 'other');
    await mkdirp(f.fx, other, 0o755);
    const b = await runMain(f, ['--root', other, 'rsi', 'stop']);
    expect([b.code, b.err]).toEqual([2, 'RSI_USAGE reason=root_mismatch\n']);
    expect(a.audit).toEqual([]);
    expect(b.audit).toEqual([]);
    expect((await treeOf(f.dir)).filter((l) => !l.startsWith('other'))).toEqual(
      before.filter((l) => !l.startsWith('other')),
    );
  });

  it('经 status 看到:stop 之后下一次 status 是 stopped,stop.at 与标记一致', async () => {
    const f = await makeRoFx('stop-status-');
    await direct(f);
    const s = JSON.parse((await runMain(f, ['rsi', 'status', '--json'])).out) as {
      state: string;
      stop: { present: boolean; at: string };
    };
    expect(s.state).toBe('stopped');
    expect(s.stop).toEqual({ present: true, at: NOW });
  });
});
