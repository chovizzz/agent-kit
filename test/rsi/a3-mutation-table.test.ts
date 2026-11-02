/**
 * A3 变异表自身的完整性:锚点在源码里恰好出现一次、替换不同于锚点、杀手测试文件存在、mustKill ⊆ expectRed、id 唯一;
 * 每条变异都有 javis 实测结果(红的用例非空且命中每个 mustKill、skipped 为 0、已还原)。表里没有证据的变异不算数。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from './closure-util.js';
import { A3_MUTATIONS, A3_RESULTS } from './a3-mutation-table.js';

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('A3 变异表', () => {
  it('覆盖契约 §20.8.2 A3 行的六个变异点;锚点恰好一次;杀手测试存在', async () => {
    expect(A3_MUTATIONS.map((m) => m.id)).toEqual([
      'throttle-flipped',
      'reservation-check-removed',
      'attempt-after-read',
      'hint-cap-removed',
      'auto-rsi-check-removed',
      'entry-through-launcher',
    ]);
    for (const m of A3_MUTATIONS) {
      for (const e of m.edits) {
        const src = await readText(path.join(ROOT, e.file));
        expect(countOf(src, e.anchor), `${m.id}:${e.file}`).toBe(1);
        expect(e.replacement, m.id).not.toBe(e.anchor);
      }
      for (const t of m.tests)
        expect(await exists(path.join(ROOT, 'test', t)), `${m.id}:${t}`).toBe(true);
      for (const k of m.mustKill) {
        expect(
          m.expectRed.some((r) => k.includes(r) || r.includes(k)),
          `${m.id}:${k}`,
        ).toBe(true);
      }
    }
  });

  it('每条变异都有实测结果:红的用例非空、命中每个 mustKill、无 skipped、已还原', () => {
    for (const m of A3_MUTATIONS) {
      const r = A3_RESULTS.find((x) => x.id === m.id);
      expect(r, `${m.id} 没有实测结果`).toBeDefined();
      if (r === undefined) continue;
      expect(r.failed, m.id).toBeGreaterThan(0);
      expect(r.skipped, m.id).toBe(0);
      expect(r.restored, m.id).toBe(true);
      for (const k of m.mustKill) {
        expect(
          r.killedBy.some((t) => t.includes(k)),
          `${m.id}:${k}`,
        ).toBe(true);
      }
    }
  });
});
