import { z } from 'zod';
import { RenderAgentIdSchema } from './common.js';
import { DiagnosticSchema } from './diagnostics.js';
import { EnforceSchema, LimitSourceSchema } from './config.js';

/** 单个目标(agent)的预算结果。 */
export const BudgetTargetReportSchema = z.strictObject({
  agent: RenderAgentIdSchema,
  /** 本目标全部计入文件的字节之和(UTF-8,含标记行;同一原子正文跨文件只计一次) */
  bytes: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  max_bytes: z.number().int().positive().optional(),
  max_lines: z.number().int().positive().optional(),
  hard_limit: z.union([z.number().int().positive(), z.literal('unknown')]).optional(),
  limit_source: LimitSourceSchema,
  /** ok:低于阈值;near:达到阈值(默认 90%)未超;over:超过 max */
  level: z.enum(['ok', 'near', 'over']),
  /** 是否会让 check 退出 1 = over && enforce=block && limit_source≠assumed */
  blocking: z.boolean(),
  /** 参与求和的输出文件 relPath(排除 conditional 文件) */
  files: z.array(z.string()),
  /** 被去重的原子 id(同一原子落在多个文件里) */
  deduped_atom_ids: z.array(z.string()),
});
export type BudgetTargetReport = z.infer<typeof BudgetTargetReportSchema>;

export const BudgetReportSchema = z.strictObject({
  enforce: EnforceSchema,
  targets: z.array(BudgetTargetReportSchema),
  diagnostics: z.array(DiagnosticSchema),
});
export type BudgetReport = z.infer<typeof BudgetReportSchema>;

import type { OutFile } from './render.js';
import type { BudgetConfig } from './config.js';

/**
 * Codex 项目链模型:根→cwd 各层 AGENTS.md 的**文本内容**(字节数由 B05 按 UTF-8 计;P0 由 fixture 提供,不读真实仓库)。
 * 实际函数由 B05 实现;签名在 B01 定死。
 */
export interface BudgetInputs {
  outputs: readonly OutFile[];
  config: BudgetConfig;
  projectChain?: readonly string[];
}
export type ComputeBudget = (input: BudgetInputs) => BudgetReport;
