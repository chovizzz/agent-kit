/** R7:known.ts 与口径文档 §7.3 的 k_entry / k_role / k_block 逐项相等(C6 防漂移护栏)。 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from '../../../src/io/read-fs.js';
import {
  KNOWN_BLOCK_TYPES,
  KNOWN_ENTRY_TYPES,
  KNOWN_ROLES,
} from '../../../src/readers/pi/known.js';
import { REPO_ROOT } from '../../helpers/tmp.js';

async function section(): Promise<string> {
  const doc = await readText(path.join(REPO_ROOT, 'docs', 'reader-counting-spec.md'));
  return doc.slice(doc.indexOf('### 7.3 Pi'), doc.indexOf('### 7.4'));
}

function list(sec: string, name: string): string[] {
  const m = new RegExp(`def ${name}: \\[([^\\]]*)\\]`).exec(sec);
  if (!m) throw new Error(`口径文档 §7.3 里找不到 ${name}`);
  return [...(m[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

describe('Pi known.ts 与口径文档 §7.3', () => {
  it.each([
    ['k_entry', KNOWN_ENTRY_TYPES],
    ['k_role', KNOWN_ROLES],
    ['k_block', KNOWN_BLOCK_TYPES],
  ] as const)('%s 逐项相等', async (name, set) => {
    const fromDoc = list(await section(), name);
    expect(fromDoc.length).toBeGreaterThan(3); // 正向前提:确实解析到了清单
    expect([...set].sort()).toEqual([...fromDoc].sort());
  });
});
