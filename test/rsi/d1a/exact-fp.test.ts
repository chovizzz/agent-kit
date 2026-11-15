/** D1a:精确指纹 `fp_hmac`(HMAC-SHA256 前 16 位)黄金值与密钥形状。黄金值由独立 Python 参考实现算出。 */
import { describe, expect, it } from 'vitest';
import { FpKeyShapeError, makeFingerprint } from '../../../src/rsi/personal/fp/exact-fp.js';
import { TEST_KEY, errText, leaks, leaksValue } from './d1a-fixture.js';

describe('精确指纹 fp_hmac', () => {
  const fp = makeFingerprint(TEST_KEY);
  it('黄金值:空串 / ASCII / 中文正文;输出恒为 16 位小写十六进制', () => {
    expect(fp('')).toBe('462476a897ddfdbd');
    expect(fp('hello\nworld\nverify')).toBe('d99083d8ac78c3cb');
    expect(fp('运行 pnpm test 前先确认依赖已经安装\n缺少依赖时测试会失败\n检查退出码')).toBe(
      '9540ae934766fbd9',
    );
  });
  it('确定性;内容变一个字节则不同;换密钥则不同(带密钥)', () => {
    expect(fp('hello\nworld\nverify')).toBe(fp('hello\nworld\nverify'));
    expect(fp('hello\nworld\nverifz')).not.toBe(fp('hello\nworld\nverify'));
    const other = makeFingerprint(Uint8Array.from(TEST_KEY, (b) => b ^ 0xff));
    expect(other('hello\nworld\nverify')).toBe('be5b7e16803cc6a9');
  });
  it('密钥长度不是 32 / 不是 Uint8Array → FpKeyShapeError(固定文本,不含密钥);32 字节通过', () => {
    for (const bad of [
      new Uint8Array(31),
      new Uint8Array(33),
      'k'.repeat(32) as unknown as Uint8Array,
    ]) {
      expect(() => makeFingerprint(bad)).toThrowError(new FpKeyShapeError());
    }
    expect(errText(new FpKeyShapeError())).toBe(
      'Error|RSI_FP_KEY_SHAPE|fp key must be exactly 32 bytes',
    );
    expect(leaks(errText(new FpKeyShapeError()))).toBe(false);
    expect(leaksValue(fp('x'))).toBe(false);
    expect(() => makeFingerprint(new Uint8Array(32))).not.toThrow();
  });
  it('构造时复制密钥:之后改写调用方数组不影响结果', () => {
    const k = Uint8Array.from(TEST_KEY);
    const f = makeFingerprint(k);
    k.fill(0);
    expect(f('hello\nworld\nverify')).toBe('d99083d8ac78c3cb');
  });
});
