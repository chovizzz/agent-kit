import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { PROBE_NOT_RUN, keyOf, newReport } from './common.js';
import { codexAgentToml } from './toml.js';
import type { CodexAgentFields } from './toml.js';

const UNREPRESENTABLE = ['read', 'shell', 'web', 'agent'] as const;

export function renderAgents(input: RenderInput): RenderOutput {
  const files: OutFile[] = [];
  const report = newReport();
  const sorted = [...input.agents].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const agent of sorted) {
    const fields: CodexAgentFields = { name: agent.name, description: agent.description };
    const f: OutFile = {
      agent: 'codex',
      target: 'home',
      relPath: `.codex/agents/${agent.name}.toml`,
      content: '',
      mode: 'owned',
      atomIds: [],
      atomBytes: {},
      sourceRefs: [`agent:${agent.name}`],
      confidence: 'documented',
    };
    const k = keyOf(f);
    // 档位 → 具体模型名只来自覆盖层。
    const model = input.overlay?.model_tiers?.codex?.[agent.model_tier];
    if (model !== undefined) fields.model = model;
    else {
      report.dropped.push({
        field: 'model_tier',
        file: k,
        reason: `覆盖层没有给 codex 的 ${agent.model_tier} 档位映射模型,model 字段已省略(文档:按 显式 spawn 值 → [agents] 默认 → 父会话 的顺序解析)`,
      });
    }
    // 中立定义没有 reasoning effort,不渲染 model_reasoning_effort(继承父会话)。
    // Codex 没有工具白名单;能表达的只有沙箱:没有 edit 类别 ⇒ read-only(本渲染器的映射策略)。
    const cats = agent.tools as readonly string[];
    if (!cats.includes('edit')) {
      fields.sandbox_mode = 'read-only';
      report.sideEffects.push(
        `${k}: 工具类别不含 edit,已映射为 sandbox_mode="read-only"(映射策略为本渲染器设定);Codex 会按父会话的运行时沙箱覆盖(文档),文件里的值可能被盖掉`,
      );
    }
    const lost = UNREPRESENTABLE.filter((c) => cats.includes(c));
    if (lost.length > 0) {
      report.dropped.push({
        field: 'tools',
        file: k,
        reason: `Codex 自定义代理文件没有工具白名单字段(文档:必填 name/description/developer_instructions,其余为 config.toml 键);工具类别 ${lost.join('、')} 无法逐项表达,已丢弃`,
      });
    }
    fields.developer_instructions = agent.prompt;
    f.content = codexAgentToml(fields);
    files.push(f);
    report.shadowChecks.push(
      `${k}: 代理名与内置 default / worker / explorer 同名时,自定义代理覆盖内置(documented);项目级 .codex/agents 同名文件的优先级本渲染器未核实(P0 不检查真实目录)`,
    );
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}
