/**
 * W6 信号度量与资格(R21-6.7、R21-7.2、W0-7):C1 / C3 / 主判据的计数口径、资格的 30 个 UTC 日窗口。
 */
import { describe, expect, it } from 'vitest';
import type { Signal } from '../../../src/contracts/signal.js';
import { tokenSet } from '../../../src/reflect/text.js';
import {
  makeEligibility,
  sessionMeasures,
  signatureHitCount,
  toLoaded,
} from '../../../src/rsi/analysis/measures.js';
import { sessionHitsSignature } from '../../../src/rsi/personal/shadow-count.js';
import type { LoadedSignal } from '../../../src/reflect/types.js';
import { sessRef } from './w6-fixture.js';

let n = 0;
function sig(
  kind: 'user_message' | 'tool_call' | 'tool_result_failed' | null,
  index: number,
  o: { tool?: string; text?: string; type?: string; external?: boolean; session?: number } = {},
): Signal {
  n++;
  return {
    sig_id: `sig_${n.toString(16).padStart(16, '0')}`,
    agent: 'claude',
    agent_version: '2.1.0',
    agent_version_source: 'session_meta',
    session_ref: sessRef(o.session ?? 1),
    project_key: 'p1',
    ts: '2026-11-05T00:00:00Z',
    type: o.type ?? 'event',
    excerpt_redacted: o.text ?? '',
    external_content: o.external === true,
    confidence: 1,
    loaded_rule_ids: [],
    ...(kind === null ? {} : { event_kind: kind, event_index: index }),
    ...(o.tool === undefined ? {} : { tool_name: o.tool }),
  } as unknown as Signal;
}
const retry = (start: number, tool = 'Bash'): Signal[] => [
  sig('tool_call', start, { tool }),
  sig('tool_result_failed', start + 1),
  sig('tool_call', start + 2, { tool }),
];
const TOOL = { kind: 'tool', tool_name: 'Bash' } as const;
const LESSON_TEXT = '以后不要再提交大文件到仓库里';
const LESSON = { kind: 'lesson', rep_tokens: [...tokenSet(LESSON_TEXT)].sort() } as const;
const loaded = (xs: Signal[]): LoadedSignal[] =>
  xs.map(toLoaded).filter((s): s is LoadedSignal => s !== null);

describe('R21-7.2 / W0-7 会话度量', () => {
  it('C1 = tool_result_failed 信号数;没有 event_kind 的旧行不计', () => {
    const m = sessionMeasures(TOOL, [
      sig('tool_result_failed', 0),
      sig('tool_result_failed', 1),
      sig('tool_call', 2, { tool: 'Bash' }),
      sig(null, 0, { type: 'event' }),
    ]);
    expect(m.c1).toBe(2);
  });
  it('C3 = 显式教训 ∪ 用户纠正:分类器命中的教训 + type 为 explicit_lesson / user_correction 的信号,按 sig_id 去重', () => {
    const lesson = sig('user_message', 0, { text: LESSON_TEXT });
    const typed = sig('user_message', 1, { text: '今天天气不错', type: 'user_correction' });
    const both = sig('user_message', 2, { text: LESSON_TEXT, type: 'explicit_lesson' });
    const plain = sig('user_message', 3, { text: '今天天气不错' });
    expect(sessionMeasures(LESSON, [lesson, typed, both, plain]).c3).toBe(3);
    // 外部内容的会话不做教训分类
    expect(
      sessionMeasures(LESSON, [sig('user_message', 0, { text: LESSON_TEXT, external: true })]).c3,
    ).toBe(0);
  });
  it('主判据 = 命中签名的事件数:tool 签名按「失败后重试」对计数,与 shadow 的命中判定同口径(有命中 ⇔ 计数 > 0)', () => {
    const one = retry(0);
    const two = [...retry(0), ...retry(3)];
    expect(signatureHitCount(TOOL, loaded(one))).toBe(1);
    expect(signatureHitCount(TOOL, loaded(two))).toBe(2);
    expect(signatureHitCount({ kind: 'tool', tool_name: 'Edit' }, loaded(one))).toBe(0);
    for (const s of [one, two, [], [sig('tool_result_failed', 0)]]) {
      expect(signatureHitCount(TOOL, loaded(s)) > 0).toBe(sessionHitsSignature(TOOL, loaded(s)));
    }
    expect(sessionMeasures(TOOL, two).primary).toBe(2);
  });
  it('tool_error_class 收窄:带类的签名只数同类失败', () => {
    const f = { ...sig('tool_result_failed', 1), tool_error_class: 'timeout' } as Signal;
    const s = [sig('tool_call', 0, { tool: 'Bash' }), f, sig('tool_call', 2, { tool: 'Bash' })];
    expect(signatureHitCount({ ...TOOL, tool_error_class: 'timeout' }, loaded(s))).toBe(1);
    expect(signatureHitCount({ ...TOOL, tool_error_class: 'not_found' }, loaded(s))).toBe(0);
  });
  it('lesson 签名:Jaccard ≥ 0.5 的教训计数', () => {
    const s = [
      sig('user_message', 0, { text: LESSON_TEXT }),
      sig('user_message', 1, { text: '今天天气不错' }),
    ];
    expect(signatureHitCount(LESSON, loaded(s))).toBe(1);
  });
});

const DAY = 86_400_000;
const at = (s: string): number => Date.parse(s);

describe('R21-6.7 资格:会话开始前 30 个 UTC 日内项目出现过目标签名', () => {
  const hit = { project_key: 'p1', tsMs: at('2026-10-10T23:00:00Z') };
  it('R21-6.7 窗口内 → 成立;命中日早于「会话开始日 − 30 天」→ 不成立', () => {
    const ok = makeEligibility([hit]);
    expect(ok('p1', at('2026-11-09T09:00:00Z'))).toBe(true); // 起点 = 10-10 00:00
    expect(ok('p1', at('2026-11-10T09:00:00Z'))).toBe(false); // 起点 = 10-11 00:00
    expect(ok('p1', at('2026-11-09T00:00:00Z'))).toBe(true);
  });
  it('只用会话开始之前的数据:同时刻 / 之后的命中不算;别的项目的命中不算', () => {
    const t = at('2026-10-20T10:00:00Z');
    expect(makeEligibility([{ project_key: 'p1', tsMs: t }])('p1', t)).toBe(false);
    expect(makeEligibility([{ project_key: 'p1', tsMs: t + 1 }])('p1', t)).toBe(false);
    expect(makeEligibility([{ project_key: 'p1', tsMs: t - 1 }])('p1', t)).toBe(true);
    expect(makeEligibility([{ project_key: 'p2', tsMs: t - DAY }])('p1', t)).toBe(false);
    expect(makeEligibility([])('p1', t)).toBe(false);
  });
});
