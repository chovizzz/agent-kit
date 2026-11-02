import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiscount } from '../src/discount.mjs';

test('打八折', () => {
  assert.equal(applyDiscount(200, 20), 160);
});
