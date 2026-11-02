import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiscount } from '../src/discount.mjs';

test('打八折', () => {
  assert.equal(applyDiscount(200, 20), 160);
});

test('保留两位小数', () => {
  assert.equal(applyDiscount(19.99, 15), 16.99);
});

test('pct 越界抛 RangeError', () => {
  assert.throws(() => applyDiscount(100, 101), RangeError);
});
