import type { Adapter } from '../../src/contracts/render.js';
import { renderAgents } from './agents.js';
import { renderRules } from './rules.js';
import { renderSkills } from './skills.js';

/**
 * Kimi Code 渲染器(B08)。只产出内存 OutFile,不读也不写任何真实路径(P0 里 ~/.kimi-code/AGENTS.md 按空文件渲染)。
 * testedVersions 里的版本是"格式所依据的文档快照对应的版本",不是探针验证过的版本(探针在 P1)。
 * 子代理 md 不含 model 字段(Kimi 忽略它)。
 */
export const adapter: Adapter = {
  agent: 'kimi',
  // 空:文档快照 2.1.1 与调研时本机 2.0.0 不是同一版本,任何版本都没跑过探针。口径:只有"文档版本 = 本机安装版本"才列入(Pi / Claude / Codex 满足,Kimi / OpenCode 不满足)。
  testedVersions: [],
  renderRules,
  renderSkills,
  renderAgents,
};
