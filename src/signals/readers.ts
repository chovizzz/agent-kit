/**
 * agent → reader 工厂表。B11–B14 的四个 reader 挂在这里(opencode / openclaw 的 reader 不在 P0)。
 * 测试用 `createSignalsCollectCommand({ readers })` 直接注入,不依赖本表。
 */
import type { AgentId } from '../contracts/common.js';
import type { TraceReader } from '../contracts/reader.js';
import { createClaudeReader } from '../readers/claude/index.js';
import { createCodexReader } from '../readers/codex/index.js';
import { createKimiReader } from '../readers/kimi/index.js';
import { createPiReader } from '../readers/pi/index.js';

export type ReaderRegistry = Partial<Record<AgentId, () => TraceReader>>;

export const DEFAULT_READERS: ReaderRegistry = {
  claude: createClaudeReader,
  codex: createCodexReader,
  pi: createPiReader,
  kimi: createKimiReader,
};
