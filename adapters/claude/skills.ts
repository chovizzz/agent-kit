import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { PROBE_NOT_RUN, keyOf, newReport } from './common.js';
import { skillMarkdown } from './skill-md.js';

export { SKILL_FRONTMATTER_KEYS } from './skill-md.js';

/** Claude Code 保留名:同名技能不会加载(claude-skills.md "Reserved name")。 */
const isReservedName = (name: string): boolean => name === 'synced' || name === 'anthropic-skills';

export function renderSkills(input: RenderInput): RenderOutput {
  const files: OutFile[] = [];
  const report = newReport();
  const sorted = [...input.skills].sort((a, b) => (a.fm.name < b.fm.name ? -1 : 1));
  for (const skill of sorted) {
    const name = skill.fm.name;
    if (isReservedName(name)) {
      report.dropped.push({
        field: 'skill',
        reason: `技能名 ${name} 是 Claude Code 保留名,同名技能不会被加载,已不渲染`,
      });
      continue;
    }
    const f: OutFile = {
      agent: 'claude',
      target: 'home',
      relPath: `.claude/skills/${name}/SKILL.md`,
      content: skillMarkdown(skill),
      mode: 'owned',
      atomIds: [],
      atomBytes: {},
      sourceRefs: [`skill:${name}`],
      confidence: 'documented',
    };
    files.push(f);
    const k = keyOf(f);
    const extra = skill.files
      .map((x) => x.relPath)
      .filter((p) => p !== 'SKILL.md')
      .sort();
    if (extra.length > 0) {
      report.dropped.push({
        field: 'files',
        file: k,
        reason: `渲染输入的 Skill 只带资源文件清单(relPath/sha256)不带内容,P0 渲染器只写 SKILL.md;未渲染 ${extra.length} 个资源文件:${extra.join(', ')}`,
      });
    }
    report.shadowChecks.push(
      `${k}: 共管目录 ~/.claude/skills 里 skills-hub、插件或手写的同名技能会与本技能冲突(§4.6;P0 不检查真实目录)`,
    );
  }
  if (files.length > 0) {
    report.sideEffects.push(
      'claude: 技能写入共管目录 ~/.claude/skills/<name>/(P2 sync 时只对 owner=kit 的条目负责,不改他方条目)',
    );
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}
