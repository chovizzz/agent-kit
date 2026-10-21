import { z } from 'zod';

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

/**
 * 计数表的 zod 模式。不用 `z.record`:zod 4 的 record 解析会**静默丢弃** `__proto__` 键(计数凭空消失,且不报错)。
 * 这里手写键 / 值校验(报错路径仍是 `[键]`),输出为无原型对象,`__proto__` 作为普通键保留。
 */
export function countRecordSchema(keySchema: z.ZodType<string> = z.string()) {
  return z
    .custom<Record<string, number>>(
      (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
      { message: '应为对象' },
    )
    .superRefine((rec, ctx) => {
      for (const [k, v] of Object.entries(rec)) {
        if (!keySchema.safeParse(k).success) {
          ctx.addIssue({ code: 'custom', path: [k], message: '计数键不合法' });
        }
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          ctx.addIssue({ code: 'custom', path: [k], message: '计数应为非负整数' });
        }
      }
    })
    .transform((rec) => toCountRecord(rec));
}
