/**
 * N4 变异表自身的完整性:锚点在对应源码里恰好出现一次、替换不同于锚点、杀手测试文件存在、mustKill ⊆ expectRed、id 唯一,
 * 且每条 expectRed 都能在杀手测试文件的源码里找到(防止变异表与测试脱节)。契约 R20-18.28 的每个变异点都要有对应 id。
 * 变异的实测结果(`N4_RESULTS`)由主代理在 javis 上执行变异后填写,实装块留空;填写后本文件校验它与变异表一一对应、每条都被杀、已还原。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from './closure-util.js';
import { N4_MUTATIONS, N4_RESULTS } from './n4-mutation-table.js';

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('N4 变异表', () => {
  it('覆盖契约 R20-18.28 的必杀变异点;id 唯一', () => {
    const ids = N4_MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const must of [
      'skip-tty-gate',
      'vendor-compare-skipped',
      'vendor-compare-substring',
      'vendor-compare-self',
      'rule-hash-not-checked',
      'run-id-not-checked',
      'fingerprint-not-recomputed',
      'overwrite-existing-judge',
      'replace-allows-spawned',
      'unconfirmed-reflector-passes',
      'judge-binding-not-recomputed',
      'reflector-binding-not-recomputed',
      'same-vendor-passes',
      'judge-unknown-vendor-passes',
      'declared-conflict-removed',
      'label-lost-judge',
      'report-self-reported-lost',
      'promo-id-ignores-evidence',
      'ci-pair-check-dropped',
      'legacy-provenance-rejected',
      'legacy-provenance-as-session',
      'confirmed-on-spawned-accepted',
      'auto-entry-imports-judge-ingest',
      'typed-content-echoed',
      'parse-output-bypassed',
      'strict-batch-degraded',
      'store-reflector-fields-modified',
      'screen-leak-gate-bypassed',
      'stdout-polluted',
      'c5-reason-not-wired',
      'cross-vendor-of-referenced-outside',
      'self-confirmed-reflector-not-suppressed',
      'calibration-counts-self-reported',
      'calibration-self-reported-no-warn',
      'c8-misses-declared-model',
      'c8-misses-confirmed-model',
      'superrefine-uses-raw-vendor',
    ]) {
      expect(ids, must).toContain(must);
    }
  });

  it('N4_RESULTS(主代理在 javis 上执行后填写;实装块为空):非空时与变异表一一对应,每条都被杀、无 skipped、已还原,mustKill 都在 killedBy 里', () => {
    if (N4_RESULTS.length === 0) return;
    expect(N4_RESULTS.map((r) => r.id)).toEqual(N4_MUTATIONS.map((m) => m.id));
    for (const r of N4_RESULTS) {
      const m = N4_MUTATIONS.find((x) => x.id === r.id);
      expect(r.failed, r.id).toBeGreaterThan(0);
      expect(r.failed, r.id).toBe(r.killedBy.length);
      expect([r.skipped, r.restored], r.id).toEqual([0, true]);
      for (const k of m?.mustKill ?? []) {
        expect(
          r.killedBy.some((n) => n.includes(k) || k.includes(n)),
          `${r.id}: ${k}`,
        ).toBe(true);
      }
    }
  });

  it('锚点在源码里恰好出现一次;替换不同于锚点;杀手测试存在;mustKill ⊆ expectRed', async () => {
    for (const m of N4_MUTATIONS) {
      expect(m.edits.length, m.id).toBeGreaterThan(0);
      for (const e of m.edits) {
        const src = await readText(path.join(ROOT, e.file));
        expect(countOf(src, e.anchor), `${m.id}:${e.file}`).toBe(1);
        expect(e.replacement, m.id).not.toBe(e.anchor);
      }
      for (const t of m.tests) {
        expect(await exists(path.join(ROOT, 'test', t)), `${m.id}:${t}`).toBe(true);
      }
      for (const k of m.mustKill) {
        expect(
          m.expectRed.some((r) => k.includes(r) || r.includes(k)),
          `${m.id}:${k}`,
        ).toBe(true);
      }
    }
  });

  it('expectRed 的每一项都能在杀手测试文件的源码里找到', async () => {
    for (const m of N4_MUTATIONS) {
      const srcs = await Promise.all(m.tests.map((t) => readText(path.join(ROOT, 'test', t))));
      for (const r of m.expectRed) {
        expect(
          srcs.some((s) => s.includes(r)),
          `${m.id}: ${r}`,
        ).toBe(true);
      }
    }
  });
});
