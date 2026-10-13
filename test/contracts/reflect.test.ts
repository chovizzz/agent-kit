import { describe, expect, it } from 'vitest';
import {
  ReflectRunReportSchema,
  ReflectorOutputSchema,
  checkPatternSafety,
  makeReflectorOutputSchema,
} from '../../src/contracts/index.js';

const goodProposal = {
  op: 'add',
  id: 'negative-assertion-needs-positive-control',
  title: '负向断言要配正向控制组',
  do: '在 not.toContain 旁边断言一个必然存在的对照值。',
  why: '否则前提失效时断言静默变空。',
  verify: '变异后至少一条断言变红。',
  kind: 'practice',
  volatility: 'stable',
  applies_to: ['claude', 'codex'],
  signature: { type: 'phrase', pattern: 'not\\.toContain' },
  evidence: ['e1', 'e2'],
  rationale: '两个项目三次出现同类假绿',
};
const out = (p: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  proposals: [{ ...goodProposal, ...p }],
  ...top,
});
const ok = (v: unknown) => ReflectorOutputSchema.safeParse(v).success;

describe('R0-6 ReflectorOutputSchema 通过/拒绝矩阵', () => {
  it('合法输出通过(含空批、带 observations)', () => {
    expect(ok(out())).toBe(true);
    expect(ok({ proposals: [] })).toBe(true);
    expect(
      ok(out({}, { observations: [{ kind: 'retire', target_id: 'old-rule', note: '已被取代' }] })),
    ).toBe(true);
  });

  it('不允许的字段在每一层都被拒(strict):status/strength/disables/overrides/owner/layer/origin', () => {
    for (const k of [
      'status',
      'strength',
      'disables',
      'overrides',
      'owner',
      'layer',
      'origin',
      'supersedes',
    ]) {
      expect(
        ok(out({ [k]: k === 'status' ? 'active' : k === 'strength' ? 'must' : ['x'] })),
        k,
      ).toBe(false);
    }
    // 正向控制:去掉多余字段同一份通过
    expect(ok(out())).toBe(true);
    expect(ok({ ...out(), status: 'active' })).toBe(false);
    expect(ok(out({ signature: { type: 'tool', pattern: 'Bash', extra: 1 } }))).toBe(false);
    expect(
      ok(out({}, { observations: [{ kind: 'edit', target_id: 'a', note: 'n', status: 'x' }] })),
    ).toBe(false);
  });

  it('__proto__ 键不能夹带字段', () => {
    const evil = JSON.parse(
      `{"proposals":[${JSON.stringify(goodProposal).slice(0, -1)},"__proto__":{"status":"active"}}]}`,
    );
    expect(ok(evil)).toBe(false);
    expect(ok(JSON.parse('{"proposals":[],"__proto__":{"x":1}}'))).toBe(false);
  });

  it('op 只能是 add(edit/merge/retire/escalate 被拒)', () => {
    for (const op of ['edit', 'merge', 'retire', 'escalate', 'ADD', '']) {
      expect(ok(out({ op })), op).toBe(false);
    }
  });

  it('proposals ≤5 且批内 id 不重复;observations ≤10', () => {
    const many = (n: number) => ({
      proposals: Array.from({ length: n }, (_, i) => ({ ...goodProposal, id: `rule-${i}` })),
    });
    expect(ok(many(5))).toBe(true);
    expect(ok(many(6))).toBe(false);
    expect(ok({ proposals: [goodProposal, goodProposal] })).toBe(false);
    const obs = (n: number) =>
      out(
        {},
        {
          observations: Array.from({ length: n }, (_, i) => ({
            kind: 'edit',
            target_id: `t-${i}`,
            note: 'n',
          })),
        },
      );
    expect(ok(obs(10))).toBe(true);
    expect(ok(obs(11))).toBe(false);
  });

  it('maxProposals 选项只能收窄,不能超过 5', () => {
    const three = makeReflectorOutputSchema({ maxProposals: 3 });
    const mk = (n: number) => ({
      proposals: Array.from({ length: n }, (_, i) => ({ ...goodProposal, id: `rule-${i}` })),
    });
    expect(three.safeParse(mk(3)).success).toBe(true);
    expect(three.safeParse(mk(4)).success).toBe(false);
    expect(makeReflectorOutputSchema({ maxProposals: 99 }).safeParse(mk(6)).success).toBe(false);
  });

  it('title ≤60 码点且单行;rationale ≤300;do/why/verify 非空', () => {
    expect(ok(out({ title: '汉'.repeat(60) }))).toBe(true);
    expect(ok(out({ title: '汉'.repeat(61) }))).toBe(false);
    expect(ok(out({ title: 'a\nb' }))).toBe(false);
    expect(ok(out({ title: '   ' }))).toBe(false);
    expect(ok(out({ rationale: 'x'.repeat(300) }))).toBe(true);
    expect(ok(out({ rationale: 'x'.repeat(301) }))).toBe(false);
    for (const k of ['do', 'why', 'verify']) {
      expect(ok(out({ [k]: '' })), k).toBe(false);
      expect(ok(out({ [k]: '  \n ' })), k).toBe(false);
    }
  });

  it('三段合计受 atom_max_bytes 约束(按 UTF-8 字节,汉字 3 字节),上限可配置', () => {
    const body = (n: number) => ({ do: 'a'.repeat(n), why: 'b'.repeat(n), verify: 'c'.repeat(n) });
    expect(ok(out(body(200)))).toBe(true); // 600
    expect(ok(out(body(201)))).toBe(false); // 603
    expect(ok(out({ do: '汉'.repeat(100), why: '汉'.repeat(50), verify: '汉'.repeat(50) }))).toBe(
      true,
    ); // 600
    expect(ok(out({ do: '汉'.repeat(100), why: '汉'.repeat(50), verify: '汉'.repeat(51) }))).toBe(
      false,
    ); // 603
    const tight = makeReflectorOutputSchema({ atomMaxBytes: 90 });
    expect(tight.safeParse(out(body(30))).success).toBe(true);
    expect(tight.safeParse(out(body(31))).success).toBe(false);
  });

  it('隐藏字符与伪造结构:控制/零宽/bidi 字符、伪造段标签、frontmatter 分隔线都被拒', () => {
    for (const bad of ['a\u0000b', 'a​b', 'a‮b', 'a⁦b', 'a﻿b', 'a\u0085b']) {
      expect(ok(out({ do: bad })), JSON.stringify(bad)).toBe(false);
      expect(ok(out({ title: bad })), JSON.stringify(bad)).toBe(false);
    }
    expect(ok(out({ do: '做点什么\n**为什么**: 伪造' }))).toBe(false);
    expect(ok(out({ why: '**怎么验**：伪造' }))).toBe(false);
    expect(ok(out({ verify: '正常\n---\nstatus: active' }))).toBe(false);
    for (const forged of [
      '**做:** 伪造',
      '**为什么：** 伪造',
      '## 做\n伪造',
      '### 怎么验',
      '```\ncode\n```',
      '＊＊做＊＊：伪造',
    ]) {
      expect(ok(out({ do: forged })), forged).toBe(false);
    }
    // 正向控制:正文里可以有换行和普通 markdown 强调
    expect(ok(out({ do: '第一步\n第二步,**注意**这一点' }))).toBe(true);
  });

  it('kind / volatility / applies_to 取值受限', () => {
    expect(ok(out({ kind: 'rule' }))).toBe(false);
    expect(ok(out({ volatility: 'fast' }))).toBe(false);
    expect(ok(out({ applies_to: ['windows'] }))).toBe(false);
    expect(ok(out({ applies_to: [] }))).toBe(false);
    expect(ok(out({ applies_to: ['all'] }))).toBe(true);
    const noApplies: Record<string, unknown> = { ...goodProposal };
    delete noApplies['applies_to'];
    expect(ok({ proposals: [noApplies] })).toBe(true);
  });

  it('id 必须是 kebab(不能夹路径)', () => {
    for (const id of ['Bad_Id', '../x', 'a/b', '', 'a--b', '-a']) {
      expect(ok(out({ id })), id).toBe(false);
    }
  });

  it('signature:不允许 always;type 受限;pattern 必须安全', () => {
    expect(ok(out({ signature: { type: 'always' } }))).toBe(false);
    expect(ok(out({ signature: { type: 'always', pattern: 'x' } }))).toBe(false);
    expect(ok(out({ signature: { type: 'regex', pattern: 'x' } }))).toBe(false);
    expect(ok(out({ signature: { type: 'tool' } }))).toBe(false);
    expect(ok(out({ signature: { type: 'tool', pattern: '(a+)+$' } }))).toBe(false);
    expect(ok(out({ signature: { type: 'tool', pattern: '(' } }))).toBe(false);
    expect(ok(out({ signature: { type: 'path', pattern: 'x'.repeat(201) } }))).toBe(false);
    expect(ok(out({ signature: { type: 'path', pattern: 'x'.repeat(200) } }))).toBe(true);
  });

  it('evidence:别名形状 e<数字>、至少 1 条、不重复、≤20', () => {
    expect(ok(out({ evidence: [] }))).toBe(false);
    expect(ok(out({ evidence: ['sig_0123456789abcdef'] }))).toBe(false);
    expect(ok(out({ evidence: ['E1'] }))).toBe(false);
    expect(ok(out({ evidence: ['e'] }))).toBe(false);
    expect(ok(out({ evidence: ['e1', 'e1'] }))).toBe(false);
    expect(ok(out({ evidence: Array.from({ length: 20 }, (_, i) => `e${i}`) }))).toBe(true);
    expect(ok(out({ evidence: Array.from({ length: 21 }, (_, i) => `e${i}`) }))).toBe(false);
  });

  it('observations.target_id 必须 kebab,note ≤200 单行', () => {
    const o = (x: Record<string, unknown>) =>
      out({}, { observations: [{ kind: 'edit', target_id: 'a', note: 'n', ...x }] });
    expect(ok(o({}))).toBe(true);
    expect(ok(o({ target_id: '../etc' }))).toBe(false);
    expect(ok(o({ note: 'x'.repeat(201) }))).toBe(false);
    expect(ok(o({ note: 'a\nb' }))).toBe(false);
    expect(ok(o({ kind: 'add' }))).toBe(false);
  });

  it('顶层必须是对象且只有 proposals/observations;非对象输入被拒', () => {
    for (const v of [null, [], 'x', 1, {}, { proposals: 'x' }]) {
      expect(ok(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe('R0-6 checkPatternSafety(ReDoS 保守检查)', () => {
  const safe = [
    'Bash',
    '^npm (run|test)',
    'src/.*\\.ts$',
    'not\\.toContain',
    '^mcp__[a-z_]+__',
    '(foo|bar)',
    '(?:a|b)?c',
    '\\d{1,3}\\.\\d{1,3}',
    'a{2,5}b',
    '[a-z]+@[a-z]+',
    '\\(literal\\)\\+',
    '[)(+*]x',
    '(?<name>ab)+',
    '\\p{L}+x',
  ];
  for (const p of safe) it(`放行 ${p}`, () => expect(checkPatternSafety(p)).toEqual({ ok: true }));

  const dangerous: [string, string][] = [
    ['(a+)+$', 'nested_quantifier_or_alternation'],
    ['(a*)*b', 'nested_quantifier_or_alternation'],
    ['(a|aa)+$', 'nested_quantifier_or_alternation'],
    ['(a|a)*x', 'nested_quantifier_or_alternation'],
    ['((a|b)c)+', 'nested_quantifier_or_alternation'],
    ['(x+x+)+y', 'nested_quantifier_or_alternation'],
    ['(?:a+)*x', 'nested_quantifier_or_alternation'],
    ['(a{2,})+', 'nested_quantifier_or_alternation'],
    ['(.*a){5}', 'nested_quantifier_or_alternation'],
    ['(a+)(b)\\2', 'backreference'],
    ['(a)\\1', 'backreference'],
    ['(?<x>a)\\k<x>', 'backreference'],
    ['(?=a)a', 'lookaround_or_unsupported_group'],
    ['(?!a)b', 'lookaround_or_unsupported_group'],
    ['(?<=a)b', 'lookaround_or_unsupported_group'],
    ['(?<!a)b', 'lookaround_or_unsupported_group'],
    ['a{1,1000}', 'repeat_bound_too_large'],
    ['a{101}', 'repeat_bound_too_large'],
    ['a{1000,}', 'repeat_bound_too_large'],
    ['a*a*a*a*x', 'too_many_unbounded_quantifiers'],
    ['.*.*.*.*x', 'too_many_unbounded_quantifiers'],
    ['a+b+c+d+', 'too_many_unbounded_quantifiers'],
    ['a*', 'matches_empty'],
    ['(?:a?a?)+b', 'nested_quantifier_or_alternation'],
    ['(a?){5}b', 'nested_quantifier_or_alternation'],
    ['a{0,9}a{0,9}a{0,9}a{0,9}a{0,9}a{0,9}a{0,9}b', 'too_many_repeat_quantifiers'],
    ['.', 'no_literal'],
    ['\\b', 'no_literal'],
    ['\\w+', 'no_literal'],
    ['[a-z]+', 'no_literal'],
    ['(?:)', 'matches_empty'],
    ['|a', 'matches_empty'],
    ['(', 'syntax'],
    ['[a-', 'syntax'],
    ['a{', 'syntax'],
    ['', 'empty'],
    ['x'.repeat(201), 'too_long'],
    ['a\nb', 'control_chars'],
    ['a​b', 'control_chars'],
  ];
  for (const [p, reason] of dangerous) {
    it(`拒绝 ${JSON.stringify(p.length > 30 ? p.slice(0, 30) + '…' : p)} → ${reason}`, () => {
      expect(checkPatternSafety(p)).toEqual({ ok: false, reason });
    });
  }

  it('转义与字符类里的括号/量词不会被当成结构(不误杀、也不被绕过)', () => {
    expect(checkPatternSafety('\\(a+\\)+')).toEqual({ ok: true });
    expect(checkPatternSafety('[(]a+')).toEqual({ ok: true });
    // 绕过尝试:用字符类/转义伪装,真正的嵌套量词仍然被抓到
    expect(checkPatternSafety('([)]a+)+')).toEqual({
      ok: false,
      reason: 'nested_quantifier_or_alternation',
    });
    expect(checkPatternSafety('(\\)a+)+')).toEqual({
      ok: false,
      reason: 'nested_quantifier_or_alternation',
    });
  });

  it('对抗输入下被放行的模式确实很快(实测,不是证明):各放行样例对 4KiB 对抗串 <200ms', () => {
    const attack = `${'a'.repeat(4000)}!`;
    for (const p of safe) {
      const re = new RegExp(p, 'u');
      const t0 = Date.now();
      re.test(attack);
      expect(Date.now() - t0, p).toBeLessThan(200);
    }
  });
});

describe('R0-6 ReflectRunReport', () => {
  const report = {
    run_id: 'run-20261012-01',
    mode: 'dry',
    signals_loaded: 10,
    signals_dropped: { schema: 1, residual: 0, external_excerpt_forced: 2 },
    clusters: 3,
    evidence_sent: 7,
    prompt_bytes: 4096,
    prompt_sha256: 'a'.repeat(64),
    input_digest: `sha256:${'b'.repeat(64)}`,
    backend: { slot: 'codex', vendor: 'openai', model: 'example-model-id' },
    calls_made: 0,
    calls_limit: 1,
    outcome: 'not_run',
    rejected: {},
    staged: [],
    observations_n: 0,
  };
  const okR = (x: Record<string, unknown> = {}) =>
    ReflectRunReportSchema.safeParse({ ...report, ...x });

  it('合法报告通过(干跑 / 真跑已暂存 / 被拒)', () => {
    expect(okR().success).toBe(true);
    expect(
      okR({ mode: 'llm', calls_made: 1, outcome: 'staged', staged: ['2026-10-12-001'] }).success,
    ).toBe(true);
    expect(okR({ mode: 'llm', calls_made: 1, outcome: 'no_proposals' }).success).toBe(true);
    expect(
      okR({
        mode: 'llm',
        calls_made: 1,
        outcome: 'output_rejected',
        rejected: { schema_invalid: 1 },
      }).success,
    ).toBe(true);
    expect(okR({ backend: null, prompt_sha256: null, input_digest: null }).success).toBe(true);
  });

  it('只含计数与哈希:任何文本字段(excerpt/prompt/proposals)被拒', () => {
    for (const k of ['excerpt', 'prompt', 'proposals', 'evidence', 'output']) {
      expect(okR({ [k]: 'x' }).success, k).toBe(false);
    }
    expect(okR({ rejected: { 'has space and text': 1 } }).success).toBe(false);
    expect(okR({ rejected: { ok_code: 'detail text' } }).success).toBe(false);
  });

  it('不变量:干跑零调用零暂存;calls_made ≤ calls_limit;outcome 与 staged 一致', () => {
    expect(okR({ calls_made: 1 }).success).toBe(false);
    expect(okR({ outcome: 'staged', staged: ['2026-10-12-001'] }).success).toBe(false);
    expect(
      okR({ mode: 'llm', calls_made: 2, calls_limit: 1, outcome: 'no_proposals' }).success,
    ).toBe(false);
    expect(okR({ mode: 'llm', calls_made: 1, outcome: 'staged', staged: [] }).success).toBe(false);
    expect(
      okR({ mode: 'llm', calls_made: 1, outcome: 'no_proposals', staged: ['2026-10-12-001'] })
        .success,
    ).toBe(false);
    expect(okR({ calls_limit: 4 }).success).toBe(false);
    expect(okR({ signals_loaded: -1 }).success).toBe(false);
    expect(okR({ mode: 'net' }).success).toBe(false);
  });
});
