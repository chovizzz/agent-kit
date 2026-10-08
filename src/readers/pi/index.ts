import type { TraceReader } from '../../contracts/reader.js';
import { PiReader } from './reader.js';

/** Pi reader 工厂;由主代理在集成(B19)时挂到 src/signals/readers.ts。 */
export function createPiReader(): TraceReader {
  return new PiReader();
}

export { PiReader } from './reader.js';
export { PiTree } from './tree.js';
