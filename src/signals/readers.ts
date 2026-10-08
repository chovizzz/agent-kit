/**
 * agent → reader 工厂表。P0 在 B10b 里是空的:B11–B14 各自实现 `TraceReader` 后,
 * 由主代理在集成(B19)时把 `src/readers/<agent>/index.ts` 的工厂挂到这里。
 * 测试用 `createSignalsCollectCommand({ readers })` 直接注入,不依赖本表。
 */
import type { AgentId } from '../contracts/common.js';
import type { TraceReader } from '../contracts/reader.js';

export type ReaderRegistry = Partial<Record<AgentId, () => TraceReader>>;

export const DEFAULT_READERS: ReaderRegistry = {};
