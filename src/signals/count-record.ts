/**
 * 计数表(键 → 次数)的原型安全实现。
 * 键来自 trace 原文(未知事件类型名),可能恰好叫 `constructor` / `__proto__` / `toString`:
 * 在普通 `{}` 上 `rec[k] = (rec[k] ?? 0) + 1` 会读到原型链上的函数(得到字符串拼接)或在 `__proto__` 上静默丢计数。
 * 一律用无原型对象;JSON 序列化与键序不变,所以输出与哈希口径不受影响。
 */
export type CountRecord = Record<string, number>;

export function newCountRecord(): CountRecord {
  return Object.create(null) as CountRecord;
}

/** 把任意计数对象拷成无原型对象(`__proto__` 作为普通键保留)。 */
export function toCountRecord(src: Readonly<Record<string, number>>): CountRecord {
  const out = newCountRecord();
  for (const [k, v] of Object.entries(src)) out[k] = v;
  return out;
}

export function addCount(rec: CountRecord, key: string, n = 1): void {
  rec[key] = (rec[key] ?? 0) + n;
}
