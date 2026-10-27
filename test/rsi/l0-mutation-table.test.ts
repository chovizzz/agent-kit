/** 变异表自身的完整性:引用的测试文件存在、字段非空、变异名不重复(变异脚本按名字找它们)。 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists } from '../../src/io/read-fs.js';
import { B4C2_MUTATION_TABLE } from './l0-mutation-table.js';

describe('B4c2 变异表', () => {
  it('每行字段非空、引用的测试文件存在、变异名唯一', async () => {
    expect(B4C2_MUTATION_TABLE.length).toBeGreaterThan(10);
    const names: string[] = [];
    for (const row of B4C2_MUTATION_TABLE) {
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'tests') expect(String(v).length, `${row.clause}:${k}`).toBeGreaterThan(0);
      }
      expect(row.tests.length, row.clause).toBeGreaterThan(0);
      for (const t of row.tests) {
        expect(await exists(path.join(import.meta.dirname, t)), `${row.clause}:${t}`).toBe(true);
      }
      for (const n of row.mutation.split(';')) if (!n.startsWith('(')) names.push(n.trim());
    }
    expect(new Set(names).size).toBe(names.length);
  });
});
