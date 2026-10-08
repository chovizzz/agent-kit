import { stringify as yamlStringify } from 'yaml';
import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { PROBE_NOT_RUN, keyOf, newReport } from './common.js';
import { ASSUMED_CATEGORIES, NOT_MAPPED, kimiTools } from './tools.js';
import type { ToolCategory } from './tools.js';
import { pickKimiAgentFields } from './whitelist.js';

/** Kimi 内置子代理名:目录里的同名文件不会覆盖它们(documented:agents.md "Built-in agents")。 */
const BUILTIN_NAMES = ['coder', 'explore', 'plan'] as const;

export function renderAgents(input: RenderInput): RenderOutput {
  const files: OutFile[] = [];
  const report = newReport();
  const sorted = [...input.agents].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const agent of sorted) {
    const cats = agent.tools as readonly ToolCategory[];
    // 严格字段白名单:只写 name / description / tools;不写 model(Kimi 忽略文件里的 model,
    // 模型走全局配置),也不写 whenToUse / override / disallowedTools / subagents。
    const picked = pickKimiAgentFields({
      name: agent.name,
      description: agent.description,
      tools: kimiTools(cats),
    });
    const f: OutFile = {
      agent: 'kimi',
      target: 'home',
      relPath: `.kimi-code/agents/${agent.name}.md`,
      content: `---\n${yamlStringify(picked.kept, { lineWidth: 0 })}---\n\n${agent.prompt}\n`,
      mode: 'owned',
      atomIds: [],
      atomBytes: {},
      sourceRefs: [`agent:${agent.name}`],
      confidence: cats.some((c) => ASSUMED_CATEGORIES.includes(c)) ? 'assumed' : 'documented',
    };
    files.push(f);
    const k = keyOf(f);
    report.dropped.push({
      field: 'model_tier',
      file: k,
      reason: `Kimi 忽略 agent 文件里来自其他工具的 model 字段(documented:agents.md),不能在文件里指定模型;档位 ${agent.model_tier} 未渲染(模型如何选取不在本渲染器范围;调研 A §2.4-3 提到全局 [secondary_model] 为实验项,未验证)`,
    });
    for (const c of cats) {
      const skipped = NOT_MAPPED[c];
      if (skipped) {
        report.dropped.push({
          field: 'tools',
          file: k,
          reason: `工具类别 ${c} 里的 ${skipped.names.join('、')} 未映射:${skipped.why}`,
        });
      }
    }
    report.sideEffects.push(
      `${k}: tools 显式写成白名单(Kimi 缺省 = 全部工具);工具名大小写敏感,写错的名字只产生警告不报错(documented:agents.md)`,
    );
    if (agent.prompt.includes('${')) {
      report.sideEffects.push(
        `${k}: 正文含 \${...} 形态的文本,Kimi 会把已知变量(cwd、os、base_prompt 等)按模板展开,未知变量保持原样(documented:agents.md)`,
      );
    }
    const shadow = [
      `${k}: 项目 .kimi-code/agents、.agents/agents 里的同名文件优先于用户级(documented:Project > Extra > User);$KIMI_CODE_HOME/SYSTEM.md 在用户级内部优先于 agents/ 目录里同名文件(documented);P0 不检查真实目录`,
    ];
    if ((BUILTIN_NAMES as readonly string[]).includes(agent.name)) {
      shadow.push(
        `${k}: 名字 ${agent.name} 与 Kimi 内置子代理同名,目录里的文件不覆盖内置(除非 frontmatter 声明 override: true,而本渲染器不写 override)——本文件会被内置遮蔽(documented)`,
      );
    }
    report.shadowChecks.push(...shadow);
  }
  if (files.length > 0) {
    report.pendingProbes.push({
      id: 'P-Q5',
      description:
        'Kimi:~/.kimi-code/agents/ 是否被加载;tools 里 Edit / Write / WebSearch / FetchURL 的工具名需对照工具参考页',
    });
  }
  if (files.length > 0) {
    report.pendingProbes.push({
      id: 'kimi-tool-names',
      description:
        'Kimi 工具名 Edit / Write(更新日志)与 WebSearch / FetchURL(环境变量文档)只被二手提到,工具参考页(reference/tools.md)未抓取,所以也不知道 Kimi 工具全集是否更大(如独立的目录列举工具,read 类映射可能不全);含 edit / web 类别的子代理文件标 assumed',
    });
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}
