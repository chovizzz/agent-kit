import type { RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { PROBE_NOT_RUN, newReport } from './common.js';

/**
 * Pi 不渲染子代理(Q-N17):本体文档没有提到子代理机制;本机装的 pi-subagents 是第三方扩展,格式未核实。
 * 返回空输出并在报告里说明,防止以后有人"顺手"开启。
 */
export function renderAgents(input: RenderInput): RenderOutput {
  const report = newReport();
  if (input.agents.length > 0) {
    report.dropped.push({
      field: 'agents',
      reason: `Pi 本体文档没有提到子代理机制(源码里是否有未核实;第三方扩展 pi-subagents 的格式也未核实),不渲染子代理,留 P1;未渲染 ${input.agents.length} 个:${input.agents
        .map((a) => a.name)
        .sort()
        .join(', ')}`,
    });
  }
  report.pendingProbes.push({
    id: 'pi-subagents-format',
    description:
      'Pi 子代理:本体文档未提及此机制(源码未核实),pi-subagents 扩展的文件格式未核实(Q-N17,留 P1)',
  });
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files: [], report };
}
