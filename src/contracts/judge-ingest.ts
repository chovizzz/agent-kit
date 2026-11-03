import { z } from 'zod';
import { RunIdSchema, Sha256Schema } from './common.js';

/**
 * `judge --ingest` / `--confirm-reflector`(N4,docs/contracts.md §20.18)的稳定码与 payload 形状。
 * 码前缀是 `JUDGE_`,不属 rsi 命令族,**不并入 R20-3.0 总表**(R20-18.23);本文件与 §20.18-5 的表逐行对拍
 * (`test/contracts/n4-judge-ingest-codes.test.ts`,沿用 `rsi-codes-table` 的做法)。
 */

/** `JUDGE_INGEST_REJECTED reason=<子码>` 的封闭集合(R20-18.23) */
export const JUDGE_INGEST_REASONS = [
  'schema_invalid',
  'input_too_large',
  'not_json_object',
  'run_mismatch',
  'proposal_unknown',
  'proposal_unsupported',
  'rule_hash_mismatch',
  'already_judged',
  'declared_invalid',
  'declared_vendor_conflict',
  'same_vendor',
  'output_too_large',
  'placeholder_in_output',
  'output_residual',
  'hidden_chars_in_output',
  'injection_suspected_local',
  'conflicts_invalid',
  'notes_too_long',
  'prediction_invalid',
] as const;
export type JudgeIngestReason = (typeof JUDGE_INGEST_REASONS)[number];

/** `JUDGE_USAGE reason=<码>`(退出 2)。`missing:--run` 带冒号,故用字符串字面量集合 */
export const JUDGE_USAGE_REASONS = [
  'not_tty',
  'stdin_is_tty',
  'mode_conflict',
  'missing:--run',
  'unknown_arg',
  'write_required',
  'bad_run',
] as const;
export type JudgeUsageReason = (typeof JUDGE_USAGE_REASONS)[number];

/** `JUDGE_FAIL_CLOSED reason=<码>`(退出 3;ingest 模式的词表以本表为准) */
export const JUDGE_FAIL_CLOSED_REASONS = [
  'freeze_unavailable',
  'lock_lost',
  'write_denied',
  'state_invalid',
  'output_leak',
  'internal',
  'stdin_unreadable',
] as const;
export type JudgeFailClosedReason = (typeof JUDGE_FAIL_CLOSED_REASONS)[number];

/** 其余稳定码(退出码在 R20-18.22 的表里) */
export const JUDGE_INGEST_CODES = {
  rejected: 'JUDGE_INGEST_REJECTED',
  declined: 'JUDGE_CONFIRM_DECLINED',
  stale: 'JUDGE_CONFIRM_STALE',
  usage: 'JUDGE_USAGE',
  failClosed: 'JUDGE_FAIL_CLOSED',
  notRun: 'JUDGE_NOT_RUN',
} as const;

/**
 * `parseJudgeOutput` 的拒绝码 → 子码的显式映射(R20-18.23)。单测钉死:`JudgeOutputRejection` 的全部取值都在表里、
 * 映射值都属于 {@link JUDGE_INGEST_REASONS};运行时未登记的值兜底为 `schema_invalid`(见 {@link outputRejectionReason})。
 */
export const OUTPUT_REJECTION_TO_REASON = Object.freeze({
  too_large: 'output_too_large',
  not_json: 'not_json_object',
  not_object: 'not_json_object',
  schema: 'schema_invalid',
  prediction_invalid: 'prediction_invalid',
  notes_too_long: 'notes_too_long',
  conflicts_invalid: 'conflicts_invalid',
  placeholder: 'placeholder_in_output',
  residual: 'output_residual',
} as const satisfies Record<string, JudgeIngestReason>);

export function outputRejectionReason(code: string): JudgeIngestReason {
  return Object.hasOwn(OUTPUT_REJECTION_TO_REASON, code)
    ? (OUTPUT_REJECTION_TO_REASON as Record<string, JudgeIngestReason>)[code]!
    : 'schema_invalid';
}

/** payload 的上限(R20-18.9) */
export const MAX_INGEST_INPUT_BYTES = 64 * 1024;
export const MAX_INGEST_VERDICTS = 5;

/**
 * stdin 里的信封(R20-18.9)。`output` 在这里只收「是对象」——全形 `JudgeOutput` 的强校验走 `parseJudgeOutput`
 * (≤16 KiB、整文单个 JSON、严格 schema、pass2、话术),以便各拒绝原因映射到各自子码。
 */
export const JudgeIngestPayloadSchema = z.strictObject({
  schema: z.literal('judge-ingest-v1'),
  run_id: RunIdSchema,
  declared: z.strictObject({
    agent: z.enum(['claude', 'codex', 'pi']),
    vendor: z.string(),
    model: z.string(),
  }),
  verdicts: z
    .array(
      z.strictObject({
        id: z.string().regex(/^\d{4}-\d{2}-\d{2}-\d{3}$/),
        rule_sha256: Sha256Schema,
        output: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(MAX_INGEST_VERDICTS),
});
export type JudgeIngestPayload = z.infer<typeof JudgeIngestPayloadSchema>;

/** `--json` 结果(键集合固定,R20-18.22) */
export const JUDGE_INGEST_RESULTS = [
  'dry',
  'written',
  'partial',
  'declined',
  'rejected',
  'not_run',
] as const;
export type JudgeIngestResult = (typeof JUDGE_INGEST_RESULTS)[number];
