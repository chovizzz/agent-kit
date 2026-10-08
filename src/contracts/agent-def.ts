import { z } from 'zod';
import { KebabIdSchema } from './common.js';

/** 中立工具类别(设计 §4.3)。 */
export const ToolCategorySchema = z.enum(['read', 'edit', 'shell', 'web', 'agent']);
/** 模型档位;档位到具体模型名的映射只在覆盖层,core 内不得出现任何具体模型名。 */
export const ModelTierSchema = z.enum(['judge', 'implement', 'readonly']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** `agents/<name>.yaml` */
export const NeutralAgentSchema = z.strictObject({
  name: KebabIdSchema,
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(ToolCategorySchema).min(1),
  model_tier: ModelTierSchema,
});
export type NeutralAgent = z.infer<typeof NeutralAgentSchema>;
