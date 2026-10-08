import type { RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { PROBE_NOT_RUN, newReport } from './common.js';

/**
 * OpenCode 技能 P0 不渲染(设计 §10 L1):它同时读 ~/.claude/skills 与 ~/.agents/skills,
 * 同名重复时的行为未知(探针 P-Q6),未验证前写进 ~/.agents/skills 只会加重不确定性。
 * 返回空输出并在报告里说明,防止以后有人"顺手"开启。
 */
export function renderSkills(input: RenderInput): RenderOutput {
  const report = newReport();
  if (input.skills.length > 0) {
    report.dropped.push({
      field: 'skills',
      reason: `OpenCode 技能在探针 P-Q6 通过前不渲染(它同时读 ~/.claude/skills 与 ~/.agents/skills,同名重复时的行为未知);未渲染 ${input.skills.length} 个:${input.skills
        .map((s) => s.fm.name)
        .sort()
        .join(', ')}`,
    });
  }
  report.pendingProbes.push({
    id: 'P-Q6',
    description:
      'OpenCode 1.1.19:~/.claude/skills 与 ~/.agents/skills 同名技能的行为;通过前技能不渲染(设计 §10 L1)',
  });
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files: [], report };
}
