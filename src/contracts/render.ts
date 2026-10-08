import { z } from 'zod';
import { LayerSchema } from './atom.js';
import { ResolvedAtomSchema } from './merge.js';
import { RenderAgentIdSchema, Sha256Schema } from './common.js';
import { ChannelNameSchema, OverlaySchema } from './config.js';
import { SkillSchema } from './skill.js';
import { NeutralAgentSchema } from './agent-def.js';
import type { ResolvedAtom } from './merge.js';
import type { Skill } from './skill.js';
import type { NeutralAgent } from './agent-def.js';
import type { Overlay, ChannelName } from './config.js';
import type { RenderAgentId } from './common.js';

export const ConfidenceSchema = z.enum(['documented', 'probed', 'assumed']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/**
 * `out/<agent>/<target>/<relPath>` 的 relPath:正斜杠、相对、不含 `..`、不含绝对路径或用户名。
 * `home` 只是路径记号:将来 P2 才映射到真实 `~`,P0 任何代码不得把它展开成真实 HOME。
 */
export const OutRelPathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.split('/').some((s) => s === '..' || s === '.' || s === ''),
    { message: 'relPath 必须是正斜杠相对路径,且不含 .. 或空段' },
  );

const OutFileBaseSchema = z.strictObject({
  agent: RenderAgentIdSchema,
  target: z.enum(['home', 'project']),
  relPath: OutRelPathSchema,
  /** 规范化文本:LF,末尾恰一个换行 */
  content: z.string(),
  /** owned:整文件独占,首行写生成头;managed-block:只写托管块 */
  mode: z.enum(['owned', 'managed-block']),
  /** 渲染进本文件的规则原子 id(技能/子代理文件为空数组) */
  atomIds: z.array(z.string()),
  /**
   * 每个原子的正文在本文件中占的 UTF-8 字节数(键集合必须等于 atomIds)。
   * 预算「按原子 id 去重」(设计 §3.6)靠它:同一原子出现在多个文件时,只计一份。
   * 这是 B01 接口走查补的字段:仅有 content 的话,预算无法知道某原子占多少字节。
   */
  atomBytes: z.record(z.string(), z.number().int().nonnegative()),
  /** 非规则来源,如 `skill:foo` / `agent:bar` */
  sourceRefs: z.array(z.string()).optional(),
  confidence: ConfidenceSchema,
  /** 待探针验证的条件(如 "P-Q1");有值的文件不计预算、不得作为事实 */
  conditional: z.string().optional(),
});
export const OutFileSchema = OutFileBaseSchema.refine(
  (f) => {
    const ids = new Set(f.atomIds);
    const keys = Object.keys(f.atomBytes);
    return (
      ids.size === f.atomIds.length && keys.length === ids.size && keys.every((k) => ids.has(k))
    );
  },
  { message: 'atomBytes 的键集合必须等于 atomIds(且 atomIds 无重复)', path: ['atomBytes'] },
);
export type OutFile = z.infer<typeof OutFileSchema>;

export const RenderReportSchema = z.strictObject({
  /** 目标不支持而被丢弃的字段 */
  dropped: z.array(
    z.strictObject({ field: z.string(), reason: z.string(), file: z.string().optional() }),
  ),
  /** 副作用说明,如「新建后 Pi 第一次读到全局规则,属行为变化」 */
  sideEffects: z.array(z.string()),
  /** 遮蔽文件列表(设计 §4.6);P0 只列出不检查真实文件 */
  shadowChecks: z.array(z.string()),
  /** 待探针验证项(如 P-Q1 / P-Q6),不作为事实 */
  pendingProbes: z.array(z.strictObject({ id: z.string(), description: z.string() })),
  /** 被跳过的层,如 personal(P2 才渲染) */
  skippedLayers: z.array(z.strictObject({ layer: LayerSchema, reason: z.string() })),
});
export type RenderReport = z.infer<typeof RenderReportSchema>;

export const RenderOutputSchema = z.strictObject({
  files: z.array(OutFileSchema),
  report: RenderReportSchema,
});
export type RenderOutput = z.infer<typeof RenderOutputSchema>;

export interface RenderInput {
  /** 只含合并后的原子;渲染器必须过滤 coreEligible=false */
  resolved: readonly ResolvedAtom[];
  skills: readonly Skill[];
  agents: readonly NeutralAgent[];
  overlay?: Overlay;
  kitVersion: string;
  channel: ChannelName;
}

export interface Adapter {
  agent: RenderAgentId;
  /** 渲染器针对哪些 agent 版本验证过;版本不符先跑探针 */
  testedVersions: readonly string[];
  renderRules(input: RenderInput): RenderOutput;
  renderSkills?(input: RenderInput): RenderOutput;
  renderAgents?(input: RenderInput): RenderOutput;
}

/** `adapters/<agent>/managed-targets.json`:声明该 adapter 在 P2 会写的全部落点,供 A5 清单并集。 */
export const AdapterMetaSchema = z.strictObject({
  agent: RenderAgentIdSchema,
  tested_versions: z.array(z.string().min(1)),
  /** 以 `~` 开头的真实落点路径,语义同 ops/managed-paths.txt 的行 */
  managed_targets: z.array(z.string().min(1)),
});
export type AdapterMeta = z.infer<typeof AdapterMetaSchema>;

/** `out/manifest.json`:A15 逐文件核对 personal 原子不入 core 输出的依据。 */
export const ManifestEntrySchema = z.strictObject({
  path: z.string().min(1),
  agent: RenderAgentIdSchema,
  target: z.enum(['home', 'project']),
  mode: z.enum(['owned', 'managed-block']),
  confidence: ConfidenceSchema,
  conditional: z.string().optional(),
  sha256: Sha256Schema,
  atoms: z.array(z.strictObject({ id: z.string(), layer: LayerSchema })),
  sourceRefs: z.array(z.string()),
});
export const ManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  kit_version: z.string(),
  channel: ChannelNameSchema,
  /** 按 path 字节序 */
  files: z.array(ManifestEntrySchema),
  skippedLayers: z.array(z.strictObject({ layer: LayerSchema, reason: z.string() })),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// 供输入形状校验(测试/CLI 边界用);Adapter 接口里的 RenderInput 保持 TS 接口。
export const RenderInputSchema = z.strictObject({
  resolved: z.array(ResolvedAtomSchema),
  skills: z.array(SkillSchema),
  agents: z.array(NeutralAgentSchema),
  overlay: OverlaySchema.optional(),
  kitVersion: z.string(),
  channel: ChannelNameSchema,
});
