/**
 * D-AU 变异表自身的完整性:锚点在源码里恰好出现一次、替换不同于锚点、杀手测试文件存在、`expectRed` / `mustKill` 每项都是杀手测试源码里的字面子串、
 * id 唯一;每条变异都有 javis 实测结果(红的用例非空且命中每个 mustKill、skipped 为 0、已还原)。表里没有证据的变异不算数。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from '../rsi/closure-util.js';
import { AU_MUTATIONS, AU_RESULTS } from './au-mutation-table.js';

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('D-AU 变异表', () => {
  it('id 唯一;锚点恰好一次且替换不同;杀手测试存在', async () => {
    expect(new Set(AU_MUTATIONS.map((m) => m.id)).size).toBe(AU_MUTATIONS.length);
    for (const m of AU_MUTATIONS) {
      for (const e of m.edits) {
        const src = await readText(path.join(ROOT, e.file));
        expect(countOf(src, e.anchor), `${m.id}:${e.file}`).toBe(1);
        expect(e.replacement, m.id).not.toBe(e.anchor);
      }
      for (const t of m.tests) {
        expect(await exists(path.join(ROOT, 'test', t)), `${m.id}:${t}`).toBe(true);
      }
    }
  });

  it('expectRed / mustKill 每一项都是杀手测试源码里的字面子串;mustKill ⊆ expectRed', async () => {
    for (const m of AU_MUTATIONS) {
      const srcs = await Promise.all(m.tests.map((t) => readText(path.join(ROOT, 'test', t))));
      const all = srcs.join('\n');
      for (const r of [...m.expectRed, ...m.mustKill]) {
        expect(all.includes(r), `${m.id}: 「${r}」不在杀手测试源码里`).toBe(true);
      }
      for (const k of m.mustKill) {
        expect(
          m.expectRed.some((r) => k.includes(r) || r.includes(k)),
          `${m.id}:${k}`,
        ).toBe(true);
      }
    }
  });

  it('每条变异都有实测结果:红的用例非空、命中每个 mustKill、无 skipped、已还原', () => {
    for (const m of AU_MUTATIONS) {
      const r = AU_RESULTS.find((x) => x.id === m.id);
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
