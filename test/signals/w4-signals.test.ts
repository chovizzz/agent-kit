/** W4 / R21-18 第 20、40 条:`tool_error_class` 固定映射表、`retry_chain_len` 三种边界、`sig_id` 不变。 */
import { describe, expect, it } from 'vitest';
import { TOOL_ERROR_CLASSES } from '../../src/contracts/signal.js';
import type { ToolErrorClass } from '../../src/contracts/signal.js';
import { createClaudeReader } from '../../src/readers/claude/index.js';
import { sigIdFor } from '../../src/signals/ids.js';
import { RetryChainTracker } from '../../src/signals/retry-chain.js';
import {
  classifyToolError,
  TOOL_ERROR_CLASS_TABLE,
  TOOL_ERROR_SCAN_CHARS,
} from '../../src/signals/tool-error-class.js';
import { writeClaudeLines } from '../fixtures/sessions/gen-claude.js';
import { assistantLine, userLine } from '../readers/claude/helpers.js';
import { newWork } from './helpers.js';
import { controlBlock, runFile, W4_SALT } from './w4-helpers.js';

/** 固定映射表:每个枚举一个样例(`other` 是兜底样例)。 */
const EXAMPLES: Record<ToolErrorClass, string> = {
  permission: 'bash: /etc/shadow: Permission denied',
  timeout: 'Command timed out after 120000ms',
  network: 'getaddrinfo ENOTFOUND registry.example.org',
  not_found: 'cat: nope.txt: No such file or directory',
  conflict: 'fatal: Unable to create index.lock: File exists',
  syntax: 'SyntaxError: Unexpected token } in JSON at position 5',
  other: '这个工具炸了,原因不明',
};

describe('tool_error_class 固定映射表', () => {
  it('枚举与契约一致;表里 6 类 + other 兜底', () => {
    expect([...TOOL_ERROR_CLASSES].sort()).toEqual(Object.keys(EXAMPLES).sort());
    expect(TOOL_ERROR_CLASS_TABLE.map(([c]) => c)).toEqual([
      'permission',
      'timeout',
      'network',
      'not_found',
      'conflict',
      'syntax',
    ]);
  });

  it.each(Object.entries(EXAMPLES))('%s:样例命中该类', (cls, text) => {
    expect(classifyToolError(text)).toBe(cls);
  });

  it('other 兜底:有文本但没命中任何一类;正向对照:同一函数对命中的文本不返回 other', () => {
    expect(classifyToolError('完全无关的一段话')).toBe('other');
    expect(classifyToolError(EXAMPLES.timeout)).not.toBe('other');
  });

  it('没有失败文本(缺失 / 空 / 纯空白)→ undefined(不写字段,不写 other)', () => {
    expect(classifyToolError(undefined)).toBeUndefined();
    expect(classifyToolError('')).toBeUndefined();
    expect(classifyToolError(' \n\t ')).toBeUndefined();
  });

  it('有序、首个命中即用:多类重叠归到靠前的类', () => {
    expect(classifyToolError('Permission denied: file not found')).toBe('permission');
    expect(classifyToolError('connection timed out')).toBe('timeout'); // timeout 先于 network
    expect(classifyToolError('Connection refused: no such file or directory')).toBe('network'); // network 先于 not_found
    expect(classifyToolError('ENOENT while merge conflict')).toBe('not_found'); // not_found 先于 conflict
    expect(classifyToolError('file already exists: unexpected token')).toBe('conflict'); // conflict 先于 syntax
  });

  it('只扫前 TOOL_ERROR_SCAN_CHARS 个码元', () => {
    const pad = 'x'.repeat(TOOL_ERROR_SCAN_CHARS);
    expect(classifyToolError(`timeout ${pad}`)).toBe('timeout');
    expect(classifyToolError(`${pad} timeout`)).toBe('other');
  });
});

describe('RetryChainTracker(纯函数)', () => {
  it('同一工具连续失败累加;该工具成功结束链;别的工具的结果不断链', () => {
    const t = new RetryChainTracker();
    expect([t.observe('Bash', true), t.observe('Bash', true)]).toEqual([1, 2]);
    expect(t.observe('Read', false)).toBeUndefined(); // 别的工具成功:不动 Bash 的链
    expect(t.observe('Bash', true)).toBe(3);
    expect(t.observe('Bash', false)).toBeUndefined(); // 成功:结束
    expect(t.observe('Bash', true)).toBe(1); // 新链
    expect(t.max()).toBe(3);
  });

  it('没有工具名的失败不成链、不改状态', () => {
    const t = new RetryChainTracker();
    expect(t.observe(undefined, true)).toBeUndefined();
    expect(t.observe('', true)).toBeUndefined();
    expect(t.max()).toBe(0);
  });
});

const toolUse = (id: string, name: string): Record<string, unknown> => ({
  type: 'tool_use',
  id,
  name,
  input: { command: 'x' },
});
let n = 0;
const sid = (): string => `w4s${n++}`;
type Line = Record<string, unknown>;
const fail = (id: string, name: string, text = 'boom'): Line[] => [
  assistantLine([toolUse(id, name)]),
  userLine([{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }]),
];
const ok = (id: string, name: string): Line[] => [
  assistantLine([toolUse(id, name)]),
  userLine([{ type: 'tool_result', tool_use_id: id, content: 'fine' }]),
];

describe('retry_chain_len / retry_chain_max(经管线,claude)', () => {
  async function chain(lines: Line[], w?: Awaited<ReturnType<typeof newWork>>) {
    const work = w ?? (await newWork('w4-rc-'));
    const file = await writeClaudeLines(work.io, {
      root: work.sessions,
      cwd: '/work/proj-a',
      id: sid(),
      lines,
    });
    const r = await runFile(createClaudeReader(), file);
    const lens = r.signals
      .filter((s) => s.event_kind === 'tool_result_failed')
      .sort((a, b) => (a.event_index ?? 0) - (b.event_index ?? 0))
      .map((s) => s.retry_chain_len);
    return { r, lens, work };
  }

  it('成功结束:失败失败成功再失败 → 序号 1、2、(成功断链)、1;max = 2', async () => {
    const { r, lens } = await chain([
      ...fail('a1', 'Bash'),
      ...fail('a2', 'Bash'),
      ...ok('a3', 'Bash'),
      ...fail('a4', 'Bash'),
    ]);
    expect(lens).toEqual([1, 2, 1]);
    expect(r.w4?.retryChainMax).toBe(2);
  });

  it('放弃:会话结束时链仍未成功 → 停在当前长度(max = 3)', async () => {
    const { r, lens } = await chain([
      ...fail('b1', 'Bash'),
      ...fail('b2', 'Bash'),
      ...fail('b3', 'Bash'),
    ]);
    expect(lens).toEqual([1, 2, 3]);
    expect(r.w4?.retryChainMax).toBe(3);
  });

  it('跨会话不连:前一个会话以 Bash 失败结尾,后一个以 Bash 失败开头 → 后者从 1 起', async () => {
    const first = await chain([...fail('c1', 'Bash'), ...fail('c2', 'Bash')]);
    const second = await chain([...fail('c3', 'Bash')], first.work);
    expect(first.lens).toEqual([1, 2]); // 正向:前一个会话确有链
    expect(second.lens).toEqual([1]);
    expect(second.r.w4?.retryChainMax).toBe(1);
  });

  it('穿插:别的工具的失败 / 成功、用户消息都不断链', async () => {
    const { lens } = await chain([
      ...fail('d1', 'Bash'),
      ...fail('d2', 'Read'),
      userLine('再试一次'),
      ...ok('d3', 'Read'),
      ...fail('d4', 'Bash'),
    ]);
    expect(lens).toEqual([1, 1, 2]);
  });

  it('没有失败 → retry_chain_max = 0、信号不带 retry_chain_len', async () => {
    const { r, lens } = await chain([...ok('e1', 'Bash')]);
    expect(lens).toEqual([]);
    expect(r.w4?.retryChainMax).toBe(0);
    expect(r.signals.every((s) => s.retry_chain_len === undefined)).toBe(true);
  });

  it('被注入排除的结果事件不进链(正向:真实失败照常计链)', async () => {
    const { r, lens } = await chain([
      ...fail('f1', 'Bash'),
      ...fail('f2', 'Bash', controlBlock()), // 被引用的块 → 事件被排除
      ...fail('f3', 'Bash'),
    ]);
    expect(lens).toEqual([1, 2]);
    expect(r.w4?.retryChainMax).toBe(2);
    expect(r.w4?.injectionExcluded).toBe(1);
  });

  it('找不到工具名的失败(tool_use_id 对不上)→ 不成链,但仍有 tool_error_class', async () => {
    const { r, lens } = await chain([
      userLine([
        { type: 'tool_result', tool_use_id: 'ghost', is_error: true, content: 'timeout!' },
      ]),
    ]);
    expect(lens).toEqual([undefined]);
    expect(r.signals.find((s) => s.event_kind === 'tool_result_failed')?.tool_error_class).toBe(
      'timeout',
    );
    expect(r.w4?.retryChainMax).toBe(0);
  });
});

describe('信号上的 tool_error_class;sig_id 不变(第 40 条)', () => {
  it('失败信号带 tool_error_class(每个枚举经管线各一例);非失败信号不带', async () => {
    const w = await newWork('w4-sig-');
    const lines: Line[] = [userLine('hi')];
    Object.values(EXAMPLES).forEach((text, i) => lines.push(...fail(`g${i}`, `T${i}`, text)));
    const file = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: sid(),
      lines,
    });
    const r = await runFile(createClaudeReader(), file);
    const failed = r.signals
      .filter((s) => s.event_kind === 'tool_result_failed')
      .sort((a, b) => (a.event_index ?? 0) - (b.event_index ?? 0));
    expect(failed.map((s) => s.tool_error_class)).toEqual(Object.keys(EXAMPLES));
    expect(
      r.signals
        .filter((s) => s.event_kind !== 'tool_result_failed')
        .every((s) => !('tool_error_class' in s)),
    ).toBe(true);
  });

  it('sig_id 只由 (盐, session_ref, 事件序号) 决定:新字段非空时仍等于 sigIdFor;改失败文本(类变了)sig_id 不变', async () => {
    const w = await newWork('w4-sigid-');
    const id = sid();
    const build = (text: string): Line[] => [
      ...fail('h1', 'Bash', text),
      ...fail('h2', 'Bash', text),
    ];
    const f = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id,
      lines: build(EXAMPLES.timeout),
    });
    const r1 = await runFile(createClaudeReader(), f);
    await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id,
      lines: build(EXAMPLES.permission),
    });
    const r2 = await runFile(createClaudeReader(), f);
    const failed = (r: typeof r1) =>
      r.signals
        .filter((s) => s.event_kind === 'tool_result_failed')
        .sort((a, b) => (a.event_index ?? 0) - (b.event_index ?? 0));
    const a = failed(r1);
    const b = failed(r2);
    // 正向:新字段确实非空,且两次不同
    expect(a.map((s) => [s.tool_error_class, s.retry_chain_len])).toEqual([
      ['timeout', 1],
      ['timeout', 2],
    ]);
    expect(b.map((s) => s.tool_error_class)).toEqual(['permission', 'permission']);
    for (const s of [...a, ...b]) {
      expect(s.sig_id).toBe(sigIdFor(W4_SALT, r1.sessionRef, s.event_index as number));
    }
    expect(a.map((s) => s.sig_id)).toEqual(b.map((s) => s.sig_id));
  });
});
