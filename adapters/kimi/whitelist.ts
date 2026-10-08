/**
 * Kimi 配置字段的严格白名单(设计 §4.2:多一个字段整份配置加载失败,所以渲染器必须只写白名单内的键)。
 * 白名单宁可保守:文档没明列的字段不写,宁可少渲染并报告 dropped。
 */

/** `config.toml [[hooks]]` 只允许这四个字段,多余字段会使整个配置加载失败(documented:customization/hooks.md)。P0 不渲染 hooks,供 P4 使用。 */
export const KIMI_HOOK_FIELDS = ['event', 'matcher', 'command', 'timeout'] as const;

/** 子代理 md 的 frontmatter 字段(documented:customization/agents.md "Agent File Format")。本渲染器实际只写 name / description / tools。 */
export const KIMI_AGENT_FIELDS = [
  'name',
  'description',
  'whenToUse',
  'override',
  'tools',
  'disallowedTools',
  'subagents',
] as const;

export interface Whitelisted<T> {
  kept: Partial<T>;
  /** 被丢弃的键(字节序),调用方负责写进渲染报告 */
  dropped: string[];
}

/** 只保留白名单内的键,其余返回在 dropped 里。结果的键序跟 allowed 一致(确定性)。 */
export function pickWhitelisted<T extends Record<string, unknown>>(
  raw: T,
  allowed: readonly string[],
): Whitelisted<T> {
  const kept: Record<string, unknown> = {};
  for (const k of allowed) if (k in raw && raw[k] !== undefined) kept[k] = raw[k];
  const dropped = Object.keys(raw)
    .filter((k) => !allowed.includes(k))
    .sort();
  return { kept: kept as Partial<T>, dropped };
}

export function pickKimiHookFields<T extends Record<string, unknown>>(raw: T): Whitelisted<T> {
  return pickWhitelisted(raw, KIMI_HOOK_FIELDS);
}

export function pickKimiAgentFields<T extends Record<string, unknown>>(raw: T): Whitelisted<T> {
  return pickWhitelisted(raw, KIMI_AGENT_FIELDS);
}
