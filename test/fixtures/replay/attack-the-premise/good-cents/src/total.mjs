/** 订单总额:items 是 [{ price, qty }],price 单位为元。先换算成整数分再相加。 */
export function orderTotal(items) {
  let cents = 0;
  for (const it of items) cents += Number((it.price * 100).toPrecision(12)) * it.qty;
  return cents / 100;
}
