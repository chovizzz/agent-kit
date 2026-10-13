/**
 * C1b:不可见/格式字符的补全集(设计稿 §2 C1b,`docs/p1-backlog.md:50-52` 的缺口)。
 *
 * 只给 lifecycle 检查用,不改 `src/reflect/text.ts` 的 `hasInvisible`,也不改契约。
 * 判定**只看下面的显式区段表**,不再套 `\p{Cf}` 之类的类别兜底:每个区段都能被单独删掉做变异验证
 * (类别兜底会让「删掉 tag 区段」这种变异悄悄存活)。类别兜底仍由 C1 里的 `hasInvisible` 负责,两者互补。
 * 允许的空白控制字符只有 TAB(0x09)、LF(0x0A)、CR(0x0D)。
 */

export interface InvisibleRange {
  /** 稳定名,出现在报告里;不含被扫描文本 */
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

export const INVISIBLE_RANGES: readonly InvisibleRange[] = Object.freeze([
  { name: 'c0-controls-a', from: 0x0000, to: 0x0008 },
  { name: 'c0-controls-b', from: 0x000b, to: 0x000c },
  { name: 'c0-controls-c', from: 0x000e, to: 0x001f },
  { name: 'del-c1-controls', from: 0x007f, to: 0x009f },
  { name: 'soft-hyphen', from: 0x00ad, to: 0x00ad },
  { name: 'combining-grapheme-joiner', from: 0x034f, to: 0x034f },
  { name: 'arabic-letter-mark', from: 0x061c, to: 0x061c },
  { name: 'hangul-choseong-filler', from: 0x115f, to: 0x1160 },
  { name: 'khmer-inherent-vowels', from: 0x17b4, to: 0x17b5 },
  { name: 'mongolian-selectors', from: 0x180b, to: 0x180f },
  { name: 'zero-width-and-marks', from: 0x200b, to: 0x200f },
  { name: 'bidi-embeddings', from: 0x202a, to: 0x202e },
  { name: 'invisible-operators-and-bidi-isolates', from: 0x2060, to: 0x206f },
  { name: 'braille-blank', from: 0x2800, to: 0x2800 },
  { name: 'hangul-filler', from: 0x3164, to: 0x3164 },
  { name: 'variation-selectors', from: 0xfe00, to: 0xfe0f },
  { name: 'bom-zwnbsp', from: 0xfeff, to: 0xfeff },
  { name: 'halfwidth-hangul-filler', from: 0xffa0, to: 0xffa0 },
  { name: 'interlinear-annotation', from: 0xfff9, to: 0xfffb },
  { name: 'musical-formatting', from: 0x1d173, to: 0x1d17a },
  { name: 'tag-characters', from: 0xe0000, to: 0xe007f },
  { name: 'variation-selectors-supplement', from: 0xe0100, to: 0xe01ef },
]);

/** 命中的区段名(去重、按表序);空数组 = 没有不可见字符。 */
export function findInvisibleRanges(
  s: string,
  ranges: readonly InvisibleRange[] = INVISIBLE_RANGES,
): string[] {
  const hit = new Set<string>();
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    for (const r of ranges) {
      if (cp >= r.from && cp <= r.to) hit.add(r.name);
    }
  }
  return ranges.map((r) => r.name).filter((n) => hit.has(n));
}

export function hasInvisibleExtended(s: string): boolean {
  return findInvisibleRanges(s).length > 0;
}
