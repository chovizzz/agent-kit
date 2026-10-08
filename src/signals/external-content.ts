/**
 * 外部内容判定(设计 §6.1:含外部内容的会话,摘录不进反思器,只保留结构化计数)。
 * 口径 C11:具体判定由各 reader 在 SessionMeta/NormEvent 上标记;这里是 collector 层的**兜底**,
 * 且保守:不确定就当外部内容(多丢摘录,不多放)。
 */

/**
 * 工具名(小写后)含这些片段之一即视为拉取外部内容。
 * 不收裸 `search`/`http`:会误伤 ToolSearch 这类本地工具,使几乎所有会话都被判成外部内容。
 */
const EXTERNAL_TOOL_FRAGMENTS = [
  'webfetch',
  'web_fetch',
  'websearch',
  'web_search',
  'browser',
  'playwright',
  'puppeteer',
  'fetch',
  'scrape',
  'crawl',
];

export function isExternalToolName(name: string | undefined): boolean {
  if (name === undefined || name === '') return false;
  const n = name.toLowerCase();
  // MCP 工具(`mcp__server__tool` 或 `mcp:`)一律保守当外部内容
  if (n.startsWith('mcp__') || n.startsWith('mcp:') || n.startsWith('mcp.')) return true;
  return EXTERNAL_TOOL_FRAGMENTS.some((f) => n.includes(f));
}
