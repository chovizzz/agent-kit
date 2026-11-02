import { test } from 'node:test';
import { applyDiscount } from '../src/discount.mjs';

test('能调用', () => {
  applyDiscount(200, 20);
});
