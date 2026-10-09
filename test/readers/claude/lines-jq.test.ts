/**
 * R2/R3:空白行、行首 BOM、超长行的口径。期望值来自本机 jq 1.7.1 在同样合成输入上的实测
 * (`test("\\S")` 与 `fromjson?`),不是照实现写的。
 */
import { describe, expect, it } from 'vitest';
import { mkdirp, remove, writeFile } from '../../../src/io/safe-fs.js';
import { createClaudeReader } from '../../../src/readers/claude/index.js';
import type { SessionRef } from '../../../src/contracts/reader.js';
import { SALT, newWork, readLines, userLine } from './helpers.js';

const BOM = '﻿';
const U = (): Record<string, unknown> => userLine('hello');

describe('R2:空白与 BOM 对齐 jq', () => {
  it('只含 U+FEFF 的非首行:不是空白 → <malformed>(jq: test("\\S") 为 true,fromjson 失败)', async () => {
    const w = await newWork('cl-bom1-');
    const r = await readLines(w, [U(), BOM, U()]);
    expect(r.counts.unknown_event_types).toEqual({ '<malformed>': 1 });
    expect(r.counts.user_messages).toBe(2);
  });

  it('只含 U+0085 的行:是空白 → 跳过(jq: test("\\S") 为 false)', async () => {
    const w = await newWork('cl-bom2-');
    const r = await readLines(w, [U(), '\u0085', '    ', U()]);
    expect(r.counts.unknown_event_types).toEqual({});
    expect(r.counts.user_messages).toBe(2);
  });

  it('行首恰好一个 BOM + JSON 对象(非首行,如 cat 拼接):正常计数(jq: fromjson 跳过 BOM)', async () => {
    const w = await newWork('cl-bom3-');
    const r = await readLines(w, [U(), BOM + JSON.stringify(U()), U()]);
    expect(r.counts.unknown_event_types).toEqual({});
    expect(r.counts.user_messages).toBe(3);
  });

  it('BOM 在别处(行尾 / 两个 BOM / 空格后 BOM)仍是 <malformed>(jq 同)', async () => {
    const w = await newWork('cl-bom4-');
    const j = JSON.stringify(U());
    const r = await readLines(w, [j + BOM, BOM + BOM + j, ' ' + BOM + j, U()]);
    expect(r.counts.unknown_event_types).toEqual({ '<malformed>': 3 });
    expect(r.counts.user_messages).toBe(1);
  });

  it('首行只有 BOM:同样计 <malformed>(与非首行一致,jq 同)', async () => {
    const w = await newWork('cl-bom5-');
    const r = await readLines(w, [BOM, U()]);
    expect(r.counts.unknown_event_types).toEqual({ '<malformed>': 1 });
  });

  it('控制组:首行 BOM + JSON 照常', async () => {
    const w = await newWork('cl-bom6-');
    const r = await readLines(w, [BOM + JSON.stringify(U()), U()]);
    expect(r.counts.user_messages).toBe(2);
    expect(r.counts.unknown_event_types).toEqual({});
  });
});

describe('R3:超过硬上限的行', () => {
  it('maxEventBytes 大于单行硬上限 → read() 直接报错,不悄悄截断', async () => {
    const w = await newWork('cl-big0-');
    const r = await readLines(w, [U()]);
    const reader = createClaudeReader();
    const refs: SessionRef[] = await reader.discover(r.file);
    expect(() => reader.read(refs[0] as SessionRef, { salt: SALT, maxEventBytes: 1e12 })).toThrow(
      /硬上限/,
    );
  });

  it('超大行(> 64 MiB)不让整个会话失败:计 oversized 与 <line-too-large>,前后行照常', async () => {
    const w = await newWork('cl-big1-');
    const file = `${w.sessions}/proj/00000000-0000-4000-8000-000000000001.jsonl`;
    const huge = 'q'.repeat(64 * 1024 * 1024 + 10);
    await mkdirp(w.io, `${w.sessions}/proj`);
    await writeFile(
      w.io,
      file,
      `${JSON.stringify(U())}\n{"type":"user","pad":"${huge}"}\n${JSON.stringify(U())}\n`,
    );
    const reader = createClaudeReader();
    const refs = await reader.discover(file);
    const read = reader.read(refs[0] as SessionRef, { salt: SALT });
    let n = 0;
    for await (const e of read.events) {
      void e;
      n++;
    }
    const c = read.counts();
    expect(c.user_messages).toBe(2);
    expect(c.oversized_lines).toBe(1);
    expect(c.unknown_event_types).toEqual({ '<line-too-large>': 1 });
    expect(n).toBe(2);
    await remove(w.io, file);
  }, 60_000);
});
