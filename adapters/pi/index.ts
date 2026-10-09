import type { Adapter } from '../../src/contracts/render.js';
import { DOCS_VERSION } from './common.js';
import { renderAgents } from './agents.js';
import { renderRules } from './rules.js';
import { renderSkills } from './skills.js';

/**
 * Pi 渲染器(B08)。只产出内存 OutFile,不读也不写任何真实路径(P0 里 ~/.pi/agent/AGENTS.md 按"不存在"渲染)。
 * testedVersions 里的版本是"格式所依据的随包官方文档对应的版本",不是探针验证过的版本(探针在 P1)。
 * 子代理:不渲染(renderAgents 返回空输出 + 报告说明,Q-N17)。
 */
export const adapter: Adapter = {
  agent: 'pi',
  testedVersions: [DOCS_VERSION],
  renderRules,
  renderSkills,
  renderAgents,
};
