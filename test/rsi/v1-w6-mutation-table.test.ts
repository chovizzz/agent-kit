/**
 * W6 变异表自身的完整性(同 W5):锚点在源码里恰好出现一次、替换不同于锚点、杀手测试存在、mustKill ⊆ expectRed、id 唯一、expectRed 能在测试源码里找到。
 * 结果(`V1_W6_RESULTS`)由主代理执行变异后回填。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from './closure-util.js';
import { V1_W6_MUTATIONS, V1_W6_RESULTS } from './v1-w6-mutation-table.js';

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('W6 变异表', () => {
  it('id 唯一;每条都有杀手测试与 mustKill', () => {
    const ids = V1_W6_MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of V1_W6_MUTATIONS) {
      expect(m.mustKill.length, m.id).toBeGreaterThan(0);
      expect(m.id, m.id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });

  it('V1_W6_RESULTS(执行后填写):非空时与变异表一一对应,每条都被杀、已还原', () => {
    if (V1_W6_RESULTS.length === 0) return;
    expect(V1_W6_RESULTS.map((r) => r.id)).toEqual(V1_W6_MUTATIONS.map((m) => m.id));
    for (const r of V1_W6_RESULTS) {
      const m = V1_W6_MUTATIONS.find((x) => x.id === r.id);
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
    for (const m of V1_W6_MUTATIONS) {
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
    for (const m of V1_W6_MUTATIONS) {
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
