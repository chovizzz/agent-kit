/**
 * 中立工具类别 → Kimi Code 工具名。Kimi 的 `tools` 是**大小写敏感**的白名单,缺省 = 允许全部工具
 * (customization/agents.md),所以渲染器必须显式写,否则只读子代理会变成全权限。
 * 文档原话(customization/agents.md Frontmatter Fields 表,`tools` 行):"Tool allowlist (`Read`, `Bash`); MCP tools match as globs
 * (`mcp__github__*`). YAML list or comma-separated string; omit or use a lone `*` to allow all tools, `tools: []` disables all tools"。
 * 中立工具类别是封闭枚举(read/edit/shell/web/agent),下面的映射覆盖全部类别,不存在"映射表之外的类别"。
 *
 * 出处与置信度(拿不准的不当事实):
 * - read  → Read, Grep, Glob   documented(agents.md 示例 tools 列表)
 * - shell → Bash               documented(agents.md、customization/mcp.md)
 * - agent → Agent              documented(agents.md "The `Agent` tool");同文档点名的 AgentSwarm 不映射(见 NOT_MAPPED)
 * - edit  → Edit, Write        assumed:只在 release-notes 里提到 "Edit and Write",工具参考页(reference/tools.md)没抓取
 * - web   → WebSearch, FetchURL assumed:只在 env-vars 文档里提到(`KIMI_WEB_SEARCH_*` → `WebSearch`,`KIMI_WEB_FETCH_*` → `FetchURL`);
 *             Kimi 的抓取工具叫 FetchURL,不是 Claude 的 WebFetch
 */
export type ToolCategory = 'read' | 'edit' | 'shell' | 'web' | 'agent';

const ORDER: readonly ToolCategory[] = ['read', 'edit', 'shell', 'web', 'agent'];

const MAP: Readonly<Record<ToolCategory, readonly string[]>> = {
  read: ['Read', 'Grep', 'Glob'],
  edit: ['Edit', 'Write'],
  shell: ['Bash'],
  web: ['WebSearch', 'FetchURL'],
  agent: ['Agent'],
};

/**
 * 类别对应的 Kimi 工具里有意不映射的部分(报告用,写进 dropped)。
 * AgentSwarm 的名字是 documented(agents.md、config-files.md),不映射的理由是判断而非文档:
 * 中立 `agent` 类别只表示"可委派子代理",AgentSwarm 是并行扩散的更宽能力,不自动授予。
 */
export const NOT_MAPPED: Readonly<
  Partial<Record<ToolCategory, { names: readonly string[]; why: string }>>
> = {
  agent: {
    names: ['AgentSwarm'],
    why: '中立 agent 类别只表示可委派子代理,AgentSwarm(documented 的工具名)是并行扩散的更宽能力,不自动授予',
  },
};

/** 工具名来源只有二手提及(非工具参考页)的类别 ⇒ 含它们的子代理文件 confidence=assumed。 */
export const ASSUMED_CATEGORIES: readonly ToolCategory[] = ['edit', 'web'];

export function kimiTools(categories: readonly ToolCategory[]): string[] {
  const names = ORDER.filter((c) => categories.includes(c)).flatMap((c) => MAP[c]);
  if (names.length === 0) throw new Error('工具类别映射结果为空');
  return names;
}
