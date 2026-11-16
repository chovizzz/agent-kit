import { z } from 'zod';
import { Sha256Schema } from './common.js';

/**
 * N4-2 判官裁决信号的封闭取值(contracts R20-18.34、W0-27;`src/rsi/personal/judge-signal.ts` 的输出与 `judge_seen` 共用)。
 * 只依赖 zod / common:读侧可以 import,不引入任何 IO。
 */

/** R20-18.34 的 8 个忽略原因(封闭集合;只进审计 `reason`,不新增码) */
export const JUDGE_IGNORE_REASONS = Object.freeze([
  'no_link',
  'run_gone',
  'run_excluded',
  'unreadable',
  'invalid',
  'rule_changed',
  'not_verified',
  'not_tightening',
] as const);
export type JudgeIgnoreReason = (typeof JUDGE_IGNORE_REASONS)[number];

/** 评估结果:8 个忽略原因,或 R20-18.35 的两个转移原因(`judge_reject` / `judge_injection`) */
export const JUDGE_SIGNAL_RESULTS = Object.freeze([
  ...JUDGE_IGNORE_REASONS,
  'judge_reject',
  'judge_injection',
] as const);
export type JudgeSignalResult = (typeof JUDGE_SIGNAL_RESULTS)[number];

/**
 * `CandidateWorkingCopy.judge_seen`(W0-27,订正 R21-3.8;可选键,缺失 = 从未评估过):上一次已写入审计的评估结果,
 * 只用来决定「是否再写一行 `judge_signal`」(基线一行、变化才写)。**永不参与安全判定,也不用来跳过重读**。
 * `binding` 是完整 64 位小写十六进制(无信号 = `null`);`indeterminate` = 该次结果属「读不出」一类。
 */
export const JudgeSeenSchema = z.strictObject({
  result: z.enum(JUDGE_SIGNAL_RESULTS),
  binding: Sha256Schema.nullable(),
  indeterminate: z.boolean(),
});
export type JudgeSeen = z.infer<typeof JudgeSeenSchema>;
