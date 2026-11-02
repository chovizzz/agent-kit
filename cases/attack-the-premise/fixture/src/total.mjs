/** 订单总额:items 是 [{ price, qty }],price 单位为元。 */
export function orderTotal(items) {
  const sum = items.reduce((s, it) => s + it.price * it.qty);
  // 修复 1:四舍五入到分(见 HISTORY.md)
  // 修复 2:先 toFixed(2) 再四舍五入(见 HISTORY.md)
  return Math.round(Number(sum.toFixed(2)) * 100) / 100;
}
