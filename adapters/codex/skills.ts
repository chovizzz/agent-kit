import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { PROBE_NOT_RUN, keyOf, newReport } from './common.js';
import { skillMarkdown } from './skill-md.js';

export { SKILL_FRONTMATTER_KEYS } from './skill-md.js';

export function renderSkills(input: RenderInput): RenderOutput {
  const files: OutFile[] = [];
  const report = newReport();
  const sorted = [...input.skills].sort((a, b) => (a.fm.name < b.fm.name ? -1 : 1));
  for (const skill of sorted) {
    const name = skill.fm.name;
    // 技能写到 .agents/skills(文档只记载该路径),绝不写 .codex/skills(文档未记载该路径)。
    // license/compatibility/metadata 出自 agentskills.io 标准;Codex 文档只明文要求 name+description,
    // 带这三个键之一的技能文件按 assumed 标注。
    const optional =
      skill.fm.license !== undefined ||
      skill.fm.compatibility !== undefined ||
      skill.fm.metadata !== undefined;
    const f: OutFile = {
      agent: 'codex',
      target: 'home',
      relPath: `.agents/skills/${name}/SKILL.md`,
      content: skillMarkdown(skill),
      mode: 'owned',
      atomIds: [],
      atomBytes: {},
      sourceRefs: [`skill:${name}`],
      confidence: optional ? 'assumed' : 'documented',
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
      `${k}: 同名技能不合并,~/.agents/skills 与仓库 .agents/skills 的同名技能会同时出现(documented);共管目录里他方同名条目会冲突(§4.6;P0 不检查真实目录)`,
    );
  }
  if (files.length > 0) {
    report.sideEffects.push(
      'codex: 技能写入共享目录 ~/.agents/skills/<name>/(设计 §4.1:其它 agent 也读该目录),不写 ~/.codex/skills',
    );
  }
  if (files.some((f) => f.confidence === 'assumed')) {
    report.pendingProbes.push({
      id: 'codex-skill-optional-fields',
      description:
        'Codex 对技能 frontmatter 的 license / compatibility / metadata 的处理文档未明说(只要求 name+description),带这些键的技能文件标 assumed',
    });
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}
