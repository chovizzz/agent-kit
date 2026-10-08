import type { Adapter } from '../../src/contracts/render.js';
import { DOCS_VERSION } from './common.js';
import { renderAgents } from './agents.js';
import { renderRules } from './rules.js';
import { renderSkills } from './skills.js';

/**
 * Claude Code 渲染器(B07)。只产出内存 OutFile,不读也不写任何真实路径。
 * testedVersions 里的版本是"格式所依据的官方文档对应的版本",不是探针验证过的版本(探针在 P1)。
 */
export const adapter: Adapter = {
  agent: 'claude',
  testedVersions: [DOCS_VERSION],
  renderRules,
  renderSkills,
  renderAgents,
};
