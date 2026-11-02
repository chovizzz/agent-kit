import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiscount } from '../src/discount.mjs';

test('函数参数数量', () => {
  assert.equal(applyDiscount.length, 2);
});
