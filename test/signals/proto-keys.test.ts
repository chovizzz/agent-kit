// 未知事件类型名恰好是原型链上的名字(constructor / __proto__ / toString)时,计数表不能被污染或丢计数。
// 覆盖:四个 reader(claude / codex / kimi / pi,共用 base-reader 的计数)、safeKey 之后的 sanitizeCounts、
// 会话计数库的 capKeys、collect 聚合与 CLI 输出。
import { describe, expect, it } from 'vitest';
import { CountsSchema } from '../../src/contracts/reader.js';
import type { SessionRef, TraceReader } from '../../src/contracts/reader.js';
import { SessionStatSchema } from '../../src/contracts/session-stat.js';
import { readText } from '../../src/io/read-fs.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { createClaudeReader } from '../../src/readers/claude/index.js';
import { createCodexReader } from '../../src/readers/codex/index.js';
import { createKimiReader } from '../../src/readers/kimi/index.js';
import { createPiReader } from '../../src/readers/pi/index.js';
import { createRedactor } from '../../src/redact/index.js';
import { addCount, newCountRecord, toCountRecord } from '../../src/contracts/count-record.js';
import { sanitizeCounts } from '../../src/signals/pipeline.js';
import { statLine } from '../../src/signals/session-stats.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { genCodex } from '../fixtures/sessions/gen-codex.js';
import { genKimi } from '../fixtures/sessions/gen-kimi.js';
import { genPi } from '../fixtures/sessions/gen-pi.js';
import type { GeneratedSession, SessionSpec } from '../fixtures/sessions/common.js';
import { newWork, runCollect } from './helpers.js';
import type { Work } from './helpers.js';

const SALT = 'f'.repeat(64);
// constructor 出现两次,验证「读到原型链上的函数再 +1」不会发生;其余各一次
const NAMES = ['constructor', '__proto__', 'toString', 'constructor'] as const;
const EXPECTED: [string, number][] = [
  ['__proto__', 1],
  ['constructor', 2],
  ['toString', 1],
];

function spec(w: Work, id: string): SessionSpec {
  return {
    root: w.sessions,
    cwd: '/work/proj-a',
    id,
    userTexts: ['你好'],
    toolCalls: 1,
    failedResults: 0,
    version: '2.1.294',
    unknownEvent: true,
  };
}

interface Case {
  agent: string;
  /** 生成器放进文件的那条「未知事件」行里独有的子串 */
  marker: string;
  /** 把那一行改成顶层类型名 = name 的行 */
  mutate: (obj: Record<string, unknown>, name: string, i: number) => Record<string, unknown>;
  gen: (w: Work) => Promise<GeneratedSession>;
  make: () => TraceReader;
}

const CASES: Case[] = [
  {
    agent: 'claude',
    marker: 'weird-new-type',
    mutate: (o, name) => ({ ...o, type: name }),
    gen: (w) => genClaude(w.io, spec(w, 'p1')),
    make: createClaudeReader,
  },
  {
    agent: 'codex',
    marker: 'brand_new_event',
    mutate: (o, name) => {
      const rest = { ...o, type: name };
      delete rest['payload'];
      return rest;
    },
    gen: (w) => genCodex(w.io, spec(w, 'p2')),
    make: createCodexReader,
  },
  {
    agent: 'kimi',
    marker: 'future.thing',
    mutate: (o, name) => ({ ...o, type: name }),
    gen: (w) => genKimi(w.io, spec(w, 'p3')),
    make: createKimiReader,
  },
  {
    agent: 'pi',
    marker: 'mystery_entry',
    mutate: (o, name, i) => ({ ...o, type: name, id: `u0-${i}` }),
    gen: (w) => genPi(w.io, spec(w, 'p4')),
    make: createPiReader,
  },
];

async function injected(w: Work, c: Case): Promise<{ file: string }> {
  const g = await c.gen(w);
  const lines = (await readText(g.file)).split('\n');
  const at = lines.findIndex((l) => l.includes(c.marker));
  expect(at, `${c.agent}: 生成器的未知事件行`).toBeGreaterThanOrEqual(0);
  const base = JSON.parse(lines[at] as string) as Record<string, unknown>;
  lines.splice(at, 1, ...NAMES.map((n, i) => JSON.stringify(c.mutate(base, n, i))));
  await writeFile(w.io, g.file, lines.join('\n'));
  return { file: g.file };
}

const sorted = (rec: Record<string, number>): [string, number][] =>
  Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe.each(CASES)('$agent reader:原型链同名的事件类型', (c) => {
  it('unknown_event_types 按键各自计数,无原型,整数计数', async () => {
    const w = await newWork(`pk-${c.agent}-`);
    const { file } = await injected(w, c);
    const reader = c.make();
    const refs = await reader.discover(file);
    expect(refs).toHaveLength(1);
    const r = reader.read(refs[0] as SessionRef, { salt: SALT });
    for await (const _ of r.events) void _;
    const unknown = r.counts().unknown_event_types;
    expect(sorted(unknown)).toEqual(EXPECTED);
    expect(Object.getPrototypeOf(unknown)).toBeNull();
    for (const v of Object.values(unknown)) expect(Number.isInteger(v)).toBe(true);
    // JSON 口径:键数、键序、值与普通对象的序列化一致
    expect(JSON.parse(JSON.stringify(unknown))).toEqual(Object.fromEntries(EXPECTED));
  });
});

describe('count-record 与下游计数函数', () => {
  it('addCount / toCountRecord 对原型名按普通键处理', () => {
    const r = newCountRecord();
    for (const n of NAMES) addCount(r, n);
    expect(sorted(r)).toEqual(EXPECTED);
    const copy = toCountRecord(r);
    expect(copy).not.toBe(r);
    expect(sorted(copy)).toEqual(EXPECTED);
    expect(Object.getPrototypeOf(copy)).toBeNull();
    // 对照:普通对象的老写法确实坏(钉住这个测试在检测什么)
    const plain: Record<string, number> = {};
    plain['constructor'] = (plain['constructor'] ?? 0) + 1;
    expect(typeof plain['constructor']).not.toBe('number');
  });

  it('sanitizeCounts:原型名通过 safeKey 后仍按键计数;折叠到 <unprintable> 的计数相加', () => {
    const redactor = createRedactor({ timeout_ms: 5000 });
    const unknown = newCountRecord();
    for (const n of NAMES) addCount(unknown, n);
    addCount(unknown, 'has space', 2);
    addCount(unknown, 'also bad!', 3);
    const out = sanitizeCounts(redactor, {
      user_messages: 0,
      tool_calls: 0,
      tool_failures: 0,
      oversized_lines: 0,
      unknown_event_types: unknown,
      ignored_duplicate_kinds: toCountRecord({ constructor: 1, toString: 2 }),
    });
    expect(sorted(out.unknown_event_types)).toEqual([['<unprintable>', 5], ...EXPECTED]);
    expect(sorted(out.ignored_duplicate_kinds ?? {})).toEqual([
      ['constructor', 1],
      ['toString', 2],
    ]);
  });
});

describe('collect 端到端(claude)', () => {
  it('会话计数与汇总报告里原型名各自计数', async () => {
    const w = await newWork('pk-collect-');
    const c = CASES[0] as Case;
    await injected(w, c);
    const r = await runCollect(w, [
      '--source',
      w.sessions,
      '--agent',
      'claude',
      '--allow-project',
      'proj-a',
    ]);
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out) as {
      report: { unknown_event_types: Record<string, number> };
      sessions: { counts: { unknown_event_types: Record<string, number> } }[];
    };
    expect(sorted(out.report.unknown_event_types)).toEqual(EXPECTED);
    expect(sorted(out.sessions[0]!.counts.unknown_event_types)).toEqual(EXPECTED);
  });
});

describe('契约模式不丢 __proto__ 键(zod 的 z.record 会静默丢)', () => {
  const wire = '{"__proto__":1,"constructor":2,"toString":3}';

  it('CountsSchema:JSON 反序列化出的自有 __proto__ 键保留,值仍被校验', () => {
    const base = { user_messages: 0, tool_calls: 0, tool_failures: 0 };
    const ok = CountsSchema.parse({ ...base, unknown_event_types: JSON.parse(wire) });
    expect(sorted(ok.unknown_event_types)).toEqual([
      ['__proto__', 1],
      ['constructor', 2],
      ['toString', 3],
    ]);
    expect(
      CountsSchema.safeParse({ ...base, unknown_event_types: JSON.parse('{"__proto__":-1}') })
        .success,
    ).toBe(false);
    expect(CountsSchema.safeParse({ ...base, unknown_event_types: { a: 1.5 } }).success).toBe(
      false,
    );
    expect(CountsSchema.safeParse({ ...base, unknown_event_types: [] }).success).toBe(false);
  });

  it('SessionStatSchema:__proto__ 保留且键白名单仍生效;statLine 往返字节稳定', () => {
    const mk = (counts: unknown) => ({
      session_ref: 's_0123456789abcdef',
      project_key: 'p_fedcba9876543210',
      ts: '2026-10-12T00:00:00Z',
      external_content: false,
      counts,
    });
    const counts = {
      user_messages: 1,
      tool_calls: 0,
      tool_failures: 0,
      unknown_event_types: JSON.parse(wire),
    };
    const stat = SessionStatSchema.parse(mk(counts));
    expect(sorted(stat.counts.unknown_event_types)).toHaveLength(3);
    const line = statLine(stat);
    expect(line).toContain('"__proto__":1');
    expect(statLine(SessionStatSchema.parse(JSON.parse(line)))).toBe(line);
    const badKey = { ...counts, unknown_event_types: { 'has space': 1 } };
    expect(SessionStatSchema.safeParse(mk(badKey)).success).toBe(false);
  });
});
