import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { PROBE_NOT_RUN, keyOf, newReport } from './common.js';
import { skillMarkdown } from './skill-md.js';

export { SKILL_FRONTMATTER_KEYS } from './skill-md.js';

/** Kimi 会在技能正文里展开的占位符(documented:customization/skills.md "Body Placeholders")。 */
const KIMI_PLACEHOLDER = /\$ARGUMENTS|\$\{KIMI_SKILL_DIR\}|\$\d|\$[A-Za-z_]/;

export function renderSkills(input: RenderInput): RenderOutput {
  const files: OutFile[] = [];
  const report = newReport();
  const sorted = [...input.skills].sort((a, b) => (a.fm.name < b.fm.name ? -1 : 1));
  for (const skill of sorted) {
    const name = skill.fm.name;
    // 技能写到 ~/.agents/skills(documented:skills.md 用户级目录),不写 ~/.kimi-code/skills(避免重复,见设计 §4.2)。
    // Kimi 文档的 frontmatter 表只列 name/description/type/whenToUse/disableModelInvocation/arguments,
    // license / compatibility / metadata 是否被识别文档没说 → 带这些键的技能文件标 assumed。
    const optional =
      skill.fm.license !== undefined ||
      skill.fm.compatibility !== undefined ||
      skill.fm.metadata !== undefined;
    const f: OutFile = {
      agent: 'kimi',
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
    report.sideEffects.push(
      `${k}: 技能写入共享目录 ~/.agents/skills/<name>/(设计 §4.1:Codex、Pi、OpenCode、OpenClaw 也读该目录),装进去后这些 agent 都会看到;不写 ~/.kimi-code/skills`,
    );
    if (KIMI_PLACEHOLDER.test(skill.body)) {
      report.sideEffects.push(
        `${k}: 技能正文含 $ARGUMENTS / $0 / $<name> / \${KIMI_SKILL_DIR} 形态的文本,Kimi 会在送给模型前展开这些占位符(documented:skills.md),与原文可能不同;具名参数($<name>)依赖 frontmatter 的 arguments,本渲染器不渲染 arguments(共同子集只有 5 个键),这类占位符不会被展开`,
      );
    }
    report.shadowChecks.push(
      `${k}: 项目 .kimi-code/skills、.agents/skills 里的同名技能优先于用户级(documented:Project > User > Extra > Built-in);用户级 ~/.kimi-code/skills 与 ~/.agents/skills 同名时谁优先文档未说明(assumed,探针 P-Q5;本机两处有大量同名);共管目录里他方同名条目会冲突(§4.6;P0 不检查真实目录)`,
    );
  }
  if (files.some((f) => f.confidence === 'assumed')) {
    report.pendingProbes.push({
      id: 'kimi-skill-optional-fields',
      description:
        'Kimi 对技能 frontmatter 的 license / compatibility / metadata 的处理文档未说明(frontmatter 表只列 name/description/type/whenToUse/disableModelInvocation/arguments),带这些键的技能文件标 assumed',
    });
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}
