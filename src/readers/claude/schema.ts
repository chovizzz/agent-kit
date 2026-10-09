/**
 * Claude Code 会话的已知集合(docs/reader-counting-spec.md §2.1.2)。
 * 唯一来源是 spec §7.1 里 `unknown_event_types` jq 程序的 known_line / known_block;
 * test/readers/claude/schema.test.ts 从 spec 文本抽出两份清单与这里逐项断言相等。
 */

/** 顶层 `type` 的已知集合(本机观察到的 20 个)。 */
export const KNOWN_LINE_TYPES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
  'queue-operation',
  'permission-mode',
  'mode',
  'atis-latch',
  'last-prompt',
  'ai-title',
  'frame-link',
  'bridge-session',
  'file-history-snapshot',
  'artifact-autoreact-ledger',
  'file-history-delta',
  'artifact-comment-monitor',
  'pr-link',
  'agent-name',
  'cost-state',
  'continued-in',
]);

/** 内容块 `type` 的已知集合,按行 `type` 区分(只检查 user / assistant)。 */
export const KNOWN_BLOCK_TYPES: Readonly<Record<'user' | 'assistant', ReadonlySet<string>>> = {
  assistant: new Set(['text', 'thinking', 'tool_use']),
  user: new Set(['text', 'image', 'tool_result']),
};

/** 主文件名:`<项目目录>/<UUID>.jsonl`,按 spec §2.1.1 的 glob `????????-????-????-????-????????????.jsonl`(任意字符,不限十六进制)。 */
export const SESSION_FILE_RE = /^[^/]+\/[^/]{8}-[^/]{4}-[^/]{4}-[^/]{4}-[^/]{12}\.jsonl$/u;

/** 显式传入单个文件时的文件名判据(同 SESSION_FILE_RE 的文件名部分)。 */
export const SESSION_NAME_RE = /^[^/]{8}-[^/]{4}-[^/]{4}-[^/]{4}-[^/]{12}\.jsonl$/u;

export const SIDECHAIN_KEY = 'claude.sidechain_line';
