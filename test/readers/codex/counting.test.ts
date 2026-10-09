import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stat } from '../../../src/io/read-fs.js';
import { writeFile } from '../../../src/io/safe-fs.js';
import { newWork } from '../../signals/helpers.js';
import { LineBuilder, SPEC_FIXTURE_EXPECTED, specFixture, writeRollout } from './build.js';
import { sessionRefFor } from '../../../src/signals/ids.js';
import { SALT, readFile, reader, triple } from './helpers.js';

async function write(prefix: string, b: LineBuilder, id = 's1') {
  const w = await newWork(prefix);
  const file = await writeRollout(w.io, w.sessions, b, { id });
  return { w, file };
}

describe('合成夹具端到端(§7.2 夹具的运行时版)', () => {
  it('三个计数、unknown_event_types、ignored_duplicate_kinds 与口径文档的期望逐项相等', async () => {
    const { file } = await write('cx-spec-', specFixture());
    const { events, counts, meta } = await readFile(file);
    expect(triple(counts)).toEqual([1, 3, 1]);
    expect(counts.unknown_event_types).toEqual(SPEC_FIXTURE_EXPECTED.unknown_event_types);
    expect(counts.ignored_duplicate_kinds).toEqual(SPEC_FIXTURE_EXPECTED.ignored_duplicate_kinds);
    expect(counts.oversized_lines).toBe(0);
    // C5 恒等式:计数只来自事件流
    expect(events.filter((e) => e.kind === 'user_message')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'tool_call')).toHaveLength(3);
    expect(events.filter((e) => e.tool_failed === true)).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'unknown').map((e) => e.raw_type)).toEqual([
      'event_msg.item_completed.FutureThing',
      'event_msg.brand_new_event',
      'brand_new_top',
    ]);
    expect(meta.agent_version).toBe('0.154.0');
    expect(meta.cwd_hint).toBe('/work/proj-a');
  });
});

describe('口径例外谓词:成对用例(每条一正一反)', () => {
  it('用户消息:item_completed(UserMessage) 计;response_item 里的用户消息不计,只进 ignored', async () => {
    const pos = await write('cx-u1-', new LineBuilder().meta().userItem('a'));
    const neg = await write('cx-u2-', new LineBuilder().meta().respUser('a'), 's2');
    const p = await readFile(pos.file);
    const n = await readFile(neg.file);
    expect(p.counts.user_messages).toBe(1);
    expect(p.counts.ignored_duplicate_kinds).toBeUndefined();
    expect(n.counts.user_messages).toBe(0);
    expect(n.counts.ignored_duplicate_kinds).toEqual({ 'response_item.message.user': 1 });
    // 其它 role 的 message 既不计用户消息也不进 ignored
    const dev = await write(
      'cx-u3-',
      new LineBuilder().meta().add({
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [] },
      }),
      's3',
    );
    const d = await readFile(dev.file);
    expect(d.counts.user_messages).toBe(0);
    expect(d.counts.ignored_duplicate_kinds).toBeUndefined();
    expect(d.counts.unknown_event_types).toEqual({});
  });

  it('只有 item_completed 的 UserMessage 计;同类型出现在 response_item.payload 里不计(类型名撞车)', async () => {
    const b = new LineBuilder().meta();
    b.add({
      type: 'response_item',
      payload: { type: 'message', role: 'user', item: { type: 'UserMessage' } },
    });
    b.add({ type: 'event_msg', payload: { type: 'task_started', item: { type: 'UserMessage' } } });
    const { file } = await write('cx-u4-', b);
    const c = (await readFile(file)).counts;
    expect(c.user_messages).toBe(0);
    // 正向前提:两行都被读到并归为已知类型(不是降级成 unknown 才得到 0)
    expect(c.unknown_event_types).toEqual({});
    expect(c.ignored_duplicate_kinds).toEqual({ 'response_item.message.user': 1 });
  });

  it('工具调用:4 种 *_call 各计 1;*_call_output / tool_search_output / event_msg 的 WebSearch 不计', async () => {
    const calls = new LineBuilder().meta();
    calls.call('function_call', { name: 'f' });
    calls.call('custom_tool_call', { name: 'c' });
    calls.call('web_search_call', {});
    calls.call('tool_search_call', {});
    const outs = new LineBuilder().meta();
    outs.call('function_call_output', { output: 'x' });
    outs.call('custom_tool_call_output', { output: 'x' });
    outs.call('tool_search_output', {});
    outs.item({ type: 'WebSearch' });
    outs.item({ type: 'ImageView' });
    const a = await readFile((await write('cx-t1-', calls)).file);
    const c = await readFile((await write('cx-t2-', outs, 's2')).file);
    expect(a.counts.tool_calls).toBe(4);
    expect(a.events.filter((e) => e.kind === 'tool_call').map((e) => e.tool_name)).toEqual([
      'f',
      'c',
      'web_search',
      'tool_search',
    ]);
    expect(c.counts.tool_calls).toBe(0);
    expect(c.counts.unknown_event_types).toEqual({});
    expect(c.counts.ignored_duplicate_kinds).toEqual({
      'event_msg.item_completed.WebSearch': 1,
      'event_msg.item_completed.ImageView': 1,
    });
  });

  it('未知的 *_call(如 local_shell_call)不静默计入:落入未知键', async () => {
    const b = new LineBuilder().meta().call('local_shell_call', {});
    const r = await readFile((await write('cx-t3-', b)).file);
    expect(r.counts.tool_calls).toBe(0);
    expect(r.counts.unknown_event_types).toEqual({ 'response_item.local_shell_call': 1 });
  });

  it('工具失败:5 种工具 item 的 failed 各计 1;completed / declined / 缺 status / 非字符串 status 不计', async () => {
    const failed = new LineBuilder().meta();
    for (const t of [
      'CommandExecution',
      'FileChange',
      'McpToolCall',
      'DynamicToolCall',
      'CollabAgentToolCall',
    ]) {
      failed.toolItem(t, 'failed');
    }
    const notFailed = new LineBuilder().meta();
    notFailed.toolItem('CommandExecution', 'completed');
    notFailed.toolItem('FileChange', 'declined');
    notFailed.item({ type: 'McpToolCall' });
    notFailed.item({ type: 'DynamicToolCall', status: true });
    notFailed.item({ type: 'CollabAgentToolCall', status: 'FAILED' });
    const f = await readFile((await write('cx-f1-', failed)).file);
    const n = await readFile((await write('cx-f2-', notFailed, 's2')).file);
    expect(f.counts.tool_failures).toBe(5);
    expect(f.events.filter((e) => e.tool_failed === true)).toHaveLength(5);
    expect(f.events.filter((e) => e.kind === 'tool_result')).toHaveLength(5);
    expect(n.counts.tool_failures).toBe(0);
    expect(n.events.filter((e) => e.kind === 'tool_result')).toHaveLength(5); // 事件在,只是没失败
    expect(
      n.events.filter((e) => e.kind === 'tool_result').every((e) => e.tool_failed === false),
    ).toBe(true);
  });

  it('非工具类 item 带 status:"failed" 不计失败:已知的(WebSearch/Reasoning/AgentMessage/UserMessage/ImageView)与未知的', async () => {
    const b = new LineBuilder().meta();
    for (const t of [
      'WebSearch',
      'Reasoning',
      'AgentMessage',
      'ImageView',
      'Plan',
      'FutureThing',
    ]) {
      b.toolItem(t, 'failed');
    }
    b.add({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', status: 'failed' } },
    });
    const r = await readFile((await write('cx-f3-', b)).file);
    expect(r.counts.tool_failures).toBe(0);
    expect(r.counts.user_messages).toBe(1); // 正向前提:UserMessage 确实被读到了
    expect(r.counts.ignored_duplicate_kinds).toEqual({
      'event_msg.item_completed.WebSearch': 1,
      'event_msg.item_completed.Reasoning': 1,
      'event_msg.item_completed.AgentMessage': 1,
      'event_msg.item_completed.ImageView': 1,
    });
    expect(r.counts.unknown_event_types).toEqual({ 'event_msg.item_completed.FutureThing': 1 });
    // 同样的 failed 放在 response_item 一侧也不计
    const c = new LineBuilder().meta();
    c.call('function_call', { name: 'x', status: 'failed' });
    c.call('custom_tool_call_output', { status: 'failed', output: 'x' });
    const r2 = await readFile((await write('cx-f4-', c, 's2')).file);
    expect(r2.counts.tool_failures).toBe(0);
    expect(r2.counts.tool_calls).toBe(1);
  });

  it('SubAgentActivity / ContextCompaction / Plan 是 meta,不计任何数', async () => {
    const b = new LineBuilder().meta();
    b.item({ type: 'SubAgentActivity' });
    b.item({ type: 'ContextCompaction' });
    b.item({ type: 'Plan' });
    const r = await readFile((await write('cx-m-', b)).file);
    expect(triple(r.counts)).toEqual([0, 0, 0]);
    expect(r.events.filter((e) => e.kind === 'meta').length).toBe(4); // + session_meta
    expect(r.counts.unknown_event_types).toEqual({});
    expect(r.counts.ignored_duplicate_kinds).toBeUndefined();
  });

  it('assistant 消息:response_item 计 assistant_message;item_completed.AgentMessage 只进 ignored', async () => {
    const b = new LineBuilder().meta().respAssistant('hi').item({ type: 'AgentMessage' });
    const r = await readFile((await write('cx-a-', b)).file);
    expect(r.events.filter((e) => e.kind === 'assistant_message')).toHaveLength(1);
    expect(r.counts.ignored_duplicate_kinds).toEqual({
      'event_msg.item_completed.AgentMessage': 1,
    });
  });
});

describe('未知键格式(§2.2.3)', () => {
  it('缺 payload.type / 缺 item.type 记 (none);非字符串 type 记 <no-type>;未知顶层 type 原样', async () => {
    const b = new LineBuilder().meta();
    b.add({ type: 'response_item', payload: {} });
    b.add({ type: 'response_item' });
    b.add({ type: 'event_msg', payload: { type: 'item_completed' } });
    b.add({ type: 'event_msg', payload: { type: 'item_completed', item: 'x' } });
    b.add({ type: 'event_msg', payload: { type: 7 } });
    b.add({ type: 'turn_context', payload: { cwd: '/x' } }); // 已知,不计
    b.raw({ timestamp: '2026-10-01T00:00:00.000Z', payload: {} });
    b.raw({ type: 3 });
    b.add({ type: 'novel' });
    b.add({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Novel2' } } });
    const r = await readFile((await write('cx-k-', b)).file);
    expect(r.counts.unknown_event_types).toEqual({
      'response_item.(none)': 2,
      'event_msg.item_completed.(none)': 2,
      'event_msg.(none)': 1,
      '<no-type>': 2,
      novel: 1,
      'event_msg.item_completed.Novel2': 1,
    });
    expect(triple(r.counts)).toEqual([0, 0, 0]);
  });
});

describe('会话文件识别(§2.2.1)', () => {
  it('首行 payload.source 是含 subagent 键的对象 → 侧链排除;字符串 source / 无 source 的对象 → 主会话', async () => {
    const w = await newWork('cx-side-');
    const main = await writeRollout(w.io, w.sessions, new LineBuilder().meta().userItem('a'), {
      id: 'main',
    });
    const side = await writeRollout(
      w.io,
      w.sessions,
      new LineBuilder().meta({ source: { subagent: { kind: 'review' } } }).userItem('a'),
      { id: 'side', baseMs: Date.UTC(2026, 9, 2) },
    );
    const objNoSub = await writeRollout(
      w.io,
      w.sessions,
      new LineBuilder().meta({ source: { custom: 'x' } }),
      { id: 'objsrc', baseMs: Date.UTC(2026, 9, 3) },
    );
    const noSource = await writeRollout(
      w.io,
      w.sessions,
      new LineBuilder().add({ type: 'session_meta', payload: { id: 'x' } }),
      { id: 'nosrc', baseMs: Date.UTC(2026, 9, 4) },
    );
    const refs = await reader.discover(w.sessions);
    expect(refs.map((r) => r.path).sort()).toEqual([main, objNoSub, noSource].sort());
    expect(refs.map((r) => r.path)).not.toContain(side);
    // 显式传入侧链文件本身也不是会话
    expect(await reader.discover(side)).toEqual([]);
    expect((await reader.discover(main)).map((r) => r.path)).toEqual([main]);
    for (const r of refs) {
      expect(r.agent).toBe('codex');
      expect(r.bytes).toBe((await stat(r.path)).size);
    }
  });

  it('空文件、空白首行、畸形首行、首行非对象、payload 非对象的文件不是会话;只认文件名 rollout-*.jsonl(不要求目录形状)', async () => {
    const w = await newWork('cx-files-');
    const d = path.join(w.sessions, '2026', '10', '01');
    const ok = await writeRollout(w.io, w.sessions, new LineBuilder().meta(), { id: 'ok' });
    await writeFile(w.io, path.join(d, 'rollout-empty.jsonl'), '');
    await writeFile(w.io, path.join(d, 'rollout-blank.jsonl'), '\n{"type":"session_meta"}\n');
    await writeFile(w.io, path.join(d, 'rollout-trunc.jsonl'), '{"type":"session_meta","payl\n');
    await writeFile(w.io, path.join(d, 'rollout-array.jsonl'), '[1]\n');
    for (const [i, payload] of ['"str"', '[1]', '7', 'true'].entries()) {
      await writeFile(
        w.io,
        path.join(d, `rollout-payload${i}.jsonl`),
        `{"type":"session_meta","payload":${payload}}\n`,
      );
    }
    await writeFile(w.io, path.join(d, 'rollout-.jsonl'), '{"type":"session_meta"}\n');
    await writeFile(w.io, path.join(d, 'other.jsonl'), '{"type":"session_meta"}\n');
    await writeFile(w.io, path.join(d, 'rollout-x.txt'), '{"type":"session_meta"}\n');
    // 首行 JSON null:jq 退出码 0,算主会话
    await writeFile(w.io, path.join(d, 'rollout-null.jsonl'), 'null\n');
    // 目录形状不限:顶层、浅层的 rollout-*.jsonl 只要首行是主会话就收;payload 缺失/为 null 也是主会话
    const top = path.join(w.sessions, 'rollout-top.jsonl');
    await writeFile(w.io, top, '{"type":"session_meta"}\n');
    const shallow = path.join(w.sessions, '2026', '10', 'rollout-shallow.jsonl');
    await writeFile(w.io, shallow, '{"type":"session_meta","payload":null}\n');
    expect((await reader.discover(w.sessions)).map((r) => r.path).sort()).toEqual(
      [ok, top, shallow, path.join(d, 'rollout-.jsonl'), path.join(d, 'rollout-null.jsonl')].sort(),
    );
  });

  it('首行带 BOM 的主会话 / 侧链文件判定不受影响', async () => {
    const w = await newWork('cx-bomhead-');
    const m = await writeRollout(w.io, w.sessions, new LineBuilder().meta(), {
      id: 'm',
      bom: true,
    });
    await writeRollout(w.io, w.sessions, new LineBuilder().meta({ source: { subagent: 1 } }), {
      id: 's',
      bom: true,
      baseMs: Date.UTC(2026, 9, 2),
    });
    expect((await reader.discover(w.sessions)).map((r) => r.path)).toEqual([m]);
  });
});

describe('鲁棒性变体:计数与基线逐项相同(基线非零)', () => {
  it('BOM / CRLF / 末行无换行 / 三者叠加', async () => {
    const w = await newWork('cx-var-');
    const base = await readFile(
      await writeRollout(w.io, w.sessions, specFixture(), { id: 'base' }),
    );
    expect(base.counts.user_messages).toBe(1);
    expect(base.counts.tool_calls).toBe(3);
    expect(base.counts.tool_failures).toBe(1);
    const variants = [
      { bom: true },
      { eol: '\r\n' as const },
      { finalNewline: false },
      { bom: true, eol: '\r\n' as const, finalNewline: false },
    ];
    for (const [i, v] of variants.entries()) {
      const f = await writeRollout(w.io, w.sessions, specFixture(), {
        id: `v${i}`,
        baseMs: Date.UTC(2026, 9, 2 + i),
        ...v,
      });
      const got = await readFile(f);
      expect(got.counts, JSON.stringify(v)).toEqual(base.counts);
      expect(got.meta.agent_version, JSON.stringify(v)).toBe('0.154.0');
    }
  });

  it('末行是被截断的 JSON(正在写入):计 <malformed>,其它计数不变', async () => {
    const b = new LineBuilder().meta().userItem('a').fn();
    b.raw(
      '{"timestamp":"2026-10-01T00:00:09.000Z","type":"event_msg","payload":{"type":"item_comp',
    );
    const w = await newWork('cx-trunc-');
    const r = await readFile(
      await writeRollout(w.io, w.sessions, b, { id: 't', finalNewline: false }),
    );
    expect(triple(r.counts)).toEqual([1, 1, 0]);
    expect(r.counts.unknown_event_types).toEqual({ '<malformed>': 1 });
  });

  it('重复行不去重:逐字节相同的 UserMessage 两行算两条', async () => {
    const b = new LineBuilder().meta();
    const line = {
      timestamp: '2026-10-01T00:00:05.000Z',
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', content: [] } },
    };
    b.raw(line).raw(line);
    const r = await readFile((await write('cx-dup-', b)).file);
    expect(r.counts.user_messages).toBe(2);
  });

  it('超长行:maxEventBytes 取小(触发 oversized)与取大,计数完全相同;只丢那一行的 text', async () => {
    const big = 'Z'.repeat(5000);
    const b = new LineBuilder().meta().userItem('短').userItem(big).fn('f', big).userItem('尾');
    b.item({ type: 'FutureBig', pad: big });
    const w = await newWork('cx-big-');
    const f = await writeRollout(w.io, w.sessions, b, { id: 'big' });
    const roomy = await readFile(f, 1_000_000);
    const tight = await readFile(f, 1000);
    expect(roomy.counts.oversized_lines).toBe(0);
    expect(tight.counts.oversized_lines).toBe(3);
    const strip = (c: typeof roomy.counts) => ({ ...c, oversized_lines: 0 });
    expect(strip(tight.counts)).toEqual(strip(roomy.counts));
    expect(triple(tight.counts)).toEqual([3, 1, 0]);
    expect(roomy.counts.unknown_event_types).toEqual({ 'event_msg.item_completed.FutureBig': 1 });
    const users = (r: typeof roomy) => r.events.filter((e) => e.kind === 'user_message');
    expect(users(roomy).map((e) => e.text)).toEqual(['短', big, '尾']);
    expect(users(tight).map((e) => e.text)).toEqual(['短', undefined, '尾']);
    expect(tight.events.map((e) => e.kind)).toEqual(roomy.events.map((e) => e.kind));
  });
});

describe('非空率与元数据(A6 的非计数项)', () => {
  it('每个事件 agent/session_ref/ts/kind/raw_type 非空;缺时间戳的行回退到会话内第一个有效时间戳', async () => {
    const b = new LineBuilder().meta().userItem('a').fn();
    b.raw({ type: 'event_msg', payload: { type: 'task_started' } }); // 无 timestamp
    b.raw({ timestamp: 'garbage', type: 'event_msg', payload: { type: 'task_complete' } });
    const { file } = await write('cx-ts-', b);
    const r = await readFile(file);
    expect(r.events.length).toBe(5);
    for (const e of r.events) {
      expect(e.agent).toBe('codex');
      expect(e.session_ref).toBe(sessionRefFor(SALT, file));
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
      expect(e.kind).not.toBe('');
      expect(e.raw_type).not.toBe('');
    }
    const first = r.events[0]?.ts;
    expect(r.events.slice(-2).map((e) => e.ts)).toEqual([first, first]);
    expect(r.meta.started_at).toBe(first);
  });

  it('整个文件没有有效时间戳 → 文件 mtime,started_at 为 null', async () => {
    const b = new LineBuilder();
    b.raw({ type: 'session_meta', payload: { cli_version: '0.1.0', cwd: '/w' } });
    b.raw({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage' } },
    });
    const { file } = await write('cx-mtime-', b);
    const r = await readFile(file);
    const mtime = (await stat(file)).mtime.toISOString();
    expect(new Set(r.events.map((e) => e.ts))).toEqual(new Set([mtime]));
    expect(r.meta.started_at).toBeNull();
  });

  it('agent_version 取 session_meta.cli_version,预发布后缀原样保留;取不到为 null(不在 reader 里兜底)', async () => {
    const alpha = await write(
      'cx-ver1-',
      new LineBuilder().meta({ cli_version: '0.149.0-alpha.4.3' }),
    );
    expect((await readFile(alpha.file)).meta.agent_version).toBe('0.149.0-alpha.4.3');
    for (const [i, payload] of [{ cli_version: '' }, { cli_version: 5 }, {}].entries()) {
      const b = new LineBuilder().add({
        type: 'session_meta',
        payload: { source: 'cli', ...payload },
      });
      const x = await write(`cx-ver2-${i}-`, b);
      expect((await readFile(x.file)).meta.agent_version, JSON.stringify(payload)).toBeNull();
    }
  });

  it('agent_version 与 started_at 取第一个 session_meta;cwd_hint 优先 session_meta,缺时取 turn_context', async () => {
    const b = new LineBuilder();
    b.add({
      type: 'session_meta',
      payload: { source: 'cli', timestamp: '2026-09-30T00:00:00.000Z' },
    });
    b.add({ type: 'turn_context', payload: { cwd: '/from/turn' } });
    b.meta({ cli_version: '0.1.0', cwd: '/from/meta' });
    b.meta({ cli_version: '9.9.9', cwd: '/other' });
    const r = await readFile((await write('cx-meta-', b)).file);
    expect(r.meta.agent_version).toBe('0.1.0'); // 第一个非空 cli_version(§7.5 探针)
    expect(r.meta.cwd_hint).toBe('/from/turn'); // 前面没有 session_meta.cwd,turn_context 先到
    expect(r.meta.started_at).toBe('2026-09-30T00:00:00.000Z');
    expect(r.meta.loaded_rule_paths).toEqual([]);
    expect(r.meta.external_content).toBe(false);
  });

  it('web_search_call 的 tool_name 是 web_search(collector 据此判外部内容);工具文本进事件、tool_result 无文本', async () => {
    const b = new LineBuilder().meta();
    b.fn('exec_command', '{"cmd":"ls"}');
    b.call('custom_tool_call', { name: 'apply_patch', input: 'PATCH' });
    b.call('web_search_call', { action: { type: 'search', query: 'q' } });
    b.call('tool_search_call', { arguments: { q: 1 } });
    b.toolItem('CommandExecution', 'failed');
    const r = await readFile((await write('cx-text-', b)).file);
    const calls = r.events.filter((e) => e.kind === 'tool_call');
    expect(calls.map((e) => e.text)).toEqual([
      '{"cmd":"ls"}',
      'PATCH',
      '{"type":"search","query":"q"}',
      '{"q":1}',
    ]);
    expect(r.events.find((e) => e.kind === 'tool_result')?.text).toBeUndefined();
  });

  it('UserMessage 文本:content[] 里 type=text 的 text 用换行连接;缺 content 时事件仍产出(计数不依赖文本)', async () => {
    const b = new LineBuilder().meta();
    b.item({ type: 'UserMessage', content: '纯字符串' });
    b.add({ type: 'response_item', payload: { type: 'message' } }); // 缺 role:meta,不计
    b.item({
      type: 'UserMessage',
      content: [
        { type: 'text', text: '甲' },
        { type: 'image', url: 'x' },
        { type: 'text', text: '乙' },
      ],
    });
    b.item({ type: 'UserMessage' });
    const r = await readFile((await write('cx-utext-', b)).file);
    expect(r.counts.user_messages).toBe(3);
    expect(r.counts.unknown_event_types).toEqual({});
    expect(r.counts.ignored_duplicate_kinds).toBeUndefined();
    expect(r.events.filter((e) => e.kind === 'user_message').map((e) => e.text)).toEqual([
      '纯字符串',
      '甲\n乙',
      undefined,
    ]);
  });
});

describe('raw_type 与 NormEvent 接缝(§6.3)', () => {
  it('已知行的 raw_type 用与未知键同格式的键', async () => {
    const b = new LineBuilder().meta().userItem('a').respAssistant('r');
    b.fn('f')
      .call('custom_tool_call', { name: 'c' })
      .call('web_search_call', {})
      .call('tool_search_call', {});
    b.toolItem('McpToolCall', 'failed').item({ type: 'Plan' });
    b.add({ type: 'turn_context', payload: {} }).event('token_count');
    b.call('function_call_output', {}).call('reasoning', {});
    const r = await readFile((await write('cx-raw-', b)).file);
    expect(r.events.map((e) => e.raw_type)).toEqual([
      'session_meta',
      'event_msg.item_completed.UserMessage',
      'response_item.message',
      'response_item.function_call',
      'response_item.custom_tool_call',
      'response_item.web_search_call',
      'response_item.tool_search_call',
      'event_msg.item_completed.McpToolCall',
      'event_msg.item_completed.Plan',
      'turn_context',
      'event_msg.token_count',
      'response_item.function_call_output',
      'response_item.reasoning',
    ]);
    // tool_failed 只设在 tool_result 上
    expect(r.events.filter((e) => e.tool_failed !== undefined).map((e) => e.kind)).toEqual([
      'tool_result',
    ]);
  });
});
