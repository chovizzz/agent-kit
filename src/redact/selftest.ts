/**
 * `agent-kit redact --selftest [--mutate]`
 *
 * 通过标准(A3):
 *  - 第一遍应替换的 100% 精确替换(输出逐字等于期望,且被替换的原始片段一个不剩);
 *  - 第二遍对"真秘密残留"零漏检:对原始输入 pass2 必须判不干净;对第一遍输出必须干净;
 *  - 合法占位符与良性文本零误杀:第一遍一个字符都不许动,第二遍干净;
 *  - 变异自检:逐条禁用规则/阶段,红的种子集合必须恰好等于该种子声明的 pinned。
 *
 * 输出只含种子 id、规则 id 与计数,**绝不打印种子内容**(日志也不能成为泄露面)。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { createRedactor } from './redactor.js';
import type { RedactorImpl } from './redactor.js';
import { STAGE_IDS } from './rules.js';
import {
  buildSeeds,
  SELFTEST_CONFIG,
  SELFTEST_INTERNAL_DOMAINS,
  SEED_CATEGORIES,
} from './seeds.js';
import type { Seed } from './seeds.js';

export function selftestRedactor(disabled: Iterable<string> = []): RedactorImpl {
  return createRedactor(SELFTEST_CONFIG, {
    internalDomains: SELFTEST_INTERNAL_DOMAINS,
    disabledRules: disabled,
  });
}

export interface SeedVerdict {
  seed: Seed;
  ok: boolean;
  reasons: string[];
}

/** 评估一个种子。reasons 只写原因码,不写文本。 */
export function evaluateSeed(seed: Seed, r: RedactorImpl): SeedVerdict {
  const reasons: string[] = [];
  const fail = (why: string): void => void reasons.push(why);
  try {
    switch (seed.tier) {
      case 'recognized':
      case 'entropy_only': {
        const p1 = r.pass1(seed.input);
        if (p1.text !== seed.expected) fail('pass1_output_mismatch');
        for (const n of seed.needles)
          if (n.length > 0 && p1.text.includes(n)) fail('needle_survived');
        if (!r.pass2(p1.text).clean) fail('pass2_dirty_after_pass1');
        if (r.pass2(seed.input).clean) fail('pass2_missed_raw');
        break;
      }
      case 'pass2_only': {
        const p1 = r.pass1(seed.input);
        if (p1.text !== seed.input) fail('pass1_should_not_catch_depth3');
        if (r.pass2(seed.input).clean) fail('pass2_missed_raw');
        const a = r.apply(seed.input);
        if (a.ok) fail('apply_should_fail_closed');
        break;
      }
      case 'benign':
      case 'legit_placeholder': {
        const p1 = r.pass1(seed.input);
        if (p1.text !== seed.input) fail('false_positive_pass1');
        if (!r.pass2(seed.input).clean) fail('false_positive_pass2');
        const a = r.apply(seed.input);
        if (!a.ok || a.text !== seed.input) fail('apply_changed_or_failed');
        break;
      }
      case 'known_gap':
        break;
    }
  } catch {
    fail('scanner_threw');
  }
  return { seed, ok: reasons.length === 0, reasons };
}

export interface GapReport {
  id: string;
  /** 现在被抓到了吗(抓到了说明可以"晋升"成 recognized,但不是失败) */
  detected: boolean;
}

export function evaluateGap(seed: Seed, r: RedactorImpl): GapReport {
  return { id: seed.id, detected: !r.pass2(seed.input).clean };
}

export interface MutationReport {
  /** 规则/阶段 id -> 禁用后变红的种子 id */
  red: Map<string, string[]>;
  /** 声明了 pinned 但禁用后没变红 / 没声明却变红 的偏差 */
  mismatches: string[];
  /** 没有任何 pinned 种子的规则/阶段 */
  uncovered: string[];
}

/** 变异自检:对每个规则/阶段 id 跑一遍"禁用后哪些种子变红",再与种子声明的 pinned 对账。 */
export function runMutation(seeds: readonly Seed[]): MutationReport {
  const base = selftestRedactor();
  const ids = [...base.ruleIds, ...STAGE_IDS];
  const active = seeds.filter((s) => s.tier === 'recognized' || s.tier === 'entropy_only');
  const red = new Map<string, string[]>();
  for (const id of ids) {
    const r = selftestRedactor([id]);
    const reds: string[] = [];
    for (const s of active) if (!evaluateSeed(s, r).ok) reds.push(s.id);
    red.set(id, reds);
  }
  const mismatches: string[] = [];
  const uncovered: string[] = [];
  for (const id of ids) {
    const reds = new Set(red.get(id));
    const pinnedBy = active.filter((s) => s.pinned.includes(id)).map((s) => s.id);
    if (pinnedBy.length === 0) uncovered.push(id);
    for (const sid of pinnedBy)
      if (!reds.has(sid)) mismatches.push(`pinned_not_red ${sid} <- ${id}`);
    for (const sid of reds) {
      const s = active.find((x) => x.id === sid) as Seed;
      if (!s.pinned.includes(id)) mismatches.push(`red_not_pinned ${sid} <- ${id}`);
    }
  }
  for (const s of active) {
    for (const p of s.pinned) {
      if (!ids.includes(p)) mismatches.push(`unknown_pinned ${s.id} <- ${p}`);
    }
  }
  return { red, mismatches: mismatches.sort(), uncovered };
}

export interface SelftestResult {
  exitCode: number;
  lines: string[];
}

export function runSelftest(opts: { mutate: boolean }): SelftestResult {
  const lines: string[] = [];
  let failed = false;
  let seeds: Seed[];
  try {
    seeds = buildSeeds();
  } catch {
    return {
      exitCode: ExitCode.FAIL_CLOSED,
      lines: ['REDACT_SELFTEST_ERROR seed generation failed'],
    };
  }

  // 生成器自检:id 唯一、每类 >=3 个变体、每个被替换的片段确实出现在输入里
  const ids = new Set<string>();
  for (const s of seeds) {
    if (ids.has(s.id)) {
      lines.push(`FAIL seed_id_duplicate ${s.id}`);
      failed = true;
    }
    ids.add(s.id);
    for (const n of s.needles) {
      if (!s.input.includes(n)) {
        lines.push(`FAIL seed_needle_not_in_input ${s.id}`);
        failed = true;
      }
    }
  }
  for (const cat of SEED_CATEGORIES) {
    const n = seeds.filter((s) => s.category === cat).length;
    if (n < 3) {
      lines.push(`FAIL category_too_small ${cat} ${n}`);
      failed = true;
    }
  }

  const r = selftestRedactor();
  const verdicts = seeds.filter((s) => s.tier !== 'known_gap').map((s) => evaluateSeed(s, r));
  const byTier = new Map<string, { total: number; ok: number }>();
  for (const v of verdicts) {
    const t = byTier.get(v.seed.tier) ?? { total: 0, ok: 0 };
    t.total++;
    if (v.ok) t.ok++;
    byTier.set(v.seed.tier, t);
    if (!v.ok) {
      failed = true;
      lines.push(`FAIL ${v.seed.id} [${v.seed.tier}] ${v.reasons.join(',')}`);
    }
  }
  for (const [tier, t] of [...byTier.entries()].sort()) {
    lines.push(`seeds ${tier}: ${t.ok}/${t.total}`);
  }
  const recallSeeds = verdicts.filter(
    (v) => v.seed.tier === 'recognized' || v.seed.tier === 'entropy_only',
  );
  const recalled = recallSeeds.filter((v) => v.ok).length;
  lines.push(`recall: ${recalled}/${recallSeeds.length}`);

  const gaps = seeds.filter((s) => s.tier === 'known_gap').map((s) => evaluateGap(s, r));
  lines.push(`known_gap (not counted, see docs/redaction.md): ${gaps.length}`);
  for (const gp of gaps) {
    lines.push(
      `  ${gp.detected ? 'NOW_DETECTED(promote to recognized)' : 'not_detected'} ${gp.id}`,
    );
  }

  if (opts.mutate) {
    const rep = runMutation(seeds);
    const ruleCount = rep.red.size;
    lines.push(`mutation: ${ruleCount} rules/stages checked`);
    for (const id of rep.uncovered) {
      lines.push(`FAIL mutation_uncovered ${id} (no pinned seed)`);
      failed = true;
    }
    for (const m of rep.mismatches) {
      lines.push(`FAIL mutation_${m}`);
      failed = true;
    }
    const killed = [...rep.red.values()].filter((v) => v.length > 0).length;
    lines.push(`mutation killed: ${killed}/${ruleCount}`);
  }

  lines.push(failed ? 'SELFTEST FAILED' : 'SELFTEST OK');
  return { exitCode: failed ? ExitCode.CHECK_FAILED : ExitCode.OK, lines };
}
