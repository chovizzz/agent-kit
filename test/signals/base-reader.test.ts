import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NormEvent, SessionRef } from '../../src/contracts/reader.js';
import { readText, stat } from '../../src/io/read-fs.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { readCompanionText, setOpenObserver } from '../../src/signals/open-readonly.js';
import { normalizeTs, truncateUtf8 } from '../../src/signals/base-reader.js';
import { sessionRefFor } from '../../src/signals/ids.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { writeSession } from '../fixtures/sessions/common.js';
import type { SessionSpec } from '../fixtures/sessions/common.js';
import { ReferenceClaudeReader } from '../fixtures/sessions/reference-reader.js';
import { newWork, sha256File } from './helpers.js';
import type { Work } from './helpers.js';

const SALT = 'c'.repeat(64);
const reader = new ReferenceClaudeReader();

function spec(w: Work, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    root: w.sessions,
    cwd: '/work/proj-a',
    id: 's1',
    userTexts: ['第一条', '第二条', 'third'],
    toolCalls: 3,
    failedResults: 1,
    version: '2.1.294',
    ...over,
  };
}

async function readAll(ref: SessionRef, maxEventBytes?: number) {
  const r = reader.read(ref, {
    salt: SALT,
    ...(maxEventBytes !== undefined ? { maxEventBytes } : {}),
  });
  const events: NormEvent[] = [];
  for await (const e of r.events) events.push(e);
  return { events, counts: r.counts(), meta: r.meta() };
}

async function oneRef(file: string): Promise<SessionRef> {
  const refs = await reader.discover(file);
  expect(refs).toHaveLength(1);
  return refs[0] as SessionRef;
}

describe('基类:计数与事件恒等(C5)', () => {
  it('三个计数 = 构造期望,且恰等于事件流里对应的事件数', async () => {
    const w = await newWork('br-count-');
    const g = await genClaude(
      w.io,
      spec(w, { unknownEvent: true, malformedLine: true, duplicates: true }),
    );
    const { events, counts, meta } = await readAll(await oneRef(g.file));
    expect(counts.user_messages).toBe(3);
    expect(counts.tool_calls).toBe(3);
    expect(counts.tool_failures).toBe(1);
    // 恒等式:计数只来自事件流
    expect(events.filter((e) => e.kind === 'user_message')).toHaveLength(counts.user_messages);
    expect(events.filter((e) => e.kind === 'tool_call')).toHaveLength(counts.tool_calls);
    expect(events.filter((e) => e.tool_failed === true)).toHaveLength(counts.tool_failures);
    expect(counts.unknown_event_types).toEqual(g.expected.unknown_event_types);
    expect(counts.unknown_event_types['<malformed>']).toBe(1);
    expect(counts.ignored_duplicate_kinds).toEqual({ 'claude.sidechain_line': 1 });
    expect(meta.agent_version).toBe('2.1.294');
    expect(meta.cwd_hint).toBe('/work/proj-a');
    // 未知事件产出 kind=unknown 的事件,不抛错
    expect(events.filter((e) => e.kind === 'unknown').map((e) => e.raw_type)).toEqual([
      'weird-new-type',
    ]);
  });

  it('每个事件都有 agent/session_ref/ts/kind(非空率 100%),session_ref 来自 opts.salt', async () => {
    const w = await newWork('br-fields-');
    const g = await genClaude(w.io, spec(w));
    const ref = await oneRef(g.file);
    const { events } = await readAll(ref);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.agent).toBe('claude');
      expect(e.session_ref).toBe(sessionRefFor(SALT, ref.path));
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
    }
  });
});

describe('基类:行解析鲁棒性(C2)', () => {
  it('BOM / CRLF / 末行无换行:计数与基线逐项相同(正向对照:基线计数非零)', async () => {
    const w = await newWork('br-fmt-');
    const base = await genClaude(
      w.io,
      spec(w, { id: 'base', unknownEvent: true, malformedLine: true }),
    );
    const baseline = (await readAll(await oneRef(base.file))).counts;
    expect(baseline.user_messages).toBe(3);
    expect(baseline.tool_calls).toBe(3);
    const variants: Partial<SessionSpec>[] = [
      { bom: true },
      { eol: '\r\n' },
      { finalNewline: false },
      { bom: true, eol: '\r\n', finalNewline: false },
    ];
    for (const [i, v] of variants.entries()) {
      const g = await genClaude(
        w.io,
        spec(w, { id: `v${i}`, unknownEvent: true, malformedLine: true, ...v }),
      );
      const c = (await readAll(await oneRef(g.file))).counts;
      expect(c, JSON.stringify(v)).toEqual(baseline);
    }
  });

  it('畸形行:非法 JSON、合法但非对象的行都计入 <malformed>,不产出事件;空白行忽略(C2)', async () => {
    const w = await newWork('br-mal-');
    const g = await genClaude(w.io, spec(w, { userTexts: ['x'], toolCalls: 0, failedResults: 0 }));
    const prev = await readText(g.file);
    await writeFile(w.io, g.file, `${prev}[1,2]\n"str"\n42\nnull\n   \n\n{"type":"user",\n`);
    const { events, counts } = await readAll(await oneRef(g.file));
    expect(counts.unknown_event_types['<malformed>']).toBe(5); // [1,2] "str" 42 null 截断行
    expect(counts.user_messages).toBe(1);
    expect(events.every((e) => e.kind !== 'unknown')).toBe(true);
  });

  it('对象行缺 type → <no-type>,不产出事件;侧链行优先于 <no-type>', async () => {
    const w = await newWork('br-notype-');
    const g = await genClaude(w.io, spec(w, { userTexts: ['x'], toolCalls: 0, failedResults: 0 }));
    const prev = await readText(g.file);
    await writeFile(w.io, g.file, `${prev}{"foo":1}\n{"type":7}\n{"isSidechain":true}\n`);
    const { counts } = await readAll(await oneRef(g.file));
    expect(counts.unknown_event_types).toEqual({ '<no-type>': 2 });
    expect(counts.ignored_duplicate_kinds).toEqual({ 'claude.sidechain_line': 1 });
  });
});

describe('基类:超长行不改变计数(C8)', () => {
  it('maxEventBytes 取小(触发 oversized)与取大,三个计数/未知计数完全相同;只丢 text', async () => {
    const w = await newWork('br-big-');
    const big = 'Z'.repeat(5000);
    const g = await genClaude(
      w.io,
      spec(w, { userTexts: ['短', big, '尾'], unknownEvent: true, malformedLine: true }),
    );
    const ref = await oneRef(g.file);
    const roomy = await readAll(ref, 1_000_000);
    const tight = await readAll(ref, 1000);
    // 正向对照:宽松时没有超长行、文本都在;紧时恰有超长行且那条 text 被丢
    expect(roomy.counts.oversized_lines).toBe(0);
    expect(tight.counts.oversized_lines).toBe(1);
    const strip = (c: typeof roomy.counts) => ({ ...c, oversized_lines: 0 });
    expect(strip(tight.counts)).toEqual(strip(roomy.counts));
    expect(tight.counts.user_messages).toBe(3);
    const users = (r: typeof roomy) => r.events.filter((e) => e.kind === 'user_message');
    expect(users(roomy).map((e) => e.text)).toEqual(['短', big, '尾']);
    expect(users(tight).map((e) => e.text)).toEqual(['短', undefined, '尾']);
    expect(tight.events.map((e) => e.kind)).toEqual(roomy.events.map((e) => e.kind));
  });

  it('truncateUtf8 不留半个字符', () => {
    expect(truncateUtf8('你好世界', 7)).toBe('你好');
    expect(truncateUtf8('abc', 10)).toBe('abc');
  });
});

describe('基类:ts 规范化与回退(C3)', () => {
  it('规范化:无时区按 UTC;非 ISO 前缀/非法日期无效;毫秒数仅在 acceptEpochMs 时有效', () => {
    expect(normalizeTs('2026-10-01T00:00:00')).toBe('2026-10-01T00:00:00.000Z');
    expect(normalizeTs('2026-10-01T08:00:00+08:00')).toBe('2026-10-01T00:00:00.000Z');
    expect(normalizeTs('2026-10-01')).toBeUndefined();
    expect(normalizeTs('2026-13-45T00:00:00Z')).toBeUndefined();
    expect(normalizeTs(1790000000000)).toBeUndefined();
    expect(normalizeTs(1790000000000, true)).toBe(new Date(1790000000000).toISOString());
    expect(normalizeTs(5, true)).toBeUndefined();
  });

  it('缺时间戳的行用会话内第一个有效时间戳;started_at 同值', async () => {
    const w = await newWork('br-ts-');
    const g = await genClaude(w.io, spec(w, { baseMs: Date.UTC(2026, 9, 2) }));
    const { events, meta } = await readAll(await oneRef(g.file));
    const first = events[0] as NormEvent; // permission-mode 行无时间戳
    expect(first.raw_type).toBe('permission-mode');
    expect(first.ts).toBe('2026-10-02T00:00:00.000Z');
    expect(meta.started_at).toBe('2026-10-02T00:00:00.000Z');
  });

  it('整个文件没有有效时间戳 → 文件 mtime,started_at 为 null', async () => {
    const w = await newWork('br-mtime-');
    const g = await genClaude(w.io, spec(w, { noTimestamps: true }));
    const { events, meta } = await readAll(await oneRef(g.file));
    const mtime = (await stat(g.file)).mtime.toISOString();
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((e) => e.ts))).toEqual(new Set([mtime]));
    expect(meta.started_at).toBeNull();
  });
});

describe('基类:discover 与只读', () => {
  it('只返回主会话文件;子代理/非 UUID 文件不收(C1);discover 的 session_ref 无盐临时值', async () => {
    const w = await newWork('br-disc-');
    const g = await genClaude(w.io, spec(w));
    const dir = path.dirname(g.file);
    const uuid = path.basename(g.file, '.jsonl');
    await writeSession(
      w.io,
      path.join(dir, uuid, 'subagents', 'agent-x.jsonl'),
      '{"type":"user"}\n',
    );
    await writeFile(w.io, path.join(dir, 'notes.jsonl'), '{"type":"user"}\n');
    const refs = await reader.discover(w.sessions);
    expect(refs.map((r) => r.path)).toEqual([g.file]);
    expect(refs[0]?.bytes).toBe((await stat(g.file)).size);
    expect(refs[0]?.session_ref).not.toBe(sessionRefFor(SALT, g.file));
  });

  it('读取不改变会话文件(sha256 前后相同)', async () => {
    const w = await newWork('br-ro-');
    const g = await genClaude(w.io, spec(w, { malformedLine: true }));
    const before = await sha256File(g.file);
    await readAll(await oneRef(g.file));
    expect(await sha256File(g.file)).toBe(before);
  });

  it('events 只能迭代一次', async () => {
    const w = await newWork('br-once-');
    const g = await genClaude(w.io, spec(w));
    const r = reader.read(await oneRef(g.file), { salt: SALT });
    for await (const _e of r.events) void _e;
    expect(() => r.events[Symbol.asyncIterator]()).toThrow();
  });
});

describe('基类:prepare 钩子与入口垫片', () => {
  it('prepare 返回的 meta 先于行应用(首值优先),伴随文件经 readCompanionText 只读读取', async () => {
    const w = await newWork('br-prep-');
    const g = await genClaude(w.io, spec(w, { cwd: '/work/from-lines' }));
    const companion = path.join(w.dir, 'companion.json');
    await writeFile(w.io, companion, JSON.stringify({ cwd: '/work/from-companion' }));
    class WithCompanion extends ReferenceClaudeReader {
      protected override async prepare() {
        const t = await readCompanionText(companion);
        return t === undefined ? undefined : { cwd_hint: (JSON.parse(t) as { cwd: string }).cwd };
      }
    }
    const opened: string[] = [];
    const prev = setOpenObserver((e) => opened.push(`${e.purpose}:${path.basename(e.path)}`));
    try {
      const r = new WithCompanion().read(await oneRef(g.file), { salt: SALT });
      for await (const _e of r.events) void _e;
      expect(r.meta().cwd_hint).toBe('/work/from-companion');
    } finally {
      setOpenObserver(prev);
    }
    expect(opened).toContain('text:companion.json');
    // 对照:不覆盖 prepare 时 cwd 来自行
    expect((await readAll(await oneRef(g.file))).meta.cwd_hint).toBe('/work/from-lines');
  });

  it('入口垫片:一次 read 恰好对会话文件打开两次(预扫 + 主读),全部 O_RDONLY', async () => {
    const w = await newWork('br-shim-');
    const g = await genClaude(w.io, spec(w));
    const ref = await oneRef(g.file);
    const seen: { path: string; flags: string; purpose: string }[] = [];
    const prev = setOpenObserver((e) => seen.push(e));
    try {
      await readAll(ref);
    } finally {
      setOpenObserver(prev);
    }
    const lines = seen.filter((e) => e.purpose === 'lines' && e.path === g.file);
    expect(lines).toHaveLength(2);
    expect(seen.every((e) => e.flags === 'O_RDONLY')).toBe(true);
  });
});
