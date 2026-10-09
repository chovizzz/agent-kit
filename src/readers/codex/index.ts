import type { TraceReader } from '../../contracts/reader.js';
import { CodexReader } from './reader.js';

export function createCodexReader(): TraceReader {
  return new CodexReader();
}
