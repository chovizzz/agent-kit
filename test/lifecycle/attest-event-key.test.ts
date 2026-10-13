import { describe, expect, it } from 'vitest';
import type {
  Counts,
  NormEvent,
  SessionMeta,
  SessionRead,
  TraceReader,
} from '../../src/contracts/reader.js';
import { EVENT_KEY_RE } from '../../src/contracts/signal.js';
import type { AgentId } from '../../src/contracts/common.js';
import { createRedactor } from '../../src/redact/index.js';
import type { ExcludePolicy } from '../../src/signals/exclude.js';
import { processSession } from '../../src/signals/pipeline.js';
import type { PipelineDeps } from '../../src/signals/pipeline.js';

/** pipeline 只加 event_key(D4):resume / fork 复制的同一事件在不同会话文件里得到同一个键。 */
const COUNTS: Counts = {
  user_messages: 2,
  tool_calls: 0,
  tool_failures: 0,
  unknown_event_types: {},
};
const META: SessionMeta = {
  agent_version: '1.0.0',
  cwd_hint: '/work/proj-a',
  started_at: null,
  external_content: false,
  loaded_rule_paths: [],
};
const ev = (over: Partial<NormEvent> = {}): NormEvent =>
  ({
    agent: 'claude',
    session_ref: 'a'.repeat(16),
    ts: '2026-10-01T00:00:00Z',
    kind: 'user_message',
    raw_type: 'user',
    text: 'hello there',
    ...over,
  }) as NormEvent;

const readerOf = (agent: AgentId, events: NormEvent[]): TraceReader => ({
  agent,
  discover: async () => [],
  read: (): SessionRead => ({
    events: (async function* () {
      for (const e of events) yield e;
    })(),
    meta: () => META,
    counts: () => COUNTS,
  }),
});
const policy: ExcludePolicy = {
  decide: async () => ({ action: 'process', projectRoot: '/work/proj-a' }),
};
const deps = (salt = 'a'.repeat(32)): PipelineDeps => ({
  redactor: createRedactor({ timeout_ms: 5000 }),
  policy,
  salt,
  fallbackVersion: undefined,
  maxEventBytes: undefined,
});
const ref = (name: string) =>
  ({ agent: 'claude', path: `/nonexistent/${name}.jsonl`, session_ref: 'x', bytes: 0 }) as const;

describe('event_key 生成', () => {
  it('claude:不同会话文件里的同一事件 → 同一个键(签名合规);sig_id 与 session_ref 仍各异', async () => {
    const events = [ev(), ev({ ts: '2026-10-01T00:00:05Z', text: 'second' })];
    const a = await processSession(readerOf('claude', events), ref('a'), deps());
    const b = await processSession(readerOf('claude', events), ref('b'), deps());
    expect(a.signals.map((s) => s.event_key)).toEqual(b.signals.map((s) => s.event_key));
    for (const s of a.signals) expect(s.event_key).toMatch(EVENT_KEY_RE);
    expect(a.signals[0]?.event_key).not.toBe(a.signals[1]?.event_key);
    expect(a.signals[0]?.sig_id).not.toBe(b.signals[0]?.sig_id);
  });

  it('同一会话里指纹完全相同的两次事件靠历史链区分;内容/盐不同则键不同', async () => {
    const same = await processSession(readerOf('claude', [ev(), ev()]), ref('a'), deps());
    expect(same.signals[0]?.event_key).not.toBe(same.signals[1]?.event_key);
    const other = await processSession(
      readerOf('claude', [ev({ text: 'different' })]),
      ref('a'),
      deps(),
    );
    expect(other.signals[0]?.event_key).not.toBe(same.signals[0]?.event_key);
    const salted = await processSession(readerOf('claude', [ev()]), ref('a'), deps('b'.repeat(32)));
    expect(salted.signals[0]?.event_key).not.toBe(same.signals[0]?.event_key);
  });

  it('resume:带着同一段前缀的会话共享前缀事件的键;新增的事件键不同', async () => {
    const prefix = [ev(), ev({ ts: '2026-10-01T00:00:05Z', text: 'second' })];
    const a = await processSession(readerOf('claude', prefix), ref('a'), deps());
    const b = await processSession(
      readerOf('claude', [...prefix, ev({ ts: '2026-10-02T00:00:00Z', text: 'after resume' })]),
      ref('b'),
      deps(),
    );
    const ka = a.signals.map((s) => s.event_key);
    const kb = b.signals.map((s) => s.event_key);
    expect(kb.slice(0, 2)).toEqual(ka);
    expect(kb[2]).toBeDefined();
    expect(ka).not.toContain(kb[2]);
  });

  it('两个独立会话在同一秒做了同样的事:历史不同 → 键不同(不会误合并);历史相同才合并', async () => {
    const same = ev({ ts: '2026-10-05T00:00:00Z', text: 'hello' });
    const a = await processSession(
      readerOf('claude', [ev({ text: 'a-first' }), same]),
      ref('a'),
      deps(),
    );
    const b = await processSession(
      readerOf('claude', [ev({ text: 'b-first' }), same]),
      ref('b'),
      deps(),
    );
    expect(a.signals[1]?.event_key).not.toBe(b.signals[1]?.event_key);
    const c = await processSession(
      readerOf('claude', [ev({ text: 'a-first' }), same]),
      ref('c'),
      deps(),
    );
    expect(c.signals[1]?.event_key).toBe(a.signals[1]?.event_key);
  });

  it('键里没有原文:不含文本、盐', async () => {
    const r = await processSession(
      readerOf('claude', [ev({ text: 'zzz-secret-marker' })]),
      ref('a'),
      deps(),
    );
    const key = r.signals[0]?.event_key ?? '';
    expect(key).not.toContain('zzz');
    expect(key).not.toContain('a'.repeat(32));
  });

  it('pi 带键;codex / kimi 不带(无跨文件重复)', async () => {
    for (const [agent, has] of [
      ['pi', true],
      ['claude', true],
      ['codex', false],
      ['kimi', false],
    ] as const) {
      const r = await processSession(readerOf(agent, [ev({ agent })]), ref('a'), deps());
      expect(r.signals).toHaveLength(1);
      expect(r.signals[0]?.event_key !== undefined, agent).toBe(has);
    }
  });
});
