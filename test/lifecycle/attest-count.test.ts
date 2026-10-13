import { describe, expect, it } from 'vitest';
import {
  MATCH_TEXT_LIMIT_BYTES,
  buildMatcher,
  clipForMatch,
  countWindow,
  normalizedRuleSha256,
  signalIdsDigest,
  signalMatches,
  windowBounds,
} from '../../src/lifecycle/attest-count.js';
import type { CountInput, SignatureMatcher } from '../../src/lifecycle/attest-count.js';
import type { Signal } from '../../src/contracts/signal.js';

const hex = (n: number, len: number): string => n.toString(16).padStart(len, '0');
let seq = 0;
function sig(over: Partial<Signal> & { n?: number } = {}): Signal {
  const n = over.n ?? ++seq;
  const { n: _n, ...rest } = over;
  void _n;
  return {
    sig_id: `sig_${hex(n, 16)}`,
    agent: 'claude',
    agent_version: '2.1.280',
    agent_version_source: 'session_meta',
    session_ref: `s_${hex(1, 16)}`,
    project_key: `p_${hex(1, 16)}`,
    ts: '2026-10-10T10:00:00Z',
    type: 'event',
    excerpt_redacted: '',
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
    event_kind: 'user_message',
    event_index: n,
    ...rest,
  };
}
const sess = (n: number): string => `s_${hex(n, 16)}`;

const { fromMs, toMs } = windowBounds('2026-10-01', '2026-10-14');
const phrase = (pattern: string): Extract<SignatureMatcher, { kind: 'match' }> => {
  const m = buildMatcher({ type: 'phrase', pattern });
  if (m.kind !== 'match') throw new Error('matcher');
  return m;
};
const base = (signals: Signal[], matcher: CountInput['matcher']): CountInput => ({
  signals,
  sessionStats: [],
  matcher,
  from: fromMs,
  to: toMs,
  agents: [],
});

describe('buildMatcher', () => {
  it('path / 无签名 / 不安全 pattern / always 各有专属结果', () => {
    expect(buildMatcher({ type: 'path', pattern: '**/*.ts' }).kind).toBe('path');
    expect(buildMatcher(undefined).kind).toBe('none');
    expect(buildMatcher({ type: 'always' }).kind).toBe('always');
    expect(buildMatcher({ type: 'phrase', pattern: '(a+)+b' }).kind).toBe('unsafe');
    expect(buildMatcher({ type: 'tool', pattern: '^Bash$' }).kind).toBe('match');
  });
});

describe('4KiB 截断', () => {
  const padding = 'a'.repeat(MATCH_TEXT_LIMIT_BYTES);
  it('clipForMatch 不超过 4096 字节且不切断码点', () => {
    const t = '汉'.repeat(3000); // 9000 字节
    const c = clipForMatch(t);
    expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(MATCH_TEXT_LIMIT_BYTES);
    expect(c).toBe('汉'.repeat(1365));
    expect(clipForMatch('short')).toBe('short');
  });
  it('只出现在 4KiB 之后的内容不参与匹配;之前的照常命中(正向对照)', () => {
    const m = phrase('needle-xyz');
    const evt = (excerpt: string) => ({ event_kind: 'user_message', excerpt });
    expect(signalMatches(m, evt(`${padding}needle-xyz`))).toBe(false);
    expect(signalMatches(m, evt(`needle-xyz${padding}`))).toBe(true);
  });
});

describe('signalMatches', () => {
  it('tool 型只看 tool_call 的 tool_name;phrase 型只看 user_message 的摘录', () => {
    const tool = buildMatcher({ type: 'tool', pattern: '^Bash$' });
    const ph = phrase('please');
    if (tool.kind !== 'match') throw new Error('x');
    expect(signalMatches(tool, { event_kind: 'tool_call', tool_name: 'Bash', excerpt: '' })).toBe(
      true,
    );
    expect(signalMatches(tool, { event_kind: 'tool_call', tool_name: 'Read', excerpt: '' })).toBe(
      false,
    );
    expect(
      signalMatches(tool, { event_kind: 'user_message', tool_name: 'Bash', excerpt: '' }),
    ).toBe(false);
    expect(signalMatches(ph, { event_kind: 'user_message', excerpt: 'please do' })).toBe(true);
    expect(signalMatches(ph, { event_kind: 'tool_call', excerpt: 'please do' })).toBe(false);
  });
});

describe('countWindow', () => {
  const m = phrase('hello');
  const hit = (over: Partial<Signal> & { n?: number } = {}): Signal =>
    sig({ excerpt_redacted: 'hello world', ...over });

  it('窗口边界:start 当天 0 点含,end 当天含,end+1 天不含', () => {
    const inside = [
      hit({ ts: '2026-10-01T00:00:00Z', session_ref: sess(1) }),
      hit({ ts: '2026-10-14T23:59:59Z', session_ref: sess(2) }),
    ];
    const outside = [
      hit({ ts: '2026-09-30T23:59:59Z', session_ref: sess(3) }),
      hit({ ts: '2026-10-15T00:00:00Z', session_ref: sess(4) }),
    ];
    const r = countWindow(base([...inside, ...outside], m));
    expect(r.fired).toBe(2);
    expect(r.exposure_sessions).toBe(2);
  });

  it('D4:跨文件重复的同一事件只计一次;去掉 event_key 时计两次(正向控制组)', () => {
    const a = hit({ session_ref: sess(1), event_key: 'ek_dup', n: 1 });
    const b = hit({ session_ref: sess(2), event_key: 'ek_dup', n: 2 });
    const deduped = countWindow(base([a, b], m));
    expect(deduped.fired).toBe(1);
    expect(deduped.exposure_sessions).toBe(1);
    expect(deduped.sessions_total).toBe(1);
    expect(deduped.deduplicated).toBe(1);
    expect(deduped.signal_ids).toHaveLength(1);

    const { event_key: _a, ...a0 } = a;
    const { event_key: _b, ...b0 } = b;
    void _a;
    void _b;
    const naive = countWindow(base([a0, b0], m));
    expect(naive.fired).toBe(2);
    expect(naive.exposure_sessions).toBe(2);
    expect(naive.sessions_total).toBe(2);
  });

  it('去重决定与输入顺序无关(排序后最早的一条胜出)', () => {
    const a = hit({ session_ref: sess(1), event_key: 'ek_dup', n: 1 });
    const b = hit({ session_ref: sess(2), event_key: 'ek_dup', n: 2 });
    expect(countWindow(base([a, b], m))).toEqual(countWindow(base([b, a], m)));
  });

  it('不同 event_key 不去重;重复文件里独有的事件仍保留该会话', () => {
    const a = hit({ session_ref: sess(1), event_key: 'ek_1', n: 1 });
    const b = hit({ session_ref: sess(2), event_key: 'ek_1', n: 2 });
    const c = hit({ session_ref: sess(2), event_key: 'ek_2', n: 3, ts: '2026-10-10T10:00:01Z' });
    const r = countWindow(base([a, b, c], m));
    expect(r.fired).toBe(2);
    expect(r.sessions_total).toBe(2);
  });

  it('exposure_projects 数不同项目;sessions_total 并入会话计数库的会话,且不小于 exposure_sessions', () => {
    const s = [
      hit({ session_ref: sess(1), project_key: 'p_a' }),
      hit({ session_ref: sess(2), project_key: 'p_a' }),
      hit({ session_ref: sess(3), project_key: 'p_b' }),
    ];
    const r = countWindow({
      ...base(s, m),
      sessionStats: [
        { session_ref: sess(9), ts: '2026-10-05T00:00:00Z' },
        { session_ref: sess(1), ts: '2026-10-05T00:00:00Z' },
        { session_ref: sess(8), ts: '2026-11-05T00:00:00Z' }, // 窗口外
      ],
    });
    expect(r.exposure_projects).toBe(2);
    expect(r.exposure_sessions).toBe(3);
    expect(r.sessions_total).toBe(4);
    expect(r.sessions_total).toBeGreaterThanOrEqual(r.exposure_sessions);
    expect(r.window_stat_rows).toBe(2);
  });

  it('外部内容会话与失败工具结果的摘录视为空,不参与 phrase 匹配', () => {
    const ext1 = hit({ session_ref: sess(1), external_content: true });
    const ext2 = hit({ session_ref: sess(1) }); // 同会话有外部信号 → 整会话摘录为空
    const failed = hit({ session_ref: sess(2), event_kind: 'tool_result_failed' });
    expect(countWindow(base([ext1, ext2, failed], m)).fired).toBe(0);
  });

  it('agents 过滤', () => {
    const s = [
      hit({ agent: 'claude', session_ref: sess(1) }),
      hit({ agent: 'pi', session_ref: sess(2) }),
    ];
    expect(countWindow({ ...base(s, m), agents: ['pi'] }).exposure_sessions).toBe(1);
  });

  it('harmful:曝光会话内首次命中之后的 user_correction / revert;之前的与未曝光会话的不算', () => {
    const t = (sec: number): string => `2026-10-10T10:00:${String(sec).padStart(2, '0')}Z`;
    const s = [
      sig({ session_ref: sess(1), type: 'user_correction', ts: t(0) }), // 命中之前
      hit({ session_ref: sess(1), ts: t(1) }),
      sig({ session_ref: sess(1), type: 'revert', ts: t(2) }),
      sig({ session_ref: sess(1), type: 'user_correction', ts: t(3) }),
      sig({ session_ref: sess(2), type: 'revert', ts: t(4) }), // 未曝光
    ];
    expect(countWindow(base(s, m)).harmful).toBe(2);
  });

  it('同一时刻的事件按 event_index 排序(不按 sig_id 哈希):命中前的纠正不算 harmful', () => {
    const t = '2026-10-10T10:00:00Z';
    const correction = sig({
      session_ref: sess(1),
      type: 'user_correction',
      ts: t,
      event_index: 1,
      n: 99,
    });
    const h = hit({ session_ref: sess(1), ts: t, event_index: 2, n: 1 }); // sig_id 比纠正小
    expect(countWindow(base([h, correction], m)).harmful).toBe(0);
    const later = sig({ session_ref: sess(1), type: 'revert', ts: t, event_index: 3, n: 0 });
    expect(countWindow(base([h, correction, later], m)).harmful).toBe(1);
  });

  it('时区偏移/小数秒按解析后的时间比较,不按字符串', () => {
    const early = hit({ session_ref: sess(1), ts: '2026-10-10T10:00:00.100Z', n: 5 });
    const late = sig({ session_ref: sess(1), type: 'revert', ts: '2026-10-10T10:00:00Z', n: 6 });
    // late 在字典序上排在 early 前面,但实际早 0.1 秒 → 不算 harmful
    expect(countWindow(base([early, late], m)).harmful).toBe(0);
  });

  it('always 型:仅有会话计数行(无信号)的会话也计入曝光项目;窗口内全部纠正/回退都算 harmful', () => {
    const r = countWindow({
      ...base([sig({ session_ref: sess(1), project_key: 'p_a', type: 'revert' })], {
        kind: 'always',
      }),
      sessionStats: [{ session_ref: sess(2), ts: '2026-10-05T00:00:00Z', project_key: 'p_b' }],
    });
    expect(r.exposure_sessions).toBe(2);
    expect(r.exposure_projects).toBe(2);
    expect(r.harmful).toBe(1);
  });

  it('always 型:每个会话都算曝光,fired = exposure_sessions', () => {
    const s = [sig({ session_ref: sess(1) }), sig({ session_ref: sess(2) })];
    const r = countWindow(base(s, { kind: 'always' }));
    expect(r.exposure_sessions).toBe(2);
    expect(r.fired).toBe(2);
    expect(r.signal_ids).toEqual([]);
  });

  it('collector_versions 取每个 agent 的最大版本;recurrence 恒 0', () => {
    const s = [
      hit({ session_ref: sess(1), agent_version: '2.1.9' }),
      hit({ session_ref: sess(2), agent_version: '2.1.10' }),
      hit({ session_ref: sess(3), agent: 'pi', agent_version: '0.87.1' }),
    ];
    const r = countWindow(base(s, m));
    expect(r.collector_versions).toEqual({ claude: '2.1.10', pi: '0.87.1' });
    expect(r.recurrence).toBe(0);
  });
});

describe('signalIdsDigest / normalizedRuleSha256', () => {
  it('digest 形状固定且只依赖已排序的 id 列表', () => {
    expect(signalIdsDigest(['a', 'b'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(signalIdsDigest(['a', 'b'])).not.toBe(signalIdsDigest(['b', 'a']));
  });

  const src = (status: string, review: string, body = 'x'): string =>
    `---\nid: r\nstatus: ${status}\nreview_by: ${review}\n---\n\n**做**:${body}\n`;
  it('status / review_by 归一化;正文与其它字段变化会改哈希;CRLF 不影响', () => {
    const h = normalizedRuleSha256(src('advisory', '2027-01-01'));
    expect(normalizedRuleSha256(src('active', '2027-02-02'))).toBe(h);
    expect(normalizedRuleSha256(src('advisory', '2027-01-01').replace(/\n/g, '\r\n'))).toBe(h);
    expect(normalizedRuleSha256(src('advisory', '2027-01-01', 'y'))).not.toBe(h);
    expect(normalizedRuleSha256(src('advisory', '2027-01-01').replace('id: r', 'id: q'))).not.toBe(
      h,
    );
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('只归一化 frontmatter 里的行,正文里长得像 status: 的行不动', () => {
    const a = `---\nid: r\nstatus: advisory\n---\nstatus: one\n`;
    const b = `---\nid: r\nstatus: advisory\n---\nstatus: two\n`;
    expect(normalizedRuleSha256(a)).not.toBe(normalizedRuleSha256(b));
  });
});
