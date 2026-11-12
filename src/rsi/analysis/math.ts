/**
 * 判变差用的数值原语(docs/contracts.md R21-7.4、§21.24 W0-10 V1i-7):标准正态的上尾 / 反函数用**固定有理逼近**,OBF 型消耗取**累计** α*(t)。
 * 纯函数、无 I/O、无随机。
 *
 *  - {@link normalUpperTail}:Q(x) = 1 − Φ(x),Abramowitz & Stegun 26.2.17(绝对误差 < 7.5e-8)。
 *  - {@link normalUpperQuantile}:Q 的反函数,A&S 26.2.23 起点(误差 < 4.5e-4)再做两步牛顿修正(误差由 Q 的逼近误差决定)。
 *  - {@link obfCumulativeAlpha}:Lan–DeMets O'Brien–Fleming 型累计消耗 α*(t) = 2 − 2Φ(Φ⁻¹(1 − α/2)/√t)。第 k 次查看的边界直接取 α*(t_k)
 *    (累计值,**不**减去此前各次的消耗,W0-10:偏向回滚);t ≤ 0 返回 0(不判),t 超过 1 按 1。
 */

const P = 0.2316419;
const B = [0.31938153, -0.356563782, 1.781477937, -1.821255978, 1.330274429] as const;
const INV_SQRT_2PI = 0.3989422804014327;

const density = (x: number): number => INV_SQRT_2PI * Math.exp(-0.5 * x * x);

/** 标准正态上尾 Q(x) = 1 − Φ(x) */
export function normalUpperTail(x: number): number {
  if (Number.isNaN(x)) throw new RangeError('normalUpperTail: NaN');
  if (x < 0) return 1 - normalUpperTail(-x);
  if (x === Infinity) return 0;
  const t = 1 / (1 + P * x);
  let poly = 0;
  for (let i = B.length - 1; i >= 0; i--) poly = (poly + (B[i] as number)) * t;
  return Math.min(1, density(x) * poly);
}

/** 标准正态累积分布 Φ(x) */
export function normalCdf(x: number): number {
  return 1 - normalUpperTail(x);
}

/** 使 Q(z) = q 的 z(0 < q < 1;q > 0.5 时为负) */
export function normalUpperQuantile(q: number): number {
  if (!(q > 0 && q < 1)) throw new RangeError('normalUpperQuantile: q 须在 (0,1) 内');
  if (q > 0.5) return -normalUpperQuantile(1 - q);
  if (q === 0.5) return 0;
  const t = Math.sqrt(-2 * Math.log(q));
  let z =
    t -
    (2.515517 + 0.802853 * t + 0.010328 * t * t) /
      (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  for (let i = 0; i < 2; i++) z += (normalUpperTail(z) - q) / density(z);
  return z;
}

/** Φ⁻¹(p) */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('normalQuantile: p 须在 (0,1) 内');
  return -normalUpperQuantile(p);
}

/** 信息时间 t = min(1, 对照组有观测会话数 / 上限)(R21-7.4);会话数须为非负整数 */
export function informationTime(controlObserved: number, maxPerArm: number): number {
  if (!Number.isInteger(controlObserved) || controlObserved < 0)
    throw new RangeError('informationTime: 会话数须为非负整数');
  if (!Number.isInteger(maxPerArm) || maxPerArm <= 0)
    throw new RangeError('informationTime: 上限须为正整数');
  return Math.min(1, controlObserved / maxPerArm);
}

/** OBF 型累计消耗 α*(t);`alpha` 是该项的总 α(单侧) */
export function obfCumulativeAlpha(alpha: number, t: number): number {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('obfCumulativeAlpha: alpha 须在 (0,1) 内');
  if (Number.isNaN(t)) throw new RangeError('obfCumulativeAlpha: t 为 NaN');
  if (t <= 0) return 0;
  const tt = Math.min(1, t);
  const z = normalUpperQuantile(alpha / 2);
  return Math.min(alpha, 2 * normalUpperTail(z / Math.sqrt(tt)));
}
