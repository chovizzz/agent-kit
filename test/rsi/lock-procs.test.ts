/**
 * R20 A1:`rsi/lock` 的真进程测试(docs/contracts.md §20.5 / §20.8.2 A1 行)。
 *  - 并发写入方第二个报占用、无交错写(读-改-写不丢更新);
 *  - SIGKILL 持锁进程后被回收(只杀本测试自己起的子进程,按 pid);
 *  - 盐首建:多个进程同时首建只得一个盐(R20 §20.9 第 8 条)。
 * 子进程入口 test/rsi/proc/child-entry.ts 由 vite 打成单文件再用 node 跑(不依赖 .ts 加载器)。
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRealHome } from '../../src/io/paths.js';
import { exists, lstat, readDir, readText } from '../../src/io/read-fs.js';
import { RsiLockError, acquireRsiLock } from '../../src/rsi/lock.js';
import { SALT_RE } from '../../src/signals/ids.js';
import { makeTempDir } from '../helpers/tmp.js';
import { newWork } from '../signals/helpers.js';
import { buildChild, runChild, startChild } from './proc/helper.js';

let script = '';
let homeBefore: string[] = [];

/** 真实 HOME 里 kit 相关目录的粗快照(名字 + 大小 + mtime):测试前后必须一致 */
async function homeSnap(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let ents;
    try {
      ents = await readDir(dir);
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const st = await lstat(p).catch(() => undefined);
      if (st === undefined) continue;
      out.push(`${p}:${st.size}:${st.mtimeMs}`);
      if (e.isDirectory && depth < 4) await walk(p, depth + 1);
    }
  };
  const home = getRealHome();
  await walk(path.join(home, '.local', 'state', 'agent-kit'), 0);
  await walk(path.join(home, '.config', 'agent-kit'), 0);
  return out;
}

beforeAll(async () => {
  homeBefore = await homeSnap();
  const { dir } = await makeTempDir('rl-build-');
  script = await buildChild(dir);
}, 120_000);

afterAll(async () => {
  expect(await homeSnap()).toEqual(homeBefore); // 真 HOME 未变
});

describe('R20-5.1 / 5.5 进程级', () => {
  it('持锁的真子进程在时:本进程与另一个子进程都被拒(locked),锁文件不变', async () => {
    const w = await newWork('rlp-held-');
    const holder = startChild(script, { op: 'hold', tmp: w.dir, state: w.state });
    try {
      const first = JSON.parse(await holder.firstLine()) as { held?: boolean; pid: number };
      expect(first.held).toBe(true);
      const before = await readText(path.join(w.state, 'rsi', 'lock'));
      const e = await acquireRsiLock(w.io).catch((x: unknown) => x);
      expect((e as RsiLockError).kind).toBe('locked');
      expect(await runChild(script, { op: 'try', tmp: w.dir, state: w.state })).toEqual([
        { got: false, kind: 'locked' },
      ]);
      expect(await readText(path.join(w.state, 'rsi', 'lock'))).toBe(before);
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
  });

  it('SIGKILL 持锁子进程后,锁被回收(pid 不存在 = ESRCH),随后能正常拿锁释放', async () => {
    const w = await newWork('rlp-kill-');
    const holder = startChild(script, { op: 'hold', tmp: w.dir, state: w.state });
    const first = JSON.parse(await holder.firstLine()) as { pid: number; nonce: string };
    expect(holder.child.pid).toBe(first.pid);
    holder.child.kill('SIGKILL'); // 只杀自己起的子进程,按 pid
    await holder.exited;
    expect(await exists(path.join(w.state, 'rsi', 'lock'))).toBe(true); // 死进程留下了锁文件
    const lock = await acquireRsiLock(w.io); // 真 isAlive:ESRCH → 回收
    expect(lock.nonce).not.toBe(first.nonce);
    expect(JSON.parse(await readText(path.join(w.state, 'rsi', 'lock')))['pid']).toBe(process.pid);
    await lock.release();
    expect(await exists(path.join(w.state, 'rsi', 'lock'))).toBe(false);
  });

  it('4 个进程并发做「读-改-写」,各拿锁 12 轮:一行都不丢(无交错写)', async () => {
    const w = await newWork('rlp-writers-');
    const shared = path.join(w.dir, 'shared.txt');
    const ids = ['a', 'b', 'c', 'd'];
    const runs = ids.map((id) =>
      runChild(script, { op: 'writer', tmp: w.dir, state: w.state, id, rounds: 12, shared }),
    );
    const results = await Promise.all(runs);
    for (const r of results) expect(r).toEqual([{ done: true }]);
    const lines = (await readText(shared)).split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(ids.length * 12);
    expect(new Set(lines).size).toBe(ids.length * 12);
    expect(await exists(path.join(w.state, 'rsi', 'lock'))).toBe(false);
  }, 60_000);
});

describe('R20 §20.9#8 盐首建经 createExclusive', () => {
  it('同一时刻 6 个进程首建盐,重复 8 轮:每轮只得一个盐,且等于落盘的那份', async () => {
    for (let round = 0; round < 8; round++) {
      const w = await newWork(`rlp-salt${round}-`);
      const startAt = Date.now() + 700; // 全部子进程在同一时刻开跑
      const runs = Array.from({ length: 6 }, () =>
        runChild(script, { op: 'salt', tmp: w.dir, state: w.state, startAt }),
      );
      const raw = await Promise.all(runs);
      const outs = raw.map((r) => (r[0] as { salt?: string }).salt);
      // 失败时带上 6 个子进程的原始输出,偶发红能直接看到是哪个错误码
      for (const s of outs) expect(s, JSON.stringify(raw)).toMatch(SALT_RE);
      expect(new Set(outs).size).toBe(1);
      expect((await readText(path.join(w.state, 'salt'))).trim()).toBe(outs[0]);
      expect(((await lstat(path.join(w.state, 'salt'))).mode & 0o777).toString(8)).toBe('600');
    }
  }, 120_000);
});
