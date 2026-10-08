import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import {
  buildSeeds,
  evaluateSeed,
  runMutation,
  runSelftest,
  selftestRedactor,
  SEED,
} from '../../src/redact/index.js';
import { SEED_CATEGORIES } from '../../src/redact/seeds.js';
import { readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

describe('种子集生成器', () => {
  const seeds = buildSeeds();

  it('固定 seed 确定性:同 seed 两次一致,换 seed 不同', () => {
    const again = buildSeeds(SEED);
    expect(again.map((s) => s.input)).toEqual(seeds.map((s) => s.input));
    const other = buildSeeds(SEED + 1);
    expect(other.map((s) => s.input)).not.toEqual(seeds.map((s) => s.input));
  });

  it('id 唯一;每类至少 3 个变体;需要被替换的片段确实出现在输入里', () => {
    expect(new Set(seeds.map((s) => s.id)).size).toBe(seeds.length);
    for (const cat of SEED_CATEGORIES) {
      expect(seeds.filter((s) => s.category === cat).length, cat).toBeGreaterThanOrEqual(3);
    }
    for (const s of seeds) for (const n of s.needles) expect(s.input.includes(n), s.id).toBe(true);
  });

  it('生成物确实含目标变形(防止生成器 bug 让断言平凡通过)', () => {
    const byId = (id: string) => seeds.find((s) => s.id === id)?.input ?? '';
    expect(byId('zw.zwsp_in_prefix')).toContain('​');
    expect(byId('zw.zwj_wj_in_body')).toContain('‍');
    expect(byId('zw.zwj_wj_in_body')).toContain('⁠');
    expect(byId('zw.bom_soft_hyphen')).toContain('﻿');
    expect([...byId('zw.tag_chars')].some((c) => (c.codePointAt(0) as number) >= 0xe0020)).toBe(
      true,
    );
    expect(byId('fold.fullwidth')).toMatch(/[＀-￯]/);
    expect(byId('fold.cyrillic_s')).toContain('ѕ');
    expect(byId('b64.wrapped16').split('\n').length).toBeGreaterThan(3);
    expect(byId('enc.pct_all')).toMatch(/%[0-9A-F]{2}/);
    expect(byId('cjk.zero_width')).toContain('​');
    expect(byId('ph.secret_in_type')).toContain('[[REDACTED:');
  });

  it('每个具名规则前缀表条目都有一个种子', () => {
    expect(seeds.filter((s) => s.id.startsWith('plain.prefix.')).length).toBeGreaterThanOrEqual(30);
  });
});

describe('A3:种子集召回与误杀', () => {
  it('--selftest:召回 100%、第二遍零命中、合法占位符与良性文本零误杀', () => {
    const res = runSelftest({ mutate: false });
    expect(res.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(res.exitCode).toBe(ExitCode.OK);
    expect(res.lines.join('\n')).toMatch(/recall: (\d+)\/\1\b/);
  });

  it('逐种子:第一遍后无残留片段,第二遍对输出干净、对原文不干净', () => {
    const r = selftestRedactor();
    for (const s of buildSeeds()) {
      if (s.tier === 'known_gap') continue;
      const v = evaluateSeed(s, r);
      expect(v.reasons, s.id).toEqual([]);
    }
  });

  it('合法占位符零误杀:第一遍不改动,第二遍干净,apply 原样返回', () => {
    const r = selftestRedactor();
    const legit = buildSeeds().filter((s) => s.tier === 'legit_placeholder' || s.tier === 'benign');
    expect(legit.length).toBeGreaterThan(20);
    for (const s of legit) {
      expect(r.pass1(s.input).text, s.id).toBe(s.input);
      expect(r.pass2(s.input).clean, s.id).toBe(true);
      expect(r.apply(s.input), s.id).toEqual({ ok: true, text: s.input });
    }
  });

  it('pass2_only:第一遍漏、第二遍抓、apply fail-closed(residual)', () => {
    const r = selftestRedactor();
    const s = buildSeeds().find((x) => x.tier === 'pass2_only');
    expect(s).toBeDefined();
    expect(r.pass1(s!.input).text).toBe(s!.input);
    expect(r.pass2(s!.input).clean).toBe(false);
    expect(r.apply(s!.input)).toEqual({ ok: false, reason: 'residual' });
  });

  it('known_gap 只报告:当前确实抓不到的才能留在 known_gap 里(抓到了就该晋升)', () => {
    const r = selftestRedactor();
    for (const s of buildSeeds().filter((x) => x.tier === 'known_gap')) {
      expect(
        r.pass2(s.input).clean,
        `${s.id} 已能识别,请晋升为 recognized 并更新 docs/redaction.md`,
      ).toBe(true);
    }
  });

  it('known_gap 的 id 都登记在 docs/redaction.md 里(不把做不到的写成做到)', async () => {
    const doc = await readText(`${REPO_ROOT}/docs/redaction.md`);
    for (const s of buildSeeds().filter((x) => x.tier === 'known_gap')) {
      expect(doc, s.id).toContain(s.id);
    }
  });
});

describe('A3:变异自检', () => {
  const seeds = buildSeeds();
  const report = runMutation(seeds);

  it('删掉任一条规则/阶段,至少有一个种子变红(且恰好是声明过的 pinned)', () => {
    expect(report.uncovered).toEqual([]);
    expect(report.mismatches).toEqual([]);
    for (const [id, reds] of report.red) expect(reds.length, id).toBeGreaterThan(0);
  });

  it('规则表里的每条前缀规则、每个阶段都在被检查之列', () => {
    const ids = new Set(report.red.keys());
    for (const id of [
      'pem_private_key',
      'jwt',
      'high_entropy',
      'ipv4',
      'email',
      'url',
      'sensitive_words',
      'internal_domains',
      'view_normalize',
      'view_compact',
      'decode_base64',
      'decode_hex',
      'decode_base32',
      'decode_escape',
      'prefix_sk',
      'prefix_soh',
      'prefix_soh_svc',
      'webhook_feishu',
      'feishu_id',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('变异自检本身有效:禁用 prefix_sk 后 plain.real.sk 与前缀种子确实变红', () => {
    const r = selftestRedactor(['prefix_sk']);
    const s = seeds.find((x) => x.id === 'plain.prefix.sk');
    expect(s).toBeDefined();
    expect(evaluateSeed(s!, r).ok).toBe(false);
    expect(evaluateSeed(s!, selftestRedactor()).ok).toBe(true);
  });

  it('--selftest --mutate 退出 0', () => {
    const res = runSelftest({ mutate: true });
    expect(res.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(res.exitCode).toBe(ExitCode.OK);
    expect(res.lines.join('\n')).toMatch(/mutation killed: (\d+)\/\1\b/);
  });

  it('selftest 输出里不含任何种子内容', () => {
    const out = runSelftest({ mutate: true }).lines.join('\n');
    for (const s of buildSeeds())
      for (const n of s.needles) expect(out.includes(n), s.id).toBe(false);
  });
});
