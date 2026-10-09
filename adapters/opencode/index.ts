import type { Adapter } from '../../src/contracts/render.js';
import { renderAgents } from './agents.js';
import { renderRules } from './rules.js';
import { renderSkills } from './skills.js';

/**
 * OpenCode 渲染器(B08)。只产出内存 OutFile,不读也不写任何真实路径。
 * **只渲染规则**:技能(P-Q6 之前,设计 §10 L1)与子代理(留 P1,Q-N17)的调用返回空输出 + 报告说明。
 * testedVersions 为空:格式依据是无版本号的线上文档快照,本机 1.1.19 与之差异未核实,没有任何已验证版本。
 *
 * 与 codex / pi / kimi 的差异是有意的:它们的格式依据带版本号的文档(documented + compat-probe-not-run),
 * OpenCode 的文档无版本号且本机版本远落后,所以规则文件整体 assumed、tested_versions 为空。
 * 不设 conditional:conditional 表示"文件是否被识别取决于某个探针"(如 Claude 的 P-Q1),会让文件不计预算;
 * 这里的不确定性靠 assumed 表达(assumed 目标预算只告警,不阻断),而不是把文件排除出预算。
 */
export const adapter: Adapter = {
  agent: 'opencode',
  testedVersions: [],
  renderRules,
  renderSkills,
  renderAgents,
};
