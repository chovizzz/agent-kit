/**
 * B14 Kimi reader:口径 docs/reader-counting-spec.md §2.4、§7.4。全部使用合成夹具(运行时写到 KIT_TMP)。
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readText } from '../../../src/io/read-fs.js';
import { createKimiReader } from '../../../src/readers/kimi/index.js';
import { KNOWN_LOOP_EVENT_TYPES, KNOWN_TOP_TYPES } from '../../../src/readers/kimi/known.js';
import { setOpenObserver } from '../../../src/signals/open-readonly.js';
import type { OpenEvent } from '../../../src/signals/open-readonly.js';
import { genKimi } from '../../fixtures/sessions/gen-kimi.js';
import type { SessionSpec } from '../../fixtures/sessions/common.js';
import { REPO_ROOT, homeSnapshot } from '../../signals/helpers.js';
import {
  L,
  NO_ORIGIN,
  T0,
  loopEv,
  metadataLine,
  newWork,
  readAll,
  runCustom,
  userMsg,
} from './util.js';
import type { Work } from './util.js';

let homeBefore = '';
beforeAll(async () => {
  homeBefore = await homeSnapshot();
});
afterAll(async () => {
  // 真实 HOME 前后无变化(测试只写 KIT_TMP,会话源用工作目录里的假 HOME 形状)
  expect(await homeSnapshot()).toBe(homeBefore);
});

function spec(w: Work, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    root: w.sessions,
    cwd: '/work/proj-a',
    id: 's1',
    userTexts: ['第一条', '第二条', 'third'],
    toolCalls: 4,
    failedResults: 2,
    ...over,
  };
}

describe('三个计数 = 构造期望(§2.4.3),且恒等于事件流', () => {
  it('生成器会话:counts / unknown / ignored 全部对上,事件类型对应', async () => {
    const w = await newWork('kimi-count-');
    const g = await genKimi(
      w.io,
      spec(w, { unknownEvent: true, malformedLine: true, duplicates: true }),
    );
    const reader = createKimiReader();
    const refs = await reader.discover(w.sessions);
    // 正向对照:main 被收;子代理 wire(decoy)存在于磁盘但不被收
    expect(refs.map((r) => r.path)).toEqual([g.file]);
    expect(g.decoyFile).toBeDefined();
    const { events, counts } = await readAll(reader, refs[0]!);
    expect(counts.user_messages).toBe(g.expected.user_messages);
    expect(counts.tool_calls).toBe(g.expected.tool_calls);
    expect(counts.tool_failures).toBe(g.expected.tool_failures);
    expect(counts.unknown_event_types).toEqual(g.expected.unknown_event_types);
    expect(counts.ignored_duplicate_kinds).toEqual(g.expected.ignored_duplicate_kinds);
    expect(events.filter((e) => e.kind === 'user_message')).toHaveLength(3);
    expect(events.filter((e) => e.kind === 'tool_call')).toHaveLength(4);
    expect(events.filter((e) => e.tool_failed === true)).toHaveLength(2);
    // tool_failed 只设在 tool_result 上,tool_call 不设
    expect(
      events.filter((e) => e.kind === 'tool_call').every((e) => e.tool_failed === undefined),
    ).toBe(true);
    expect(
      events
        .filter((e) => e.kind === 'tool_result')
        .every((e) => typeof e.tool_failed === 'boolean'),
    ).toBe(true);
    expect(events.filter((e) => e.kind === 'tool_call').every((e) => e.tool_name === 'shell')).toBe(
      true,
    );
    // 未知行 → kind=unknown + raw_type=未知键;畸形行不产出事件
    expect(events.filter((e) => e.kind === 'unknown').map((e) => e.raw_type)).toEqual([
      'future.thing',
    ]);
  });

  it('user 文本来自 content 的 text 块;assistant 的 text 片段 → assistant_message,think → meta', async () => {
    const w = await newWork('kimi-text-');
    const { events, counts } = await runCustom(w, {
      lines: [
        metadataLine(),
        userMsg('你好 world'),
        loopEv({ type: 'content.part', part: { type: 'text', text: 'hi' } }),
        loopEv({ type: 'content.part', part: { type: 'think', think: '…' } }),
        loopEv({ type: 'content.part', part: 'weird' }),
        loopEv({ type: 'step.begin' }),
        loopEv({ type: 'step.end' }),
      ],
    });
    expect(events.map((e) => e.kind)).toEqual([
      'meta',
      'user_message',
      'assistant_message',
      'meta',
      'meta',
      'meta',
      'meta',
    ]);
    expect(events[1]?.text).toBe('你好 world');
    expect(counts.unknown_event_types).toEqual({});
    expect(counts.user_messages).toBe(1);
  });
});

describe('口径 §7.4 自带夹具(从口径文档抽取,不另抄一份)', () => {
  async function specSection(): Promise<string> {
    const doc = await readText(path.join(REPO_ROOT, 'docs', 'reader-counting-spec.md'));
    const start = doc.indexOf('### 7.4 Kimi');
    const end = doc.indexOf('### 7.5');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return doc.slice(start, end);
  }

  it('夹具 → {2,2,1};unknown / ignored 与文档一致', async () => {
    const sec = await specSection();
    const m = /```jsonl\n([\s\S]*?)\n```/.exec(sec);
    expect(m).not.toBeNull();
    const lines = (m?.[1] ?? '').split('\n');
    expect(lines.length).toBe(14);
    const w = await newWork('kimi-specfx-');
    const { counts, events } = await runCustom(w, { lines, stateJson: null });
    expect({
      u: counts.user_messages,
      c: counts.tool_calls,
      f: counts.tool_failures,
    }).toEqual({ u: 2, c: 2, f: 1 });
    expect(counts.unknown_event_types).toEqual({
      'context.append_loop_event.future.event': 1,
      'brand.new.type': 1,
    });
    expect(counts.ignored_duplicate_kinds).toEqual({ 'turn.prompt': 1, 'turn.steer': 1 });
    expect(events.every((e) => typeof e.ts === 'string' && e.ts !== '')).toBe(true);
  });

  it('已知清单与口径文档 §7.4 的 k_top / k_loop 逐项相等(顺序也一致)', async () => {
    const sec = await specSection();
    const list = (name: string): string[] => {
      const m = new RegExp(`def ${name}: (\\[[^\\]]*\\]);`).exec(sec);
      expect(m, name).not.toBeNull();
      return JSON.parse(m?.[1] ?? '[]') as string[];
    };
    expect([...KNOWN_TOP_TYPES]).toEqual(list('k_top'));
    expect([...KNOWN_LOOP_EVENT_TYPES]).toEqual(list('k_loop'));
    expect(new Set(KNOWN_TOP_TYPES).size).toBe(KNOWN_TOP_TYPES.length);
  });
});

describe('会话文件与 agentId(§2.4.1、C1、C2)', () => {
  it('子代理文件不收:即使里面有 agentId:main 的行;正向对照 main 被收;main 旁的其它文件不收', async () => {
    const w = await newWork('kimi-sub-');
    const g1 = await runCustom(w, {
      id: 'a',
      lines: [metadataLine(), userMsg('main-msg')],
      subagentLines: [metadataLine(), userMsg('sub-msg', { agentId: 'main' })],
      strayFiles: ['other.jsonl', 'wire.jsonl.bak'],
    });
    const refs = await g1.reader.discover(w.sessions);
    expect(refs.map((r) => r.path)).toEqual([g1.g.file]);
    expect(g1.counts.user_messages).toBe(1);
    // 显式把子代理文件当 source 也不返回(显式文件不经 match,但尾部卡了一遍)
    expect(await g1.reader.discover(g1.g.subagentFile as string)).toEqual([]);
    // 显式传主 wire → 收
    expect((await g1.reader.discover(g1.g.file)).map((r) => r.path)).toEqual([g1.g.file]);
    // source 缩到会话目录 / wd 目录也能找到
    expect((await g1.reader.discover(g1.g.sessionDir)).length).toBe(1);
    expect((await g1.reader.discover(path.dirname(g1.g.sessionDir))).length).toBe(1);
  });

  it('agentId:缺失 / null / "main" 收;其它任何值(含非字符串)整行跳过,不计任何键', async () => {
    const w = await newWork('kimi-agentid-');
    const { counts, events } = await runCustom(w, {
      lines: [
        metadataLine(),
        userMsg('a'), // 缺失
        userMsg('b', { agentId: null }),
        userMsg('c', { agentId: 'main' }),
        userMsg('d', { agentId: 'agent-1' }),
        userMsg('e', { agentId: 5 }),
        userMsg('f', { agentId: false }),
        userMsg('g', { agentId: '' }),
        loopEv({ type: 'tool.call', name: 'X', args: {} }, { agentId: 'agent-2' }),
        loopEv({ type: 'tool.result', result: { isError: true } }, { agentId: 'agent-2' }),
        loopEv({ type: 'weird' }, { agentId: 'agent-2' }),
        L({ type: 'turn.prompt', origin: { kind: 'user' }, agentId: 'agent-2' }),
        L({ type: 'brand.new', agentId: 'agent-3' }),
      ],
    });
    expect(counts.user_messages).toBe(3);
    expect(counts.tool_calls).toBe(0);
    expect(counts.tool_failures).toBe(0);
    expect(counts.unknown_event_types).toEqual({});
    expect(counts.ignored_duplicate_kinds).toBeUndefined();
    expect(events.filter((e) => e.kind === 'user_message')).toHaveLength(3);
  });

  it('缺 type:main 行计 <no-type>、不产出事件;侧链行优先(缺 type 的侧链行不计 <no-type>)', async () => {
    const w = await newWork('kimi-notype-');
    const { counts, events } = await runCustom(w, {
      lines: [
        metadataLine(),
        L({ time: T0 }), // 无 type
        L({ type: 7, time: T0 }), // type 非字符串
        L({ type: null }),
        L({ time: T0, agentId: 'agent-1' }), // 侧链且无 type
        L({ type: 'brand.new', agentId: 'agent-1' }),
        '[1,2,3]', // 合法 JSON 非对象 → malformed
        '"str"',
      ],
    });
    expect(counts.unknown_event_types).toEqual({ '<no-type>': 3, '<malformed>': 2 });
    expect(events.map((e) => e.kind)).toEqual(['meta']);
  });
});

describe('user_messages 判定:origin 异常不算、不进 unknown(§2.4.3)', () => {
  it('origin 缺失 / 非对象 / 其它 kind / 未来新 kind / 非 user 角色 / message 非对象 → meta', async () => {
    const w = await newWork('kimi-origin-');
    const { counts, events } = await runCustom(w, {
      lines: [
        metadataLine(),
        userMsg('ok', {}, { kind: 'user', clientMetadata: { a: 1 } }), // 算
        userMsg('x', {}, NO_ORIGIN), // 无 origin
        userMsg('x', {}, 'user'), // origin 是字符串
        userMsg('x', {}, null),
        userMsg('x', {}, []),
        userMsg('x', {}, { kind: 'injection', variant: 'goal' }),
        userMsg('x', {}, { kind: 'system_trigger' }),
        userMsg('x', {}, { kind: 'background_task' }),
        userMsg('x', {}, { kind: 'task' }),
        userMsg('x', {}, { kind: 'skill_activation' }),
        userMsg('x', {}, { kind: 'some-future-kind' }),
        userMsg('x', {}, { kind: 'USER' }),
        userMsg('x', {}, { kind: 1 }),
        L({
          type: 'context.append_message',
          time: T0,
          message: { role: 'assistant', origin: { kind: 'user' }, content: [] },
        }),
        L({
          type: 'context.append_message',
          time: T0,
          message: { role: 'system', origin: { kind: 'user' } },
        }),
        L({ type: 'context.append_message', time: T0, message: 5 }),
        L({ type: 'context.append_message', time: T0 }),
      ],
    });
    expect(counts.user_messages).toBe(1);
    expect(counts.unknown_event_types).toEqual({});
    expect(events.filter((e) => e.kind === 'meta')).toHaveLength(17); // metadata + 16 条非用户
  });
});

describe('工具调用 / 失败(§2.4.3)', () => {
  it('isError 只有严格 true 才算失败;result 缺失/非对象/字符串 "true"/false 都不算', async () => {
    const w = await newWork('kimi-fail-');
    const { counts, events } = await runCustom(w, {
      lines: [
        metadataLine(),
        loopEv({ type: 'tool.call', toolCallId: 'a', name: 'Bash', args: { c: 1 } }),
        loopEv({ type: 'tool.result', toolCallId: 'a', result: { isError: true, output: 'boom' } }),
        loopEv({ type: 'tool.result', toolCallId: 'b', result: { isError: 'true' } }),
        loopEv({ type: 'tool.result', toolCallId: 'c', result: { isError: false } }),
        loopEv({ type: 'tool.result', toolCallId: 'd', result: { isError: 1 } }),
        loopEv({ type: 'tool.result', toolCallId: 'e', result: 'oops' }),
        loopEv({ type: 'tool.result', toolCallId: 'f' }),
        loopEv({ type: 'tool.call' }), // 无 name:仍算一次调用
      ],
    });
    expect(counts.tool_calls).toBe(2);
    expect(counts.tool_failures).toBe(1);
    const calls = events.filter((e) => e.kind === 'tool_call');
    expect(calls[0]?.tool_name).toBe('Bash');
    expect(calls[1]?.tool_name).toBeUndefined();
    expect(events.filter((e) => e.kind === 'tool_result')).toHaveLength(6);
  });

  it('loop event 未知子类型 / event 非对象 / type 非字符串 → context.append_loop_event.<子类型|(none)>', async () => {
    const w = await newWork('kimi-loopunk-');
    const { counts, events } = await runCustom(w, {
      lines: [
        metadataLine(),
        loopEv({ type: 'future.event' }),
        loopEv({ type: 'future.event' }),
        loopEv('str'),
        loopEv(null),
        loopEv({ type: 5 }),
        loopEv({}),
        loopEv({ type: 'tool.call', name: 'ok', args: {} }),
      ],
    });
    expect(counts.unknown_event_types).toEqual({
      'context.append_loop_event.future.event': 2,
      'context.append_loop_event.(none)': 4,
    });
    expect(events.filter((e) => e.kind === 'unknown')).toHaveLength(6);
    expect(counts.tool_calls).toBe(1);
  });

  it('turn.prompt / turn.steer:origin.kind=user → 忽略并计 ignored;其它 origin → meta,不计', async () => {
    const w = await newWork('kimi-dup-');
    const { counts, events } = await runCustom(w, {
      lines: [
        metadataLine(),
        L({ type: 'turn.prompt', time: T0, origin: { kind: 'user' } }),
        L({ type: 'turn.prompt', time: T0, origin: { kind: 'user' } }),
        L({ type: 'turn.prompt', time: T0, origin: { kind: 'injection' } }),
        L({ type: 'turn.prompt', time: T0 }),
        L({ type: 'turn.steer', time: T0, origin: { kind: 'user' } }),
        L({ type: 'turn.steer', time: T0, origin: 'user' }),
      ],
    });
    expect(counts.ignored_duplicate_kinds).toEqual({ 'turn.prompt': 2, 'turn.steer': 1 });
    expect(counts.user_messages).toBe(0);
    expect(events.map((e) => e.kind)).toEqual(['meta', 'meta', 'meta', 'meta']);
    expect(counts.unknown_event_types).toEqual({});
  });
});

describe('ts 与 agent_version(§2.4.4、C3)', () => {
  it('ts = 行内 time(毫秒数);metadata 用 created_at;每个事件 ts 非空', async () => {
    const w = await newWork('kimi-ts-');
    const { events, meta } = await runCustom(w, {
      lines: [
        metadataLine({ created_at: T0 }),
        userMsg('a', { time: T0 + 5000 }),
        loopEv({ type: 'tool.call', name: 'X' }, { time: T0 + 7000 }),
      ],
    });
    expect(events.map((e) => e.ts)).toEqual([
      new Date(T0).toISOString(),
      new Date(T0 + 5000).toISOString(),
      new Date(T0 + 7000).toISOString(),
    ]);
    expect(meta.started_at).toBe(new Date(T0).toISOString());
  });

  it('无效 time(字符串 / 秒级 / 0 / 超大)回退到会话第一个有效时间;全无 → 文件 mtime', async () => {
    const w = await newWork('kimi-tsfb-');
    const a = await runCustom(w, {
      id: 'fa',
      lines: [
        metadataLine({ created_at: T0 }),
        userMsg('s', { time: '2026-01-01T00:00:09Z' }), // Kimi 只认毫秒数字
        userMsg('s', { time: 1767225600 }), // 秒级
        userMsg('s', { time: 0 }),
        userMsg('s', { time: 9e12 }),
        userMsg('s', { time: null }), // null → 用 created_at(无)→ 回退
      ],
    });
    expect(a.events.every((e) => e.ts === new Date(T0).toISOString())).toBe(true);

    const b = await runCustom(w, {
      id: 'fb',
      lines: [L({ type: 'metadata', protocol_version: '1.5' }), userMsg('s', { time: undefined })],
    });
    expect(b.meta.started_at).toBeNull(); // 第 3 级回退时为 null
    expect(b.events).toHaveLength(2);
    for (const e of b.events) expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
  });

  it('agent_version 恒为 null(会话里没有);protocol_version / state.json.version 不是 CLI 版本', async () => {
    const w = await newWork('kimi-ver-');
    const { meta } = await runCustom(w, {
      lines: [
        metadataLine({ protocol_version: '1.4', version: '9.9.9', agent_version: '8.8.8' }),
        userMsg('a'),
      ],
      stateJson: L({ version: 2, cwd: '/x/y' }),
    });
    expect(meta.agent_version).toBeNull();
  });
});

describe('meta:state.json(prepare)与 agentsMdPaths', () => {
  it('cwd_hint 来自同级 state.json,并经只读入口打开(purpose=text,O_RDONLY)', async () => {
    const w = await newWork('kimi-state-');
    const opens: OpenEvent[] = [];
    const prev = setOpenObserver((e) => opens.push(e));
    try {
      const { meta, g } = await runCustom(w, {
        lines: [metadataLine(), userMsg('a')],
        stateJson: L({ version: 2, cwd: '/work/proj-z' }),
      });
      expect(meta.cwd_hint).toBe('/work/proj-z');
      const stateOpen = opens.find((o) => o.path === path.join(g.sessionDir, 'state.json'));
      expect(stateOpen?.purpose).toBe('text');
      expect(opens.length).toBeGreaterThan(0);
      expect(opens.every((o) => o.flags === 'O_RDONLY')).toBe(true);
    } finally {
      setOpenObserver(prev);
    }
  });

  it('旧版 workDir 兜底;cwd 优先于 workDir;缺文件 / 损坏 / 非对象 / 非字符串 → null(不影响计数)', async () => {
    const w = await newWork('kimi-state2-');
    const lines = [metadataLine(), userMsg('a')];
    const run = async (id: string, stateJson: string | null) =>
      (await runCustom(w, { id, lines, stateJson })).meta.cwd_hint;
    expect(await run('s1', L({ workDir: '/old/dir' }))).toBe('/old/dir');
    expect(await run('s2', L({ cwd: '/new', workDir: '/old' }))).toBe('/new');
    expect(await run('s3', L({ cwd: '', workDir: '/old' }))).toBe('/old');
    expect(await run('s4', null)).toBeNull();
    expect(await run('s5', '{not json')).toBeNull();
    expect(await run('s6', '[1]')).toBeNull();
    expect(await run('s7', L({ cwd: 5 }))).toBeNull();
  });

  it('loaded_rule_paths 来自 profile.bind 的顶层 agentsMdPaths:去重累积、过滤非字符串;缺失 → []', async () => {
    const w = await newWork('kimi-rules-');
    const a = await runCustom(w, {
      id: 'ra',
      lines: [
        metadataLine(),
        L({
          type: 'profile.bind',
          time: T0,
          agentsMdPaths: ['/p/AGENTS.md', 5, '', '/p/AGENTS.md'],
        }),
        L({ type: 'profile.bind', time: T0, agentsMdPaths: ['/q/AGENTS.md'] }),
        L({ type: 'profile.bind', time: T0, agentsMdPaths: 'nope' }),
        L({ type: 'profile.bind', time: T0, profile: { agentsMdPaths: ['/nested.md'] } }),
        L({ type: 'config.update', time: T0, agentsMdPaths: ['/other-type.md'] }),
      ],
    });
    expect(a.meta.loaded_rule_paths).toEqual(['/p/AGENTS.md', '/q/AGENTS.md']);
    expect(a.counts.unknown_event_types).toEqual({});
    const b = await runCustom(w, { id: 'rb', lines: [metadataLine(), userMsg('a')] });
    expect(b.meta.loaded_rule_paths).toEqual([]);
  });
});

describe('格式鲁棒性(C2)与超长行(C8)', () => {
  it('BOM / CRLF / 末行无换行:三个计数、unknown 与基线相同', async () => {
    const results: string[] = [];
    for (const [i, variant] of [
      {},
      { bom: true },
      { eol: '\r\n' as const },
      { finalNewline: false },
    ].entries()) {
      const w = await newWork(`kimi-fmt${i}-`);
      const g = await genKimi(
        w.io,
        spec(w, { unknownEvent: true, malformedLine: true, duplicates: true, ...variant }),
      );
      const reader = createKimiReader();
      const refs = await reader.discover(w.sessions);
      const { counts } = await readAll(reader, refs[0]!);
      expect(counts.user_messages).toBe(g.expected.user_messages);
      results.push(JSON.stringify(counts));
    }
    expect(new Set(results).size).toBe(1);
  });

  it('超长行:计数不因 maxEventBytes 改变,只丢 text 并计 oversized_lines', async () => {
    const w = await newWork('kimi-big-');
    const big = 'x'.repeat(5000);
    const lines = [
      metadataLine(),
      userMsg(big),
      loopEv({ type: 'tool.call', name: 'T', args: { big } }),
      loopEv({ type: 'tool.result', result: { isError: true, output: big } }),
    ];
    const small = await runCustom(w, { id: 'o1', lines }, 1000);
    const large = await runCustom(w, { id: 'o2', lines }, 1_000_000);
    expect(small.counts.oversized_lines).toBe(3);
    expect(large.counts.oversized_lines).toBe(0);
    for (const k of ['user_messages', 'tool_calls', 'tool_failures'] as const) {
      expect(small.counts[k]).toBe(large.counts[k]);
    }
    expect(small.events.every((e) => e.text === undefined)).toBe(true);
    expect(large.events.some((e) => e.text === big)).toBe(true);
  });
});
