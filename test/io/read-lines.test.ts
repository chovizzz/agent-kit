import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLines } from '../../src/io/read-fs.js';
import { remove, writeFile } from '../../src/io/safe-fs.js';
import { makeTempDir } from '../helpers/tmp.js';

async function lines(content: string): Promise<string[]> {
  const { ctx, dir } = await makeTempDir('read-lines-');
  const p = path.join(dir, 'x.jsonl');
  try {
    await writeFile(ctx, p, content);
    const out: string[] = [];
    for await (const l of readLines(p)) out.push(l);
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
