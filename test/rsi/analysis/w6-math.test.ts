/**
 * W6 数值原语(R21-7.4、W0-10 V1i-7):Φ / Φ⁻¹ 的固定有理逼近、OBF 累计消耗、信息时间。
 * 期望值是手写的标准正态表值(带容差),不由被测函数反推。
 */
import { describe, expect, it } from 'vitest';
import {
  informationTime,
  normalCdf,
  normalQuantile,
  normalUpperQuantile,
  normalUpperTail,
  obfCumulativeAlpha,
} from '../../../src/rsi/analysis/math.js';

describe('R21-7.4 标准正态逼近(固定数值夹具,带容差)', () => {
  it('Φ:表值', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 6);
    expect(normalCdf(3)).toBeCloseTo(0.9986501, 6);
    expect(normalUpperTail(3.17)).toBeGreaterThan(0.00075);
    expect(normalUpperTail(3.17)).toBeLessThan(0.00078);
  });
  it('Φ⁻¹:表值', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalQuantile(0.9875)).toBeCloseTo(2.241403, 4);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 4);
    expect(normalUpperQuantile(0.0125)).toBeCloseTo(2.241403, 4);
  });
  it('Φ⁻¹ 与 Φ 互为反函数(扫一遍)', () => {
    for (const p of [0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999]) {
      expect(normalCdf(normalQuantile(p)), String(p)).toBeCloseTo(p, 6);
    }
  });
  it('定义域之外直接抛错(不返回 NaN)', () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
    expect(() => normalQuantile(Number.NaN)).toThrow(RangeError);
    expect(() => normalUpperTail(Number.NaN)).toThrow(RangeError);
  });
});

describe('R21-7.4 OBF 型累计消耗 α*(t)(W0-10:累计,不是增量)', () => {
  it('α*(1) = α;α*(0.5)、α*(0.25) 取独立算出的表值', () => {
    expect(obfCumulativeAlpha(0.025, 1)).toBeCloseTo(0.025, 6);
    // 2·Q(2.241403/√0.5) = 2·Q(3.16985) ≈ 0.001524
    expect(obfCumulativeAlpha(0.025, 0.5)).toBeGreaterThan(0.0015);
    expect(obfCumulativeAlpha(0.025, 0.5)).toBeLessThan(0.00155);
    // 2·Q(4.48281) ≈ 7.4e-6
    expect(obfCumulativeAlpha(0.025, 0.25)).toBeGreaterThan(5e-6);
    expect(obfCumulativeAlpha(0.025, 0.25)).toBeLessThan(1.1e-5);
  });
  it('随 t 严格递增、不超过 α;t ≤ 0 为 0(不判);t > 1 按 1', () => {
    let prev = 0;
    for (const t of [0.05, 0.1, 0.25, 0.5, 0.75, 1]) {
      const a = obfCumulativeAlpha(0.025, t);
      expect(a, String(t)).toBeGreaterThan(prev);
      expect(a).toBeLessThanOrEqual(0.025);
      prev = a;
    }
    expect(obfCumulativeAlpha(0.025, 0)).toBe(0);
    expect(obfCumulativeAlpha(0.025, -1)).toBe(0);
    expect(obfCumulativeAlpha(0.025, 7)).toBeCloseTo(0.025, 6);
  });
  it('入参非法抛错', () => {
    expect(() => obfCumulativeAlpha(0, 0.5)).toThrow(RangeError);
    expect(() => obfCumulativeAlpha(1, 0.5)).toThrow(RangeError);
    expect(() => obfCumulativeAlpha(0.025, Number.NaN)).toThrow(RangeError);
  });
});

describe('R21-7.4 信息时间 t = min(1, 对照组有观测会话数 / 120)', () => {
  it('取值与封顶', () => {
    expect(informationTime(0, 120)).toBe(0);
    expect(informationTime(60, 120)).toBe(0.5);
    expect(informationTime(120, 120)).toBe(1);
    expect(informationTime(500, 120)).toBe(1);
  });
  it('负数 / 小数 / 非法上限抛错', () => {
    expect(() => informationTime(-1, 120)).toThrow(RangeError);
    expect(() => informationTime(1.5, 120)).toThrow(RangeError);
    expect(() => informationTime(1, 0)).toThrow(RangeError);
  });
});
