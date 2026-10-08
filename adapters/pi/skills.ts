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
    // Pi docs/skills.md 明列 name / description / license / compatibility / metadata,
    // 并支持 ~/.agents/skills/ 与 .agents/skills/ → 路径与字段都是 documented。
    const f: OutFile = {
      agent: 'pi',
      target: 'home',
      relPath: `.agents/skills/${name}/SKILL.md`,
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
    report.sideEffects.push(
      `${k}: 技能写入共享目录 ~/.agents/skills/<name>/(设计 §4.1:Codex、Kimi、OpenCode、OpenClaw 也读该目录),装进去后这些 agent 都会看到;不写 ~/.pi/agent/skills`,
    );
    report.shadowChecks.push(
      `${k}: Pi 对同名技能保留先发现者并警告,后发现的被丢弃(documented:Pi docs/skills.md);~/.pi/agent/skills、项目 .pi/skills、项目 .agents/skills 里的同名技能可能先于本文件被发现(发现顺序文档未给出,assumed);启动参数 -ns / --no-skills 会关闭技能发现(documented:Pi docs/cli.md;P0 不检查);共管目录里他方同名条目会冲突(§4.6;P0 不检查真实目录)`,
    );
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}
