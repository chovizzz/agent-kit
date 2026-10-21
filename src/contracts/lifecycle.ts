import { z } from 'zod';
import {
  IsoDateSchema,
  KebabIdSchema,
  RunIdSchema,
  Sha256Schema,
  codePointLength,
} from './common.js';
import { StatusSchema } from './atom.js';

/**
 * L0 追加(⑦A):`lifecycle/<rule-id>/*.json`,退役审计记录,只增不改;同时是 id 墓碑
 * (原子文件被 G4 删掉后,记录仍在)。只含枚举、计数、哈希与短备注,不含规则正文。
 */

export const RETIRE_REASONS = [
  'manual',
  'expired',
  'superseded',
  'no_exposure',
  'harmful',
  'rejected',
] as const;
export const RetireReasonSchema = z.enum(RETIRE_REASONS);
export type RetireReason = z.infer<typeof RetireReasonSchema>;

/** `kit:retire` 允许的转移(含 ③A 新增的 proposed→retired);与 guards 白名单的对齐由 L2 负责。 */
export const RETIRE_TRANSITIONS = [
  ['advisory', 'deprecated'],
  ['active', 'deprecated'],
  ['deprecated', 'retired'],
  ['proposed', 'retired'],
] as const;

export const MAX_LIFECYCLE_NOTE_CHARS = 200;

/**
 * 契约层的不可见字符判定:控制字符 Cc(含 TAB/LF/CR)、格式字符 Cf(含 bidi、U+061C、tag 段)、私用区 Co、未分配 Cn,
 * 外加不属这些类的两族:变体选择符(U+FE00–FE0E、U+E0100–E01EF,类 Mn)与 Hangul 填充(U+115F/1160/3164/FFA0,类 Lo)。
 * U+FE0F(emoji 呈现选择符)刻意不在内:note 是已落盘的历史记录字段,新拦会让含 ⚠️ 等的旧记录解析失败(待定夺)。
 */
const HIDDEN_CHARS_RE =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u115f\u1160\u3164\ufe00-\ufe0e\uffa0\u{e0100}-\u{e01ef}]/u;

export const LifecycleRecordSchema = z
  .strictObject({
    schema_version: z.literal(1),
    rule_id: KebabIdSchema,
    kind: z.literal('retire'),
    reason: RetireReasonSchema,
    from_status: StatusSchema,
    to_status: StatusSchema,
    /** `superseded` 时必填:接替它的原子 id;其它理由不得带 */
    by: KebabIdSchema.optional(),
    /** 退役时规则文本的哈希(`status` / `review_by` 归一化后) */
    rule_sha256: Sha256Schema,
    /** 作为理由证据的 attest 文件哈希(`sha256:<hex>`);无证据的理由为空数组 */
    attest_digests: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
    kit_version: z.string().min(1),
    run_id: RunIdSchema,
    recorded_at: IsoDateSchema,
    /** 负责人 handle(含 @) */
    owner: z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9_-]*$/),
    note: z
      .string()
      .min(1)
      .refine((s) => codePointLength(s) <= MAX_LIFECYCLE_NOTE_CHARS, {
        message: `note 超过 ${MAX_LIFECYCLE_NOTE_CHARS} 字`,
      })
      .refine((s) => !HIDDEN_CHARS_RE.test(s), { message: 'note 含不可见/控制字符' })
      .optional(),
  })
  .superRefine((r, ctx) => {
    const ok = RETIRE_TRANSITIONS.some(([f, t]) => f === r.from_status && t === r.to_status);
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['to_status'],
        message: `转移 ${r.from_status}→${r.to_status} 不在 kit:retire 允许的方向内`,
      });
    }
    const fromProposed = r.from_status === 'proposed';
    if (r.reason === 'rejected' && !fromProposed) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason=rejected 只用于 proposed→retired',
      });
    }
    if (r.reason !== 'rejected' && fromProposed) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'proposed→retired 的理由只能是 rejected',
      });
    }
    if ((r.reason === 'no_exposure' || r.reason === 'harmful') && r.to_status === 'retired') {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `reason=${r.reason} 只用于退到 deprecated(deprecated→retired 不适用)`,
      });
    }
    if (r.reason === 'superseded' && r.by === undefined) {
      ctx.addIssue({ code: 'custom', path: ['by'], message: 'reason=superseded 必须有 by' });
    }
    if (r.reason !== 'superseded' && r.by !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['by'], message: '只有 reason=superseded 可以带 by' });
    }
    if (r.by !== undefined && r.by === r.rule_id) {
      ctx.addIssue({ code: 'custom', path: ['by'], message: 'by 不得等于 rule_id' });
    }
  });
export type LifecycleRecord = z.infer<typeof LifecycleRecordSchema>;

/** 文件名:`<recorded_at>-<run_id>.json`。 */
export function lifecycleFileName(r: Pick<LifecycleRecord, 'recorded_at' | 'run_id'>): string {
  return `${r.recorded_at}-${r.run_id}.json`;
}
