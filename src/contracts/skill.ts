import { z } from 'zod';
import {
  KebabIdSchema,
  MAX_SKILL_DESCRIPTION_CHARS,
  Sha256Schema,
  codePointLength,
} from './common.js';

/** 共同子集 frontmatter(设计 §4.1):只用这些键,关键语义不靠 Claude 扩展字段。 */
export const SkillFrontmatterSchema = z.strictObject({
  /** 必须等于目录名(由 lint 比对) */
  name: KebabIdSchema,
  description: z
    .string()
    .min(1)
    .refine((s) => codePointLength(s) <= MAX_SKILL_DESCRIPTION_CHARS, {
      message: `description 超过 ${MAX_SKILL_DESCRIPTION_CHARS} 字`,
    }),
  license: z.string().min(1).optional(),
  compatibility: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const SkillFileSchema = z.strictObject({
  /** 相对技能目录的路径,正斜杠 */
  relPath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
});

export const SkillSchema = z.strictObject({
  fm: SkillFrontmatterSchema,
  /** SKILL.md 去掉 frontmatter 后的正文 */
  body: z.string(),
  /** 仓库相对路径,如 skills/<name> */
  sourceDir: z.string().min(1),
  /** 技能目录下全部文件(含 SKILL.md、scripts/ references/ assets/),按 relPath 字节序 */
  files: z.array(SkillFileSchema),
});
export type Skill = z.infer<typeof SkillSchema>;
