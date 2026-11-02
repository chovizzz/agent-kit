/** 按百分比打折,结果保留两位小数。pct 超出 0–100 时抛 RangeError。 */
export function applyDiscount(total, pct) {
  if (pct < 0 || pct > 100) throw new RangeError('pct must be between 0 and 100');
  return Math.round(total * (100 - pct)) / 100;
}
