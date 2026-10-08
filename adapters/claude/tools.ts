/**
 * 中立工具类别 → Claude Code 工具名(设计 §4.3)。工具名出自 Claude 官方文档
 * (claude-sub-agents.md "Available tools"、claude-hooks.md PreToolUse 列表)。
 * 输出固定序、去重;结果不得为空(tools 解析不到任何工具时子代理会启动失败)。
 */
export type ToolCategory = 'read' | 'edit' | 'shell' | 'web' | 'agent';

const ORDER: readonly ToolCategory[] = ['read', 'edit', 'shell', 'web', 'agent'];

const MAP: Readonly<Record<ToolCategory, readonly string[]>> = {
  read: ['Read', 'Grep', 'Glob'],
  edit: ['Edit', 'Write'],
  shell: ['Bash'],
  web: ['WebFetch', 'WebSearch'],
  agent: ['Agent'],
};

export function claudeTools(categories: readonly ToolCategory[]): string {
  const names = ORDER.filter((c) => categories.includes(c)).flatMap((c) => MAP[c]);
  if (names.length === 0) throw new Error('工具类别映射结果为空,Claude 子代理会启动失败');
  return names.join(', ');
}
