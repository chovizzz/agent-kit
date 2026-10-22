/**
 * D3:脱敏 §7 残余缺口登记为 known_gap 种子。
 *
 * 钉住两件事:
 *  - 这些形态「当前确实漏」(第一遍放过、第二遍也不报)。修好了测试会变红,提醒晋升为 recognized 并改 docs/redaction.md;
 *  - 登记没有被悄悄删掉(id 清单与 known_gap 总数)。
 */
import { describe, expect, it } from 'vitest';
import { runSelftest, selftestRedactor } from '../../src/redact/selftest.js';
import { buildSeeds } from '../../src/redact/seeds.js';

/** P1-A.3 收尾登记的残余缺口(含此前已登记、docs §7 点名的几条) */
const D3_GAP_IDS = [
  'gap.triple_escaped_quotes',
  'gap.yaml_anchor_block',
  'gap.template_default_call',
  'gap.yaml_anchor_inline',
  'gap.yaml_tag',
  'gap.helm_default_func',
  'gap.hcl_variable_default',
  'gap.hcl_ternary_default',
  'gap.long_segment_concat',
  'gap.md_inline_code_split',
  'gap.backtick_leading_space',
  'gap.placeholder_then_space_value',
  'gap.upper_dollar_name',
  'gap.upper_getenv_default',
  'gap.upper_env_or_default',
] as const;

const KNOWN_GAP_TOTAL = 32;

/** 全部 known_gap 的 id(排序):替换一条为另一条也会红 */
const ALL_GAP_IDS = [
  'gap.backtick_leading_space',
  'gap.bare_hex32',
  'gap.bare_literal_assert',
  'gap.call_then_quoted',
  'gap.char_codes',
  'gap.concat_call',
  'gap.hcl_ternary_default',
  'gap.hcl_variable_default',
  'gap.helm_default_func',
  'gap.lower36_24',
  'gap.long_segment_concat',
  'gap.md_inline_code_split',
  'gap.neutral_open_type',
  'gap.obfuscated_at',
  'gap.pct_nested4',
  'gap.placeholder_then_space_value',
  'gap.reversed',
  'gap.rot13',
  'gap.shards6',
  'gap.spaced_b64_groups',
  'gap.tag_wrapped_chars',
  'gap.template_default_call',
  'gap.template_interp',
  'gap.triple_escaped_quotes',
  'gap.upper_dollar_name',
  'gap.upper_env_or_default',
  'gap.upper_getenv_default',
  'gap.word_after_name_quote',
  'gap.word_password',
  'gap.yaml_anchor_block',
  'gap.yaml_anchor_inline',
  'gap.yaml_tag',
];

describe('D3:残余缺口 known_gap 种子', () => {
  const seeds = buildSeeds();
  const gaps = seeds.filter((s) => s.tier === 'known_gap');

  it('每个残余缺口都登记为 known_gap,且 id 唯一', () => {
    const byId = new Map(seeds.map((s) => [s.id, s]));
    for (const id of D3_GAP_IDS) expect(byId.get(id)?.tier, id).toBe('known_gap');
    expect(new Set(seeds.map((s) => s.id)).size).toBe(seeds.length);
  });

  it('known_gap 总数钉死(删登记会红)', () => {
    expect(gaps.length).toBe(KNOWN_GAP_TOTAL);
    expect(gaps.map((s) => s.id).sort()).toEqual(ALL_GAP_IDS);
  });

  it('当前确实漏:第一遍后敏感片段仍在,第二遍对输入判干净', () => {
    const r = selftestRedactor();
    for (const id of D3_GAP_IDS) {
      const s = seeds.find((x) => x.id === id)!;
      expect(s.needles.length, `${id} 必须带 needle`).toBeGreaterThan(0);
      const out = r.pass1(s.input).text;
      for (const n of s.needles) expect(out.includes(n), `${id} 第一遍不应已脱敏`).toBe(true);
      expect(r.pass2(s.input).clean, `${id} 第二遍已能识别,请晋升`).toBe(true);
      // 实际流程是 pass2(pass1(x)):apply 放行且输出里仍带敏感片段 = 静默漏出
      const a = r.apply(s.input);
      expect(a.ok, `${id} apply 已 fail-closed,请晋升或改登记`).toBe(true);
      if (a.ok) for (const n of s.needles) expect(a.text.includes(n), id).toBe(true);
    }
  });

  it('selftest 汇总里的 known_gap 数与登记一致', () => {
    const res = runSelftest({ mutate: false });
    expect(res.lines.join('\n')).toContain(
      `known_gap (not counted, see docs/redaction.md): ${KNOWN_GAP_TOTAL}`,
    );
  });
});

/**
 * docs/redaction.md §7 里「复测已不漏」的结论固化成回归:这些形态不是缺口,所以没有 known_gap 种子。
 * 输入全部运行时拼装的合成值。
 */
describe('D3:复测已不漏的形态(不是缺口)', () => {
  const r = selftestRedactor();
  const PW = ['pass', 'word'].join('');
  const V = 'Kq7Zr2WxLm9Tb';
  const U = ['HUNTER', 'XYZABC'].join('');

  it.each([
    ['f 前缀字符串', `${PW} = f"${V}"`, V],
    ['b 前缀字符串', `${PW} = b"${V}"`, V],
    ['类型标注里带 =', `${PW}: Annotated[str, Field(min_length=8)] = "${V}"`, V],
    ['大写口令 NAME=UPPER', `${PW}=${U}`, U],
    ['大写口令带引号', `${PW}="${U}"`, U],
    ['大写口令 ${X:-UPPER} 默认值链', `${PW}=\${DB_X:-${U}}`, U],
  ])('%s:第一遍已脱敏', (_n, input, v) => {
    expect(r.pass1(input).text.includes(v)).toBe(false);
  });
});
