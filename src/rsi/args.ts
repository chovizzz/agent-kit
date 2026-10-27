/**
 * rsi 子命令的严格参数解析(R20-3.0 通用约定):未知参数、重复的单值参数、`--x=y` 写法一律 `RSI_USAGE reason=unknown_arg`(退出 2)。
 * 位置参数一律视为未知参数。纯函数。
 */
export type ParsedFlags = ReadonlySet<string>;

export type ParseResult = { ok: true; flags: ParsedFlags } | { ok: false };

export function parseFlags(argv: readonly string[], allowed: readonly string[]): ParseResult {
  const seen = new Set<string>();
  for (const a of argv) {
    if (!allowed.includes(a) || seen.has(a)) return { ok: false };
    seen.add(a);
  }
  return { ok: true, flags: seen };
}
