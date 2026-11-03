/**
 * 严格 JSON 与格式保真闸(contracts §20.15 R20-15.15 / 15.16 / 15.17)。纯函数,不碰文件系统。
 *
 *  - 严格:UTF-8(含不许 BOM)、无注释、无尾逗号、**无重复键**、根必须是对象(根类型由调用方判断)。`JSON.parse` 自己拒绝注释 / 尾逗号 / BOM,
 *    重复键它会静默取最后一个,所以另扫一遍。
 *  - 格式保真闸:受限格式支持,不承诺多数文件能过——原文去掉**一个**末尾换行后,必须逐字等于 `JSON.stringify(JSON.parse(原文), null, 2)`。
 *    因此重新序列化只会改动 kit 自己增删的节点,其余节点的字节片段与原文件逐字相同(R20-15.17 的验收断言基于此)。写出时保留原文件「有无末尾换行」。
 */

export type StrictParse =
  | { ok: true; value: unknown; text: string }
  | { ok: false; reason: 'not_utf8' | 'syntax' | 'duplicate_key' };

/** 扫描已确认语法合法的 JSON 文本里是否有重复键(逐层记录对象的键集合) */
export function hasDuplicateKeys(text: string): boolean {
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top instanceof Set && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return true;
        top.add(key);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (c === '[') {
      stack.push(null);
      expectKey = false;
    } else if (c === '}' || c === ']') {
      stack.pop();
      expectKey = false;
    } else if (c === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
    i++;
  }
  return false;
}

export function parseStrictJson(bytes: Buffer): StrictParse {
  let text: string;
  try {
    // ignoreBOM: true → BOM 保留在字符串里,JSON.parse 随即拒绝(不静默吞掉再写回去)
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'not_utf8' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'syntax' };
  }
  if (hasDuplicateKeys(text)) return { ok: false, reason: 'duplicate_key' };
  return { ok: true, value, text };
}

/** 格式保真闸:通过时返回「原文有无末尾换行」 */
export function canonicalFormat(
  text: string,
  value: unknown,
): { ok: true; trailingNewline: boolean } | { ok: false } {
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return body === JSON.stringify(value, null, 2) ? { ok: true, trailingNewline } : { ok: false };
}

export function serializeJson(value: unknown, trailingNewline: boolean): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}${trailingNewline ? '\n' : ''}`, 'utf8');
}
