import { stringify as yamlStringify } from 'yaml';
import type { Skill } from '../../src/contracts/skill.js';

/**
 * 共同子集 frontmatter(设计 §4.1)的键,固定顺序。技能渲染只许写这五个键,
 * 不写任何 Claude 扩展字段(paths、allowed-tools、model、context ……),关键语义不靠扩展字段承载。
 */
export const SKILL_FRONTMATTER_KEYS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
] as const;

export function skillMarkdown(skill: Skill): string {
  const fm: Record<string, unknown> = { name: skill.fm.name, description: skill.fm.description };
  if (skill.fm.license !== undefined) fm['license'] = skill.fm.license;
  if (skill.fm.compatibility !== undefined) fm['compatibility'] = skill.fm.compatibility;
  if (skill.fm.metadata !== undefined) {
    fm['metadata'] = Object.fromEntries(
      Object.entries(skill.fm.metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  const yaml = yamlStringify(fm, { lineWidth: 0 });
  const body = skill.body.replace(/^\n+/, '');
  return `---\n${yaml}---\n\n${body}`;
}
