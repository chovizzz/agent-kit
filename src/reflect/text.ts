/**
 * reflect 的文本小工具(纯函数,确定性)。
 * - 实体转义:证据摘录进提示前把 `& < >` 转成实体,所以摘录里写不出 `</evidence>`。
 * - 归一化:NFKC + 小写 + 去零宽/bidi/控制字符 + 折叠空白,用于话术匹配、回显检测、相似度。
 */
import { createHash } from 'node:crypto';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** `& < >` → 实体。顺序固定(先 &)。 */
export function escapeEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 把 JSON 文本里的 `< > &` 换成 \uXXXX 转义:仍是合法 JSON,但提示里不会出现裸的标签字符。 */
export function escapeJsonForPrompt(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028))
    .join('\\u2028')
    .split(String.fromCharCode(0x2029))
    .join('\\u2029');
}

const INVISIBLE_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{e0000}-\u{e007f}]/gu;

/** 含不可见/格式字符(零宽、bidi、tag 字符、变体选择符、Hangul 填充…)。归一化会把它们抹掉,所以必须在归一前单独拒收。 */
export function hasInvisible(s: string): boolean {
  return new RegExp(INVISIBLE_RE.source, 'u').test(s) || /[\p{Cf}\p{Co}\p{Cn}]/u.test(s);
}

/** 用于「匹配」的归一形:NFKC、小写、去不可见字符、空白折叠。不用于展示。 */
export function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').replace(INVISIBLE_RE, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 在 normalizeForMatch 之上再去掉所有空白、连字符与下划线:抵抗 `no - verify`、`no_verify` 这类拆写。 */
export function squeeze(s: string): string {
  return normalizeForMatch(s).replace(/[\s_\-.]+/g, '');
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'or',
  'in',
  'on',
  'for',
  'is',
  'it',
  'be',
  'as',
  'at',
  'by',
  'if',
  'do',
  'not',
  'with',
  'that',
  'this',
  'you',
  'your',
  'are',
  'was',
  'when',
  'then',
  'from',
  'use',
]);

const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const WORD_RE = /[a-z0-9_]{2,}/g;

/**
 * 相似度用的 token 集合:ASCII 词(去停用词) ∪ CJK 连续段的字二元组(单字段取单字)。
 * 入参先归一化,所以全角/半角、大小写、零宽字符插入都不改变结果。
 */
export function tokenSet(text: string): Set<string> {
  // CJK 字符之间的空白/标点不应切断二元组(字间插空格是常见的去重绕过)
  const norm = normalizeForMatch(text).replace(
    /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\s\p{P}]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu,
    '',
  );
  const out = new Set<string>();
  for (const m of norm.matchAll(WORD_RE)) {
    if (!STOPWORDS.has(m[0])) out.add(m[0]);
  }
  for (const m of norm.matchAll(CJK_RUN_RE)) {
    const chars = Array.from(m[0]);
    if (chars.length === 1) out.add(chars[0] as string);
    else for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

export function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of small) if (big.has(x)) n++;
  return n;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const inter = intersectionSize(a, b);
  return inter / (a.size + b.size - inter);
}

/** 重叠系数:交集 / 较小集合。较小集合几乎被较大集合包含时接近 1(抵抗 padding)。 */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const min = Math.min(a.size, b.size);
  return min === 0 ? 0 : intersectionSize(a, b) / min;
}

/**
 * `needle` 的任意连续 `n` 个码点是否出现在 `haystack` 里(两侧都按 normalizeForMatch 归一)。
 * needle 不足 n 个码点时不可能构成「≥n 码点的连续原文」,返回 false。
 */
export function sharesRun(needle: string, haystack: string, n: number): boolean {
  const a = Array.from(normalizeForMatch(needle));
  if (a.length < n) return false;
  const h = normalizeForMatch(haystack);
  for (let i = 0; i + n <= a.length; i++) {
    if (h.includes(a.slice(i, i + n).join(''))) return true;
  }
  return false;
}
