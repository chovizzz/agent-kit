/**
 * C6:已知集合的唯一来源是口径文档 §7.2 里 `unknown_event_types` 程序的 k_* 列表;
 * reader 的 known.ts 必须与之逐项相等,防止清单漂移(新增类型 = 修订口径文档,两边同步改)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from '../../../src/io/read-fs.js';
import {
  CALL_TYPES,
  KNOWN_EVENT_MSG,
  KNOWN_ITEM,
  KNOWN_RESPONSE_ITEM,
  KNOWN_TOP,
  TOOL_ITEM_TYPES,
} from '../../../src/readers/codex/known.js';
import { REPO_ROOT } from '../../helpers/tmp.js';

async function specText(): Promise<string> {
  return readText(path.join(REPO_ROOT, 'docs', 'reader-counting-spec.md'));
}

/** 取 `def <name>: ["a","b",...];` 里的字符串列表(只取 Codex 一节,避免撞别家同名)。 */
function list(doc: string, name: string): string[] {
  const codex = doc.slice(doc.indexOf('### 7.2 Codex'), doc.indexOf('### 7.3 Pi'));
  const m = new RegExp(`def ${name}: \\[([^\\]]*)\\]`).exec(codex);
  if (!m) throw new Error(`口径文档 §7.2 里找不到 ${name}`);
  return [...(m[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

describe('known.ts 与口径文档 §7.2 的 k_* 列表逐项相等', () => {
  it.each([
    ['k_top', KNOWN_TOP],
    ['k_resp', KNOWN_RESPONSE_ITEM],
    ['k_evt', KNOWN_EVENT_MSG],
    ['k_item', KNOWN_ITEM],
  ] as const)('%s', async (name, set) => {
    const fromDoc = list(await specText(), name);
    expect(fromDoc.length).toBeGreaterThan(5); // 正向前提:确实解析到了清单
    expect([...set].sort()).toEqual([...fromDoc].sort());
  });

  it('计数用的两个集合与文档一致:4 种调用、5 种工具 item(出现在 §7.2 的 count 程序里)', async () => {
    const codex = (await specText()).slice(
      (await specText()).indexOf('### 7.2 Codex'),
      (await specText()).indexOf('### 7.3 Pi'),
    );
    const calls = /IN\("function_call","custom_tool_call","web_search_call","tool_search_call"\)/;
    const items =
      /IN\("CommandExecution","FileChange","McpToolCall","DynamicToolCall","CollabAgentToolCall"\)/;
    expect(calls.test(codex)).toBe(true);
    expect(items.test(codex)).toBe(true);
    expect([...CALL_TYPES]).toEqual([
      'function_call',
      'custom_tool_call',
      'web_search_call',
      'tool_search_call',
    ]);
    expect([...TOOL_ITEM_TYPES]).toEqual([
      'CommandExecution',
      'FileChange',
      'McpToolCall',
      'DynamicToolCall',
      'CollabAgentToolCall',
    ]);
  });
});
