/**
 * 确定性 JSON:键按码元序排序、2 空格缩进、LF、末尾恰一个换行。
 * 拒绝会让输出不确定或静默丢数据的值:undefined、函数、symbol、bigint、NaN/Infinity、
 * 非纯对象(Date/Map/Set/类实例)、环。
 */
export class CanonicalJsonError extends Error {
  readonly code = 'IO_CANONICAL_JSON';
}

function normalize(value: unknown, seen: Set<object>, where: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`非有限数字:${where}`);
      return value;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`不可序列化的值(${typeof value}):${where}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError(`循环引用:${where}`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((v, i) => normalize(v, seen, `${where}[${i}]`));
    }
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(`非纯对象:${where}`);
    }
    // 无原型对象:键叫 `__proto__` 时普通 `{}` 的赋值会改原型而不是写键(计数凭空消失)
    const out = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(obj).sort()) {
      out[k] = normalize((obj as Record<string, unknown>)[k], seen, `${where}.${k}`);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(normalize(value, new Set(), '$'), null, 2)}\n`;
}
