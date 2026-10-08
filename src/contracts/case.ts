import { z } from 'zod';
import { AgentIdSchema, KebabIdSchema } from './common.js';

/** `cases/<rule-id>/case.yaml`(设计 §6.5 回放)。 */
export const CaseSchema = z.strictObject({
  /** 等于目录名 */
  id: KebabIdSchema,
  /** fixture:模板目录或 git bundle,路径相对 case 目录 */
  fixture: z.strictObject({ type: z.enum(['dir', 'git-bundle']), path: z.string().min(1) }),
  /** 任务 prompt */
  prompt: z.string().min(1),
  /** 目标 agent */
  agent: AgentIdSchema,
  /** 机械判定脚本;agent 运行时看不到,结束后由 harness 复制进来执行 */
  check: z.string().min(1),
  /** holdout 不给反思器看 */
  split: z.enum(['train', 'holdout']),
});
export type Case = z.infer<typeof CaseSchema>;
