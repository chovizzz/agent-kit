/**
 * R20-A2 B2:流式安全读取原语 `openStreamSafe`(src/io/read-fs.ts)与流式 JSONL 校验引擎(src/rsi/jsonl-stream.ts)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStreamSafe } from '../../src/io/read-fs.js';
import { chmod, hardlink, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import { JsonlStream, JsonlStreamError, type JsonlFailure } from '../../src/rsi/jsonl-stream.js';
import { newWork } from '../signals/helpers.js';
import { mkfifo } from './proc/helper.js';

const myUid = (): number => process.getuid?.() ?? 0;

async function collect(
  s: Awaited<ReturnType<typeof openStreamSafe>>,
): Promise<{ bytes: Buffer; chunks: number }> {
  if (s.kind !== 'ok') throw new Error(`not ok: ${s.kind}`);
  const parts: Buffer[] = [];
  try {
    for await (const c of s.chunks()) parts.push(c);
  } finally {
    await s.close();
  }
  return { bytes: Buffer.concat(parts), chunks: parts.length };
}

describe('openStreamSafe:一次安全打开、同一句柄读完', () => {
  it('普通文件:按块读完,字节原样(含多字节、CRLF),元数据来自句柄;小块演练多块', async () => {
    const w = await newWork('os-ok-');
    const f = path.join(w.dir, 'a.jsonl');
    const text = '{"a":"你好"}\r\n{"b":2}\n';
    await writeFile(w.io, f, text, { mode: 0o600 });
    const s = await openStreamSafe(f, { chunkBytes: 5, owner: { maxPerm: 0o600 } });
    expect(s.kind).toBe('ok');
    if (s.kind === 'ok') expect(s.meta.nlink).toBe(1);
    const got = await collect(s);
    expect(got.bytes.toString('utf8')).toBe(text);
    expect(got.chunks).toBeGreaterThan(3);
  });

  it('不存在 → missing;符号链接 → unsafe/link(不跟随);硬链接 → hardlink;FIFO → not_regular 且不挂住;目录 → not_regular', async () => {
    const w = await newWork('os-bad-');
    expect(await openStreamSafe(path.join(w.dir, 'none'))).toEqual({ kind: 'missing' });
    const real = path.join(w.dir, 'real');
    await writeFile(w.io, real, 'x', { mode: 0o600 });
    await symlink(w.io, real, path.join(w.dir, 'lnk'));
    expect(await openStreamSafe(path.join(w.dir, 'lnk'))).toEqual({ kind: 'unsafe', why: 'link' });
    await hardlink(w.io, real, path.join(w.dir, 'alias'));
    expect(await openStreamSafe(real)).toEqual({ kind: 'unsafe', why: 'hardlink' });
    const fifo = path.join(w.dir, 'fifo');
    mkfifo(fifo);
    expect(await openStreamSafe(fifo)).toEqual({ kind: 'unsafe', why: 'not_regular' });
    await mkdirp(w.io, path.join(w.dir, 'd'), 0o700);
    const d = await openStreamSafe(path.join(w.dir, 'd'));
    expect(d.kind).toBe('unsafe');
  });

  it('属主 / 权限策略与 readFileSafe 一致(提供 owner 才校验;不收紧)', async () => {
    const w = await newWork('os-owner-');
    const f = path.join(w.dir, 'a');
    await writeFile(w.io, f, 'x', { mode: 0o600 });
    expect(await openStreamSafe(f, { owner: { maxPerm: 0o600, uid: myUid() + 1 } })).toEqual({
      kind: 'unsafe',
      why: 'owner',
    });
    await chmod(w.io, f, 0o644);
    expect(await openStreamSafe(f, { owner: { maxPerm: 0o600 } })).toEqual({
      kind: 'unsafe',
      why: 'perm',
    });
    const s = await openStreamSafe(f); // 不提供 owner 不看权限
    expect(s.kind).toBe('ok');
    if (s.kind === 'ok') await s.close();
  });

  it('检查之后、打开之前被换成符号链接 / FIFO → unsafe,不跟随、不挂住(beforeOpen 缝)', async () => {
    const w = await newWork('os-race-');
    const f = path.join(w.dir, 'a');
    await writeFile(w.io, f, 'x', { mode: 0o600 });
    const target = path.join(w.dir, 'target');
    await writeFile(w.io, target, 'secret', { mode: 0o600 });
    const s1 = await openStreamSafe(f, {
      beforeOpen: async () => {
        await remove(w.io, f);
        await symlink(w.io, target, f);
      },
    });
    expect(s1).toEqual({ kind: 'unsafe', why: 'link' });
    const s2 = await openStreamSafe(f, {
      beforeOpen: async () => {
        await remove(w.io, f);
        mkfifo(f);
      },
    });
    expect(s2).toEqual({ kind: 'unsafe', why: 'not_regular' });
  });

  it('提前 return(消费方抛错 / break)会关句柄:之后再读同一生成器的句柄得到错误;close() 幂等', async () => {
    const w = await newWork('os-close-');
    const f = path.join(w.dir, 'a');
    await writeFile(w.io, f, 'x'.repeat(100), { mode: 0o600 });
    const s = await openStreamSafe(f, { chunkBytes: 10 });
    if (s.kind !== 'ok') throw new Error('unreachable');
    const it1 = s.chunks();
    expect((await it1.next()).done).toBe(false);
    await it1.return(undefined); // 提前退出 → finally 关句柄
    await expect(s.chunks().next()).rejects.toThrow(); // 句柄已关:读取抛错(EBADF)
    await s.close();
    await s.close(); // 幂等
  });

  it('从未迭代 chunks() 时,调用方 close() 即释放句柄(之后读取同样抛错)', async () => {
    const w = await newWork('os-close2-');
    const f = path.join(w.dir, 'a');
    await writeFile(w.io, f, 'abc', { mode: 0o600 });
    const s = await openStreamSafe(f);
    if (s.kind !== 'ok') throw new Error('unreachable');
    await s.close();
    await expect(s.chunks().next()).rejects.toThrow();
  });

  it('文件中途被截断 / 追加:读到的是同一个 inode 的实际内容(摘要对应读到的字节,不是路径上后来的文件)', async () => {
    const w = await newWork('os-same-inode-');
    const f = path.join(w.dir, 'a');
    await writeFile(w.io, f, 'first', { mode: 0o600 });
    const s = await openStreamSafe(f);
    // 打开之后路径被换成另一个文件:已打开的句柄仍读原来的 inode
    await remove(w.io, f);
    await writeFile(w.io, f, 'replaced-by-someone', { mode: 0o600 });
    expect((await collect(s)).bytes.toString('utf8')).toBe('first');
  });
});

function run(
  chunks: Buffer[],
  opts: { max?: number; accept?: (v: unknown) => boolean } = {},
): { lines: number; endsWithNewline: boolean } | JsonlFailure {
  const j = new JsonlStream(opts.max ?? 1 << 20, opts.accept ?? (() => true));
  try {
    for (const c of chunks) j.push(c);
    j.end();
    return { lines: j.lines, endsWithNewline: j.endsWithNewline };
  } catch (e) {
    if (e instanceof JsonlStreamError) return e.why;
    throw e;
  }
}

/** 把整份字节切成每块 n 字节 */
const split = (b: Buffer, n: number): Buffer[] => {
  const out: Buffer[] = [];
  for (let i = 0; i < b.length; i += n) out.push(b.subarray(i, i + n));
  return out;
};

describe('JsonlStream:流式 JSONL 校验引擎', () => {
  const doc = Buffer.from('{"a":"你好,世界"}\n{"b":"😀"}\n', 'utf8');

  it('空文件合法;合法文件无论切成几块,结论与行数一致(跨块 UTF-8 字符:每个字节边界都切一遍)', () => {
    expect(run([])).toEqual({ lines: 0, endsWithNewline: true });
    for (let n = 1; n <= doc.length; n++) {
      expect(run(split(doc, n)), `chunk=${n}`).toEqual({ lines: 2, endsWithNewline: true });
    }
  });

  it('CRLF:\\r 与 \\n 落在不同块里也一致;CRLF 与 LF 判定相同(行尾 \\r 留给 JSON.parse 当空白)', () => {
    const crlf = Buffer.from('{"a":1}\r\n{"b":2}\r\n', 'utf8');
    for (let n = 1; n <= crlf.length; n++) {
      expect(run(split(crlf, n)), `chunk=${n}`).toEqual({ lines: 2, endsWithNewline: true });
    }
  });

  it('缺尾换行 → no_trailing_newline(无论尾行是否是合法 JSON);任何块切法都一样', () => {
    const noTail = Buffer.from('{"a":1}\n{"b":2}', 'utf8');
    for (let n = 1; n <= noTail.length; n++) {
      expect(run(split(noTail, n)), `chunk=${n}`).toBe('no_trailing_newline');
    }
    expect(run([Buffer.from('{"a":1}', 'utf8')])).toBe('no_trailing_newline');
  });

  it('空行 / 非 JSON → bad_json;非法 UTF-8 → bad_utf8(fatal,不悄悄替换);BOM 不被吞掉 → bad_json', () => {
    expect(run([Buffer.from('{"a":1}\n\n{"b":2}\n')])).toBe('bad_json');
    expect(run([Buffer.from('not json\n')])).toBe('bad_json');
    expect(run([Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d, 0x0a])])).toBe('bad_utf8');
    expect(run([Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('{"a":1}\n')])])).toBe('bad_json');
  });

  it('记录校验为否 → bad_record(只在行完整后调用一次);校验函数看到的是解析后的值', () => {
    const seen: unknown[] = [];
    const r = run([Buffer.from('{"a":1}\n[1]\n')], {
      accept: (v) => {
        seen.push(v);
        return !Array.isArray(v);
      },
    });
    expect(r).toBe('bad_record');
    expect(seen).toEqual([{ a: 1 }, [1]]);
  });

  it('单行超过上限 → too_long,在换行出现之前就停(按字节累计,不无限占内存)', () => {
    expect(run([Buffer.from('{"a":"' + 'x'.repeat(50) + '"}\n')], { max: 20 })).toBe('too_long');
    // 恰好等于上限的一行通过
    const line = '{"a":"' + 'x'.repeat(10) + '"}';
    expect(run([Buffer.from(line + '\n')], { max: line.length })).toEqual({
      lines: 1,
      endsWithNewline: true,
    });
    // 没有换行的超长内容也在到达换行前就失败
    expect(run([Buffer.from('x'.repeat(21))], { max: 20 })).toBe('too_long');
    expect(run(split(Buffer.from('x'.repeat(21)), 4), { max: 20 })).toBe('too_long');
  });
});
