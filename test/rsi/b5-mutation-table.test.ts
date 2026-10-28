/**
 * B5 变异表自身的完整性(B5e):引用的测试文件存在、字段非空、可执行变异的锚点在源码里恰好出现一次、变异名唯一、
 * 每条可执行变异都挂在某一行上、且都有 javis 上跑出来的结果(杀手非空、skipped 为 0、已还原)。表里没有证据的变异不算数。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { ROOT } from './closure-util.js';
import { B5E_MUTATIONS, B5E_RESULTS, B5_MUTATION_TABLE } from './b5-mutation-table.js';

const TEST_DIR = path.join(ROOT, 'test');

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('B5 变异表', () => {
  it('每行字段非空、引用的测试文件存在', async () => {
    expect(B5_MUTATION_TABLE.length).toBeGreaterThan(15);
    for (const row of B5_MUTATION_TABLE) {
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'tests') expect(String(v).length, `${row.clause}:${k}`).toBeGreaterThan(0);
      }
      expect(row.tests.length, row.clause).toBeGreaterThan(0);
      for (const t of row.tests) {
        expect(await exists(path.join(TEST_DIR, t)), `${row.clause}:${t}`).toBe(true);
      }
    }
  });

  it('可执行变异:名字唯一、挂在某一行的 mutation 里(恰好一行)、锚点在源码里恰好出现一次、杀手测试文件存在', async () => {
    const ids = B5E_MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length, '10 个入口的删拿锁 + 3 个闸门 + 6 个零写入变异').toBeGreaterThanOrEqual(19);
    for (const m of B5E_MUTATIONS) {
      const rows = B5_MUTATION_TABLE.filter((r) =>
        r.mutation
          .split(';')
          .map((s) => s.trim())
          .includes(m.id),
      );
      expect(rows.length, `${m.id} 恰好挂在一行上`).toBe(1);
      expect(
        rows[0]?.clause.startsWith(m.row) || m.row.startsWith(rows[0]?.clause ?? '\0'),
        `${m.id}:行名`,
      ).toBe(true);
      const src = await readText(path.join(ROOT, m.file));
      expect(countOf(src, m.anchor), `${m.id}:锚点在 ${m.file} 里恰好一次`).toBe(1);
      expect(m.replacement, m.id).not.toBe(m.anchor);
      expect(m.expectRed.length, m.id).toBeGreaterThan(0);
      expect(m.mustKill.length, m.id).toBeGreaterThan(0);
      for (const k of m.mustKill) expect(m.expectRed, `${m.id}:mustKill ⊆ expectRed`).toContain(k);
      for (const t of m.tests)
        expect(await exists(path.join(TEST_DIR, t)), `${m.id}:${t}`).toBe(true);
    }
  });

  it('入口覆盖:持锁矩阵里每个入口(MAIN_ENTRIES 的 id + 三个独立用例)都有对应的「删拿锁」变异;变异声明的杀手名都真的出现在矩阵的用例标题里', async () => {
    const matrix = await readText(path.join(TEST_DIR, 'rsi/b5-lock-matrix.test.ts'));
    const block = /const MAIN_ENTRIES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(matrix)?.[1] ?? '';
    const entryIds = [...block.matchAll(/^\s+id: '([^']+)',$/gm)].map((m) => m[1] as string);
    expect(entryIds.length, '入口表解析出 ≥ 8 项(不是对空表成立)').toBeGreaterThanOrEqual(8);
    const locks = B5E_MUTATIONS.filter((m) => m.id.startsWith('lock-removed:'));
    const covered = locks.flatMap((m) => m.expectRed);
    for (const id of entryIds) {
      expect(
        covered.some((c) => id.includes(c.replace(/:$/, ''))),
        `入口 ${id} 无删拿锁变异`,
      ).toBe(true);
    }
    // 三个不在 MAIN_ENTRIES 里的入口:collect / reflect --run-llm / judge --run-llm
    for (const name of ['signals collect', 'reflect --run-llm', 'judge --run-llm']) {
      expect(covered, name).toContain(name);
    }
    // 每个声明的杀手名都出现在矩阵的某个 describe / 用例标题里(失败用例名 = describe 链 + 用例标题;标题里的 ${e.id} 展开成各入口 id)
    const rawTitles = [...matrix.matchAll(/\b(?:it|describe)\(\s*[`']([^`'\n]+)/g)].map(
      (m) => m[1] as string,
    );
    const titles = rawTitles.flatMap((t) =>
      t.includes('${e.id}') ? entryIds.map((id) => t.replace('${e.id}', id)) : [t],
    );
    expect(titles.length).toBeGreaterThan(entryIds.length);
    for (const m of locks) {
      for (const k of m.expectRed) {
        expect(
          titles.some((t) => t.includes(k)),
          `${m.id}: 杀手名 ${k} 不在任何用例标题里`,
        ).toBe(true);
      }
    }
  });

  it('结果:每条可执行变异都有证据(杀手非空且全部命中 expectRed、skipped 为 0、已还原);结果里没有表外的变异', () => {
    const byId = new Map(B5E_RESULTS.map((r) => [r.id, r]));
    expect(byId.size).toBe(B5E_RESULTS.length);
    for (const m of B5E_MUTATIONS) {
      const r = byId.get(m.id);
      expect(r, `${m.id} 缺结果:变异没有在 javis 上跑过`).toBeDefined();
      if (r === undefined) continue;
      expect(r.killedBy.length, `${m.id} 杀手非空`).toBeGreaterThan(0);
      for (const k of r.killedBy) {
        expect(
          m.expectRed.some((e) => k.includes(e)),
          `${m.id}:${k} 不在预期杀手里(不是只有自己入口红)`,
        ).toBe(true);
      }
      for (const k of m.mustKill) {
        expect(r.killedBy, `${m.id}: 必杀项 ${k} 没有命中任何失败用例`).toContain(k);
      }
      expect(r.skipped, `${m.id} skipped`).toBe(0);
      expect(r.restored, `${m.id} 已还原`).toBe(true);
    }
    for (const r of B5E_RESULTS)
      expect(
        B5E_MUTATIONS.some((m) => m.id === r.id),
        r.id,
      ).toBe(true);
  });
});
