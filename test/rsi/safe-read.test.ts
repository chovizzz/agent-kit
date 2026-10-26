/**
 * R20 A1(docs/contracts.md §20.7 R20-7.2、§20.5 R20-5.6):读取前元数据校验、句柄级安全读取、恢复时「缺失文件」可判定、2000 项上限在枚举阶段执行。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_SNAPSHOT_MAX_FILES } from '../../src/contracts/rsi.js';
import { exists, lstat, readFileSafe, readText, statDirSafe } from '../../src/io/read-fs.js';
import { chmod, hardlink, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import { acquireRsiLock, peekRsiLock, type RsiLockHandle } from '../../src/rsi/lock.js';
import {
  RSI_SNAPSHOT_MAX_BYTES,
  commitSnapshot,
  readSnapshot,
  readVerified,
  recoverSnapshot,
} from '../../src/rsi/snapshot.js';
import { newWork, type Work } from '../signals/helpers.js';
import { mkfifo } from './proc/helper.js';

const rsiFile = (w: Work, n: string): string => path.join(w.state, 'rsi', n);
const STATE = JSON.stringify({ schema_version: 1 });
const mode = async (p: string): Promise<number> => (await lstat(p)).mode & 0o777;
const myUid = (): number => process.getuid?.() ?? 0;

async function put(w: Work, rel: string, text: string, m = 0o600): Promise<void> {
  const abs = rel.includes('/') ? path.join(w.state, rel) : rsiFile(w, rel);
  await mkdirp(w.io, path.dirname(abs), 0o700);
  await writeFile(w.io, abs, text, { mode: m });
}

async function withLock<T>(w: Work, fn: (l: RsiLockHandle) => Promise<T>): Promise<T> {
  const l = await acquireRsiLock(w.io);
  try {
    return await fn(l);
  } finally {
    await l.release();
  }
}

/** 把 file 换成符号链接(指向一个内容合法的真文件) */
async function swapToSymlink(w: Work, file: string): Promise<void> {
  const real = path.join(w.dir, 'swap-target.json');
  await writeFile(w.io, real, STATE, { mode: 0o600 });
  await remove(w.io, file);
  await symlink(w.io, real, file);
}

async function swapToFifo(w: Work, file: string): Promise<void> {
  await remove(w.io, file);
  void w;
  mkfifo(file);
}

describe('R20-7.2 句柄级安全读取原语(src/io/read-fs.ts)', () => {
  it('普通文件 0600 → ok,返回字节与句柄元数据', async () => {
    const w = await newWork('sr-ok-');
    const f = path.join(w.dir, 'a.json');
    await writeFile(w.io, f, 'hello', { mode: 0o600 });
    const r = await readFileSafe(f, { maxBytes: 100, owner: { maxPerm: 0o600 } });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.bytes.toString('utf8')).toBe('hello');
      expect(r.meta.nlink).toBe(1);
      expect(r.meta.uid).toBe(myUid());
    }
    expect(await readFileSafe(path.join(w.dir, 'none'), { maxBytes: 1 })).toEqual({
      kind: 'missing',
    });
  });

  it('属主不是期望 uid → unsafe/owner(变异:去掉 uid 检查 → 红)', async () => {
    const w = await newWork('sr-owner-');
    const f = path.join(w.dir, 'a.json');
    await writeFile(w.io, f, 'x', { mode: 0o600 });
    const r = await readFileSafe(f, { maxBytes: 10, owner: { maxPerm: 0o600, uid: myUid() + 1 } });
    expect(r).toEqual({ kind: 'unsafe', why: 'owner' });
    expect((await readFileSafe(f, { maxBytes: 10, owner: { maxPerm: 0o600, uid: myUid() } })).kind).toBe(
      'ok',
    );
  });

  it('权限宽于 0600 → unsafe/perm(0644、0620、带执行位的 0700 都拒;0400 / 0600 过);不提供 owner 策略则不看权限', async () => {
    const w = await newWork('sr-perm-');
    const f = path.join(w.dir, 'a.json');
    await writeFile(w.io, f, 'x', { mode: 0o600 });
    const read = (): ReturnType<typeof readFileSafe> =>
      readFileSafe(f, { maxBytes: 10, owner: { maxPerm: 0o600 } });
    for (const m of [0o644, 0o620, 0o640, 0o700, 0o601]) {
      await chmod(w.io, f, m);
      expect(await read(), m.toString(8)).toEqual({ kind: 'unsafe', why: 'perm' });
      expect((await readFileSafe(f, { maxBytes: 10 })).kind).toBe('ok');
      expect(await mode(f)).toBe(m); // 只读校验绝不收紧
    }
    for (const m of [0o400, 0o600]) {
      await chmod(w.io, f, m);
      expect((await read()).kind, m.toString(8)).toBe('ok');
    }
  });

  it('硬链接(nlink>1)→ unsafe/hardlink(变异:去掉 nlink 检查 → 红)', async () => {
    const w = await newWork('sr-nlink-');
    const f = path.join(w.dir, 'a.json');
    await writeFile(w.io, f, 'x', { mode: 0o600 });
    await hardlink(w.io, f, path.join(w.dir, 'alias.json'));
    expect(await readFileSafe(f, { maxBytes: 10 })).toEqual({ kind: 'unsafe', why: 'hardlink' });
  });

  it('符号链接 → unsafe/link,不跟随(O_NOFOLLOW);目录 / 超限 → unsafe', async () => {
    const w = await newWork('sr-link-');
    const real = path.join(w.dir, 'real.json');
    await writeFile(w.io, real, 'secret', { mode: 0o600 });
    const lnk = path.join(w.dir, 'lnk.json');
    await symlink(w.io, real, lnk);
    expect(await readFileSafe(lnk, { maxBytes: 100 })).toEqual({ kind: 'unsafe', why: 'link' });
    await mkdirp(w.io, path.join(w.dir, 'd'), 0o700);
    expect((await readFileSafe(path.join(w.dir, 'd'), { maxBytes: 100 })).kind).toBe('unsafe');
    expect(await readFileSafe(real, { maxBytes: 5 })).toEqual({ kind: 'unsafe', why: 'too_large' });
    expect((await readFileSafe(real, { maxBytes: 6 })).kind).toBe('ok');
  });

  it('检查之后、读取之前被换成符号链接 → unsafe,不跟随(变异:去掉 O_NOFOLLOW → 红)', async () => {
    const w = await newWork('sr-race-link-');
    const f = path.join(w.dir, 'a.json');
    await writeFile(w.io, f, STATE, { mode: 0o600 });
    const r = await readFileSafe(f, {
      maxBytes: 100,
      beforeOpen: () => swapToSymlink(w, f),
    });
    expect(r).toEqual({ kind: 'unsafe', why: 'link' });
  });

  it('检查之后、读取之前被换成 FIFO → unsafe,不挂住(O_NONBLOCK + 句柄 fstat)', async () => {
    const w = await newWork('sr-race-fifo-');
    const f = path.join(w.dir, 'a.json');
    await writeFile(w.io, f, STATE, { mode: 0o600 });
    const r = await readFileSafe(f, { maxBytes: 100, beforeOpen: () => swapToFifo(w, f) });
    expect(r).toEqual({ kind: 'unsafe', why: 'not_regular' });
  });

  it('statDirSafe:真实目录 0700 过;0755 / 符号链接 / 普通文件 / 别人的目录拒;不存在 = missing;只读不收紧', async () => {
    const w = await newWork('sr-dir-');
    const d = path.join(w.dir, 'd');
    await mkdirp(w.io, d, 0o700);
    await chmod(w.io, d, 0o700);
    const policy = { owner: { maxPerm: 0o700 } };
    expect((await statDirSafe(d, policy)).kind).toBe('ok');
    expect(await statDirSafe(d, { owner: { maxPerm: 0o700, uid: myUid() + 1 } })).toEqual({
      kind: 'unsafe',
      why: 'owner',
    });
    await chmod(w.io, d, 0o755);
    expect(await statDirSafe(d, policy)).toEqual({ kind: 'unsafe', why: 'perm' });
    expect(await mode(d)).toBe(0o755);
    const lnk = path.join(w.dir, 'l');
    await symlink(w.io, d, lnk);
    expect((await statDirSafe(lnk, policy)).kind).toBe('unsafe');
    const f = path.join(w.dir, 'f');
    await writeFile(w.io, f, 'x', { mode: 0o600 });
    expect((await statDirSafe(f, policy)).kind).toBe('unsafe');
    expect(await statDirSafe(path.join(w.dir, 'none'), policy)).toEqual({ kind: 'missing' });
  });
});

describe('R20-7.2 锁文件读取前校验', () => {
  const lockOf = (w: Work): string => rsiFile(w, 'lock');

  it('锁文件权限宽于 0600 / 硬链接 → peek 为 unknown、获取为 state_dir_unsafe,且不被收紧、不被回收', async () => {
    const w = await newWork('sl-meta-');
    const l = await acquireRsiLock(w.io, { pid: 4242 });
    // 另一进程视角:同一把锁被改宽 / 被硬链接
    await chmod(w.io, lockOf(w), 0o644);
    expect(await peekRsiLock(w.io)).toBe('unknown');
    expect(await mode(lockOf(w))).toBe(0o644);
    await chmod(w.io, lockOf(w), 0o600);
    expect(await peekRsiLock(w.io, { isAlive: () => true })).toBe('held');
    await hardlink(w.io, lockOf(w), path.join(w.dir, 'lock-alias'));
    expect(await peekRsiLock(w.io)).toBe('unknown');
    await expect(l.assertHeld()).rejects.toMatchObject({ kind: 'lock_lost' });
  });

  it('宽权限的陈旧锁不会被回收(只读校验在回收判定之前):acquire → state_dir_unsafe,文件原样', async () => {
    const w = await newWork('sl-wide-');
    await mkdirp(w.io, path.join(w.state, 'rsi'), 0o700);
    const stale = JSON.stringify({
      pid: 99991,
      started_at: new Date().toISOString(),
      nonce: 'b'.repeat(16),
      kit_version: '0.1.0',
    });
    await writeFile(w.io, lockOf(w), stale, { mode: 0o644 });
    await expect(
      acquireRsiLock(w.io, { isAlive: () => false }),
    ).rejects.toMatchObject({ kind: 'state_dir_unsafe' });
    expect(await readText(lockOf(w))).toBe(stale);
    expect(await mode(lockOf(w))).toBe(0o644);
  });

  it('rsi/ 目录宽于 0700:只读 peek 为 unknown 且不 chmod;写入方 acquire 照旧收紧到 0700(已有行为)', async () => {
    const w = await newWork('sl-dir-');
    const l = await acquireRsiLock(w.io);
    await l.release();
    await chmod(w.io, path.join(w.state, 'rsi'), 0o755);
    expect(await peekRsiLock(w.io)).toBe('unknown');
    expect(await mode(path.join(w.state, 'rsi'))).toBe(0o755);
    const l2 = await acquireRsiLock(w.io);
    expect(await mode(path.join(w.state, 'rsi'))).toBe(0o700);
    await l2.release();
  });

  it('检查之后、读取之前锁文件被换成符号链接 / FIFO → unknown(不跟随、不挂住)', async () => {
    for (const swap of [swapToSymlink, swapToFifo]) {
      const w = await newWork('sl-race-');
      await mkdirp(w.io, path.join(w.state, 'rsi'), 0o700);
      await writeFile(w.io, lockOf(w), '', { mode: 0o600 });
      const state = await peekRsiLock(w.io, {
        beforeRead: async (file) => {
          if (file === lockOf(w) || file.endsWith(`${path.sep}lock`)) await swap(w, file);
        },
      });
      expect(state, swap.name).toBe('unknown');
    }
  });
});

describe('R20-7.2 快照与固定数据文件读取前校验', () => {
  it('固定数据文件宽于 0600:只读 unsafe、commit / recover 抛 state_dir_unsafe,文件不被收紧(变异:权限判断取反 → 红)', async () => {
    const w = await newWork('ss-perm-');
    await put(w, 'state.json', STATE);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    await chmod(w.io, rsiFile(w, 'state.json'), 0o644);
    expect(await readVerified(w.io, ['state.json'])).toEqual({ status: 'unsafe' });
    await expect(withLock(w, (l) => commitSnapshot(w.io, l))).rejects.toMatchObject({
      reason: 'state_dir_unsafe',
    });
    await expect(withLock(w, (l) => recoverSnapshot(w.io, l))).rejects.toMatchObject({
      reason: 'state_dir_unsafe',
    });
    expect(await mode(rsiFile(w, 'state.json'))).toBe(0o644);
    await chmod(w.io, rsiFile(w, 'state.json'), 0o600);
    expect((await readVerified(w.io, ['state.json'])).status).toBe('ok'); // 对照
  });

  it('清单文件宽于 0600 → readSnapshot unsafe;rsi/ 目录宽于 0700 → unsafe(只读不收紧)', async () => {
    const w = await newWork('ss-snap-perm-');
    await put(w, 'state.json', STATE);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    await chmod(w.io, rsiFile(w, 'snapshot.json'), 0o640);
    expect(await readSnapshot(w.io)).toEqual({ kind: 'unsafe' });
    await chmod(w.io, rsiFile(w, 'snapshot.json'), 0o600);
    expect((await readSnapshot(w.io)).kind).toBe('ok');
    await chmod(w.io, path.join(w.state, 'rsi'), 0o750);
    expect(await readSnapshot(w.io)).toEqual({ kind: 'unsafe' });
    expect(await readVerified(w.io, ['state.json'])).toEqual({ status: 'unsafe' });
    expect(await mode(path.join(w.state, 'rsi'))).toBe(0o750);
  });

  it('信号库 / 会话计数月文件沿用 state-store 口径:宽权限不拒(只拒链接 / 非普通文件 / 硬链接)', async () => {
    const w = await newWork('ss-month-');
    await put(w, 'state.json', STATE);
    await put(w, 'signals/claude/202610.jsonl', '', 0o644);
    const s = await withLock(w, (l) => commitSnapshot(w.io, l));
    expect(s.files.map((f) => f.name)).toContain('signals/claude/202610.jsonl');
    expect((await readVerified(w.io, ['signals/claude/202610.jsonl'])).status).toBe('ok');
  });

  it('检查之后、读取之前固定数据文件 / 清单被换成符号链接或 FIFO → unsafe,不跟随、不挂住', async () => {
    for (const swap of [swapToSymlink, swapToFifo]) {
      const w = await newWork('ss-race-');
      await put(w, 'state.json', STATE);
      await withLock(w, (l) => commitSnapshot(w.io, l));
      const r = await readVerified(w.io, ['state.json'], {
        beforeOpen: async (file) => {
          if (file === rsiFile(w, 'state.json')) await swap(w, file);
        },
      });
      expect(r, swap.name).toEqual({ status: 'unsafe' });
      const w2 = await newWork('ss-race-snap-');
      await put(w2, 'state.json', STATE);
      await withLock(w2, (l) => commitSnapshot(w2.io, l));
      const r2 = await readSnapshot(w2.io, {
        beforeOpen: async (file) => {
          if (file === rsiFile(w2, 'snapshot.json')) await swap(w2, file);
        },
      });
      expect(r2, swap.name).toEqual({ kind: 'unsafe' });
    }
  });
});

describe('R20-5.6 恢复接口看得见「清单里有、现状里缺」的文件', () => {
  const requireState = (name: string, bytes: Uint8Array | null): boolean =>
    !(name === 'state.json' && bytes === null);

  async function committed(prefix: string): Promise<Work> {
    const w = await newWork(prefix);
    await put(w, 'state.json', STATE);
    await put(w, 'cursor.json', '{}');
    await withLock(w, (l) => commitSnapshot(w.io, l));
    return w;
  }

  it('必需文件缺失:validator 对 null 判否 → 抛 state_invalid,清单不被改写(变异:validator 看不到缺失 → 红)', async () => {
    const w = await committed('rm-required-');
    const before = await readText(rsiFile(w, 'snapshot.json'));
    await remove(w.io, rsiFile(w, 'state.json'));
    await expect(withLock(w, (l) => recoverSnapshot(w.io, l, requireState))).rejects.toMatchObject({
      reason: 'state_invalid',
    });
    expect(await readText(rsiFile(w, 'snapshot.json'))).toBe(before);
  });

  it('允许缺失的文件(cursor.json)被删 → 仍 rebuilt;validator 收到的是 (name, null)', async () => {
    const w = await committed('rm-allowed-');
    await remove(w.io, rsiFile(w, 'cursor.json'));
    const seen: [string, boolean][] = [];
    const outcome = await withLock(w, (l) =>
      recoverSnapshot(w.io, l, (n, b) => {
        seen.push([n, b === null]);
        return requireState(n, b);
      }),
    );
    expect(outcome).toBe('rebuilt');
    expect(seen).toContainEqual(['cursor.json', true]);
    expect(seen).toContainEqual(['state.json', false]);
    const after = await readSnapshot(w.io);
    expect(after.kind === 'ok' && after.snapshot.files.map((f) => f.name)).toEqual(['state.json']);
  });

  it('缺省校验函数保持原行为:任何文件被删都按未完成提交 rebuilt(必需文件规则由 A2 注入)', async () => {
    const w = await committed('rm-default-');
    await remove(w.io, rsiFile(w, 'state.json'));
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l))).toBe('rebuilt');
  });

  it('清单与现状一致时不调用 validator(缺失也不触发)', async () => {
    const w = await committed('rm-consistent-');
    let calls = 0;
    const outcome = await withLock(w, (l) =>
      recoverSnapshot(w.io, l, () => {
        calls++;
        return false;
      }),
    );
    expect(outcome).toBe('consistent');
    expect(calls).toBe(0);
  });
});

describe('R20-5.6 2000 项上限在枚举阶段执行,摘要逐文件计算', () => {
  /** 在 signals/ 与 sessions/ 的三个 agent 下造 count 个月文件(名字 000001.jsonl …) */
  async function fill(w: Work, from: number, to: number): Promise<void> {
    const dirs: string[] = [];
    for (const kind of ['signals', 'sessions']) {
      for (const agent of ['claude', 'codex', 'pi']) dirs.push(`${kind}/${agent}`);
    }
    for (const d of dirs) await mkdirp(w.io, path.join(w.state, d), 0o700);
    const jobs: Promise<void>[] = [];
    for (let i = from; i <= to; i++) {
      const d = dirs[i % dirs.length] as string;
      jobs.push(
        writeFile(w.io, path.join(w.state, d, `${String(i).padStart(6, '0')}.jsonl`), '', {
          mode: 0o600,
        }),
      );
      if (jobs.length >= 100) await Promise.all(jobs.splice(0));
    }
    await Promise.all(jobs);
  }

  it('恰好 2000 项:提交成功,每个文件各读一次;再多 1 项:commit / recover 在读取任何内容之前就抛 snapshot_invalid(变异:上限检查挪回读取之后 → 红)', async () => {
    const w = await newWork('lim-');
    await fill(w, 1, RSI_SNAPSHOT_MAX_FILES);
    const reads: string[] = [];
    const s = await withLock(w, (l) =>
      commitSnapshot(w.io, l, { onRead: (n) => reads.push(n) }),
    );
    expect(s.files).toHaveLength(RSI_SNAPSHOT_MAX_FILES);
    expect(reads).toHaveLength(RSI_SNAPSHOT_MAX_FILES);
    expect(new Set(reads).size).toBe(RSI_SNAPSHOT_MAX_FILES);

    await fill(w, RSI_SNAPSHOT_MAX_FILES + 1, RSI_SNAPSHOT_MAX_FILES + 1);
    const before = await readText(rsiFile(w, 'snapshot.json'));
    const over: string[] = [];
    await expect(
      withLock(w, (l) => commitSnapshot(w.io, l, { onRead: (n) => over.push(n) })),
    ).rejects.toMatchObject({ reason: 'snapshot_invalid' });
    expect(over).toEqual([]);
    await expect(
      withLock(w, (l) => recoverSnapshot(w.io, l, undefined, { onRead: (n) => over.push(n) })),
    ).rejects.toMatchObject({ reason: 'snapshot_invalid' });
    expect(over).toEqual([]); // 两条路径都没读过任何数据文件内容
    expect(await readText(rsiFile(w, 'snapshot.json'))).toBe(before);
    expect(await exists(`${rsiFile(w, 'snapshot.json')}.tmp`)).toBe(false);
  }, 120_000);

  it('snapshot.json 自身超过字节上限 → 解析前就判 invalid(不读内容进 JSON.parse)', async () => {
    const w = await newWork('lim-snap-');
    await put(w, 'state.json', STATE);
    await put(w, 'snapshot.json', ' '.repeat(RSI_SNAPSHOT_MAX_BYTES + 1));
    expect(await readSnapshot(w.io)).toEqual({ kind: 'invalid' });
    const reads: string[] = [];
    expect(await readVerified(w.io, ['state.json'], { onRead: (n) => reads.push(n) })).toEqual({
      status: 'invalid',
    });
    expect(reads).toEqual([]);
  });

  it('恢复时校验函数一次只拿到一个文件:按文件名升序逐个调用', async () => {
    const w = await newWork('lim-seq-');
    await put(w, 'state.json', STATE);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    await put(w, 'counts.json', '{}');
    await put(w, 'signals/pi/202610.jsonl', '');
    const order: string[] = [];
    expect(
      await withLock(w, (l) =>
        recoverSnapshot(w.io, l, (n) => {
          order.push(n);
          return true;
        }),
      ),
    ).toBe('rebuilt');
    expect(order).toEqual(['counts.json', 'signals/pi/202610.jsonl', 'state.json']);
  });
});
