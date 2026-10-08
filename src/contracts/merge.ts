import { z } from 'zod';
import { AtomSchema, LayerSchema } from './atom.js';
import { DiagnosticSchema } from './diagnostics.js';

/**
 * 合并后的原子。coreEligible=false 表示「不得进入 core 输出」(P0 决策 a:personal 层)。
 * 渲染器必须只消费 coreEligible=true 的原子;personal 原子仍出现在合并结果里(A15 的正向控制)。
 */
export const ResolvedAtomSchema = z.strictObject({
  atom: AtomSchema,
  layer: LayerSchema,
  coreEligible: z.boolean(),
  /** 本原子通过 overrides 替换掉的下层/同层原子 id */
  replaced: z.array(z.string()),
});
export type ResolvedAtom = z.infer<typeof ResolvedAtomSchema>;

export const OverrideRecordSchema = z.strictObject({
  id: z.string(),
  by: z.string(),
  kind: z.enum(['overrides', 'disables']),
  byLayer: LayerSchema,
});
export type OverrideRecord = z.infer<typeof OverrideRecordSchema>;

export const MergeResultSchema = z.strictObject({
  atoms: z.array(ResolvedAtomSchema),
  /** 渲染报告要列出的每一条被覆盖/关闭项 */
  overridden: z.array(OverrideRecordSchema),
  diagnostics: z.array(DiagnosticSchema),
});
export type MergeResult = z.infer<typeof MergeResultSchema>;
