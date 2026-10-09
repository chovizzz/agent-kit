/**
 * Codex rollout 的已知集合(docs/reader-counting-spec.md §2.2.3,与 §7.2 `unknown_event_types` 的
 * k_top / k_resp / k_evt / k_item 逐项一致)。新增类型 = 修订口径文档(§6.2),这里与 oracle 同步改。
 */
export const KNOWN_TOP: ReadonlySet<string> = new Set([
  'session_meta',
  'response_item',
  'event_msg',
  'turn_context',
  'world_state',
  'token_usage_record',
  'compacted',
  'inter_agent_communication_metadata',
]);

export const KNOWN_RESPONSE_ITEM: ReadonlySet<string> = new Set([
  'reasoning',
  'message',
  'custom_tool_call',
  'custom_tool_call_output',
  'function_call',
  'function_call_output',
  'agent_message',
  'web_search_call',
  'tool_search_call',
  'tool_search_output',
]);

export const KNOWN_EVENT_MSG: ReadonlySet<string> = new Set([
  'token_count',
  'item_completed',
  'task_started',
  'task_complete',
  'thread_settings_applied',
  'turn_aborted',
]);

export const KNOWN_ITEM: ReadonlySet<string> = new Set([
  'Reasoning',
  'AgentMessage',
  'UserMessage',
  'CommandExecution',
  'SubAgentActivity',
  'FileChange',
  'CollabAgentToolCall',
  'McpToolCall',
  'WebSearch',
  'ContextCompaction',
  'ImageView',
  'Plan',
  'DynamicToolCall',
]);

/** tool_calls:`response_item` 的这 4 种(§2.2.4)。 */
export const CALL_TYPES: ReadonlySet<string> = new Set([
  'function_call',
  'custom_tool_call',
  'web_search_call',
  'tool_search_call',
]);

/**
 * tool_failures:只在这 5 种工具类 item 上读 `status`(§2.2.5)。
 * 其它 item 即使带 `status:"failed"` 也不计;新增类型 = 修订口径文档。
 */
export const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'CommandExecution',
  'FileChange',
  'McpToolCall',
  'DynamicToolCall',
  'CollabAgentToolCall',
]);

/** 与 `response_item` 里的记录重复、只累加 ignored_duplicate_kinds 的 item 类型(§2.2.2)。 */
export const DUPLICATE_ITEM_TYPES: ReadonlySet<string> = new Set([
  'AgentMessage',
  'Reasoning',
  'WebSearch',
  'ImageView',
]);

/** 产出 meta 事件的 item 类型。 */
export const META_ITEM_TYPES: ReadonlySet<string> = new Set([
  'SubAgentActivity',
  'ContextCompaction',
  'Plan',
]);
