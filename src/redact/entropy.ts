const COUNTS = new Uint32Array(128);

/** [start, end) 内字符的 Shannon 熵(比特/字符)。只用于 ASCII 候选串;非 ASCII 字符按 127 归并。 */
export function shannon(s: string, start = 0, end = s.length): number {
  const n = end - start;
  if (n <= 0) return 0;
  COUNTS.fill(0);
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    COUNTS[c < 128 ? c : 127] = (COUNTS[c < 128 ? c : 127] as number) + 1;
  }
  let h = 0;
  for (let k = 0; k < 128; k++) {
    const c = COUNTS[k] as number;
    if (c === 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}
