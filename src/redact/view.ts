/**
 * 扫描视图:原文经"归一化"后的文本,外加 视图下标 -> 原文区间 的映射。
 *
 * 为什么要视图:规则在归一化文本上匹配(零宽字符已去掉、全角/花体字母已折叠、同形字母已还原),
 * 但替换必须落在原文上。所以每个视图字符都记着它来自原文的 [start, end)。
 * 视图可以叠加(去占位符、压缩空白),叠加后映射仍直接指向最初的原文。
 *
 * 纯 ASCII 文本(绝大多数输入)走恒等映射,不分配数组。
 */

export interface View {
  readonly text: string;
  /** 视图下标 -> 原文起点;null 表示恒等映射 */
  readonly starts: Int32Array | null;
  /** 视图下标 -> 原文终点(不含);null 表示恒等映射 */
  readonly ends: Int32Array | null;
}

export function identityView(text: string): View {
  return { text, starts: null, ends: null };
}

/** 视图区间 [s, e)(e > s)映射回原文区间。 */
export function mapSpan(v: View, s: number, e: number): [number, number] {
  if (v.starts === null || v.ends === null) return [s, e];
  const a = v.starts[s];
  const b = v.ends[e - 1];
  if (a === undefined || b === undefined) throw new RangeError('view map out of range');
  return [a, b];
}

/** 删除 ranges(视图坐标,升序、互不重叠)后得到新视图,映射与父视图复合。 */
export function deriveRemoving(v: View, ranges: ReadonlyArray<readonly [number, number]>): View {
  if (ranges.length === 0) return v;
  let removed = 0;
  for (const [s, e] of ranges) removed += e - s;
  const keep = v.text.length - removed;
  const starts = new Int32Array(keep);
  const ends = new Int32Array(keep);
  const parts: string[] = [];
  let out = 0;
  let pos = 0;
  const copy = (from: number, to: number): void => {
    if (to <= from) return;
    parts.push(v.text.slice(from, to));
    for (let i = from; i < to; i++) {
      starts[out] = v.starts ? (v.starts[i] as number) : i;
      ends[out] = v.ends ? (v.ends[i] as number) : i + 1;
      out++;
    }
  };
  for (const [s, e] of ranges) {
    copy(pos, s);
    pos = e;
  }
  copy(pos, v.text.length);
  return { text: parts.join(''), starts, ends };
}

/** 删除所有匹配 re(必须带 g 标志)的片段。 */
export function removeMatches(v: View, re: RegExp): View {
  const ranges: Array<[number, number]> = [];
  re.lastIndex = 0;
  for (let m = re.exec(v.text); m !== null; m = re.exec(v.text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return deriveRemoving(v, ranges);
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * 需要逐簇处理的字符:不可见、变音符、拉丁扩展、tag 字符、变体选择符;
 * 同形字(CONFUSABLES 表里的西里尔/希腊字母)在表定义之后补进来。
 */
const NEEDS_WORK_BASE =
  '\\u00ad\\u00c0-\\u024f\\u0300-\\u036f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u1e00-\\u1eff\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\u{e0000}-\\u{e0fff}';

const MARK = /\p{M}/u;
const MARKS_G = /[\u0300-\u036f]/g;

/** BMP 组合符号位图(惰性构建,一次约几毫秒);比对每个字符跑 \p{M} 正则快一个数量级。 */
let MARK_MAP: Uint8Array | null = null;
function isMarkCode(c: number): boolean {
  if (c < 0x300) return false;
  if (c > 0xffff) return MARK.test(String.fromCodePoint(c));
  if (MARK_MAP === null) {
    const m = new Uint8Array(0x10000);
    for (let k = 0x300; k < 0x10000; k++) if (MARK.test(String.fromCharCode(k))) m[k] = 1;
    MARK_MAP = m;
  }
  return MARK_MAP[c] === 1;
}

/** 可能有兼容分解(NFKC 会改变)的区段;其余 BMP 字符(西里尔、希腊、CJK 统一表意文字、谚文……)NFKC 稳定,不必逐个 normalize。 */
function maybeNfkcUnstable(cp: number): boolean {
  return (
    (cp >= 0xa0 && cp <= 0x24f) ||
    (cp >= 0x1e00 && cp <= 0x1eff) ||
    (cp >= 0x2000 && cp <= 0x2bff) ||
    (cp >= 0x2e80 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x33ff) ||
    (cp >= 0xf900 && cp <= 0xfdff) ||
    (cp >= 0xfe10 && cp <= 0xffef) ||
    cp > 0xffff
  );
}

function isInvisible(cp: number): boolean {
  return (
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x061c ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/** 常见西里尔/希腊/拉丁变体字母 -> ASCII。NFKC 管不到的同形字靠这张表。 */
const CONFUSABLES: ReadonlyMap<number, string> = new Map<number, string>([
  // Cyrillic lower
  [0x0430, 'a'],
  [0x0435, 'e'],
  [0x043e, 'o'],
  [0x0440, 'p'],
  [0x0441, 'c'],
  [0x0443, 'y'],
  [0x0445, 'x'],
  [0x0456, 'i'],
  [0x0458, 'j'],
  [0x0455, 's'],
  [0x0501, 'd'],
  [0x04bb, 'h'],
  [0x051b, 'q'],
  [0x051d, 'w'],
  [0x043a, 'k'],
  [0x0475, 'v'],
  [0x04cf, 'l'],
  // Cyrillic upper
  [0x0410, 'A'],
  [0x0412, 'B'],
  [0x0415, 'E'],
  [0x041a, 'K'],
  [0x041c, 'M'],
  [0x041d, 'H'],
  [0x041e, 'O'],
  [0x0420, 'P'],
  [0x0421, 'C'],
  [0x0422, 'T'],
  [0x0423, 'Y'],
  [0x0425, 'X'],
  [0x0406, 'I'],
  [0x0408, 'J'],
  [0x0405, 'S'],
  [0x04c0, 'I'],
  // Greek
  [0x03bf, 'o'],
  [0x03bd, 'v'],
  [0x03c1, 'p'],
  [0x03b9, 'i'],
  [0x03b1, 'a'],
  [0x03c5, 'u'],
  [0x03ba, 'k'],
  [0x03c7, 'x'],
  [0x0391, 'A'],
  [0x0392, 'B'],
  [0x0395, 'E'],
  [0x0396, 'Z'],
  [0x0397, 'H'],
  [0x0399, 'I'],
  [0x039a, 'K'],
  [0x039c, 'M'],
  [0x039d, 'N'],
  [0x039f, 'O'],
  [0x03a1, 'P'],
  [0x03a4, 'T'],
  [0x03a5, 'Y'],
  [0x03a7, 'X'],
  // Latin variants
  [0x0131, 'i'],
  [0x0251, 'a'],
  [0x0261, 'g'],
]);

const NEEDS_WORK = new RegExp(
  `[${NEEDS_WORK_BASE}${[...CONFUSABLES.keys()].map((k) => `\\u${k.toString(16).padStart(4, '0')}`).join('')}]`,
  'u',
);

function foldConfusables(s: string): string {
  let out = '';
  for (const ch of s) {
    const rep = CONFUSABLES.get(ch.codePointAt(0) as number);
    out += rep ?? ch;
  }
  return out;
}

/**
 * 构建归一化视图。
 * 去掉不可见字符;Unicode tag 字符(U+E0020..E007E)还原成它隐藏的 ASCII;
 * NFKC(全角/花体/圈字母 -> ASCII);拉丁变音符剥掉;同形字折叠。
 */
export function buildView(text: string): View {
  if (ASCII_ONLY.test(text)) return identityView(text);
  if (!NEEDS_WORK.test(text) && text.normalize('NFKC') === text) return identityView(text);

  const outChars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const emitChar = (ch: string, from: number, to: number): void => {
    outChars.push(ch);
    starts.push(from);
    ends.push(to);
  };

  const len = text.length;
  let i = 0;
  while (i < len) {
    const cp = text.codePointAt(i) as number;
    const w = cp > 0xffff ? 2 : 1;
    let j = i + w;
    if (isInvisible(cp)) {
      i = j;
      continue;
    }
    if (cp >= 0xe0020 && cp <= 0xe007e) {
      emitChar(String.fromCharCode(cp - 0xe0000), i, j);
      i = j;
      continue;
    }
    if (cp >= 0xe0000 && cp <= 0xe0fff) {
      i = j;
      continue;
    }
    const nextMark =
      j < len && text.charCodeAt(j) >= 0x300 && isMarkCode(text.codePointAt(j) as number);
    if (cp < 0x80 && !nextMark) {
      emitChar(String.fromCharCode(cp), i, j);
      i = j;
      continue;
    }
    // 单字符、无组合符号、NFKC 稳定:查一下同形字表就走
    if (!nextMark && !maybeNfkcUnstable(cp)) {
      const rep = CONFUSABLES.get(cp);
      if (rep !== undefined) emitChar(rep, i, j);
      else if (w === 1) emitChar(String.fromCharCode(cp), i, j);
      else {
        outChars.push(text[i] as string, text[i + 1] as string);
        starts.push(i, i);
        ends.push(j, j);
      }
      i = j;
      continue;
    }
    // 吸收后续的组合符号/不可见字符,作为同一个簇
    const unitParts: string[] = [String.fromCodePoint(cp)];
    while (j < len) {
      const c2 = text.codePointAt(j) as number;
      const w2 = c2 > 0xffff ? 2 : 1;
      if (isInvisible(c2)) {
        j += w2;
      } else if (isMarkCode(c2)) {
        unitParts.push(String.fromCodePoint(c2));
        j += w2;
      } else break;
    }
    const unit = unitParts.join('');
    const latin = cp < 0x250 || (cp >= 0x1e00 && cp <= 0x1eff);
    const norm = foldConfusables(
      latin ? unit.normalize('NFKD').replace(MARKS_G, '') : unit.normalize('NFKC'),
    );
    for (let k = 0; k < norm.length; k++) emitChar(norm[k] as string, i, j);
    i = j;
  }
  return { text: outChars.join(''), starts: Int32Array.from(starts), ends: Int32Array.from(ends) };
}

/** 保持长度的小写(toLowerCase 在个别字符上会改变长度,那种字符原样保留)。 */
export function safeLower(text: string): string {
  const l = text.toLowerCase();
  if (l.length === text.length) return l;
  let out = '';
  for (const ch of text) {
    const c = ch.toLowerCase();
    out += c.length === ch.length ? c : ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 压缩视图:抓"分行"与"字符串拼接"
// ---------------------------------------------------------------------------

function isJoinChar(c: number): boolean {
  // " ' ` + \ ,
  return c === 34 || c === 39 || c === 96 || c === 43 || c === 92 || c === 44;
}
function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0;
}

/**
 * 要从压缩视图里删掉的分隔串:由空白与 " ' ` + \ , 组成的极大连续段,且段里含引号/加号/反斜杠/逗号或换行。
 * 只含空格/制表符的段不删(否则普通单词会被粘在一起)。线性扫描,不用正则(避免空白长串上的二次回溯)。
 */
export function compactRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (!(isWs(c) || isJoinChar(c))) {
      i++;
      continue;
    }
    let j = i;
    let hasJoin = false;
    let lineStart = false;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 10 || d === 13) {
        hasJoin = true;
        lineStart = true;
      } else if (isJoinChar(d)) {
        hasJoin = true;
        lineStart = false;
      } else if (isWs(d)) {
        // 保持 lineStart
      } else if (lineStart && isCommentLead(text, j)) {
        // 换行后的行首注释/引用标记(`> ` `# ` `* ` `// `)也算分隔,抓"每行前面带引用符的折行"
        hasJoin = true;
        if (d === 47) j++;
      } else break;
      j++;
    }
    if (hasJoin) ranges.push([i, j]);
    i = j;
  }
  return ranges;
}

function isCommentLead(text: string, j: number): boolean {
  const d = text.charCodeAt(j);
  return d === 62 || d === 35 || d === 42 || (d === 47 && text.charCodeAt(j + 1) === 47);
}

/** 把落在 spans(原文坐标)内的视图字符替换成不可匹配的占位字符,长度与映射保持不变。 */
export function maskView(v: View, spans: ReadonlyArray<{ start: number; end: number }>): View {
  if (spans.length === 0) return v;
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<[number, number]> = [];
  for (const sp of sorted) {
    const last = merged[merged.length - 1];
    if (last && sp.start <= last[1]) {
      if (sp.end > last[1]) last[1] = sp.end;
    } else merged.push([sp.start, sp.end]);
  }
  const chars = v.text.split('');
  let mi = 0;
  for (let i = 0; i < chars.length; i++) {
    const pos = v.starts ? (v.starts[i] as number) : i;
    while (mi < merged.length && (merged[mi] as [number, number])[1] <= pos) mi++;
    const m = merged[mi];
    if (m && m[0] <= pos) chars[i] = '\u0001';
  }
  return { text: chars.join(''), starts: v.starts, ends: v.ends };
}
