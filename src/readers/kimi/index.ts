import type { TraceReader } from '../../contracts/reader.js';
import { KimiReader } from './reader.js';

export { KimiReader } from './reader.js';

/** Kimi Code 会话 reader 工厂。由主代理在集成(B19)时挂到 src/signals/readers.ts。 */
export function createKimiReader(): TraceReader {
  return new KimiReader();
}
