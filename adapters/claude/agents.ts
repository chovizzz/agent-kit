import { stringify as yamlStringify } from 'yaml';
import type { ToolCategory } from './tools.js';
import { claudeTools } from './tools.js';
import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { PROBE_NOT_RUN, keyOf, newReport } from './common.js';

export function renderAgents(input: RenderInput): RenderOutput {
  const files: OutFile[] = [];
  const report = newReport();
  const sorted = [...input.agents].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const agent of sorted) {
    const fm: Record<string, string> = {
      name: agent.name,
      description: agent.description,
      tools: claudeTools(agent.tools as readonly ToolCategory[]),
    };
    // 档位 → 具体模型名只来自覆盖层;core 与本渲染器内不出现任何模型名。
    const model = input.overlay?.model_tiers?.claude?.[agent.model_tier];
    const f: OutFile = {
      agent: 'claude',
      target: 'home',
      relPath: `.claude/agents/${agent.name}.md`,
      content: '',
      mode: 'owned',
      atomIds: [],
      atomBytes: {},
      sourceRefs: [`agent:${agent.name}`],
      confidence: 'documented',
    };
    if (model !== undefined) fm['model'] = model;
    else {
      report.dropped.push({
        field: 'model_tier',
        file: keyOf(f),
        reason: `覆盖层没有给 claude 的 ${agent.model_tier} 档位映射模型,model 字段已省略(省略时 Claude Code 按子代理模型顺序解析)`,
      });
    }
    f.content = `---\n${yamlStringify(fm, { lineWidth: 0 })}---\n\n${agent.prompt}\n`;
    files.push(f);
    report.shadowChecks.push(
      `${keyOf(f)}: 同名子代理按文档优先级 项目级 > 用户级 > 插件 解析(本文件是用户级,会被项目级同名文件遮蔽;P0 不检查真实目录)`,
    );
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}
