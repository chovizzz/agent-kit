/**
 * W1 变异表自身的完整性:锚点在对应源码里恰好出现一次、替换不同于锚点、杀手测试文件存在、mustKill ⊆ expectRed、id 唯一,
 * 每条 expectRed 都能在杀手测试文件的源码里找到;归属 W1 的 M13-n 各有变异条目与标题含该 ID 的测试。
 * 变异的实测结果(`V1_W1_RESULTS`)由主代理在验证机上执行后填写,这里只在非空时校验形状。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from './closure-util.js';
import { V1_W1_MUTATIONS, V1_W1_RESULTS } from './v1-w1-mutation-table.js';

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('W1 变异表', () => {
  it('id 唯一;覆盖任务点名的八类锚点', () => {
    const ids = V1_W1_MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const must of [
      'guard-inverted',
      'idem-check-removed',
      'target-terminal-downgrade',
      'veto-on-terminal-advances-state',
      'judge-rejected-above-vetoed',
      'capability-default-allow',
      'M13-6-expiry-after-slot',
      'M13-6-expiry-after-eligibility',
      'M13-7-expiry-reads-canary-ready-since',
    ]) {
      expect(ids, must).toContain(must);
    }
  });

  it('归属 W1 的 M13-n(1 / 2 / 4 / 5 / 6 / 7)各至少一条 clause 以 M13-<n> 开头的变异;M13-1 逐项各一条(≥ 12)', () => {
    for (const n of [1, 2, 4, 5, 6, 7]) {
      const hits = V1_W1_MUTATIONS.filter((m) => m.clause.startsWith(`M13-${n}`));
      expect(hits.length, `M13-${n}`).toBeGreaterThan(0);
    }
    expect(
      V1_W1_MUTATIONS.filter((m) => m.clause.startsWith('M13-1')).length,
    ).toBeGreaterThanOrEqual(12);
    // M13-3 / M13-8 / M13-9 不归 W1:这里不得登记(防止别块的 ID 被误占)
    for (const n of [3, 8, 9]) {
      expect(
        V1_W1_MUTATIONS.some((m) => m.clause.startsWith(`M13-${n}`)),
        `M13-${n}`,
      ).toBe(false);
    }
  });

  it('M13-n 的负向用例:本块测试标题含 M13-1 / M13-2 / M13-4 / M13-5 / M13-6 / M13-7(W10b 按 ID 对账)', async () => {
    const src = await readText(path.join(ROOT, 'test/rsi/personal/transition-queue.test.ts'));
    for (const n of [1, 2, 4, 5, 6, 7]) {
      expect(src.includes(`'M13-${n} `) || src.includes(`\`M13-${n} `), `M13-${n}`).toBe(true);
    }
  });

  it('V1_W1_RESULTS(执行后填写):非空时与变异表一一对应,每条都被杀、已还原', () => {
    if (V1_W1_RESULTS.length === 0) return;
    expect(V1_W1_RESULTS.map((r) => r.id)).toEqual(V1_W1_MUTATIONS.map((m) => m.id));
    for (const r of V1_W1_RESULTS) {
      const m = V1_W1_MUTATIONS.find((x) => x.id === r.id);
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
    for (const m of V1_W1_MUTATIONS) {
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
    for (const m of V1_W1_MUTATIONS) {
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
