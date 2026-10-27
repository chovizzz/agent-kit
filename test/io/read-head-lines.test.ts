/**
 * R20-A2 B4a:`readHeadLines`(D1):单次 `read(2)`、至多 maxLines 个完整行、行之外的字节不出现在返回值里。
 * 判据与 `readHead` 同一套(句柄级安全打开、一次读取),只是多行。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHead, readHeadLines } from '../../src/io/read-fs.js';
import { hardlink, mkdirp, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import { RSI_ARMED_HEAD_BYTES } from '../../src/rsi/armed-head.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';
import { mkfifo } from '../rsi/proc/helper.js';

const W = RSI_ARMED_HEAD_BYTES;

async function fxDir(prefix: string) {
  const { dir } = await makeTempDir(prefix);
  const fx = wideCtx(dir);
  const put = async (name: string, data: string | Uint8Array): Promise<string> => {
    const p = path.join(dir, name);
    await writeFile(fx, p, data, { mode: 0o600 });
    return p;
  };
  return { dir, fx, put };
}
const text = (r: { kind: string; lines?: Buffer[] }): string[] =>
  (r.lines ?? []).map((b) => b.toString('utf8'));

describe('readHeadLines:一次读取,只返回前 maxLines 个完整行', () => {
  it('大文件:onRead 恰 1 次、偏移 0、长度 = 窗口;只返回前 3 行,之后的哨兵字节不出现;bytesRead = 窗口', async () => {
    const { put } = await fxDir('rhl-big-');
    const f = await put('big.jsonl', `a\nb\nc\nSENTINEL_TAIL${'z'.repeat(200 * 1024)}\n`);
    const reads: { path: string; offset: number; length: number }[] = [];
    const r = await readHeadLines(f, W, 3, { onRead: (i) => reads.push(i) });
    expect(reads).toEqual([{ path: f, offset: 0, length: W }]);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(text(r)).toEqual(['a', 'b', 'c']);
    expect(r.bytesRead).toBe(W);
    for (const l of r.lines) expect(l.includes(Buffer.from('SENTINEL'))).toBe(false);
  });

  it('maxLines 边界:1 / 恰好等于行数 / 大于行数', async () => {
    const { put } = await fxDir('rhl-n-');
    const f = await put('n', 'l1\nl2\nl3\n');
    expect(text(await readHeadLines(f, W, 1))).toEqual(['l1']);
    expect(text(await readHeadLines(f, W, 3))).toEqual(['l1', 'l2', 'l3']);
    expect(text(await readHeadLines(f, W, 99))).toEqual(['l1', 'l2', 'l3']);
  });

  it('没有 LF 结束的尾段不返回(含:完整行后跟半行、没有任何 LF 的短文件、空文件)', async () => {
    const { put } = await fxDir('rhl-tail-');
    const half = await readHeadLines(await put('half', 'a\nb\nhalf-line'), W, 9);
    expect(text(half)).toEqual(['a', 'b']);
    const none = await readHeadLines(await put('none', 'no-newline'), W, 9);
    expect(none).toEqual({ kind: 'ok', lines: [], bytesRead: 10 });
    const empty = await readHeadLines(await put('empty', ''), W, 9);
    expect(empty).toEqual({ kind: 'ok', lines: [], bytesRead: 0 });
  });

  it('窗口边界:LF 在最后一字节(下标 W-1)→ 该行返回;LF 在 W → 不返回;短读的 bytesRead 是实际读到的字节', async () => {
    const { put } = await fxDir('rhl-edge-');
    const last = await readHeadLines(await put('last', `${'a'.repeat(W - 1)}\nrest`), W, 3);
    expect(last.kind === 'ok' && last.lines.map((l) => l.length)).toEqual([W - 1]);
    const beyond = await readHeadLines(await put('beyond', `${'a'.repeat(W)}\nrest`), W, 3);
    expect(beyond).toEqual({ kind: 'ok', lines: [], bytesRead: W });
    const short = await readHeadLines(await put('short', 'ab\n'), W, 3);
    expect(short.kind === 'ok' && short.bytesRead).toBe(3);
  });

  it('CRLF 的 \\r 原样保留;空行是空 Buffer;BOM 字节原样;UTF-8 多字节行字节原样', async () => {
    const { put } = await fxDir('rhl-forms-');
    const f = await put('forms', Buffer.from('﻿{"a":1}\r\n\n汉字\r\nz\n', 'utf8'));
    const r = await readHeadLines(f, W, 9);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.lines[0]?.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(r.lines.map((l) => l.toString('utf8'))).toEqual(['﻿{"a":1}\r', '', '汉字\r', 'z']);
  });

  it('maxLines = 1 与 readHead 的首行一致(同一文件,含 CRLF / 空首行 / 无 LF)', async () => {
    const { put } = await fxDir('rhl-eq-');
    for (const [n, body] of [
      ['a', 'abc\r\ndef'],
      ['b', '\nxyz'],
      ['c', 'solo'],
      ['d', '{"x":1}\n{"y":2}\n'],
    ] as const) {
      const f = await put(n, body);
      const one = await readHead(f, W);
      const many = await readHeadLines(f, W, 1);
      expect(one.kind === 'ok' && many.kind === 'ok').toBe(true);
      if (one.kind !== 'ok' || many.kind !== 'ok') continue;
      expect(many.lines[0] ?? null).toEqual(one.firstLine);
    }
  });

  it('不安全文件:符号链接 / FIFO / 硬链接 / 目录 → unsafe 且不发起 read;不存在 → missing', async () => {
    const { dir, fx, put } = await fxDir('rhl-unsafe-');
    const real = await put('real.jsonl', 'a\n');
    const link = path.join(dir, 'link.jsonl');
    await symlink(fx, real, link);
    const hard = path.join(dir, 'hard.jsonl');
    await hardlink(fx, real, hard);
    const fifo = path.join(dir, 'fifo.jsonl');
    mkfifo(fifo);
    const sub = path.join(dir, 'sub');
    await mkdirp(fx, sub, 0o755);
    const cases: [string, string][] = [
      [link, 'link'],
      [hard, 'hardlink'],
      [fifo, 'not_regular'],
      [sub, 'not_regular'],
    ];
    for (const [p, why] of cases) {
      let reads = 0;
      const r = await readHeadLines(p, W, 3, { onRead: () => reads++ });
      expect(r, p).toEqual({ kind: 'unsafe', why });
      expect(reads, p).toBe(0);
    }
    expect(await readHeadLines(path.join(dir, 'nope'), W, 3)).toEqual({ kind: 'missing' });
  });

  it('检查之后、打开之前被换成符号链接 / FIFO → unsafe,不跟随、不挂住;对照:不换时正常', async () => {
    const { dir, fx, put } = await fxDir('rhl-swap-');
    const target = await put('target.jsonl', '{"cwd":"/leak"}\n');
    const victim = await put('victim.jsonl', 'ok\n');
    const ok = await readHeadLines(victim, W, 1);
    expect(ok.kind === 'ok' && text(ok)).toEqual(['ok']);
    const r1 = await readHeadLines(victim, W, 1, {
      beforeOpen: async () => {
        await rename(fx, victim, path.join(dir, 'victim.moved'));
        await symlink(fx, target, victim);
      },
    });
    expect(r1).toEqual({ kind: 'unsafe', why: 'link' });
    const v2 = path.join(dir, 'v2.jsonl');
    await writeFile(fx, v2, 'ok\n', { mode: 0o600 });
    const r2 = await readHeadLines(v2, W, 1, {
      beforeOpen: async () => {
        await rename(fx, v2, path.join(dir, 'v2.moved'));
        mkfifo(v2);
      },
    });
    expect(r2).toEqual({ kind: 'unsafe', why: 'not_regular' });
  });

  it('参数非法 → RangeError', async () => {
    const { put } = await fxDir('rhl-arg-');
    const f = await put('a', 'a\n');
    await expect(readHeadLines(f, 0, 1)).rejects.toThrow(RangeError);
    await expect(readHeadLines(f, W, 0)).rejects.toThrow(RangeError);
    await expect(readHeadLines(f, W, 1.5)).rejects.toThrow(RangeError);
  });
});
