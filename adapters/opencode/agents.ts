import type { RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { PROBE_NOT_RUN, newReport } from './common.js';

/**
 * OpenCode 子代理 P0 不渲染(Q-N17 / M-3,留 P1):设计 §10 P0 只要求 OpenCode 渲染规则,
 * 且 `~/.config/opencode/agents/` 是否被本机版本识别正是探针 P-Q6 的问题。
 * 返回空输出并在报告里说明,防止以后有人"顺手"开启。
 */
export function renderAgents(input: RenderInput): RenderOutput {
  const report = newReport();
  if (input.agents.length > 0) {
    report.dropped.push({
      field: 'agents',
      reason: `OpenCode 子代理 P0 不渲染(留 P1,Q-N17):agents/ 目录是否被本机版本识别属探针 P-Q6;未渲染 ${input.agents.length} 个:${input.agents
        .map((a) => a.name)
        .sort()
        .join(', ')}`,
    });
  }
  report.pendingProbes.push({
    id: 'P-Q6',
    description: 'OpenCode 1.1.19:agents/ 目录是否被识别;通过前子代理不渲染(Q-N17,留 P1)',
  });
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files: [], report };
}
