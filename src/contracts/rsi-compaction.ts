/**
 * 压缩与水位线文件的 schema 与**纯解码**(§21.24 W0-26 第 7、8 条;B1a 定 schema、B1b 加读侧解码)。
 * 单独成文件的原因:读命令(`rsi report` 等)的 import 闭包必须不含存储核(`src/rsi/store/**` 与 `rsi-store.ts`,生产惰性证明),
 * 但读者要用同一份 schema 与同一个 I1 判定——不复制 schema。本文件没有 I/O、不 import 任何存储核模块。
 * `rsi-store.ts` 再导出这里的全部名字,原导入路径不变。
 */
import { z } from 'zod';
import { IsoDateSchema } from './common.js';

const NonNegInt = z.number().int().nonnegative();
/** `gen` 上限 = `Number.MAX_SAFE_INTEGER`:到顶拒写,不回绕 */
export const GenInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const RSI_COMPACTION_REFINE = Object.freeze({
  linesSum: 'lines_sum',
  byKindSum: 'by_kind_sum',
  transitionSum: 'transition_sum',
} as const);

const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);

export const RsiAuditMonthSchema = z
  .strictObject({
    lines: NonNegInt,
    /** 压缩实际删除的唯一行 */
    deleted: NonNegInt,
    /** 缺失但可由权威记录派生的唯一事件 */
    derived_missing: NonNegInt,
    by_kind: z.record(z.string().max(64), NonNegInt),
    transition_by_to: z.record(z.string().max(64), NonNegInt),
  })
  .superRefine((m, ctx) => {
    if (m.lines !== m.deleted + m.derived_missing) {
      ctx.addIssue({ code: 'custom', message: RSI_COMPACTION_REFINE.linesSum });
    }
    if (sum(m.by_kind) !== m.lines) {
      ctx.addIssue({ code: 'custom', message: RSI_COMPACTION_REFINE.byKindSum });
    }
    if (sum(m.transition_by_to) !== (m.by_kind['transition'] ?? 0)) {
      ctx.addIssue({ code: 'custom', message: RSI_COMPACTION_REFINE.transitionSum });
    }
  });
export type RsiAuditMonth = z.infer<typeof RsiAuditMonthSchema>;

export const RsiAuditCompactionSchema = z.strictObject({
  schema_version: z.literal(1),
  /** 首次创建 = 1,每次提交 +1;文件缺失 = 虚拟 `gen: 0` */
  gen: GenInt.min(1),
  /** 水位线 W(UTC 日);≤ W 的事件不再追加明细。`null` = 尚未推进 */
  through: IsoDateSchema.nullable(),
  months: z.record(z.string().regex(/^\d{4}-\d{2}$/), RsiAuditMonthSchema),
});
export type RsiAuditCompaction = z.infer<typeof RsiAuditCompactionSchema>;

export type CompactionParse =
  { ok: true; value: RsiAuditCompaction } | { ok: false; detail: string };

/**
 * 解码一份压缩文件文本:JSON → schema → I1(`through` 必须早于今日 UTC)。不合规一律 `ok: false` + 机器可读 `detail`
 * (`json` / `schema` / `*_sum` / `through_not_before_today`),**读侧与写侧(`backend.ts`)共用**,所以写出的文件下一次读取必被接受。
 */
export function parseCompactionText(text: string, today: string): CompactionParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'json' };
  }
  const p = RsiAuditCompactionSchema.safeParse(raw);
  if (!p.success) {
    const refineCode = p.error.issues.map((i) => i.message).find((m) => m.endsWith('_sum'));
    return { ok: false, detail: refineCode ?? 'schema' };
  }
  if (p.data.through !== null && p.data.through >= today) {
    return { ok: false, detail: 'through_not_before_today' };
  }
  return { ok: true, value: p.data };
}

/** 严格 UTF-8 字节版(非法序列 = `utf8`,不静默替换);其余同 {@link parseCompactionText} */
export function parseCompactionBytes(bytes: Uint8Array, today: string): CompactionParse {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, detail: 'utf8' };
  }
  return parseCompactionText(text, today);
}
