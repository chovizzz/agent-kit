import {
  JudgeOutputSchema,
  PredictionValuesSchema,
  validatePredictionShape,
} from '../contracts/proposal.js';
import type { JudgeOutput } from '../contracts/proposal.js';
import type { Redactor } from '../contracts/redact.js';
import { KebabIdSchema, codePointLength } from '../contracts/common.js';

/** 评审输出的硬上限(字节)。 */
export const MAX_JUDGE_OUTPUT_BYTES = 16 * 1024;
export const MAX_JUDGE_NOTES_CHARS = 200;
export const MAX_JUDGE_CONFLICTS = 20;

/** 稳定的失败码,不回显输出内容。 */
export type JudgeOutputRejection =
  | 'too_large'
  | 'not_json'
  | 'not_object'
  | 'schema'
  | 'prediction_invalid'
  | 'notes_too_long'
  | 'conflicts_invalid'
  | 'placeholder'
  | 'residual';

export type JudgeOutputResult =
  | { readonly ok: true; readonly value: JudgeOutput }
  | { readonly ok: false; readonly code: JudgeOutputRejection };

/**
 * 评审输出的强校验:整文 ≤16KiB;整文必须是**单个** JSON 对象(不剥 markdown 围栏、不从文本里抠、不修复重试);
 * 严格 schema(多字段/未知字段一律拒);notes ≤200 码点;conflicts 只能是 kebab id(≤20 项,
 * 因为它会写进提案文件,不允许任何自由文本落地);任何字符串含 `[[REDACTED` 或 pass2 不干净都拒。
 */
export function parseJudgeOutput(
  text: string,
  redactor: Pick<Redactor, 'pass2'>,
  opts: { readonly predictionRequired?: boolean } = {},
): JudgeOutputResult {
  const fail = (code: JudgeOutputRejection): JudgeOutputResult => ({ ok: false, code });
  if (Buffer.byteLength(text, 'utf8') > MAX_JUDGE_OUTPUT_BYTES) return fail('too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return fail('not_json');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('not_object');
  // prediction 单独处理:不要求时(status 由 kit 决定)LLM 给的一律丢弃,哪怕它形状非法;
  // 要求时缺失/非法 = prediction_invalid(该跳作废走下一跳,不允许「收下 verdict、prediction 缺省」,③A)
  const { prediction: rawPrediction, ...rest } = raw as Record<string, unknown>;
  const parsed = JudgeOutputSchema.safeParse(rest);
  if (!parsed.success) return fail('schema');
  let v = parsed.data;
  if (opts.predictionRequired === true) {
    if (
      typeof rawPrediction !== 'object' ||
      rawPrediction === null ||
      Array.isArray(rawPrediction)
    ) {
      return fail('prediction_invalid');
    }
    if (validatePredictionShape(rawPrediction as Record<string, unknown>).length > 0) {
      return fail('prediction_invalid');
    }
    const pv = PredictionValuesSchema.safeParse(rawPrediction);
    if (!pv.success) return fail('prediction_invalid');
    v = { ...v, prediction: pv.data };
  }
  if (codePointLength(v.notes) > MAX_JUDGE_NOTES_CHARS) return fail('notes_too_long');
  if (
    v.conflicts.length > MAX_JUDGE_CONFLICTS ||
    !v.conflicts.every((c) => KebabIdSchema.safeParse(c).success)
  ) {
    return fail('conflicts_invalid');
  }
  const strings = [text, v.notes, ...v.conflicts];
  if (strings.some((s) => s.includes('[[REDACTED'))) return fail('placeholder');
  if (strings.some((s) => !redactor.pass2(s).clean)) return fail('residual');
  return { ok: true, value: v };
}
