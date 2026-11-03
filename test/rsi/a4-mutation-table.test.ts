/**
 * A4 变异表自身的完整性:锚点在对应源码里恰好出现一次、替换不同于锚点、杀手测试文件存在、mustKill ⊆ expectRed、id 唯一,
 * 且每条 mustKill / expectRed 都能在杀手测试文件的源码里找到对应的用例标题(防止变异表与测试脱节)。
 * 变异的实测结果(`A4_RESULTS`)由主代理在 javis 上执行变异后填写,这里不断言(见 a4-mutation-table.ts 头注释)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from './closure-util.js';
import { A4_MUTATIONS } from './a4-mutation-table.js';

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('A4 变异表', () => {
  it('覆盖契约 R20-16.27 的 11 个变异点(及 A4 自己加的几条);id 唯一', () => {
    const ids = A4_MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const must of [
      'skip-alias-check',
      'adopt-agent-excerpt',
      'skip-session-expiry',
      'xu-after-cluster',
      'skip-output-rescan',
      'digest-skip-final-review',
      'ingest-skip-final-review',
      'digest-not-consumed',
      'quota-after-consume',
      'strict-batch-to-drop',
      'unknown-equality-pass',
      'slot-read-unsafe',
    ]) {
      expect(ids, must).toContain(must);
    }
  });

  it('锚点在源码里恰好出现一次;替换不同于锚点;杀手测试存在;mustKill ⊆ expectRed', async () => {
    for (const m of A4_MUTATIONS) {
      expect(m.edits.length, m.id).toBeGreaterThan(0);
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

  it('expectRed 的每一项都能在杀手测试文件里找到用例标题(模板标题按 ${…} 之前的前缀对照)', async () => {
    for (const m of A4_MUTATIONS) {
      const srcs = await Promise.all(m.tests.map((t) => readText(path.join(ROOT, 'test', t))));
      for (const r of m.expectRed) {
        const hit = srcs.some((s) => s.includes(r));
        expect(hit, `${m.id}:${r}`).toBe(true);
      }
    }
  });
});
