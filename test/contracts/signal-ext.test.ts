import { describe, expect, it } from 'vitest';
import { SignalSchema } from '../../src/contracts/index.js';
import { SessionStatSchema, sessionStatFileName } from '../../src/contracts/index.js';

const base = {
  sig_id: 'sig_0123456789abcdef',
  agent: 'claude',
  agent_version: '1.2.3',
  agent_version_source: 'session_meta',
  session_ref: 's_0123456789abcdef',
  project_key: 'p_fedcba9876543210',
  ts: '2026-10-12T00:00:00Z',
  type: 'event',
  excerpt_redacted: 'hello',
  external_content: false,
  confidence: 1,
  loaded_rule_ids: [],
};

describe('R0-1 Signal 追加可选字段', () => {
  it('旧信号(没有新字段)仍通过校验', () => {
    expect(SignalSchema.safeParse(base).success).toBe(true);
  });

  it('三个新字段可选且合法值通过', () => {
    for (const kind of ['user_message', 'tool_call', 'tool_result_failed']) {
      const r = SignalSchema.safeParse({
        ...base,
        event_kind: kind,
        event_index: 0,
        tool_name: 'Bash',
      });
      expect(r.success, JSON.stringify(r)).toBe(true);
    }
    expect(SignalSchema.safeParse({ ...base, tool_name: '<unprintable>' }).success).toBe(true);
    expect(SignalSchema.safeParse({ ...base, tool_name: 'mcp__srv__do.it' }).success).toBe(true);
  });

  it('非法值被拒:未知种类、负/小数序号、空/超长/含空白与控制字符的工具名', () => {
    const bad: Record<string, unknown>[] = [
      { event_kind: 'assistant_message' },
      { event_kind: '' },
      { event_index: -1 },
      { event_index: 1.5 },
      { event_index: '3' },
      { tool_name: '' },
      { tool_name: 'a'.repeat(97) },
      { tool_name: 'rm -rf /' },
      { tool_name: 'a\nb' },
      { tool_name: 'a‮b' },
    ];
    for (const extra of bad) {
      expect(SignalSchema.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('仍是 strictObject:未知字段被拒(新字段必须先进契约)', () => {
    expect(SignalSchema.safeParse({ ...base, event_kinds: 'x' }).success).toBe(false);
  });
});

describe('R0-2 会话计数库 SessionStat', () => {
  const stat = {
    session_ref: 's_0123456789abcdef',
    project_key: 'p_fedcba9876543210',
    ts: '2026-10-12T00:00:00Z',
    external_content: true,
    counts: {
      user_messages: 3,
      tool_calls: 5,
      tool_failures: 1,
      unknown_event_types: { 'weird.type': 2 },
    },
  };

  it('合法行通过;counts 可带 oversized_lines / branch_count / ignored_duplicate_kinds', () => {
    expect(SessionStatSchema.safeParse(stat).success).toBe(true);
    expect(
      SessionStatSchema.safeParse({
        ...stat,
        counts: {
          ...stat.counts,
          oversized_lines: 1,
          branch_count: 2,
          ignored_duplicate_kinds: { dup_kind: 1 },
        },
      }).success,
    ).toBe(true);
  });

  it('没有任何文本字段:多余字段(excerpt/text)被拒', () => {
    expect(SessionStatSchema.safeParse({ ...stat, excerpt_redacted: 'x' }).success).toBe(false);
    expect(SessionStatSchema.safeParse({ ...stat, text: 'x' }).success).toBe(false);
    expect(
      SessionStatSchema.safeParse({ ...stat, counts: { ...stat.counts, note: 'x' } }).success,
    ).toBe(false);
  });

  it('计数里的键(来自会话事件类型名)必须是安全字符,否则文本会借键名落盘', () => {
    for (const k of ['has space', 'a/b', '汉字', 'x'.repeat(97), '', 'line\nbreak']) {
      expect(
        SessionStatSchema.safeParse({
          ...stat,
          counts: { ...stat.counts, unknown_event_types: { [k]: 1 } },
        }).success,
        JSON.stringify(k),
      ).toBe(false);
      expect(
        SessionStatSchema.safeParse({
          ...stat,
          counts: { ...stat.counts, ignored_duplicate_kinds: { [k]: 1 } },
        }).success,
        JSON.stringify(k),
      ).toBe(false);
    }
    expect(
      SessionStatSchema.safeParse({
        ...stat,
        counts: { ...stat.counts, unknown_event_types: { '<unprintable>': 1 } },
      }).success,
    ).toBe(true);
  });

  it('键数上限 64', () => {
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1]));
    const mk = (n: number) =>
      SessionStatSchema.safeParse({
        ...stat,
        counts: { ...stat.counts, unknown_event_types: many(n) },
      }).success;
    expect(mk(64)).toBe(true);
    expect(mk(65)).toBe(false);
  });

  it('字段类型:external_content 必须是布尔,计数不能为负', () => {
    expect(SessionStatSchema.safeParse({ ...stat, external_content: 'true' }).success).toBe(false);
    expect(
      SessionStatSchema.safeParse({ ...stat, counts: { ...stat.counts, tool_calls: -1 } }).success,
    ).toBe(false);
    expect(SessionStatSchema.safeParse({ ...stat, session_ref: 'sess' }).success).toBe(false);
  });

  it('文件名 <yyyymm>.jsonl:月份 01..12,其它拒绝(防路径片段)', () => {
    expect(sessionStatFileName('202610')).toBe('202610.jsonl');
    for (const bad of ['202613', '202600', '2026-10', '../x', '20261', '2026100', '']) {
      expect(() => sessionStatFileName(bad), bad).toThrow();
    }
  });
});
