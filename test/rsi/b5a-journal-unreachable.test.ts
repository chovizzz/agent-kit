/**
 * R20-A2 B5a(方案 §0.5 R7):「tick 遇到 purge journal」在 B5c 之前不可达的静态证据。
 * B5a 时没有任何生产代码对 `purge-journal.json` 调用写出口(白名单为空),所以 tick 里「confirmed 且有 journal → 临时 fail-closed `purge_incomplete`」只会被人工放置的夹具触发。
 * B5c 合并时把白名单改成 `src/rsi/services/purge-journal.ts` 并删掉 tick 的临时分支。
 * 扫描口径:在提到 journal 文件名 / 常量的行附近(±2 行)出现写出口调用(createExclusive / writeFile / rename / remove / appendFile / chmod / mkdirp)即命中。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

/** 允许写 journal 的生产文件(B5a 时为空;B5c 起只有 purge-journal.ts) */
const WRITERS: readonly string[] = ['src/rsi/services/purge-journal.ts'];

const MENTION = /purge-journal|JOURNAL_FILE|journalPath/;
const WRITE_CALL = /\b(createExclusive|writeFile|rename|remove|appendFile|chmod|mkdirp)\(/;

export function journalWriteHits(source: string): number[] {
  const lines = source.split('\n');
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (!MENTION.test(l)) return;
    const near = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
    if (WRITE_CALL.test(near)) hits.push(i + 1);
  });
  return hits;
}

async function srcFiles(rel: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readDir(path.join(REPO_ROOT, rel))) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory && !e.isSymbolicLink) out.push(...(await srcFiles(r)));
    else if (e.isFile && e.name.endsWith('.ts')) out.push(r);
  }
  return out;
}

describe('R7:purge journal 没有生产写入者(B5a)', () => {
  it('src/ 里除白名单外,没有文件对 purge-journal 调用写出口', async () => {
    const files = await srcFiles('src');
    expect(files.length, '正向前提:扫到了源码').toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      if (WRITERS.includes(f)) continue;
      const hits = journalWriteHits(await readText(path.join(REPO_ROOT, f)));
      if (hits.length > 0) offenders.push(`${f}:${hits.join(',')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('扫描器自身:对一份写 journal 的样例必须报出(正向对照),对只读样例不报', () => {
    const writes = `const f = path.join(dir, 'purge-journal.json');\nawait createExclusive(io, f, body, 0o600);\n`;
    const reads = `const f = path.join(dir, 'purge-journal.json');\nconst r = await readFileSafe(f, { maxBytes: 9 });\n`;
    expect(journalWriteHits(writes)).toEqual([1]);
    expect(journalWriteHits(reads)).toEqual([]);
  });
});
