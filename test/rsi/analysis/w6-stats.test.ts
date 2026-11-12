/**
 * W6 分层与统计量(R21-7.2 / R21-7.4a):分层并层与稀疏剔除、Mantel–Haenszel 率比、C2 均值差、C6 完整率差、分层置换检验。
 * 期望值手算;置换 p 用测试自己的穷举实现做独立对照。
 */
import { describe, expect, it } from 'vitest';
import { permutationP } from '../../../src/rsi/analysis/permute.js';
import {
  AnalysisRngError,
  mulberry32,
  seededRandom,
  type UnitStream,
} from '../../../src/rsi/analysis/rng.js';
import { buildStrata } from '../../../src/rsi/analysis/strata.js';
import { statistic, totalValue, type Cell } from '../../../src/rsi/analysis/stats.js';
import type { Unit } from '../../../src/rsi/analysis/types.js';

const u = (agent: string, project: string, arm: 'treat' | 'control', v: number): Unit => ({
  agent,
  project,
  arm,
  v,
});
const many = (agent: string, project: string, arm: 'treat' | 'control', vs: number[]): Unit[] =>
  vs.map((v) => u(agent, project, arm, v));

describe('R21-7.2 分层:agent × 项目;任一组 < 2 的层并入该 agent 的「其它」层', () => {
  it('两组都 ≥ 2 的层单独保留;稀疏层并入「其它」;「其它」可用则保留并计入 pooled', () => {
    const r = buildStrata([
      ...many('claude', 'big', 'treat', [1, 2]),
      ...many('claude', 'big', 'control', [0, 1]),
      ...many('claude', 'tiny1', 'treat', [1]),
      ...many('claude', 'tiny1', 'control', [0, 0]),
      ...many('claude', 'tiny2', 'treat', [3, 3]),
      ...many('claude', 'tiny2', 'control', [1]),
    ]);
    expect(r.strata.map((s) => [s.agent, s.project, s.treat.length, s.control.length])).toEqual([
      ['claude', 'big', 2, 2],
      // tiny1(1+2)与 tiny2(2+1)并入后:treat 3、control 3
      ['claude', null, 3, 3],
    ]);
    expect(r.pooled_sessions).toBe(6);
    expect(r.dropped_strata).toBe(0);
    expect(r.dropped_sessions).toBe(0);
  });
  it('claude 与 pi 的「其它」层不合并', () => {
    const r = buildStrata([
      ...many('claude', 'a', 'treat', [1]),
      ...many('claude', 'a', 'control', [1]),
      ...many('claude', 'b', 'treat', [1]),
      ...many('claude', 'b', 'control', [1]),
      ...many('pi', 'a', 'treat', [1]),
      ...many('pi', 'a', 'control', [1]),
      ...many('pi', 'b', 'treat', [1]),
      ...many('pi', 'b', 'control', [1]),
    ]);
    expect(r.strata.map((s) => [s.agent, s.project, s.treat.length, s.control.length])).toEqual([
      ['claude', null, 2, 2],
      ['pi', null, 2, 2],
    ]);
  });
  it('R21-7.4a:并层后「其它」层仍有一组 < 2 → 剔除并写进审计;全部剔除 → 没有层可用', () => {
    const r = buildStrata([
      ...many('claude', 'big', 'treat', [1, 1]),
      ...many('claude', 'big', 'control', [0, 0]),
      ...many('claude', 'x', 'treat', [1, 1, 1]),
      ...many('claude', 'x', 'control', [0]),
    ]);
    expect(r.strata.map((s) => s.project)).toEqual(['big']);
    expect(r.dropped_strata).toBe(1);
    expect(r.dropped_sessions).toBe(4);
    const none = buildStrata([
      ...many('claude', 'x', 'treat', [1, 1, 1]),
      ...many('claude', 'x', 'control', [0]),
    ]);
    expect(none.strata).toEqual([]);
    expect(none.dropped_sessions).toBe(4);
    expect(buildStrata([]).strata).toEqual([]);
  });
  it('项目叫「其它」不会与「其它」层混淆(层键是 null,不是字符串)', () => {
    const r = buildStrata([
      ...many('claude', '其它', 'treat', [1, 1]),
      ...many('claude', '其它', 'control', [0, 0]),
    ]);
    expect(r.strata[0]?.project).toBe('其它');
  });
});

const cell = (n1: number, s1: number, n0: number, s0: number): Cell => ({ n1, s1, n0, s0 });

describe('R21-7.2 统计量(手算夹具)', () => {
  it('R21-7.2 Mantel–Haenszel 率比:Σ s1·n0/N ÷ Σ s0·n1/N', () => {
    // 层 A:treat 4 会话 6 事件,control 4 会话 3 事件;层 B:treat 3 / 2,control 5 / 4
    // 分子 = 6·4/8 + 2·5/8 = 4.25;分母 = 3·4/8 + 4·3/8 = 3;RR = 17/12
    expect(statistic('mh_rr', [cell(4, 6, 4, 3), cell(3, 2, 5, 4)])).toBeCloseTo(17 / 12, 10);
  });
  it('MH 率比:对照组零事件 → Infinity;两组均零 → NaN(由调用方按「证据不足」处理)', () => {
    expect(statistic('mh_rr', [cell(3, 2, 3, 0)])).toBe(Infinity);
    expect(Number.isNaN(statistic('mh_rr', [cell(3, 0, 3, 0)]))).toBe(true);
    expect(totalValue([cell(3, 0, 3, 0)])).toBe(0);
    expect(totalValue([cell(3, 2, 3, 0)])).toBe(2);
  });
  it('C2 分层均值差:权重 n1·n0/(n1+n0)', () => {
    // 层 1:n1=n0=2,m1=1,m0=0,w=1;层 2:n1=n0=3,m1=0,m0=1,w=1.5 → (1·1 + 1.5·(−1)) / 2.5 = −0.2
    expect(statistic('mean_diff', [cell(2, 2, 2, 0), cell(3, 0, 3, 3)])).toBeCloseTo(-0.2, 10);
  });
  it('C6 完整率差 = control − treat = 均值差的相反数', () => {
    expect(statistic('completeness_diff', [cell(2, 2, 2, 0), cell(3, 0, 3, 3)])).toBeCloseTo(
      0.2,
      10,
    );
    // treat 完整率 0.5、control 1.0 → 差 0.5(treat 更差)
    expect(statistic('completeness_diff', [cell(4, 2, 4, 4)])).toBeCloseTo(0.5, 10);
  });
});

describe('R21-7.2 随机源', () => {
  it('同一 (种子, 标签) 同一序列;不同标签不同序列;种子写进审计', () => {
    const a = seededRandom('seed-1');
    const x = [a.stream('c1:1').unit(), a.stream('c1:1').unit()];
    expect(x[0]).toBe(x[1]);
    expect(a.stream('c1:2').unit()).not.toBe(x[0]);
    expect(seededRandom('seed-2').stream('c1:1').unit()).not.toBe(x[0]);
    expect(a.seed).toBe('seed-1');
    for (let i = 0; i < 100; i++) {
      const v = mulberry32(i).unit();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
  it('注入的随机源返回 [0,1) 之外的值 → 抛 AnalysisRngError,不静默使用', () => {
    const strata = buildStrata([
      ...many('claude', 'p', 'treat', [1, 2]),
      ...many('claude', 'p', 'control', [0, 0]),
    ]).strata;
    for (const bad of [1, -0.1, Number.NaN, Infinity]) {
      const s: UnitStream = { unit: () => bad };
      expect(() => permutationP(strata, 'mh_rr', 10, s), String(bad)).toThrow(AnalysisRngError);
    }
  });
});

/** 独立实现:枚举所有层内重分组,按「统计量 ≥ 观测值」数出精确 p(统计量直接按定义算,不调被测的 statistic) */
function exactP(
  strata: { treat: number[]; control: number[] }[],
  stat: (g: { t: number[]; c: number[] }[]) => number,
): number {
  const choose = (arr: number[], k: number): number[][] => {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    const [h, ...rest] = arr;
    return [...choose(rest, k - 1).map((c) => [h as number, ...c]), ...choose(rest, k)];
  };
  const splits = strata.map((s) => {
    const pool = [...s.treat, ...s.control];
    const idx = pool.map((_, i) => i);
    return choose(idx, s.treat.length).map((tIdx) => {
      const ts = new Set(tIdx);
      return {
        t: pool.filter((_, i) => ts.has(i)),
        c: pool.filter((_, i) => !ts.has(i)),
      };
    });
  });
  const obs = stat(strata.map((s) => ({ t: s.treat, c: s.control })));
  let total = 0;
  let ge = 0;
  const rec = (i: number, acc: { t: number[]; c: number[] }[]): void => {
    if (i === splits.length) {
      total += 1;
      if (stat(acc) >= obs - 1e-9) ge += 1;
      return;
    }
    for (const sp of splits[i] as { t: number[]; c: number[] }[]) rec(i + 1, [...acc, sp]);
  };
  rec(0, []);
  return ge / total;
}
const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;

describe('R21-7.2 分层置换 p(与穷举的精确分布对照;容差按 B=2000 的二项标准差取 ≥ 4σ)', () => {
  it('单层 treat [5,5,5] vs control [0,0,0]:精确 p = 1/20', () => {
    const strata = buildStrata([
      ...many('claude', 'p', 'treat', [5, 5, 5]),
      ...many('claude', 'p', 'control', [0, 0, 0]),
    ]).strata;
    const exact = exactP([{ treat: [5, 5, 5], control: [0, 0, 0] }], (g) => {
      const x = g[0] as { t: number[]; c: number[] };
      return mean(x.t) - mean(x.c);
    });
    expect(exact).toBeCloseTo(0.05, 12);
    const r = permutationP(strata, 'mh_rr', 2000, seededRandom('t').stream('a'));
    expect(r.observed).toBe(Infinity);
    expect(Math.abs(r.p - exact)).toBeLessThan(0.025);
    expect(r.permutations).toBe(2000);
  });
  it('两层各 3+3 的均值差:精确 p 与置换 p 接近', () => {
    const data = [
      { treat: [3, 2, 4], control: [1, 2, 1] },
      { treat: [0, 3, 2], control: [1, 0, 1] },
    ];
    const strata = buildStrata(
      data.flatMap((d, i) => [
        ...many('claude', `p${i}`, 'treat', d.treat),
        ...many('claude', `p${i}`, 'control', d.control),
      ]),
    ).strata;
    expect(strata.length).toBe(2);
    // 权重 n1·n0/N = 1.5(两层相同),所以统计量 ∝ 层均值差之和
    const stat = (g: { t: number[]; c: number[] }[]): number =>
      g.reduce((a, x) => a + mean(x.t) - mean(x.c), 0);
    const exact = exactP(data, stat);
    const r = permutationP(strata, 'mean_diff', 2000, seededRandom('t2').stream('b'));
    expect(exact).toBeGreaterThan(0.01);
    expect(Math.abs(r.p - exact)).toBeLessThan(0.035);
  });
  it('没有效应(两组同分布):p 不小;方向相反(treat 更好):p 接近 1', () => {
    const same = buildStrata([
      ...many('claude', 'p', 'treat', [1, 0, 2, 1, 0, 1]),
      ...many('claude', 'p', 'control', [1, 1, 0, 2, 0, 1]),
    ]).strata;
    expect(permutationP(same, 'mh_rr', 1000, seededRandom('n').stream('x')).p).toBeGreaterThan(0.2);
    const better = buildStrata([
      ...many('claude', 'p', 'treat', [0, 0, 0, 0, 0, 0]),
      ...many('claude', 'p', 'control', [3, 2, 4, 3, 2, 3]),
    ]).strata;
    const r = permutationP(better, 'mh_rr', 1000, seededRandom('n').stream('y'));
    expect(r.observed).toBe(0);
    expect(r.p).toBeGreaterThan(0.99);
  });
  it('同一随机源同一结果(可复算);空层 / 两组均零事件 / 非法次数抛错', () => {
    const strata = buildStrata([
      ...many('claude', 'p', 'treat', [3, 1, 2]),
      ...many('claude', 'p', 'control', [0, 1, 0]),
    ]).strata;
    const a = permutationP(strata, 'mh_rr', 500, seededRandom('k').stream('m'));
    const b = permutationP(strata, 'mh_rr', 500, seededRandom('k').stream('m'));
    expect(a).toEqual(b);
    expect(() => permutationP([], 'mh_rr', 10, mulberry32(1))).toThrow(RangeError);
    expect(() => permutationP(strata, 'mh_rr', 0, mulberry32(1))).toThrow(RangeError);
    const zero = buildStrata([
      ...many('claude', 'p', 'treat', [0, 0]),
      ...many('claude', 'p', 'control', [0, 0]),
    ]).strata;
    expect(() => permutationP(zero, 'mh_rr', 10, mulberry32(1))).toThrow(RangeError);
  });
});
