/** 已知集合与 spec §7.1 的 jq 清单同源(C6:reader 从同一份清单生成,或在测试里断言相等)。 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from '../../../src/io/read-fs.js';
import { KNOWN_BLOCK_TYPES, KNOWN_LINE_TYPES } from '../../../src/readers/claude/schema.js';
import { REPO_ROOT } from '../../helpers/tmp.js';

async function claudeUnknownProgram(): Promise<string> {
  const spec = await readText(path.join(REPO_ROOT, 'docs/reader-counting-spec.md'));
  const i = spec.indexOf('def known_line:');
  expect(i, 'spec 里找不到 known_line').toBeGreaterThan(0);
  return spec.slice(i, spec.indexOf('keys_of', i));
}

const strings = (s: string): string[] => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);

describe('已知集合 = spec §7.1 的 known_line / known_block', () => {
  it('顶层 type 清单逐项相等(20 个)', async () => {
    const prog = await claudeUnknownProgram();
    const m = /def known_line: \[([^\]]*)\]/.exec(prog);
    const fromSpec = strings(m?.[1] ?? '');
    expect(fromSpec.length).toBe(20);
    expect([...KNOWN_LINE_TYPES].sort()).toEqual([...fromSpec].sort());
  });

  it('块 type 清单逐项相等', async () => {
    const prog = await claudeUnknownProgram();
    const m = /def known_block: (\{[^}]*\})/.exec(prog);
    const obj = JSON.parse(m?.[1] ?? '{}') as Record<string, string[]>;
    expect([...KNOWN_BLOCK_TYPES.assistant].sort()).toEqual([...(obj['assistant'] ?? [])].sort());
    expect([...KNOWN_BLOCK_TYPES.user].sort()).toEqual([...(obj['user'] ?? [])].sort());
    expect(obj['assistant']?.length).toBe(3);
    expect(obj['user']?.length).toBe(3);
  });
});
