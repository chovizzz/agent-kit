/** 验收 ①:合成夹具端到端(生成器的期望计数与 reader 输出逐项相等)+ spec §7.1 的 15 行夹具。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { genClaude } from '../../fixtures/sessions/gen-claude.js';
import type { SessionSpec } from '../../fixtures/sessions/common.js';
import { homeSnapshot } from '../../signals/helpers.js';
import { newWork, oneRef, readFile, readLines } from './helpers.js';
import type { Work } from './helpers.js';
import { createClaudeReader } from '../../../src/readers/claude/index.js';
import { SALT } from './helpers.js';

let homeBefore = '';
beforeAll(async () => {
  homeBefore = await homeSnapshot();
});
afterAll(async () => {
  // 假 HOME 之外的东西不碰:真实 HOME 前后无变化
  expect(await homeSnapshot()).toBe(homeBefore);
});

function spec(w: Work, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    root: w.sessions,
    cwd: '/work/proj-a',
    id: 's1',
    userTexts: ['第一条', 'second', '第三条'],
    toolCalls: 4,
    failedResults: 2,
    version: '2.1.294',
    ...over,
  };
}

const VARIANTS: [string, Partial<SessionSpec>][] = [
  ['基本', {}],
  ['未知事件', { unknownEvent: true }],
  ['畸形行', { malformedLine: true }],
  ['侧链行', { duplicates: true }],
  ['三者齐', { unknownEvent: true, malformedLine: true, duplicates: true }],
  ['BOM', { bom: true, unknownEvent: true, malformedLine: true }],
  ['CRLF', { eol: '\r\n', unknownEvent: true, malformedLine: true, duplicates: true }],
  ['末行无换行', { finalNewline: false, malformedLine: true }],
  ['BOM+CRLF+无末行换行', { bom: true, eol: '\r\n', finalNewline: false, duplicates: true }],
  ['零工具零用户', { userTexts: [], toolCalls: 0, failedResults: 0 }],
  ['全失败', { toolCalls: 3, failedResults: 3 }],
];

describe('生成器夹具 × reader:计数逐项相等', () => {
  for (const [name, over] of VARIANTS) {
    it(name, async () => {
      const w = await newWork('cl-e2e-');
      const g = await genClaude(w.io, spec(w, over));
      const { events, counts } = await readFile(g.file);
      expect(counts.user_messages).toBe(g.expected.user_messages);
      expect(counts.tool_calls).toBe(g.expected.tool_calls);
      expect(counts.tool_failures).toBe(g.expected.tool_failures);
      expect(counts.unknown_event_types).toEqual(g.expected.unknown_event_types);
      expect(counts.ignored_duplicate_kinds).toEqual(g.expected.ignored_duplicate_kinds);
      expect(counts.oversized_lines).toBe(0);
      // C5 恒等式
      expect(events.filter((e) => e.kind === 'user_message')).toHaveLength(counts.user_messages);
      expect(events.filter((e) => e.kind === 'tool_call')).toHaveLength(counts.tool_calls);
      expect(events.filter((e) => e.tool_failed === true)).toHaveLength(counts.tool_failures);
      // 用 discover 找到的 ref 也一样(目录入口)
      const ref = await oneRef(w.sessions);
      expect(ref.path).toBe(g.file);
      expect(ref.agent).toBe('claude');
    });
  }

  it('正向对照:变体确实改变了文件内容(不是对着同一份空转)', async () => {
    const w = await newWork('cl-e2e-ctl-');
    const g = await genClaude(
      w.io,
      spec(w, { unknownEvent: true, malformedLine: true, duplicates: true }),
    );
    const { counts } = await readFile(g.file);
    expect(counts.unknown_event_types).toEqual({ 'weird-new-type': 1, '<malformed>': 1 });
    expect(counts.ignored_duplicate_kinds).toEqual({ 'claude.sidechain_line': 1 });
    expect(counts.user_messages).toBe(3);
  });
});

/** spec §7.1 的合成夹具,15 行,期望 {2,2,1}。 */
function specFixtureLines(): (Record<string, unknown> | string)[] {
  const c = (n: number): Record<string, unknown> => ({
    isSidechain: false,
    timestamp: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
    version: '2.1.0',
    sessionId: 'S1',
  });
  return [
    { type: 'mode', mode: 'default', sessionId: 'S1' },
    { type: 'user', ...c(1), cwd: '/w/p', message: { role: 'user', content: 'hello' } },
    {
      type: 'assistant',
      ...c(2),
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        ],
      },
    },
    {
      type: 'user',
      ...c(3),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'x' },
          { type: 'tool_result', tool_use_id: 't2', content: 'y' },
        ],
      },
    },
    { type: 'user', ...c(4), isMeta: true, message: { role: 'user', content: 'meta' } },
    {
      type: 'user',
      ...c(5),
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: 'n' },
    },
    {
      type: 'user',
      ...c(6),
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    },
    {
      type: 'user',
      ...c(7),
      origin: { kind: 'human' },
      turnOrigin: 'human',
      message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
    },
    {
      type: 'user',
      isSidechain: true,
      timestamp: '2026-01-01T00:00:08.000Z',
      message: { role: 'user', content: 'side' },
    },
    { type: 'weird-new-type', timestamp: '2026-01-01T00:00:09.000Z' },
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:10.000Z',
      message: { role: 'assistant', content: [{ type: 'server_tool_use', id: 'z' }] },
    },
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:10.500Z',
      message: { role: 'assistant', content: [{ text: 'block without type' }] },
    },
    {
      type: 'user',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:11.500Z',
      message: 'not-an-object-content-shape',
    },
    '{"type":"user","isSidechain":false,"timestamp":"2026-01-01T00:00:11.000Z"',
    '   ',
  ];
}

describe('spec §7.1 的 15 行合成夹具', () => {
  const expectCounts = (r: Awaited<ReturnType<typeof readLines>>): void => {
    expect(r.counts.user_messages).toBe(2);
    expect(r.counts.tool_calls).toBe(2);
    expect(r.counts.tool_failures).toBe(1);
    expect(r.counts.unknown_event_types).toEqual({
      'weird-new-type': 1,
      'assistant.server_tool_use': 1,
      'assistant.(none)': 1,
      '<malformed>': 1,
    });
    expect(r.counts.ignored_duplicate_kinds).toEqual({ 'claude.sidechain_line': 1 });
  };

  it('LF', async () => {
    const w = await newWork('cl-spec-');
    expectCounts(await readLines(w, specFixtureLines()));
  });

  it('§7.6 三种变体与原夹具计数相同:BOM / CRLF / 末行无换行', async () => {
    const w = await newWork('cl-spec-var-');
    const base = await readLines(w, specFixtureLines());
    for (const over of [{ bom: true }, { eol: '\r\n' as const }, { finalNewline: false }]) {
      const v = await readLines(w, specFixtureLines(), over);
      expectCounts(v);
      expect(v.counts).toEqual(base.counts);
    }
  });

  it('逐行判定:第 1 行 mode 无时间戳,ts 回退到第 2 行;第 13 行 message 为字符串不算用户消息也不报未知', async () => {
    const w = await newWork('cl-spec-rows-');
    const r = await readLines(w, specFixtureLines());
    const first = r.events[0];
    expect(first?.raw_type).toBe('mode');
    expect(first?.ts).toBe('2026-01-01T00:00:01.000Z');
    expect(r.meta.started_at).toBe('2026-01-01T00:00:01.000Z');
    // 第 13 行:meta,不进 unknown
    const metas = r.events.filter((e) => e.kind === 'meta' && e.raw_type === 'user');
    expect(metas.map((e) => e.ts)).toContain('2026-01-01T00:00:11.500Z');
  });
});

describe('非空率(A6)', () => {
  it('agent_version / ts / session_ref 全部非空,session_ref 来自 opts.salt', async () => {
    const w = await newWork('cl-nonnull-');
    const g = await genClaude(
      w.io,
      spec(w, { unknownEvent: true, malformedLine: true, duplicates: true }),
    );
    const { events, meta } = await readFile(g.file);
    expect(events.length).toBeGreaterThan(0);
    expect(meta.agent_version).toBe('2.1.294');
    expect(meta.agent_version).not.toBe('');
    expect(meta.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const e of events) {
      expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(e.session_ref).toMatch(/^s_[0-9a-f]{16}$/);
      expect(e.agent).toBe('claude');
    }
    const refs = await createClaudeReader().discover(w.sessions);
    const again = createClaudeReader().read(refs[0]!, { salt: SALT });
    const first = (await again.events[Symbol.asyncIterator]().next()).value;
    expect(first?.session_ref).toBe(events[0]?.session_ref);
  });
});
