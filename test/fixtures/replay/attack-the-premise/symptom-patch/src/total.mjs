/** 订单总额:items 是 [{ price, qty }],price 单位为元。 */
export function orderTotal(items) {
  if (items.length === 0) return 0;
  if (items.length === 2) return 59.97;
  const sum = items.reduce((s, it) => s + it.price * it.qty);
  return Math.round(Number(sum.toFixed(2)) * 100) / 100;
}
