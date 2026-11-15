/**
 * D1a:`FpKeyPort` 契约套件跑内存假件与真实现(真文件系统),另加真实现专属的权限 / 链接 / 并发首建用例。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, lstat, readBytes } from '../../../src/io/read-fs.js';
import { chmod, mkdirp, remove, symlink, writeFile } from '../../../src/io/safe-fs.js';
import { FpKeyInvalidError, makeFpKeyPort } from '../../../src/rsi/personal/fp/fp-key.js';
import type { FpKeyPort, FpKeyRead } from '../../../src/rsi/personal/fp/fp-ports.js';
import { rsiDir } from '../../../src/rsi/rsi-dir.js';
import { newWork } from '../../signals/helpers.js';
import { TEST_KEY, TEST_KEY_HEX, errText, leaks } from './d1a-fixture.js';
import { heldLost, heldOk, runFpKeyContract, type FpKeyHarness } from './fp-key-contract.js';

/** 内存假件:遵守同一份契约(无效不覆盖、失锁先于写、返回副本) */
async function fakeHarness(): Promise<FpKeyHarness> {
  let stored: Uint8Array | null = null;
  const read = async (): Promise<FpKeyRead> => {
    if (stored === null) return { kind: 'absent' };
    return stored.length === 32
      ? { kind: 'ok', key: Uint8Array.from(stored) }
      : { kind: 'invalid' };
  };
  const port: FpKeyPort = {
    read,
    async ensure(held) {
      await held.rsi.assertHeld();
      const cur = await read();
      if (cur.kind === 'ok') return 'exists';
      if (cur.kind === 'invalid') throw new FpKeyInvalidError();
      stored = Uint8Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
      return 'created';
    },
  };
  return {
    port,
    held: heldOk(),
    corrupt: async () => {
      stored = Uint8Array.from([1, 2, 3]);
    },
    raw: async () => (stored === null ? null : Uint8Array.from(stored)),
  };
}

async function realWorld() {
  const w = await newWork('d1a-fpkey-');
  const file = path.join(w.state, 'rsi', 'fp.key');
  const port = makeFpKeyPort({ io: w.io });
  return { w, file, port };
}

async function realHarness(): Promise<FpKeyHarness> {
  const { w, file, port } = await realWorld();
  return {
    port,
    held: heldOk(),
    corrupt: async () => {
      await rsiDir(w.io);
      await writeFile(w.io, file, Uint8Array.from([1, 2, 3]), { mode: 0o600 });
    },
    raw: async () => ((await exists(file)) ? await readBytes(file) : null),
    cleanup: async () => {
      await remove(w.io, w.dir).catch(() => undefined);
    },
  };
}

runFpKeyContract('内存假件', fakeHarness);
runFpKeyContract('真实现(文件系统)', realHarness);

describe('FpKeyPort 真实现:文件与目录', () => {
  it('首建后 fp.key 为 0600、32 字节普通文件,rsi 目录 0700', async () => {
    const { w, file, port } = await realWorld();
    expect(await port.ensure(heldOk())).toBe('created');
    const st = await lstat(file);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.size).toBe(32);
    expect((await lstat(path.join(w.state, 'rsi'))).mode & 0o777).toBe(0o700);
  });

  it('权限宽于 0600 → invalid(不修复、不覆盖);收紧回 0600 后读回 ok(正向对照)', async () => {
    const { w, file, port } = await realWorld();
    await port.ensure(heldOk());
    const raw = await readBytes(file);
    await chmod(w.io, file, 0o644);
    expect(await port.read()).toEqual({ kind: 'invalid' });
    await expect(port.ensure(heldOk())).rejects.toBeInstanceOf(FpKeyInvalidError);
    expect((await lstat(file)).mode & 0o777).toBe(0o644);
    expect(Array.from(await readBytes(file))).toEqual(Array.from(raw));
    await chmod(w.io, file, 0o600);
    expect((await port.read()).kind).toBe('ok');
  });

  it('fp.key 是符号链接 → invalid;ensure 抛错,链接目标不被写', async () => {
    const { w, file, port } = await realWorld();
    await rsiDir(w.io);
    const target = path.join(w.dir, 'elsewhere.bin');
    await writeFile(w.io, target, 'untouched', { mode: 0o600 });
    await symlink(w.io, target, file);
    expect(await port.read()).toEqual({ kind: 'invalid' });
    await expect(port.ensure(heldOk())).rejects.toBeInstanceOf(FpKeyInvalidError);
    expect(Buffer.from(await readBytes(target)).toString('utf8')).toBe('untouched');
  });

  it('过长文件(> 32 字节)与空文件 → invalid', async () => {
    const { w, file, port } = await realWorld();
    await rsiDir(w.io);
    await writeFile(w.io, file, new Uint8Array(33), { mode: 0o600 });
    expect(await port.read()).toEqual({ kind: 'invalid' });
    await writeFile(w.io, file, new Uint8Array(0), { mode: 0o600 });
    expect(await port.read()).toEqual({ kind: 'invalid' });
    await writeFile(w.io, file, new Uint8Array(32), { mode: 0o600 });
    expect((await port.read()).kind).toBe('ok');
  });

  it('rsi 目录权限宽于 0700 → read = invalid(只读入口不收紧)', async () => {
    const { w, port } = await realWorld();
    await port.ensure(heldOk());
    await chmod(w.io, path.join(w.state, 'rsi'), 0o755);
    expect(await port.read()).toEqual({ kind: 'invalid' });
  });

  it('失锁时 ensure 不建目录:状态目录里没有 rsi/', async () => {
    const { w, port } = await realWorld();
    await mkdirp(w.io, w.state, 0o700);
    await expect(port.ensure(heldLost())).rejects.toThrowError('lock_lost_for_test');
    expect(await exists(path.join(w.state, 'rsi'))).toBe(false);
  });

  it('并发首建:read 之后、createExclusive 之前别人写了有效 key → exists,且不覆盖对方的 key', async () => {
    const w = await newWork('d1a-fpkey-race-');
    const file = path.join(w.state, 'rsi', 'fp.key');
    const theirs = Uint8Array.from(TEST_KEY);
    const port = makeFpKeyPort({
      io: w.io,
      beforeCreate: async () => {
        await writeFile(w.io, file, theirs, { mode: 0o600 });
      },
    });
    expect(await port.ensure(heldOk())).toBe('exists');
    expect(Buffer.from(await readBytes(file)).toString('hex')).toBe(TEST_KEY_HEX);
  });

  it('并发首建:对方写的是无效内容 → 抛 FpKeyInvalidError,不覆盖;错误不含 key', async () => {
    const w = await newWork('d1a-fpkey-race2-');
    const file = path.join(w.state, 'rsi', 'fp.key');
    const port = makeFpKeyPort({
      io: w.io,
      randomKey: () => Uint8Array.from(TEST_KEY),
      beforeCreate: async () => {
        await writeFile(w.io, file, Uint8Array.from([9, 9]), { mode: 0o600 });
      },
    });
    let t = '';
    try {
      await port.ensure(heldOk());
    } catch (e) {
      t = errText(e);
    }
    expect(t).toContain('RSI_FP_KEY_INVALID');
    expect(leaks(t)).toBe(false);
    expect(Array.from(await readBytes(file))).toEqual([9, 9]);
  });

  it('randomKey 给出长度不对的 key → 抛错且不落盘', async () => {
    const w = await newWork('d1a-fpkey-badrnd-');
    const port = makeFpKeyPort({ io: w.io, randomKey: () => new Uint8Array(16) });
    await expect(port.ensure(heldOk())).rejects.toBeInstanceOf(FpKeyInvalidError);
    expect(await exists(path.join(w.state, 'rsi', 'fp.key'))).toBe(false);
  });
});

describe('FpKeyPort 真实现:持久化确认(首建的目录同步失败后重试)', () => {
  const rigAudit = async (prefix: string) => {
    const w = await newWork(prefix);
    const ops: string[] = [];
    const fail = { dirSync: false };
    const io = {
      ...w.io,
      writeAudit: (op: string) => {
        ops.push(op);
        if (op === 'fsyncDir' && fail.dirSync) throw new Error('injected fsyncDir failure');
      },
    };
    return {
      w,
      ops,
      fail,
      port: makeFpKeyPort({ io, randomKey: () => Uint8Array.from(TEST_KEY) }),
    };
  };

  it('首建时父目录 fsync 失败 → ensure 抛错、key 文件保留;重试返回 exists 前文件与父目录 fsync 都再执行一次(不跳过)', async () => {
    const r = await rigAudit('d1a-fpkey-dirsync-');
    r.fail.dirSync = true;
    await expect(r.port.ensure(heldOk())).rejects.toThrowError('injected fsyncDir failure');
    expect((await r.port.read()).kind).toBe('ok');
    r.ops.length = 0;
    r.fail.dirSync = false;
    expect(await r.port.ensure(heldOk())).toBe('exists');
    const synced = r.ops.filter((o) => o === 'syncFile' || o === 'fsyncDir');
    expect(synced).toEqual(['syncFile', 'fsyncDir']);
    // 内容没变(重试不重新生成 key)
    expect(
      Buffer.from(await readBytes(path.join(r.w.state, 'rsi', 'fp.key'))).toString('hex'),
    ).toBe(TEST_KEY_HEX);
  });

  it('重试路径上父目录 fsync 仍失败 → ensure 继续抛错(不返回 exists);恢复后成功(正向对照)', async () => {
    const r = await rigAudit('d1a-fpkey-dirsync2-');
    await r.port.ensure(heldOk());
    r.fail.dirSync = true;
    await expect(r.port.ensure(heldOk())).rejects.toThrowError('injected fsyncDir failure');
    r.fail.dirSync = false;
    expect(await r.port.ensure(heldOk())).toBe('exists');
  });

  it('并发首建的败者(EEXIST 后重读有效)同样补文件与目录 fsync', async () => {
    const w = await newWork('d1a-fpkey-racedur-');
    const file = path.join(w.state, 'rsi', 'fp.key');
    const ops: string[] = [];
    const io = { ...w.io, writeAudit: (op: string) => void ops.push(op) };
    const port = makeFpKeyPort({
      io,
      beforeCreate: async () => {
        await writeFile(w.io, file, Uint8Array.from(TEST_KEY), { mode: 0o600 });
      },
    });
    expect(await port.ensure(heldOk())).toBe('exists');
    expect(ops.filter((o) => o === 'syncFile' || o === 'fsyncDir')).toEqual([
      'syncFile',
      'fsyncDir',
    ]);
  });

  it('无效 key 仍不覆盖、也不触发 fsync(现有策略保留)', async () => {
    const r = await rigAudit('d1a-fpkey-invalid-keep-');
    await r.port.ensure(heldOk());
    const file = path.join(r.w.state, 'rsi', 'fp.key');
    await writeFile(r.w.io, file, Uint8Array.from([1, 2, 3]), { mode: 0o600 });
    r.ops.length = 0;
    await expect(r.port.ensure(heldOk())).rejects.toBeInstanceOf(FpKeyInvalidError);
    expect(r.ops.filter((o) => o === 'syncFile' || o === 'fsyncDir')).toEqual([]);
    expect(Array.from(await readBytes(file))).toEqual([1, 2, 3]);
  });
});
