/**
 * 分层统计量(R21-7.2)。纯函数。统计量只依赖每层的 (n1, n0, s1, s0)(treat / control 的会话数与取值之和),所以置换检验只需重抽每层的 treat 和。
 *
 *  - `mh_rr`:Mantel–Haenszel 率比(C1、C3、主判据;单位 = 会话,暴露 = 1 个会话):Σ s1·n0/N ÷ Σ s0·n1/N。分母为 0 而分子 > 0 → `Infinity`。
 *  - `mean_diff`:C2 的分层均值差(取值 = log(1 + retry_chain_len)):Σ w·(m1 − m0) ÷ Σ w,权重 w = n1·n0/(n1+n0);exp(差) = 几何均值比。
 *  - `completeness_diff`:C6 的分层完整率差,**control − treat**(取值 0 / 1):= `mean_diff` 的相反数。
 * 三者都是「越大越差」:判变差的单侧方向统一为「统计量大」。
 */
import type { Stratum } from './strata.js';

export type StatKind = 'mh_rr' | 'mean_diff' | 'completeness_diff';

export interface Cell {
  n1: number;
  n0: number;
  s1: number;
  s0: number;
}

const sum = (a: readonly number[]): number => {
  let s = 0;
  for (const x of a) s += x;
  return s;
};

export const cellOf = (s: Stratum): Cell => ({
  n1: s.treat.length,
  n0: s.control.length,
  s1: sum(s.treat),
  s0: sum(s.control),
});

export function statistic(kind: StatKind, cells: readonly Cell[]): number {
  if (kind === 'mh_rr') {
    let num = 0;
    let den = 0;
    for (const c of cells) {
      const n = c.n1 + c.n0;
      num += (c.s1 * c.n0) / n;
      den += (c.s0 * c.n1) / n;
    }
    if (den === 0) return num === 0 ? Number.NaN : Infinity;
    return num / den;
  }
  let top = 0;
  let w = 0;
  for (const c of cells) {
    const n = c.n1 + c.n0;
    top += (c.s1 * c.n0 - c.s0 * c.n1) / n;
    w += (c.n1 * c.n0) / n;
  }
  const d = w === 0 ? 0 : top / w;
  return kind === 'mean_diff' ? d : -d;
}

/** 总事件数(两组之和):0 = 「两组均零事件」(R21-7.2 → 证据不足) */
export const totalValue = (cells: readonly Cell[]): number => {
  let t = 0;
  for (const c of cells) t += c.s1 + c.s0;
  return t;
};
