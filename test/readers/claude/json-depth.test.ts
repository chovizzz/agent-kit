/**
 * R20-A0(contracts §13 / §20.9 第 14 条 / R20-6.7,Q16-A):单行 JSON 嵌套深度 > 256 的行,解析前按括号预扫拦下,
 * 按超大行记账(`oversized_lines` + `unknown_event_types["<line-too-deep>"]`),不产出事件、不使会话失败。
 * 共享基类实现,这里用 Claude reader 做端到端;预扫函数另有纯函数用例。
 */
import { describe, expect, it } from 'vitest';
import { RSI_MAX_JSON_DEPTH } from '../../../src/contracts/rsi.js';
import { LINE_TOO_DEEP_KEY, exceedsJsonDepth } from '../../../src/signals/base-reader.js';
import { writeClaudeLines } from '../../fixtures/sessions/gen-claude.js';
import { newWork, readFile, readLines, userLine } from './helpers.js';

const nest = (n: number, open = '[', close = ']'): string => open.repeat(n) + close.repeat(n);
const lineWith = (depthExtra: string): string =>
  JSON.stringify(userLine('deep')).replace(/}$/, `,"deep":${depthExtra}}`);

describe('R20-A0 §20.9#14 exceedsJsonDepth(纯函数)', () => {
  it('常量是 256;恰好 256 层不超,257 层超(两个方向的边界)', () => {
    expect(RSI_MAX_JSON_DEPTH).toBe(256);
    expect(exceedsJsonDepth(nest(256))).toBe(false);
    expect(exceedsJsonDepth(nest(257))).toBe(true);
    expect(exceedsJsonDepth('{"a":'.repeat(128) + '1' + '}'.repeat(128), 128)).toBe(false);
    expect(exceedsJsonDepth('{"a":'.repeat(129) + '1' + '}'.repeat(129), 128)).toBe(true);
  });

  it('字符串字面量里的括号与转义引号不计层数', () => {
    expect(exceedsJsonDepth(JSON.stringify({ s: '['.repeat(1000) }))).toBe(false);
    expect(exceedsJsonDepth(JSON.stringify({ s: '\\"' + '['.repeat(1000) + '"\\' }))).toBe(false);
    expect(exceedsJsonDepth('["a\\\\", ' + nest(300) + ']')).toBe(true);
  });

  it('多余的闭括号不让层数变负(不能靠前置 ] 抵消后面的嵌套)', () => {
    expect(exceedsJsonDepth(']'.repeat(500) + nest(257))).toBe(true);
    expect(exceedsJsonDepth(']'.repeat(500) + nest(100))).toBe(false);
  });

  it('兄弟节点不累加:宽而浅的行不超', () => {
    expect(exceedsJsonDepth('[' + '[],'.repeat(10_000) + '[]]')).toBe(false);
  });
});

describe('R20-A0 §20.9#14 reader 端到端', () => {
  it('过深的行:不产出事件,计 oversized_lines 与 <line-too-deep>(不计 <malformed>);前后行照常', async () => {
    const w = await newWork('depth-e2e-');
    const r = await readLines(w, [userLine('a'), lineWith(nest(300)), userLine('b')]);
    expect(r.counts.user_messages).toBe(2);
    expect(r.counts.oversized_lines).toBe(1);
    expect(r.counts.unknown_event_types).toEqual({ [LINE_TOO_DEEP_KEY]: 1 });
    expect(r.events.filter((e) => e.kind === 'user_message')).toHaveLength(2);
  });

  it('控制组:深度在上限内(含接近上限)的同形行照常解析,不记任何 oversized', async () => {
    const w = await newWork('depth-ok-');
    const r = await readLines(w, [userLine('a'), lineWith(nest(200)), userLine('b')]);
    expect(r.counts.user_messages).toBe(3);
    expect(r.counts.oversized_lines).toBe(0);
    expect(r.counts.unknown_event_types).toEqual({});
  });

  it('病态深度(20 万层)不使会话失败、不抛栈溢出,按过深计 1', async () => {
    const w = await newWork('depth-huge-');
    const r = await readLines(w, [userLine('a'), nest(200_000), userLine('b')]);
    expect(r.counts.user_messages).toBe(2);
    expect(r.counts.unknown_event_types).toEqual({ [LINE_TOO_DEEP_KEY]: 1 });
    expect(r.counts.oversized_lines).toBe(1);
  });

  it('既超字节上限又过深的行只计一次 oversized_lines', async () => {
    const w = await newWork('depth-both-');
    const file = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'both',
      lines: [userLine('a'), lineWith(nest(300))],
    });
    const r = await readFile(file, 64); // maxEventBytes=64:两行都超字节上限
    expect(r.counts.oversized_lines).toBe(2); // 'a' 行与过深行各一次,过深行不重复计
    expect(r.counts.unknown_event_types).toEqual({ [LINE_TOO_DEEP_KEY]: 1 });
  });
});
