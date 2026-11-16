/**
 * B2 变异表自身的完整性(同 W5 / W8):锚点在源码里恰好出现一次、替换不同于锚点、杀手测试存在、mustKill ⊆ expectRed、id 唯一、expectRed 能在测试源码里找到。
 * 结果(`V1_ASM_B2_RESULTS`)由主代理执行变异后回填。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from './closure-util.js';
import { V1_ASM_B2_MUTATIONS, V1_ASM_B2_RESULTS } from './v1-asm-b2-mutation-table.js';

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('B2 变异表', () => {
  it('id 唯一且为下划线词;每条都有杀手测试与 mustKill;条数不少于 20', () => {
    const ids = V1_ASM_B2_MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(20);
    for (const m of V1_ASM_B2_MUTATIONS) {
      expect(m.mustKill.length, m.id).toBeGreaterThan(0);
      expect(m.id, m.id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });

  it('V1_ASM_B2_RESULTS(执行后填写):非空时与变异表一一对应,每条都被杀、已还原', () => {
    if (V1_ASM_B2_RESULTS.length === 0) return;
    expect(V1_ASM_B2_RESULTS.map((r) => r.id)).toEqual(V1_ASM_B2_MUTATIONS.map((m) => m.id));
    for (const r of V1_ASM_B2_RESULTS) {
      const m = V1_ASM_B2_MUTATIONS.find((x) => x.id === r.id);
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
    for (const m of V1_ASM_B2_MUTATIONS) {
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
    for (const m of V1_ASM_B2_MUTATIONS) {
      const srcs = await Promise.all(m.tests.map((t) => readText(path.join(ROOT, 'test', t))));
      for (const r of m.expectRed) {
        expect(
          srcs.some((s) => s.includes(r)),
          `${m.id}:${r}`,
        ).toBe(true);
      }
    }
  });

  it('同一文件的多个锚点互不重叠(每个替换后其余锚点仍恰好出现一次)', async () => {
    for (const m of V1_ASM_B2_MUTATIONS) {
      if (m.edits.length < 2) continue;
      let src = await readText(path.join(ROOT, m.edits[0]?.file as string));
      for (const e of m.edits) {
        expect(countOf(src, e.anchor), `${m.id}`).toBe(1);
        src = src.replace(e.anchor, e.replacement);
      }
    }
  });
});
