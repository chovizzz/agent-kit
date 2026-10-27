/**
 * R20-A2 B3a:armed 头部读取原语 `readHead`(contracts R20-1.4 / R20-1.11)。
 * 判据:每个文件恰好一次物理读取(onRead 钩子),长度 ≤ 64KiB;首行之后的字节**不出现在任何返回值或解析器参数里**。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHead } from '../../src/io/read-fs.js';
import { hardlink, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import { RSI_ARMED_HEAD_BYTES, readArmedHead } from '../../src/rsi/armed-head.js';
import { mkfifo } from '../rsi/proc/helper.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';

const W = RSI_ARMED_HEAD_BYTES;

async function dirAndCtx(prefix: string): Promise<{ dir: string; fx: ReturnType<typeof wideCtx> }> {
  const { dir } = await makeTempDir(prefix);
  return { dir, fx: wideCtx(dir) };
}

describe('readHead:一次物理读取,只返回首行', () => {
  it('常量是 64KiB', () => {
    expect(W).toBe(65536);
  });

  it('大文件:onRead 恰 1 次、偏移 0、长度 = 窗口;返回值只有首行,首行之后的哨兵字节不在其中', async () => {
    const { dir, fx } = await dirAndCtx('rh-big-');
    const f = path.join(dir, 'big.jsonl');
    await writeFile(fx, f, `{"cwd":"/x"}\nSECRET_TAIL${'z'.repeat(200 * 1024)}\n`, { mode: 0o600 });
    const reads: { path: string; offset: number; length: number }[] = [];
    const r = await readHead(f, W, { onRead: (i) => reads.push(i) });
    expect(reads).toEqual([{ path: f, offset: 0, length: W }]);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.firstLine?.toString('utf8')).toBe('{"cwd":"/x"}');
    expect(r.firstLine?.includes(Buffer.from('SECRET'))).toBe(false);
  });

  it('LF 在窗口最后一字节(下标 W-1)→ 首行;LF 在 W → null(窗口外不再读)', async () => {
    const { dir, fx } = await dirAndCtx('rh-edge-');
    const last = path.join(dir, 'last');
    await writeFile(fx, last, `${'a'.repeat(W - 1)}\nrest`, { mode: 0o600 });
    const r1 = await readHead(last, W);
    expect(r1.kind === 'ok' && r1.firstLine?.length).toBe(W - 1);
    const beyond = path.join(dir, 'beyond');
    await writeFile(fx, beyond, `${'a'.repeat(W)}\nrest`, { mode: 0o600 });
    const r2 = await readHead(beyond, W);
    expect(r2).toEqual({ kind: 'ok', firstLine: null });
  });

  it('CRLF 的 \\r 原样保留;空首行 = 空 Buffer(不是 null);没有 LF 的短文件 = null;UTF-8 多字节首行字节原样', async () => {
    const { dir, fx } = await dirAndCtx('rh-forms-');
    const put = async (n: string, t: string): Promise<string> => {
      const p = path.join(dir, n);
      await writeFile(fx, p, t, { mode: 0o600 });
      return p;
    };
    const crlf = await readHead(await put('crlf', 'abc\r\ndef'), W);
    expect(crlf.kind === 'ok' && crlf.firstLine?.toString('latin1')).toBe('abc\r');
    const empty = await readHead(await put('empty', '\nxyz'), W);
    expect(empty.kind === 'ok' && empty.firstLine?.length).toBe(0);
    expect(await readHead(await put('nolf', '{"cwd":"/x"}'), W)).toEqual({
      kind: 'ok',
      firstLine: null,
    });
    expect(await readHead(await put('zero', ''), W)).toEqual({ kind: 'ok', firstLine: null });
    const utf = await readHead(await put('utf', '中文😀\nz'), W);
    expect(utf.kind === 'ok' && utf.firstLine?.toString('utf8')).toBe('中文😀');
  });

  it('maxBytes 不是正整数 → RangeError;小窗口只读到窗口为止', async () => {
    const { dir, fx } = await dirAndCtx('rh-range-');
    const f = path.join(dir, 'f');
    await writeFile(fx, f, 'abcdef\nxyz', { mode: 0o600 });
    await expect(readHead(f, 0)).rejects.toThrow(RangeError);
    await expect(readHead(f, 1.5)).rejects.toThrow(RangeError);
    expect(await readHead(f, 4)).toEqual({ kind: 'ok', firstLine: null });
    const r = await readHead(f, 7);
    expect(r.kind === 'ok' && r.firstLine?.toString()).toBe('abcdef');
  });

  it('安全打开:缺失 / 符号链接 / 目录 / 硬链接 / FIFO(不挂住)→ missing 或 unsafe,且不触发读取', async () => {
    const { dir, fx } = await dirAndCtx('rh-unsafe-');
    const real = path.join(dir, 'real');
    await writeFile(fx, real, 'a\nb', { mode: 0o600 });
    await symlink(fx, real, path.join(dir, 'link'));
    await hardlink(fx, real, path.join(dir, 'hard'));
    await mkdirp(fx, path.join(dir, 'dir'), 0o755);
    mkfifo(path.join(dir, 'fifo'));
    let reads = 0;
    const hooks = { onRead: () => void reads++ };
    expect(await readHead(path.join(dir, 'none'), W, hooks)).toEqual({ kind: 'missing' });
    expect(await readHead(path.join(dir, 'link'), W, hooks)).toEqual({
      kind: 'unsafe',
      why: 'link',
    });
    expect(await readHead(path.join(dir, 'dir'), W, hooks)).toEqual({
      kind: 'unsafe',
      why: 'not_regular',
    });
    expect(await readHead(path.join(dir, 'hard'), W, hooks)).toEqual({
      kind: 'unsafe',
      why: 'hardlink',
    });
    expect(await readHead(path.join(dir, 'fifo'), W, hooks)).toEqual({
      kind: 'unsafe',
      why: 'not_regular',
    });
    expect(reads).toBe(0);
    // 对照:同一钩子读真文件会触发
    const plain = path.join(dir, 'plain');
    await writeFile(fx, plain, 'a\nb', { mode: 0o600 });
    expect((await readHead(plain, W, hooks)).kind).toBe('ok');
    expect(reads).toBe(1);
  });

  it('检查之后被换成符号链接(beforeOpen 缝):拿到 unsafe,不跟随', async () => {
    const { dir, fx } = await dirAndCtx('rh-swap-');
    const f = path.join(dir, 'f');
    const secret = path.join(dir, 'secret');
    await writeFile(fx, f, 'ok\n', { mode: 0o600 });
    await writeFile(fx, secret, 'SECRET\n', { mode: 0o600 });
    const r = await readHead(f, W, {
      beforeOpen: async () => {
        await remove(fx, f);
        await symlink(fx, secret, f);
      },
    });
    expect(r).toEqual({ kind: 'unsafe', why: 'link' });
  });
});

describe('readArmedHead:解析器只会拿到首行', () => {
  it('解析器入参 = 首行字节;首行之后的哨兵从未传入;解析器恰调用 1 次;每个文件 onRead 恰 1 次', async () => {
    const { dir, fx } = await dirAndCtx('rh-armed-');
    const files: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = path.join(dir, `s${i}.jsonl`);
      await writeFile(fx, p, `{"cwd":"/p${i}"}\nTAIL_SENTINEL_${i}\n${'x'.repeat(100_000)}`, {
        mode: 0o600,
      });
      files.push(p);
    }
    const perFile = new Map<string, number>();
    const seen: string[] = [];
    for (const p of files) {
      const r = await readArmedHead(
        p,
        (line) => {
          seen.push(line.toString('utf8'));
          return line.length;
        },
        { onRead: (i) => perFile.set(i.path, (perFile.get(i.path) ?? 0) + 1) },
      );
      expect(r.kind).toBe('parsed');
    }
    expect(seen).toEqual(files.map((_, i) => `{"cwd":"/p${i}"}`));
    expect(seen.join('')).not.toContain('TAIL_SENTINEL');
    expect([...perFile.values()]).toEqual([1, 1, 1, 1]);
    expect(perFile.size).toBe(4);
  });

  it('首行取不到(窗口内无 LF)→ no_line,解析器不被调用;缺失 / 不安全原样返回', async () => {
    const { dir, fx } = await dirAndCtx('rh-armed2-');
    const p = path.join(dir, 'nolf');
    await writeFile(fx, p, 'a'.repeat(W + 10), { mode: 0o600 });
    let called = 0;
    const parse = (): number => ++called;
    expect(await readArmedHead(p, parse)).toEqual({ kind: 'no_line' });
    expect(await readArmedHead(path.join(dir, 'none'), parse)).toEqual({ kind: 'missing' });
    expect(called).toBe(0);
  });
});
