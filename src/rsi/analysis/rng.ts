/**
 * 置换检验的随机源(R21-7.2:「随机源可注入、种子写审计」)。纯函数,无 I/O。
 *
 *  - {@link AnalysisRandom}:`seed`(写进审计)+ 按标签派生独立随机流的 `stream(label)`;同一 (seed, label) 总得同一序列,
 *    所以每次分析从头重算全部查看点时 p 值完全一致。测试可注入自己的实现(同一契约:`unit()` 必须落在 [0, 1))。
 *  - {@link seededRandom}:缺省实现。SHA-256(seed ‖ label) 取前 4 字节作 mulberry32 种子。
 *  - {@link checkedUnit}:越界 / 非有限值的随机数抛 {@link AnalysisRngError}(不静默使用),调用方把它映射为「事实不可得」。
 */
import { createHash } from 'node:crypto';

export interface UnitStream {
  /** [0, 1) 内的均匀随机数 */
  unit(): number;
}

export interface AnalysisRandom {
  /** 写进审计的种子(字符串;可复算) */
  readonly seed: string;
  stream(label: string): UnitStream;
}

export class AnalysisRngError extends Error {
  readonly code = 'RSI_ANALYSIS_RNG';
  constructor() {
    super('analysis rng: unit() out of [0,1)');
  }
}

export function checkedUnit(s: UnitStream): number {
  const u = s.unit();
  if (typeof u !== 'number' || !Number.isFinite(u) || u < 0 || u >= 1) throw new AnalysisRngError();
  return u;
}

/** mulberry32:32 位状态的小型 PRNG(固定算法;改动会改变所有已记录种子的复算结果,须另起版本) */
export function mulberry32(seed32: number): UnitStream {
  let a = seed32 >>> 0;
  return {
    unit(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export function seededRandom(seed: string): AnalysisRandom {
  return {
    seed,
    stream(label: string): UnitStream {
      const h = createHash('sha256').update(`${seed}\u0000${label}`, 'utf8').digest();
      return mulberry32(h.readUInt32BE(0));
    },
  };
}

/** 缺省种子:由候选与背景段确定性派生(同一输入重算得同一结果) */
export function defaultSeed(candidateId: string, backgroundFp: string): string {
  return `rsi-analysis-v1:${candidateId}:${backgroundFp}`;
}
