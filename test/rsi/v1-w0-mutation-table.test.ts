/**
 * W0 变异表自身的完整性:锚点在对应源码里恰好出现一次、替换不同于锚点、杀手测试文件存在、mustKill ⊆ expectRed、id 唯一,
 * 且每条 expectRed 都能在杀手测试文件的源码里找到(防止变异表与测试脱节)。变异的实测结果(`V1_W0_RESULTS`)由主代理在验证机上执行后填写,这里只在非空时校验形状。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from './closure-util.js';
import { V1_W0_MUTATIONS, V1_W0_RESULTS } from './v1-w0-mutation-table.js';

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('W0 变异表', () => {
  it('id 唯一;覆盖 W0 的每类新不变量', () => {
    const ids = V1_W0_MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const must of [
      'phase-promoted-early',
      'decide-better-default-true',
      'capability-default-allow',
      'capability-proto-bypass',
      'journal-new-commit-optional',
      'enum-extra-pause-reason',
      'enum-missing-capability',
      'l-base-strict-again',
      'auto-enabled-coerced',
      'state-auto-pause-required',
      'ledger-probe-refine-removed',
      'stop-reconciled-ref-unchecked',
      'matrix-codex-canary-allowed',
      'journal-bootstrap-old-head-allowed',
      'lint-runsync-unrestricted',
      'lint-personal-read-not-carved-out',
    ]) {
      expect(ids, must).toContain(must);
    }
  });

  it('V1_W0_RESULTS(执行后填写):非空时与变异表一一对应,每条都被杀、已还原', () => {
    if (V1_W0_RESULTS.length === 0) return;
    expect(V1_W0_RESULTS.map((r) => r.id)).toEqual(V1_W0_MUTATIONS.map((m) => m.id));
    for (const r of V1_W0_RESULTS) {
      const m = V1_W0_MUTATIONS.find((x) => x.id === r.id);
      expect(r.failed, r.id).toBeGreaterThan(0);
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
    for (const m of V1_W0_MUTATIONS) {
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
    for (const m of V1_W0_MUTATIONS) {
      const srcs = await Promise.all(m.tests.map((t) => readText(path.join(ROOT, 'test', t))));
      for (const r of m.expectRed) {
        expect(
          srcs.some((s) => s.includes(r)),
          `${m.id}:${r}`,
        ).toBe(true);
      }
    }
  });
});
