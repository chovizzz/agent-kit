import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_LINE_BYTES, TOO_LONG_LINE, readLines } from '../../src/io/read-fs.js';
import { remove, writeFile } from '../../src/io/safe-fs.js';
import { makeTempDir } from '../helpers/tmp.js';

async function lines(content: string, max?: number): Promise<string[]> {
  const { ctx, dir } = await makeTempDir('read-lines-');
  const p = path.join(dir, 'x.jsonl');
  try {
    await writeFile(ctx, p, content);
    const out: string[] = [];
    for await (const l of readLines(p, max)) out.push(l);
    return out;
  } finally {
    await remove(ctx, dir);
  }
}

describe('readLines:行分隔符只认 \\n(口径 C2)', () => {
  it('JSON 字符串里的裸 U+2028 / U+2029 不切行', async () => {
    const a = '{"a":"x y"}';
    const b = '{"b":"p q"}';
    expect(await lines(`${a}\n${b}\n`)).toEqual([a, b]);
  });

  it('孤立 \\r 不切行;行尾的一个 \\r(CRLF)被去掉', async () => {
    expect(await lines('a\rb\r\nc\r\n')).toEqual(['a\rb', 'c']);
  });

  it('保留空行;末行无换行也产出;末尾 \\n 之后不多出空行', async () => {
    expect(await lines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(await lines('a\n')).toEqual(['a']);
    expect(await lines('')).toEqual([]);
  });

  it('跨 chunk 的多字节字符与长行完整', async () => {
    const long = '字'.repeat(200_000);
    expect(await lines(`${long}\n${long}`)).toEqual([long, long]);
  });
});

describe('readLines:单行硬上限(R3)', () => {
  it('超过上限的行产出 TOO_LONG_LINE 占位,前后行不受影响,之后的字节丢到下一个 \\n', async () => {
    const big = 'x'.repeat(5000);
    expect(await lines(`a\n${big}\nb\n${big}`, 100)).toEqual([
      'a',
      TOO_LONG_LINE,
      'b',
      TOO_LONG_LINE,
    ]);
  });

  it('恰好等于上限不算超;多一个字节算超(按 UTF-8 字节,不含 \\n)', async () => {
    expect(await lines(`${'y'.repeat(10)}\n`, 10)).toEqual(['y'.repeat(10)]);
    expect(await lines(`${'y'.repeat(11)}\n`, 10)).toEqual([TOO_LONG_LINE]);
    expect(await lines('字字字\n', 9)).toEqual(['字字字']);
    expect(await lines('字字字\n', 8)).toEqual([TOO_LONG_LINE]);
  });

  it('占位串含 NUL,不可能是合法 JSON 行;缺省上限是 64 MiB', () => {
    expect(TOO_LONG_LINE).toContain('\u0000');
    expect(() => JSON.parse(TOO_LONG_LINE)).toThrow();
    expect(MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
  });

  it('多个 chunk 拼成的长行(远大于 64 KiB)内容完整,后接短行', async () => {
    const long = 'z'.repeat(3_000_000);
    expect(await lines(`${long}\nshort\n`)).toEqual([long, 'short']);
  });

  it('BOM 保留在行首(由上层决定怎么处理)', async () => {
    expect(await lines('\ufeffa\n')).toEqual(['\ufeffa']);
  });
});
