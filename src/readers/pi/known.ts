/**
 * Pi 已知集合(docs/reader-counting-spec.md §2.3.2;唯一来源是 §7.3 `unknown_event_types` 程序的 k_* 列表)。
 * 新版本引入新类型时先落到 unknown,由人确认后修订口径文档,这里同步改。
 */
export const KNOWN_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'session',
  'message',
  'custom_message',
  'context_edit',
  'custom',
  'model_change',
  'thinking_level_change',
  'compaction',
  'session_info',
  // 文档里有、本机零样本
  'usage',
  'branch_summary',
  'label',
]);

export const KNOWN_ROLES: ReadonlySet<string> = new Set([
  'system',
  'user',
  'assistant',
  'toolResult',
  // 文档里有、本机零样本
  'bashExecution',
  'custom',
  'branchSummary',
  'compactionSummary',
]);

export const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'text',
  'thinking',
  'toolCall',
  'image',
]);

/** 只检查这三种 role 的内容块(§2.3.2 未知键格式) */
export const BLOCK_CHECKED_ROLES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'toolResult',
]);
