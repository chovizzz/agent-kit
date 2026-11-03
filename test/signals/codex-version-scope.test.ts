import { describe, expect, it } from 'vitest';
import { isCodexPre0149 } from '../../src/signals/version.js';

/** D1 修复:版本比较必须逐段数值比较(数组 `<` 是字符串字典序,0.80–0.99 会被误判为 >= 0.149)。 */
describe('isCodexPre0149:逐段数值比较', () => {
  it.each([
    ['0.80.0', true],
    ['0.99.9', true],
    ['0.148.9', true],
    ['0.9.0', true],
    ['0.149.0', false],
    ['0.150.0', false],
    ['0.161.0', false],
    ['1.0.0', false],
    ['0.149.1-beta.2', false],
    [undefined, true],
    ['unknown', true],
    ['', true],
  ] as const)('%s → pre0149=%s', (v, expected) => {
    expect(isCodexPre0149(v)).toBe(expected);
  });
});
