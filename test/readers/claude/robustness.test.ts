/** 验收 ③:侧链行、重复记录、畸形行、未知块类型、超长行、BOM/CRLF/末行无换行,以及三个计数的块级语义。 */
import { describe, expect, it } from 'vitest';
import {
  assistantLine,
  newWork,
  readFile,
  readLines,
  textBlock,
  toolResult,
  toolUse,
  userLine,
} from './helpers.js';

describe('侧链行(C1、C7)', () => {
  it('isSidechain=true 的行整体跳过:不产出事件,工具调用/失败/用户消息/未知类型都不计,只累加 claude.sidechain_line', async () => {
    const w = await newWork('cl-side-');
    const r = await readLines(w, [
      userLine('main'),
      userLine('side', { isSidechain: true }),
      assistantLine([toolUse('s1')], { isSidechain: true }),
      userLine([toolResult('s1', { is_error: true })], { isSidechain: true }),
      { type: 'weird-new-type', isSidechain: true },
      assistantLine([{ type: 'server_tool_use' }], { isSidechain: true }),
    ]);
    expect(r.counts.user_messages).toBe(1);
    expect(r.counts.tool_calls).toBe(0);
    expect(r.counts.tool_failures).toBe(0);
    expect(r.counts.unknown_event_types).toEqual({});
    expect(r.counts.ignored_duplicate_kinds).toEqual({ 'claude.sidechain_line': 5 });
    expect(r.events).toHaveLength(1);
  });

  it('侧链判定先于 <no-type>:缺 type 的侧链行只算侧链,不计 <no-type>', async () => {
    const w = await newWork('cl-side-nt-');
    const r = await readLines(w, [{ isSidechain: true, message: {} }, { noType: true }]);
    expect(r.counts.ignored_duplicate_kinds).toEqual({ 'claude.sidechain_line': 1 });
    expect(r.counts.unknown_event_types).toEqual({ '<no-type>': 1 }); // 非侧链的那行才是 <no-type>
  });

  it('只有严格 true 才是侧链:"true"、1、null、缺失都按主线处理', async () => {
    const w = await newWork('cl-side-strict-');
    const r = await readLines(w, [
      userLine('a', { isSidechain: 'true' }),
      userLine('b', { isSidechain: 1 }),
      userLine('c', { isSidechain: null }),
      (() => {
        const l = userLine('d');
        delete l['isSidechain'];
        return l;
      })(),
    ]);
    expect(r.counts.user_messages).toBe(4);
    expect(r.counts.ignored_duplicate_kinds).toBeUndefined();
  });

  it('侧链行的 version / cwd 不进会话元数据(整行跳过)', async () => {
    const w = await newWork('cl-side-meta-');
    const r = await readLines(w, [
      userLine('x', { isSidechain: true, version: '9.9.9', cwd: '/side' }),
      userLine('y', { version: '2.1.2', cwd: '/main' }),
    ]);
    expect(r.meta.agent_version).toBe('2.1.2');
    expect(r.meta.cwd_hint).toBe('/main');
  });
});

describe('<no-type> 与畸形行(C2)', () => {
  it('缺 type / type 不是字符串 → <no-type>,不产出事件;畸形与非对象 JSON → <malformed>', async () => {
    const w = await newWork('cl-nt-');
    const r = await readLines(w, [
      { message: { role: 'user', content: 'x' } },
      { type: 5 },
      { type: null },
      { type: ['user'] },
      '{"type":"user","message":{"content":"trunc',
      '[1,2,3]',
      '42',
      '"str"',
      'null',
      'not json at all',
      userLine('real'),
    ]);
    expect(r.counts.unknown_event_types).toEqual({ '<no-type>': 4, '<malformed>': 6 });
    expect(r.counts.user_messages).toBe(1);
    expect(r.events).toHaveLength(1);
  });

  it('空白行(含只有制表符/空格/CRLF 残留)忽略,不计任何数', async () => {
    const w = await newWork('cl-blank-');
    const r = await readLines(w, ['', '   ', '\t', userLine('a'), ' \t ', userLine('b')]);
    expect(r.counts.user_messages).toBe(2);
    expect(r.counts.unknown_event_types).toEqual({});
  });

  it('文件被截断在最后一行中间(正在写入):末行计 <malformed>,其它照常', async () => {
    const w = await newWork('cl-trunc-');
    const r = await readLines(w, [userLine('a'), '{"type":"assistant","message":{"con'], {
      finalNewline: false,
    });
    expect(r.counts.unknown_event_types).toEqual({ '<malformed>': 1 });
    expect(r.counts.user_messages).toBe(1);
  });
});

describe('未知类型与未知块(C6)', () => {
  it('未知顶层类型:kind=unknown、raw_type=该类型、计行数;不影响其它计数', async () => {
    const w = await newWork('cl-unk-');
    const r = await readLines(w, [
      { type: 'weird-new-type', timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'weird-new-type' },
      { type: 'summary' },
      userLine('a'),
    ]);
    expect(r.counts.unknown_event_types).toEqual({ 'weird-new-type': 2, summary: 1 });
    expect(r.events.filter((e) => e.kind === 'unknown').map((e) => e.raw_type)).toEqual([
      'weird-new-type',
      'weird-new-type',
      'summary',
    ]);
    expect(r.counts.user_messages).toBe(1);
  });

  it('其余 18 个已知顶层类型(user/assistant 由别处覆盖)都不进 unknown_event_types,各产出一个 meta', async () => {
    const w = await newWork('cl-known-');
    const types = [
      'attachment',
      'system',
      'queue-operation',
      'permission-mode',
      'mode',
      'atis-latch',
      'last-prompt',
      'ai-title',
      'frame-link',
      'bridge-session',
      'file-history-snapshot',
      'artifact-autoreact-ledger',
      'file-history-delta',
      'artifact-comment-monitor',
      'pr-link',
      'agent-name',
      'cost-state',
      'continued-in',
    ];
    const r = await readLines(
      w,
      types.map((type) => ({ type })),
    );
    expect(r.counts.unknown_event_types).toEqual({});
    expect(r.events.map((e) => `${e.kind}:${e.raw_type}`)).toEqual(types.map((t) => `meta:${t}`));
  });

  it('assistant 块级未知:键 assistant.<块type>;块缺 type 或 type 非字符串 → assistant.(none);按块计数', async () => {
    const w = await newWork('cl-unk-blk-');
    const r = await readLines(w, [
      assistantLine([
        { type: 'server_tool_use', id: 'z' },
        { type: 'server_tool_use', id: 'y' },
        { text: 'no type' },
        { type: 7 },
        'not-an-object',
        null,
        textBlock('fine'),
      ]),
    ]);
    expect(r.counts.unknown_event_types).toEqual({
      'assistant.server_tool_use': 2,
      'assistant.(none)': 2,
    });
    expect(r.counts.tool_calls).toBe(0); // 未知块不计调用
    expect(r.events.filter((e) => e.kind === 'unknown')).toHaveLength(4);
  });

  it('user 块级未知:键 user.<块type>,无论该行是不是用户消息;已知块 text/image/tool_result 不报', async () => {
    const w = await newWork('cl-unk-user-');
    const r = await readLines(w, [
      userLine([textBlock('hi'), { type: 'document' }]), // 用户消息,含未知块
      userLine([{ type: 'image', source: {} }, { type: 'document' }], { isMeta: true }), // 非用户消息,仍记块键
      userLine([toolResult('t'), { type: 'thinking' }, { nothing: 1 }]),
    ]);
    expect(r.counts.unknown_event_types).toEqual({
      'user.document': 2,
      'user.thinking': 1,
      'user.(none)': 1,
    });
    expect(r.counts.user_messages).toBe(1);
  });
});

describe('三个计数的块级语义(§2.1.3)', () => {
  it('tool_calls 按 tool_use 块计,一行多块各计;thinking/text 不计', async () => {
    const w = await newWork('cl-tc-');
    const r = await readLines(w, [
      assistantLine([textBlock('t'), toolUse('a'), toolUse('b', 'Read'), { type: 'thinking' }]),
      assistantLine([toolUse('c')]),
    ]);
    expect(r.counts.tool_calls).toBe(3);
    const calls = r.events.filter((e) => e.kind === 'tool_call');
    expect(calls.map((e) => e.tool_name)).toEqual(['Bash', 'Read', 'Bash']);
    // §6.3:tool_failed 只设在 tool_result 事件上,tool_call 不设
    expect(calls.every((e) => e.tool_failed === undefined)).toBe(true);
  });

  it('tool_use 出现在 user 行里不计调用(只看 assistant 行)', async () => {
    const w = await newWork('cl-tc-user-');
    const r = await readLines(w, [userLine([toolUse('a')])]);
    expect(r.counts.tool_calls).toBe(0);
    // 该行没有被整行丢弃:仍是用户消息(U1 只看 tool_result),且 tool_use 在 user 行里是未知块
    expect(r.counts.user_messages).toBe(1);
    expect(r.counts.unknown_event_types).toEqual({ 'user.tool_use': 1 });
    expect(r.events.some((e) => e.kind === 'tool_call')).toBe(false);
  });

  it('tool_failures:只有 is_error===true 才算;false/null/缺失/"true"/1 都不算', async () => {
    const w = await newWork('cl-tf-');
    const r = await readLines(w, [
      userLine([
        toolResult('1', { is_error: true }),
        toolResult('2', { is_error: false }),
        toolResult('3', { is_error: null }),
        toolResult('4'),
        toolResult('5', { is_error: 'true' }),
        toolResult('6', { is_error: 1 }),
        toolResult('7', { is_error: true, toolDenialKind: 'permission-rule' }),
      ]),
    ]);
    expect(r.counts.tool_failures).toBe(2); // 1 和 7(权限拒绝按失败计,不拆分)
    const results = r.events.filter((e) => e.kind === 'tool_result');
    expect(results).toHaveLength(7);
    expect(results.map((e) => e.tool_failed)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('tool_result 出现在 assistant 行里不计失败', async () => {
    const w = await newWork('cl-tf-asst-');
    const r = await readLines(w, [assistantLine([toolResult('1', { is_error: true })])]);
    expect(r.counts.tool_failures).toBe(0);
    // 块没有被静默丢弃:assistant 行里的 tool_result 是未知块
    expect(r.counts.unknown_event_types).toEqual({ 'assistant.tool_result': 1 });
    expect(r.events.some((e) => e.tool_failed !== undefined)).toBe(false);
  });

  it('带 tool_result 的行整行不是用户消息(同行的 text 块记 meta,不产生 user_message)', async () => {
    const w = await newWork('cl-mixed-');
    const r = await readLines(w, [
      userLine([toolResult('1', { is_error: true }), textBlock('typed too')]),
    ]);
    expect(r.counts.user_messages).toBe(0);
    expect(r.counts.tool_failures).toBe(1);
    expect(r.events.map((e) => `${e.kind}:${e.raw_type}`)).toEqual([
      'tool_result:user.tool_result',
      'meta:user.text',
    ]);
  });

  it('assistant content 为字符串:一个 assistant_message;其它形态(null)一个 meta', async () => {
    const w = await newWork('cl-asst-str-');
    const r = await readLines(w, [assistantLine('plain'), assistantLine(null)]);
    expect(r.events.map((e) => `${e.kind}:${e.raw_type}`)).toEqual([
      'assistant_message:assistant',
      'meta:assistant',
    ]);
    expect(r.counts.unknown_event_types).toEqual({});
  });

  it('tool_result 回填 tool_name(靠 tool_use_id);查不到则缺省', async () => {
    const w = await newWork('cl-tn-');
    const r = await readLines(w, [
      assistantLine([toolUse('a', 'Grep')]),
      userLine([toolResult('a'), toolResult('missing')]),
    ]);
    const res = r.events.filter((e) => e.kind === 'tool_result');
    expect(res[0]?.tool_name).toBe('Grep');
    expect(res[1]?.tool_name).toBeUndefined();
  });
});

describe('不去重(C2、2.1.4)', () => {
  it('同一文件里逐字节相同的两行算两行', async () => {
    const w = await newWork('cl-dup-');
    const u = JSON.stringify(userLine('same'));
    const a = JSON.stringify(assistantLine([toolUse('dup')]));
    const t = JSON.stringify(userLine([toolResult('dup', { is_error: true })]));
    const r = await readLines(w, [u, u, a, a, t, t]);
    expect(r.counts.user_messages).toBe(2);
    expect(r.counts.tool_calls).toBe(2);
    expect(r.counts.tool_failures).toBe(2);
  });

  it('同一次 API 回复拆成多行(各带不同块)按块各计一次', async () => {
    const w = await newWork('cl-split-');
    const r = await readLines(w, [
      assistantLine([toolUse('x1')], { apiBlockIndex: 0 }),
      assistantLine([toolUse('x2')], { apiBlockIndex: 1 }),
    ]);
    expect(r.counts.tool_calls).toBe(2);
  });
});

describe('超长行(C8)', () => {
  it('maxEventBytes 很小时计数与分类不变,只丢 text 并累加 oversized_lines', async () => {
    const w = await newWork('cl-big-');
    const big = 'x'.repeat(5000);
    const lines = [
      userLine(big),
      assistantLine([toolUse('a')]),
      userLine([toolResult('a', { is_error: true, content: big })]),
      assistantLine([{ type: 'server_tool_use', pad: big }]),
      { type: 'weird-new-type', pad: big },
      userLine('small'),
    ];
    const file = (await readLines(w, lines)).file;
    const normal = await readFile(file);
    const tiny = await readFile(file, 300);
    expect(normal.counts.oversized_lines).toBe(0);
    expect(tiny.counts.oversized_lines).toBe(4); // 大用户行、大 tool_result 行、server_tool_use 行、weird 行
    const strip = (c: typeof normal.counts) => ({ ...c, oversized_lines: 0 });
    expect(strip(tiny.counts)).toEqual(strip(normal.counts));
    expect(tiny.counts.user_messages).toBe(2);
    expect(tiny.counts.tool_failures).toBe(1);
    expect(tiny.counts.unknown_event_types).toEqual({
      'assistant.server_tool_use': 1,
      'weird-new-type': 1,
    });
    // 超长行的事件仍在,text 被丢
    expect(tiny.events).toHaveLength(normal.events.length);
    const bigUser = tiny.events.find((e) => e.kind === 'user_message');
    expect(bigUser?.text).toBeUndefined();
    expect(normal.events.find((e) => e.kind === 'user_message')?.text).toBe(big);
  });
});

describe('超长的侧链行 / 畸形行(C8)', () => {
  it('超长侧链行仍只算 claude.sidechain_line,超长畸形行仍计 <malformed>,都计入 oversized_lines', async () => {
    const w = await newWork('cl-big-side-');
    const pad = 'z'.repeat(4000);
    const file = (
      await readLines(w, [
        userLine(pad, { isSidechain: true }),
        `{"type":"user","message":{"content":"${pad}`,
        userLine('ok'),
      ])
    ).file;
    const tiny = await readFile(file, 200);
    expect(tiny.counts.oversized_lines).toBe(2);
    expect(tiny.counts.ignored_duplicate_kinds).toEqual({ 'claude.sidechain_line': 1 });
    expect(tiny.counts.unknown_event_types).toEqual({ '<malformed>': 1 });
    expect(tiny.counts.user_messages).toBe(1);
  });
});

describe('超长行不改变 U 谓词判定(C8:分类在丢弃文本之前)', () => {
  it('超长的命令输出行仍不计,超长的普通用户行仍计;两者都计入 oversized_lines 且 text 被丢', async () => {
    const w = await newWork('cl-big-u9-');
    const pad = 'y'.repeat(4000);
    const lines = [
      userLine(`<local-command-stdout>${pad}`),
      userLine(`hello ${pad}`),
      userLine([textBlock(`[Request interrupted ${pad}`)]),
      userLine([textBlock('ok'), textBlock(`<local-command-stdout>${pad}`)]),
    ];
    const file = (await readLines(w, lines)).file;
    const normal = await readFile(file);
    const tiny = await readFile(file, 200);
    expect(normal.counts.user_messages).toBe(2);
    expect(tiny.counts.user_messages).toBe(2);
    expect(tiny.counts.oversized_lines).toBe(4);
    expect(
      tiny.events.filter((e) => e.kind === 'user_message').every((e) => e.text === undefined),
    ).toBe(true);
  });
});

describe('BOM / CRLF / 末行无换行(§7.6)', () => {
  const lines = (): Record<string, unknown>[] => [
    userLine('a'),
    assistantLine([toolUse('t')]),
    userLine([toolResult('t', { is_error: true })]),
    userLine('b'),
  ];
  it('三种变体及其组合与原文件计数、元数据相同', async () => {
    const w = await newWork('cl-var-');
    const base = await readLines(w, lines());
    for (const over of [
      { bom: true },
      { eol: '\r\n' as const },
      { finalNewline: false },
      { bom: true, eol: '\r\n' as const, finalNewline: false },
    ]) {
      const v = await readLines(w, lines(), over);
      expect(v.counts).toEqual(base.counts);
      expect(v.counts.user_messages).toBe(2);
      expect(v.counts.unknown_event_types).toEqual({});
      expect(v.events.length).toBe(base.events.length);
    }
  });

  it('BOM 在首行是畸形 JSON 的文件里:仍只计一个 <malformed>(BOM 不额外制造畸形行)', async () => {
    const w = await newWork('cl-bom-mal-');
    const r = await readLines(w, ['{"type":"user"', userLine('a')], { bom: true });
    expect(r.counts.unknown_event_types).toEqual({ '<malformed>': 1 });
    expect(r.counts.user_messages).toBe(1);
  });
});
