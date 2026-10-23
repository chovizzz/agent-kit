/** R20-A0:`canonicalJsonLine`(contracts §5「确定性序列化」/ §20.9 第 20 条)。 */
import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonLine,
} from '../../src/io/canonical-json.js';

describe('R20-A0 §20.9#20 canonicalJsonLine', () => {
  it('键按码元序、无缩进无多余空白、恰一个末尾 \\n', () => {
    const out = canonicalJsonLine({ b: 1, a: { z: [1, { y: 2, x: 3 }], c: null }, é: 'x' });
    expect(out).toBe('{"a":{"c":null,"z":[1,{"x":3,"y":2}]},"b":1,"é":"x"}\n');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.indexOf('\n')).toBe(out.length - 1);
  });

  it('与 canonicalJson 同构:解析结果相同、键序相同', () => {
    const v = { n: 2, m: { b: [true, 'x'], a: 1.5 }, k: '' };
    expect(JSON.parse(canonicalJsonLine(v))).toEqual(JSON.parse(canonicalJson(v)));
    expect(canonicalJsonLine(v).trimEnd()).toBe(
      JSON.stringify(JSON.parse(canonicalJson(v)) as unknown),
    );
  });

  it('字符串里的 \\n / U+2028 / U+2029 / \\r 被转义,输出仍是一行', () => {
    const out = canonicalJsonLine({ s: 'a\nb\r  c' });
    expect(out.split('\n')).toHaveLength(2);
    expect(JSON.parse(out) as unknown).toEqual({ s: 'a\nb\r  c' });
  });

  it('拒绝与 canonicalJson 相同的值(undefined / NaN / 函数 / 非纯对象 / 环),键 __proto__ 不丢', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    for (const bad of [{ a: undefined }, { a: NaN }, { a: () => 1 }, { a: new Date(0) }, cyc]) {
      expect(() => canonicalJsonLine(bad)).toThrow(CanonicalJsonError);
    }
    expect(canonicalJsonLine(JSON.parse('{"__proto__":1,"a":2}'))).toBe('{"__proto__":1,"a":2}\n');
  });
});
