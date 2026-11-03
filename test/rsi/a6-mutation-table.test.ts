/**
 * A6 变异表自身的完整性:锚点在对应源码里恰好出现一次、替换不同于锚点、杀手测试文件存在、mustKill ⊆ expectRed、id 唯一,
 * 且每条 mustKill / expectRed 都能在杀手测试文件的源码里找到(防止变异表与测试脱节)。契约 R20-17.26 的 15 个变异点都要有对应 id。
 * 变异的实测结果(`A6_RESULTS`)由主代理在 javis 上执行变异后填写,这里不断言(见 a6-mutation-table.ts 头注释)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from './closure-util.js';
import { A6_MUTATIONS, A6_RESULTS } from './a6-mutation-table.js';

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('A6 变异表', () => {
  it('覆盖契约 R20-17.26 的 15 个必杀变异点;id 唯一', () => {
    const ids = A6_MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const must of [
      'pending-ignores-dismissed',
      'pending-skips-attribution-filter',
      'pending-no-runid-check',
      'notice-no-ledger',
      'notice-print-before-write',
      'notice-prints-non-tty',
      'notice-prints-armed-stopped',
      'notice-records-after-timeout',
      'notice-corrupt-rebuilt',
      'dismiss-mutates-run-dir',
      'dismiss-overwrites-corrupt',
      'hint-limit-old-template',
      'd17-leaks-abs-path',
      'd17-writes-file',
      'd17-takes-lock',
      'doctor-imports-hooks-fs',
      'status-closure-safe-fs',
    ]) {
      expect(ids, must).toContain(must);
    }
  });

  it('A6_RESULTS 在实装块留空(变异由主代理在 javis 上执行后填写)', () => {
    expect(A6_RESULTS).toEqual([]);
  });

  it('锚点在源码里恰好出现一次;替换不同于锚点;杀手测试存在;mustKill ⊆ expectRed', async () => {
    for (const m of A6_MUTATIONS) {
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
    for (const m of A6_MUTATIONS) {
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
