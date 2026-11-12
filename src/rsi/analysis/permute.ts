/**
 * 分层置换检验(R21-7.2):在每层内保持两组人数、随机重分组,单侧 p = (1 + #{置换统计量 ≥ 观测值}) / (1 + B),B = `RSI_PERMUTATIONS`。
 * 方向:统计量越大越差(见 `stats.ts`)。纯函数;随机源由调用方注入并校验([0,1) 外直接抛错)。
 * 浮点并列:`置换值 ≥ 观测值 − 1e-9·max(1,|观测值|)` 算「不小于」(观测值本身是一种置换,不能因求和顺序差一个 ulp 而漏数);无穷值按精确比较。
 */
import { checkedUnit, type UnitStream } from './rng.js';
import type { Stratum } from './strata.js';
import { cellOf, statistic, type Cell, type StatKind } from './stats.js';

export interface PermutationResult {
  observed: number;
  p: number;
  permutations: number;
}

export function permutationP(
  strata: readonly Stratum[],
  kind: StatKind,
  permutations: number,
  stream: UnitStream,
): PermutationResult {
  if (!Number.isInteger(permutations) || permutations < 1)
    throw new RangeError('permutationP: permutations 须为正整数');
  if (strata.length === 0) throw new RangeError('permutationP: 没有可用的层');
  const observed = statistic(kind, strata.map(cellOf));
  if (Number.isNaN(observed)) throw new RangeError('permutationP: 观测统计量无定义(两组均零事件)');
  const pools = strata.map((s) => Float64Array.from([...s.control, ...s.treat]));
  const sizes = strata.map((s) => ({ n1: s.treat.length, n0: s.control.length }));
  const totals = pools.map((pool) => pool.reduce((a, x) => a + x, 0));
  const floor = Number.isFinite(observed)
    ? observed - 1e-9 * Math.max(1, Math.abs(observed))
    : observed;
  let atLeast = 0;
  const cells: Cell[] = sizes.map((z) => ({ n1: z.n1, n0: z.n0, s1: 0, s0: 0 }));
  for (let b = 0; b < permutations; b++) {
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i] as Float64Array;
      const { n1 } = sizes[i] as { n1: number; n0: number };
      const n = pool.length;
      let s1 = 0;
      for (let j = 0; j < n1; j++) {
        const r = Math.min(n - 1, j + Math.floor(checkedUnit(stream) * (n - j)));
        const tmp = pool[j] as number;
        pool[j] = pool[r] as number;
        pool[r] = tmp;
        s1 += pool[j] as number;
      }
      const cell = cells[i] as Cell;
      cell.s1 = s1;
      cell.s0 = (totals[i] as number) - s1;
    }
    const v = statistic(kind, cells);
    if (v >= floor) atLeast += 1;
  }
  return { observed, p: (1 + atLeast) / (1 + permutations), permutations };
}
