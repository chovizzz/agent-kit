/**
 * 确定性文本:CRLF/CR → LF,去掉末尾全部换行后补恰好一个换行。
 * 不改 Unicode 归一化、不裁行尾空白(Markdown 里两个行尾空格是硬换行)。
 * 空串保持为空串。
 */
export function canonicalText(s: string): string {
  const lf = s.replace(/\r\n?/g, '\n');
  const trimmed = lf.replace(/\n+$/, '');
  return trimmed === '' ? '' : `${trimmed}\n`;
}
