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
  'gap.md_inline_code_split',
  'gap.backtick_leading_space',
  'gap.placeholder_then_space_value',
  'gap.upper_dollar_name',
  'gap.upper_getenv_default',
  'gap.upper_env_or_default',
] as const;

const KNOWN_GAP_TOTAL = 31;

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
  });

  it('当前确实漏:第一遍后敏感片段仍在,第二遍对输入判干净', () => {
    const r = selftestRedactor();
    for (const id of D3_GAP_IDS) {
      const s = seeds.find((x) => x.id === id)!;
      expect(s.needles.length, `${id} 必须带 needle`).toBeGreaterThan(0);
      const out = r.pass1(s.input).text;
      for (const n of s.needles) expect(out.includes(n), `${id} 第一遍不应已脱敏`).toBe(true);
      expect(r.pass2(s.input).clean, `${id} 第二遍已能识别,请晋升`).toBe(true);
    }
  });

  it('selftest 汇总里的 known_gap 数与登记一致', () => {
    const res = runSelftest({ mutate: false });
    expect(res.lines.join('\n')).toContain(
      `known_gap (not counted, see docs/redaction.md): ${KNOWN_GAP_TOTAL}`,
    );
  });
});
