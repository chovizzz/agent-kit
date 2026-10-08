import { z } from 'zod';
import {
  AgentIdSchema,
  IsoDateSchema,
  KebabIdSchema,
  MAX_EVIDENCE_EXCERPT_CHARS,
  MAX_TITLE_CHARS,
  Sha256Schema,
  codePointLength,
} from './common.js';

export const LayerSchema = z.enum(['org', 'team', 'personal', 'project']);
export type Layer = z.infer<typeof LayerSchema>;
/** 权威顺序 org > team > personal > project(设计 §3.5);数字越小越权威。 */
export const LAYER_RANK: Readonly<Record<Layer, number>> = {
  org: 0,
  team: 1,
  personal: 2,
  project: 3,
};

export const StatusSchema = z.enum(['proposed', 'advisory', 'active', 'deprecated', 'retired']);
export type Status = z.infer<typeof StatusSchema>;

export const StrengthSchema = z.enum(['must', 'should']);
export const KindSchema = z.enum(['practice', 'fact', 'preference']);
export const VolatilitySchema = z.enum(['stable', 'volatile']);

export const EvidenceSchema = z.strictObject({
  /** 证据类型,开放字符串(memory / trace / pr / incident …) */
  type: z.string().min(1),
  ref: z.string().min(1),
  /** ≤300 字(码点);是否过脱敏扫描由 lint 判(依赖 Redactor) */
  excerpt: z.string().refine((s) => codePointLength(s) <= MAX_EVIDENCE_EXCERPT_CHARS, {
    message: `excerpt 超过 ${MAX_EVIDENCE_EXCERPT_CHARS} 字`,
  }),
});

export const VerifierSchema = z
  .strictObject({
    type: z.enum(['none', 'replay', 'hook', 'script']),
    ref: z.string().min(1).optional(),
  })
  .refine((v) => v.type === 'none' || v.ref !== undefined, {
    message: 'verifier.type 不是 none 时必须有 ref(ref 指向的文件是否存在由 lint 判)',
    path: ['ref'],
  });

export const SignatureSchema = z
  .strictObject({
    type: z.enum(['tool', 'path', 'phrase', 'always']),
    pattern: z.string().min(1).optional(),
  })
  .refine((s) => s.type === 'always' || s.pattern !== undefined, {
    message: 'signature.type 不是 always 时必须有 pattern',
    path: ['pattern'],
  });

/** applies_to:`[all]` 或 agent 列表;缺省由解析器视为 [all]。 */
export const AppliesToSchema = z.array(z.union([z.literal('all'), AgentIdSchema])).min(1);

/** 原子 frontmatter。字段名与 YAML 一致(snake_case)。 */
export const AtomFrontmatterSchema = z
  .strictObject({
    id: KebabIdSchema,
    title: z
      .string()
      .min(1)
      .refine((s) => codePointLength(s) <= MAX_TITLE_CHARS, {
        message: `title 超过 ${MAX_TITLE_CHARS} 字`,
      }),
    layer: LayerSchema,
    strength: StrengthSchema,
    applies_to: AppliesToSchema.optional(),
    paths: z.array(z.string().min(1)).min(1).optional(),
    kind: KindSchema,
    volatility: VolatilitySchema,
    status: StatusSchema,
    owner: z.string().min(1),
    created: IsoDateSchema,
    review_by: IsoDateSchema,
    evidence: z.array(EvidenceSchema).min(1),
    verifier: VerifierSchema,
    signature: SignatureSchema.optional(),
    escalation_level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    overrides: z.array(KebabIdSchema).optional(),
    disables: z.array(KebabIdSchema).optional(),
    /** 谱系:提案编号等自由串,不是原子 id */
    origin: z.string().min(1).optional(),
    supersedes: z.array(KebabIdSchema).optional(),
    merged_from: z.array(KebabIdSchema).optional(),
  })
  .superRefine((fm, ctx) => {
    if (fm.strength === 'must' && fm.verifier.type === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['verifier', 'type'],
        message: 'strength=must 的原子必须有 verifier.type≠none',
      });
    }
    if (fm.status === 'active' && fm.signature === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['signature'],
        message: 'status=active 的原子必须有 signature(用于计曝光与复发)',
      });
    }
  });
export type AtomFrontmatter = z.infer<typeof AtomFrontmatterSchema>;

/**
 * 正文三段:`**做**:` `**为什么**:` `**怎么验**:`。
 * 设计 §3.4 表里「做」字段叫 how,本契约取字段名 `do`(plan-P0 §2.2 B01)。
 */
export const AtomBodySchema = z.strictObject({
  do: z.string().min(1),
  why: z.string().min(1),
  verify: z.string().min(1),
});
export type AtomBody = z.infer<typeof AtomBodySchema>;

/**
 * 解析后的原子。bodyBytes = 渲染进目标文件的正文(三段原文,UTF-8)的字节数;
 * sha256 = 规范化后整个源文件内容的 sha256;sourcePath = 仓库相对路径(无绝对路径、无用户名)。
 */
export const AtomSchema = z.strictObject({
  fm: AtomFrontmatterSchema,
  body: AtomBodySchema,
  bodyBytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  sourcePath: z.string().min(1),
});
export type Atom = z.infer<typeof AtomSchema>;
