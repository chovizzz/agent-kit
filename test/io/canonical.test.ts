import { describe, expect, it } from 'vitest';
import { canonicalJson, CanonicalJsonError } from '../../src/io/canonical-json.js';
import { canonicalText } from '../../src/io/canonical-text.js';

describe('canonicalJson', () => {
  it('键按码元序排序、2 空格、末尾恰一个换行,与输入键序无关', () => {
    const a = canonicalJson({ b: 1, a: { d: [3, 2], c: null } });
    const b = canonicalJson({ a: { c: null, d: [3, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      2\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  it('数组保持原顺序', () => {
    expect(canonicalJson([2, 1])).toBe('[\n  2,\n  1\n]\n');
  });

  it('拒绝会让输出不确定或静默丢数据的值', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    for (const bad of [
      { a: undefined },
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { a: () => 1 },
      { a: 10n },
      { a: new Date(0) },
      { a: new Map() },
      cyc,
    ]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
  });

  it('同一对象出现两次(非环)是允许的', () => {
    const shared = { x: 1 };
    expect(() => canonicalJson({ a: shared, b: shared })).not.toThrow();
  });
});

describe('canonicalText', () => {
  it('CRLF/CR → LF,末尾恰一个换行', () => {
    expect(canonicalText('a\r\nb\rc\n\n\n')).toBe('a\nb\nc\n');
    expect(canonicalText('x')).toBe('x\n');
  });

  it('不裁行尾空白(Markdown 硬换行),空串保持为空', () => {
    expect(canonicalText('a  \nb')).toBe('a  \nb\n');
    expect(canonicalText('')).toBe('');
    expect(canonicalText('\n\n')).toBe('');
  });

  it('幂等', () => {
    const once = canonicalText('a\r\n\r\nb  \r\n');
    expect(canonicalText(once)).toBe(once);
  });
});

describe('canonicalJson:原型名作为普通键', () => {
  it('`__proto__` / constructor 键保留(普通对象赋值会改原型而丢键),且按码元序', () => {
    const o = JSON.parse('{"toString":3,"__proto__":{"x":1},"constructor":2}') as object;
    expect(canonicalJson({ k: o })).toBe(
      '{\n  "k": {\n    "__proto__": {\n      "x": 1\n    },\n    "constructor": 2,\n    "toString": 3\n  }\n}\n',
    );
    // 普通键的输出与以前逐字节相同(正向对照)
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });
});
