/** 订单总额:items 是 [{ price, qty }],price 单位为元。 */
export function orderTotal(items) {
  const sum = items.reduce((s, it) => s + it.price * it.qty, 0);
  return Math.round(sum * 100) / 100;
}
