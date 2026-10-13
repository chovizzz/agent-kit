import { describe, expect, it } from 'vitest';
import { hasInvisible } from '../../src/reflect/text.js';
import {
  INVISIBLE_RANGES,
  findInvisibleRanges,
  hasInvisibleExtended,
} from '../../src/lifecycle/invisible.js';

const cp = (n: number): string => String.fromCodePoint(n);

describe('lifecycle/invisible C1b 补全集', () => {
  // 设计稿 C1b 列出的缺口:每一段至少取区段首、尾两个码点,逐个命中并报对区段名
  const CASES: readonly [name: string, cps: number[]][] = [
    ['tag-characters', [0xe0000, 0xe0041, 0xe007f]],
    ['arabic-letter-mark', [0x061c]],
    ['variation-selectors', [0xfe00, 0xfe0f]],
    ['variation-selectors-supplement', [0xe0100, 0xe01ef]],
    ['hangul-filler', [0x3164]],
    ['hangul-choseong-filler', [0x115f, 0x1160]],
    ['halfwidth-hangul-filler', [0xffa0]],
    ['zero-width-and-marks', [0x200b, 0x200d, 0x200f]],
    ['bidi-embeddings', [0x202a, 0x202e]],
    ['invisible-operators-and-bidi-isolates', [0x2060, 0x2066, 0x206f]],
    ['bom-zwnbsp', [0xfeff]],
    ['braille-blank', [0x2800]],
  ];
  for (const [name, cps] of CASES) {
    it(`${name} 被命中`, () => {
      for (const c of cps) {
        const s = `正常文本${cp(c)}后缀`;
        expect(findInvisibleRanges(s), `U+${c.toString(16)}`).toEqual([name]);
        expect(hasInvisibleExtended(s)).toBe(true);
      }
    });
  }

  it('正向对照:普通文本、TAB/LF/CR、CJK、emoji 都不命中', () => {
    for (const s of ['plain ascii', '中文 和 English', 'a\tb\nc\r\nd', '😀 🚀', '全角，标点。']) {
      expect(hasInvisibleExtended(s), s).toBe(false);
      expect(findInvisibleRanges(s)).toEqual([]);
    }
  });

  it('C1 的 hasInvisible 漏掉的补充变体选择符,这里能抓到(两者互补)', () => {
    const s = `abc${cp(0xe0100)}def`;
    expect(hasInvisible(s)).toBe(false);
    expect(hasInvisibleExtended(s)).toBe(true);
  });

  it('区段表自身:无重叠、from<=to、名称唯一', () => {
    const names = new Set(INVISIBLE_RANGES.map((r) => r.name));
    expect(names.size).toBe(INVISIBLE_RANGES.length);
    const sorted = [...INVISIBLE_RANGES].sort((a, b) => a.from - b.from);
    sorted.forEach((r, i) => {
      expect(r.from).toBeLessThanOrEqual(r.to);
      if (i > 0) expect(r.from).toBeGreaterThan(sorted[i - 1]!.to);
    });
  });

  it('多个区段同时命中时按表序返回、去重', () => {
    const s = `${cp(0xe0041)}${cp(0x200b)}${cp(0xe0041)}`;
    expect(findInvisibleRanges(s)).toEqual(['zero-width-and-marks', 'tag-characters']);
  });
});
