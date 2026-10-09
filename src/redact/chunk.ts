export interface Chunk {
  /** 该块在原文里的起始偏移 */
  start: number;
  text: string;
}

/**
 * 把超长文本切成不超过 max 字符的块,供 `--check` 分块复扫。
 * 在换行处切;相邻块重叠 overlap 个字符(对齐到行首),使跨行的 PEM、分行拼接的秘密不会恰好被切断。
 */
export function chunkForCheck(text: string, max: number, overlap: number): Chunk[] {
  if (text.length <= max) return [{ start: 0, text }];
  const out: Chunk[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1);
      if (nl > start + max / 2) end = nl + 1;
    }
    out.push({ start, text: text.slice(start, end) });
    if (end >= text.length) return out;
    let next = Math.max(end - overlap, start + 1);
    const nl = text.indexOf('\n', next);
    if (nl !== -1 && nl + 1 < end) next = nl + 1;
    start = next;
  }
}
