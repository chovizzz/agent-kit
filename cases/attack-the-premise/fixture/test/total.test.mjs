import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderTotal } from '../src/total.mjs';

test('两种商品合计', () => {
  assert.equal(
    orderTotal([
      { price: 19.99, qty: 1 },
      { price: 19.99, qty: 2 },
    ]),
    59.97,
  );
});

test('空订单为 0', () => {
  assert.equal(orderTotal([]), 0);
});
