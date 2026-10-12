/**
 * 命令行数字参数的共享解析。
 */

/**
 * 只接受十进制非负整数字面量(`/^[0-9]+$/`):拒绝 `0x10`、`1e3`、`+5`、`-1`、带空白、空串;
 * 超出安全整数范围(会被 Number 悄悄变成不精确值或 Infinity)也拒绝。非法返回 undefined。
 */
export function parseDecimalUint(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}
