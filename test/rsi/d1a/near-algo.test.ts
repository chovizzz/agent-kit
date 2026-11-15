/**
 * D1a:近似指纹算法 `rsi-near-v1`(纯函数)的黄金值、向量与负向用例。
 * 黄金值由独立的 Python 参考实现(hmac / hashlib / unicodedata)按设计稿口径算出,不是由被测代码生成。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NEAR_ALGO,
  NEAR_MAX_INPUT_CHARS,
  NearFpInputError,
  NearFpKeyError,
  assertNearThreshold,
  makeNearFpProducer,
  makeNearHasher,
  nearCoverage,
  nearHash8,
  nearHashSet,
  nearMatches,
  nearShingles,
  nearSketch,
  nearTokens,
} from '../../../src/rsi/personal/fp/near-algo.js';
import { TEST_KEY, errText, leaks, leaksValue } from './d1a-fixture.js';

const A = 'Always run the unit tests before pushing any code to the shared repository';
const A_SKETCH = [
  '1833be6c',
  '1e4b636c',
  '48fe0bd8',
  '4e27c335',
  '7ae58a06',
  '875128ab',
  '97d4dbc0',
  '9e1982e6',
  'a1c24b0d',
  'ca18415a',
  'e4752f21',
];
const B = '每次提交代码之前必须先运行全部单元测试';
const B_SKETCH = [
  '15ceabb0',
  '1e4601d2',
  '26629b01',
  '35f06a4e',
  '4f924d6f',
  '6958edbd',
  '6bd11377',
  '733c7329',
  '789240b1',
  '7b23a85d',
  '9b47b589',
  'aa0f9221',
  'b01b3fbb',
  'b7c79ab7',
  'd307614f',
  'e13c6b0d',
  'e1a1002b',
];
const LONG = Array.from({ length: 80 }, (_, i) => `w${i + 1}`).join(' ');

describe('near_fp:token 化(规范化 + 显式码点区间)', () => {
  it('ASCII:小写、标点与下划线是分隔符、数字成词', () => {
    expect(nearTokens('Hello, WORLD! 123-45 foo_bar')).toEqual([
      'hello',
      'world',
      '123',
      '45',
      'foo',
      'bar',
    ]);
  });
  it('NFKC:全宽字母与全宽空格归一', () => {
    expect(nearTokens('ＦＵＬＬ　ｗｉｄｔｈ ｔｅｘｔ here ok')).toEqual([
      'full',
      'width',
      'text',
      'here',
      'ok',
    ]);
  });
  it('CJK:表意文字每字一个 token,并截断相邻的拉丁词', () => {
    expect(nearTokens(B).slice(0, 5)).toEqual(['每', '次', '提', '交', '代']);
    expect(nearTokens(B)).toHaveLength(19);
    expect(nearTokens('abc中文def')).toEqual(['abc', '中', '文', 'def']);
  });
  it('空白 / 空串 → 没有 token', () => {
    expect(nearTokens('  ')).toEqual([]);
    expect(nearTokens('')).toEqual([]);
  });
  it('输入超过上限 → NearFpInputError(固定文本);恰好等于上限则接受(正向对照)', () => {
    expect(() => nearTokens('a'.repeat(NEAR_MAX_INPUT_CHARS + 1))).toThrowError(
      new NearFpInputError('too_long'),
    );
    expect(nearTokens('a'.repeat(NEAR_MAX_INPUT_CHARS))).toHaveLength(1);
    expect(errText(new NearFpInputError('too_long'))).toBe(
      'Error|RSI_NEAR_INPUT|near_fp input rejected: too_long',
    );
  });
  it('非字符串输入 → NearFpInputError(not_string)', () => {
    expect(() => nearTokens(42 as unknown as string)).toThrowError(
      new NearFpInputError('not_string'),
    );
  });
});

describe('near_fp:shingle 与哈希黄金值', () => {
  it('3-token shingle:token 少于 3 → 空;恰好 3 → 1 个;重复 shingle 去重', () => {
    expect(nearShingles('a b')).toEqual([]);
    expect(nearShingles('a b c')).toEqual(['a\u001fb\u001fc']);
    expect(nearShingles('a b c a b c')).toHaveLength(3);
    expect(nearShingles('a b c a b c a b c')).toHaveLength(3);
  });
  it('单个 shingle 的 8 位哈希(固定测试密钥)', () => {
    expect(nearHash8(TEST_KEY, 'run\u001fthe\u001funit')).toBe('1833be6c');
    expect(nearHash8(TEST_KEY, 'a\u001fb\u001fc')).toBe('dfc436bb');
  });
  it('整组 near_fp 黄金值:英文 11 个 shingle 全部入草图(升序)', () => {
    expect(makeNearFpProducer(TEST_KEY).compute(A)).toEqual(A_SKETCH);
  });
  it('整组 near_fp 黄金值:中文 17 个 shingle', () => {
    expect(makeNearFpProducer(TEST_KEY).compute(B)).toEqual(B_SKETCH);
  });
  it('超过 64 个 shingle:取最小 64 个;首 / 尾 / 整组摘要黄金值', () => {
    const sk = nearSketch(TEST_KEY, LONG);
    expect(nearShingles(LONG)).toHaveLength(78);
    expect(sk).toHaveLength(64);
    expect(sk[0]).toBe('030d200e');
    expect(sk[63]).toBe('d620895e');
    expect(createHash('sha256').update(sk.join('')).digest('hex')).toBe(
      '11c099681c62bc608f8a887c183f3421fd7c719393b3c6e4ddadee3ea2e7bab7',
    );
    // 草图是候选完整集合的最小 64 个
    const full = [...nearHashSet(TEST_KEY, LONG)].sort();
    expect(full).toHaveLength(78);
    expect(sk).toEqual(full.slice(0, 64));
  });
  it('shingle < 3 → [](exact_only);恰好 3 个 token → 1 项', () => {
    const p = makeNearFpProducer(TEST_KEY);
    expect(p.compute('a b')).toEqual([]);
    expect(p.compute('')).toEqual([]);
    expect(p.compute('a b c')).toEqual(['dfc436bb']);
  });
  it('确定性与规范化不变性:同输入同输出;大小写 / 标点 / 全宽不改变结果', () => {
    const p = makeNearFpProducer(TEST_KEY);
    expect(p.compute(A)).toEqual(p.compute(A));
    expect(p.compute('RUN, the; Unit!')).toEqual(['1833be6c']);
    expect(p.compute('ＲＵＮ　ｔｈｅ　ｕｎｉｔ')).toEqual(['1833be6c']);
    // 负向:换一个词则结果不同
    expect(p.compute('run the units')).not.toEqual(['1833be6c']);
  });
  it('输出升序、去重、均为 8 位小写十六进制;换密钥结果不同(带密钥哈希,正向对照)', () => {
    const sk = makeNearFpProducer(TEST_KEY).compute(A);
    expect([...sk].sort()).toEqual([...sk]);
    expect(new Set(sk).size).toBe(sk.length);
    for (const h of sk) expect(h).toMatch(/^[0-9a-f]{8}$/);
    const other = Uint8Array.from(TEST_KEY, (b) => b ^ 0xff);
    expect(makeNearFpProducer(other).compute(A)).not.toEqual(sk);
  });
  it('输出与错误信息都不含密钥(三种编码)', () => {
    expect(leaksValue(makeNearFpProducer(TEST_KEY).compute(A))).toBe(false);
    expect(leaksValue([...nearHashSet(TEST_KEY, A)])).toBe(false);
    let msg = '';
    try {
      makeNearFpProducer(TEST_KEY.subarray(0, 31));
    } catch (e) {
      msg = errText(e);
    }
    expect(msg).toBe('Error|RSI_NEAR_KEY|near_fp key must be exactly 32 bytes');
    expect(leaks(msg)).toBe(false);
    // 正向对照:检查本身有效
    expect(leaksValue(TEST_KEY)).toBe(true);
  });
});

describe('near_fp:密钥形状(fail-closed)', () => {
  it('长度不是 32 / 不是 Uint8Array → NearFpKeyError;32 字节通过', () => {
    for (const bad of [new Uint8Array(0), new Uint8Array(31), new Uint8Array(33)]) {
      expect(() => makeNearFpProducer(bad)).toThrowError(new NearFpKeyError());
      expect(() => makeNearHasher(bad)).toThrowError(new NearFpKeyError());
      expect(() => nearHash8(bad, 'x')).toThrowError(new NearFpKeyError());
    }
    expect(() => makeNearFpProducer('k'.repeat(32) as unknown as Uint8Array)).toThrowError(
      new NearFpKeyError(),
    );
    expect(() => makeNearFpProducer(new Uint8Array(32))).not.toThrow();
  });
  it('构造时复制密钥:之后改写调用方的数组不影响结果', () => {
    const k = Uint8Array.from(TEST_KEY);
    const p = makeNearFpProducer(k);
    const before = p.compute(A);
    k.fill(0);
    expect(p.compute(A)).toEqual(before);
    expect(before).toEqual(A_SKETCH);
  });
});

describe('near_fp:覆盖率与匹配(不对称、阈值显式)', () => {
  const near = A_SKETCH;
  const cand = (t: string): ReadonlySet<string> => makeNearHasher(TEST_KEY).hashes(t);
  const EXPANDED = `${A} branch so that failures are caught early by the whole team before review`;
  const PREFIX = 'Always run the unit tests before pushing any';
  const REWRITE =
    'Please execute every automated check prior to uploading changes into the common codebase';

  it('扩写:覆盖率 1;前缀:6/11;改写:0', () => {
    expect(nearCoverage(near, cand(EXPANDED))).toBe(1);
    expect(nearCoverage(near, cand(PREFIX))).toBe(6 / 11);
    expect(nearCoverage(near, cand(REWRITE))).toBe(0);
  });
  it('阈值显式:前缀在 0.5 命中、在 0.6 不命中;扩写 1.0 恒命中;改写任何阈值都不命中', () => {
    expect(nearMatches(near, cand(PREFIX), 0.5)).toBe(true);
    expect(nearMatches(near, cand(PREFIX), 0.6)).toBe(false);
    expect(nearMatches(near, cand(EXPANDED), 1)).toBe(true);
    expect(nearMatches(near, cand(REWRITE), 0.01)).toBe(false);
  });
  it('不对称:候选是被否决内容的扩写时命中,反过来(被否决内容是扩写,候选是原文)覆盖率按草图口径', () => {
    const vetoedLong = nearSketch(TEST_KEY, EXPANDED);
    // 原文只含扩写的一部分 shingle:覆盖率 < 1
    const c = nearCoverage(vetoedLong, cand(A));
    expect(c).not.toBeNull();
    expect(c as number).toBeLessThan(1);
    expect(c as number).toBeGreaterThan(0);
  });
  it('near = [] 只能精确匹配:覆盖率 null、任何阈值下都不命中(即使候选与被否决内容完全相同)', () => {
    expect(nearCoverage([], cand(A))).toBeNull();
    expect(nearMatches([], cand(A), 0.01)).toBe(false);
    expect(nearMatches([], new Set(), 1)).toBe(false);
  });
  it('候选 token 不足 3 个 → 空集 → 覆盖率 0,不命中', () => {
    expect(nearCoverage(near, cand('run the'))).toBe(0);
    expect(nearMatches(near, cand('run the'), 0.5)).toBe(false);
  });
  it('阈值必须是 (0, 1] 内的有限数:0 / 负数 / NaN / Infinity / >1 / 字符串 → RangeError(固定文本);0.5 与 1 通过', () => {
    for (const bad of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY, 1.0001, '0.5']) {
      expect(() => assertNearThreshold(bad)).toThrowError(
        new RangeError('near_fp threshold must be a finite number in (0, 1]'),
      );
      expect(() => nearMatches(near, cand(A), bad as number)).toThrowError(RangeError);
    }
    expect(() => assertNearThreshold(0.5)).not.toThrow();
    expect(() => assertNearThreshold(1)).not.toThrow();
  });
});

describe('near_fp:草案常量', () => {
  it('NEAR_ALGO:版本串、冻结位为 false、阈值是草案值,且对象被冻结(不能被运行时改写)', () => {
    expect(NEAR_ALGO).toEqual({ version: 'rsi-near-v1', frozen: false, threshold: 0.5 });
    expect(Object.isFrozen(NEAR_ALGO)).toBe(true);
    expect(() => {
      (NEAR_ALGO as { frozen: boolean }).frozen = true;
    }).toThrow(TypeError);
    expect(NEAR_ALGO.frozen).toBe(false);
  });
});
