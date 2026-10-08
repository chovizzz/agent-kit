import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exists, readDir, readText } from '../../../src/io/read-fs.js';
import { mkdirp, symlink, writeFile } from '../../../src/io/safe-fs.js';
import { genPi, genPiRaw, piNode, piUserMsg } from '../../fixtures/sessions/gen-pi.js';
import type { PiSpec } from '../../fixtures/sessions/gen-pi.js';
import { REPO_ROOT, homeSnapshot, sha256File } from '../../signals/helpers.js';
import { newWork, oneRef, readAll, reader } from './helpers.js';
import type { Work } from './helpers.js';

let homeBefore = '';
beforeAll(async () => {
  homeBefore = await homeSnapshot();
});
afterAll(async () => {
  // 真实 HOME 前后无变化(KIT_TMP 不能放在 HOME 之下,所以不改 HOME 变量;reader 不读 HOME 另有静态断言)
  expect(await homeSnapshot()).toBe(homeBefore);
});

describe('reader 源码不碰 HOME / 环境变量 / 子进程', () => {
  it('src/readers/pi/*.ts 不含 homedir / process.env / child_process / node:fs', async () => {
    const dir = path.join(REPO_ROOT, 'src', 'readers', 'pi');
    const files = (await readDir(dir)).filter((e) => e.isFile && e.name.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const text = await readText(path.join(dir, f.name));
      expect(text, f.name).not.toMatch(
        /homedir|process\.env|child_process|node:fs|node:os|\bHOME\b/,
      );
    }
  });
});

function spec(w: Work, over: Partial<PiSpec> = {}): PiSpec {
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

describe('合成夹具对拍:按构造得出的期望', () => {
  it('三个计数 + 未知键 + branch_count;计数恒等于事件流(C5)', async () => {
    const w = await newWork('pi-count-');
    const g = await genPi(w.io, spec(w, { branchEntries: 3, malformedLine: true }));
    const { events, counts, meta } = await readAll(await oneRef(g.file));
    expect(counts.user_messages).toBe(3 + 3); // 含被放弃分支上的 3 条
    expect(counts.user_messages).toBe(g.expected.user_messages);
    expect(counts.tool_calls).toBe(4);
    expect(counts.tool_failures).toBe(2);
    expect(counts.unknown_event_types).toEqual({ '<malformed>': 1 });
    expect(counts.branch_count).toBe(3);
    expect(counts.branch_count).toBe(g.expected.branch_count);
    expect(counts.ignored_duplicate_kinds).toBeUndefined();
    expect(events.filter((e) => e.kind === 'user_message')).toHaveLength(counts.user_messages);
    expect(events.filter((e) => e.kind === 'tool_call')).toHaveLength(counts.tool_calls);
    expect(events.filter((e) => e.tool_failed === true)).toHaveLength(counts.tool_failures);
    // 头不产出事件
    expect(events.some((e) => e.raw_type === 'session')).toBe(false);
    expect(meta.cwd_hint).toBe('/work/proj-a');
    expect(meta.agent_version).toBeNull(); // 会话里没有 → collector_fallback
    expect(meta.started_at).toBe('2026-10-01T00:00:00.000Z');
    expect(meta.loaded_rule_paths).toEqual([]);
  });

  it('单链会话 branch_count 显式为 0(不是缺省);无分支时与 generator 的缺省一致', async () => {
    const w = await newWork('pi-chain-');
    const g = await genPi(w.io, spec(w));
    const { counts } = await readAll(await oneRef(g.file));
    expect(g.expected.branch_count).toBeUndefined();
    expect(counts.branch_count).toBe(0);
  });

  it('未知条目类型:键 = type 值,产出 kind=unknown 事件;它自己是 parentId=null 的根,所以也是分支(多根口径)', async () => {
    const w = await newWork('pi-unk-');
    const g = await genPi(w.io, spec(w, { unknownEvent: true }));
    const { events, counts } = await readAll(await oneRef(g.file));
    expect(counts.unknown_event_types).toEqual(g.expected.unknown_event_types);
    expect(counts.unknown_event_types).toEqual({ mystery_entry: 1 });
    expect(events.filter((e) => e.kind === 'unknown').map((e) => e.raw_type)).toEqual([
      'mystery_entry',
    ]);
    // generator 把未知条目插成第二个根(parentId:null),它不在活动链上
    expect(counts.branch_count).toBe(1);
    expect(counts.user_messages).toBe(3);
  });

  it('BOM / CRLF / 末行无换行:四个计数与基线逐项相同(正向对照:基线非零)', async () => {
    const w = await newWork('pi-variants-');
    const base = spec(w, { branchEntries: 2, unknownEvent: true, malformedLine: true });
    const baseline = (await readAll(await oneRef((await genPi(w.io, base)).file))).counts;
    expect(baseline.tool_calls).toBeGreaterThan(0);
    expect(baseline.branch_count).toBe(3);
    const variants: Partial<PiSpec>[] = [
      { bom: true },
      { eol: '\r\n' },
      { finalNewline: false },
      { bom: true, eol: '\r\n', finalNewline: false },
    ];
    for (const [i, v] of variants.entries()) {
      const g = await genPi(w.io, { ...base, id: `v${i}`, ...v });
      expect((await readAll(await oneRef(g.file))).counts, JSON.stringify(v)).toEqual(baseline);
    }
  });

  it('没有任何时间戳 → 文件 mtime 回退,started_at 为 null;ts 非空率 100%', async () => {
    const w = await newWork('pi-ts-');
    const g = await genPi(w.io, spec(w, { noTimestamps: true }));
    const { events, meta } = await readAll(await oneRef(g.file));
    expect(meta.started_at).toBeNull();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('ts 取条目顶层 timestamp,不取 message.timestamp(毫秒数)', async () => {
    const w = await newWork('pi-tsfield-');
    const g = await genPiRaw(w.io, {
      root: w.sessions,
      cwd: '/w/p',
      id: 'ts1',
      lines: [
        {
          type: 'message',
          id: 'a1',
          parentId: null,
          timestamp: '2026-01-02T03:04:05.000Z',
          message: { role: 'user', content: 'hi', timestamp: 1767225601000 },
        },
      ],
    });
    const { events } = await readAll(await oneRef(g.file));
    expect(events.map((e) => e.ts)).toEqual(['2026-01-02T03:04:05.000Z']);
  });

  it('读取不改变会话文件(sha256 前后相同)', async () => {
    const w = await newWork('pi-ro-');
    const g = await genPi(w.io, spec(w, { branchEntries: 1 }));
    const before = await sha256File(g.file);
    await readAll(await oneRef(g.file));
    expect(await sha256File(g.file)).toBe(before);
  });
});

describe('口径表 §7.3 的合成夹具(分支 + 未知条目)', () => {
  it('期望 user 3 / tool_calls 3 / failures 1 / unknown {future_entry:1} / branch_count 3', async () => {
    const w = await newWork('pi-spec73-');
    const t = (n: number): string => `2026-01-01T00:00:0${n}.000Z`;
    const lines = [
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        timestamp: t(1),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1767225601000,
        },
      },
      {
        type: 'message',
        id: 'a2',
        parentId: 'a1',
        timestamp: t(2),
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
            { type: 'toolCall', id: 'c2', name: 'read', arguments: {} },
          ],
          stopReason: 'toolUse',
        },
      },
      {
        type: 'message',
        id: 'a3',
        parentId: 'a2',
        timestamp: t(3),
        message: {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [],
          isError: true,
        },
      },
      {
        type: 'message',
        id: 'a4',
        parentId: 'a3',
        timestamp: t(4),
        message: {
          role: 'toolResult',
          toolCallId: 'c2',
          toolName: 'read',
          content: [],
          isError: false,
        },
      },
      {
        type: 'message',
        id: 'b1',
        parentId: 'a1',
        timestamp: t(5),
        message: { role: 'user', content: 'abandoned branch' },
      },
      {
        type: 'message',
        id: 'b2',
        parentId: 'b1',
        timestamp: t(6),
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c3', name: 'bash', arguments: {} }],
        },
      },
      {
        type: 'custom_message',
        id: 'b3',
        parentId: 'b2',
        customType: 'x',
        content: 'inj',
        display: false,
        timestamp: t(7),
      },
      {
        type: 'message',
        id: 'a5',
        parentId: 'a4',
        timestamp: t(8),
        message: { role: 'user', content: 'live branch' },
      },
      { type: 'future_entry', id: 'a6', parentId: 'a5', timestamp: t(9) },
    ];
    const g = await genPiRaw(w.io, { root: w.sessions, cwd: '/w/p', id: 'p1', lines });
    const { counts, events } = await readAll(await oneRef(g.file));
    expect(counts.user_messages).toBe(3);
    expect(counts.tool_calls).toBe(3);
    expect(counts.tool_failures).toBe(1);
    expect(counts.unknown_event_types).toEqual({ future_entry: 1 });
    expect(counts.branch_count).toBe(3);
    // custom_message 不是用户消息
    expect(events.filter((e) => e.raw_type === 'custom_message')[0]?.kind).toBe('meta');
  });
});

describe('树结构边界(§2.3.4)', () => {
  const U = piUserMsg('x');
  async function branch(w: Work, id: string, lines: Record<string, unknown>[]) {
    const g = await genPiRaw(w.io, { root: w.sessions, cwd: '/w/p', id, lines });
    return (await readAll(await oneRef(g.file))).counts;
  }

  it('单链:0', async () => {
    const w = await newWork('pi-t-chain-');
    const c = await branch(w, 'c', [
      piNode('a1', null, U),
      piNode('a2', 'a1', U),
      piNode('a3', 'a2', U),
    ]);
    expect(c.branch_count).toBe(0);
    expect(c.user_messages).toBe(3);
  });

  it('活动链 = 最后一个节点的祖先链:最后落在旧分支上,原主链改记为分支(写入顺序敏感)', async () => {
    const w = await newWork('pi-t-lastbranch-');
    const c = await branch(w, 'l', [
      piNode('a1', null, U),
      piNode('a2', 'a1', U),
      piNode('a3', 'a2', U),
      piNode('b1', 'a1', U), // 最后追加,挂在 a1 下
    ]);
    expect(c.branch_count).toBe(2); // a2、a3 不在 b1→a1 链上
  });

  it('断链:parentId 指向不存在的 id,链在该点终止,其余全算分支', async () => {
    const w = await newWork('pi-t-dangling-');
    const c = await branch(w, 'd', [
      piNode('a1', null, U),
      piNode('a2', 'a1', U),
      piNode('a3', 'zzz', U),
    ]);
    expect(c.branch_count).toBe(2);
  });

  it('成环:自指、两节点互指,不死循环;环上节点都在「链」上', async () => {
    const w = await newWork('pi-t-cycle-');
    const self = await branch(w, 'c1', [piNode('a1', null, U), piNode('a2', 'a2', U)]);
    expect(self.branch_count).toBe(1); // a1 不在 a2 的链上
    const two = await branch(w, 'c2', [
      piNode('a1', null, U),
      piNode('x', 'y', U),
      piNode('y', 'x', U),
    ]);
    expect(two.branch_count).toBe(1);
    const tail = await branch(w, 'c3', [
      piNode('a1', null, U),
      piNode('x', 'y', U),
      piNode('y', 'x', U),
      piNode('t', 'x', U), // 最后一个节点挂在环上:链 = t→x→y(→x…)
    ]);
    expect(tail.branch_count).toBe(1); // 只有 a1
  });

  it('重复 id:后出现者覆盖父子关系,每个条目各自计数', async () => {
    const w = await newWork('pi-t-dup-');
    // b 出现两次,第二次把父改成 null;最后一个条目就是 b → 链只有 b
    const a = await branch(w, 'd1', [
      piNode('a', null, U),
      piNode('b', 'a', U),
      piNode('c', 'b', U),
      piNode('b', null, U),
    ]);
    expect(a.branch_count).toBe(2); // a、c;两条 b 都在链上
    // 覆盖后互指成环:a→b、b→a,不死循环,全在链上
    const cyc = await branch(w, 'd2', [
      piNode('a', null, U),
      piNode('b', 'a', U),
      piNode('a', 'b', U),
    ]);
    expect(cyc.branch_count).toBe(0);
    // 不在链上的重复 id 按条目数计
    const off = await branch(w, 'd3', [
      piNode('r', null, U),
      piNode('x', 'r', U),
      piNode('x', 'r', U),
      piNode('t', 'r', U),
    ]);
    expect(off.branch_count).toBe(2); // 两条 x
  });

  it('无字符串 id 的行不是树节点:既不在链上也不计分支,也不改变叶子;头(含重复的 session 行)不是节点', async () => {
    const w = await newWork('pi-t-noid-');
    const c = await branch(w, 'n', [
      piNode('a1', null, U),
      piNode('a2', 'a1', U),
      piNode(undefined, 'a2', U), // 无 id
      { id: 5, parentId: 'a2', ...U }, // 数字 id
      { id: null, parentId: 'a2', ...U },
      { type: 'session', id: 's9', parentId: null, version: 3 }, // 重复头
    ]);
    expect(c.branch_count).toBe(0);
    expect(c.user_messages).toBe(5); // 无 id 的 message 行照样计用户消息(口径:计数覆盖全部 message 条目)
  });

  it('多个根:不在活动链上的根及其后代全算分支', async () => {
    const w = await newWork('pi-t-roots-');
    const c = await branch(w, 'r', [
      piNode('r1', null, U),
      piNode('r1c', 'r1', U),
      piNode('r2', null, U),
      piNode('c', 'r2', U),
    ]);
    expect(c.branch_count).toBe(2);
  });

  it('parentId 不是字符串(数字/布尔/对象):当作无父,不崩', async () => {
    const w = await newWork('pi-t-badparent-');
    const c = await branch(w, 'b', [
      piNode('a1', null, U),
      piNode('a2', 5, U),
      piNode('a3', { x: 1 }, U),
    ]);
    expect(c.branch_count).toBe(2); // 链 = a3;a1、a2 不在
  });

  it('缺 type 但带字符串 id 的行:是树节点,同时计 <no-type>', async () => {
    const w = await newWork('pi-t-notype-');
    const c = await branch(w, 't', [
      piNode('a1', null, U),
      piNode('a2', 'a1', U),
      { id: 't1', parentId: 'a1' },
    ]);
    expect(c.unknown_event_types).toEqual({ '<no-type>': 1 });
    expect(c.branch_count).toBe(1); // a2
  });

  it('未知类型条目、各种 role 的条目都是树节点', async () => {
    const w = await newWork('pi-t-types-');
    const c = await branch(w, 'k', [
      piNode('a1', null, U),
      piNode('a2', 'a1', { type: 'compaction' }),
      piNode('a3', 'a1', { type: 'brand_new' }), // 最后一个 → 链 a3→a1;a2 是分支
    ]);
    expect(c.branch_count).toBe(1);
  });

  it('长链(5 万节点)与长环:迭代遍历不爆栈,耗时有界', async () => {
    const w = await newWork('pi-t-deep-');
    const N = 50_000;
    const chain: Record<string, unknown>[] = [];
    for (let i = 0; i < N; i++)
      chain.push(piNode(`n${i}`, i === 0 ? null : `n${i - 1}`, { type: 'custom' }));
    expect((await branch(w, 'deep', chain)).branch_count).toBe(0);
    const ring: Record<string, unknown>[] = [];
    for (let i = 0; i < N; i++) ring.push(piNode(`n${i}`, `n${(i + 1) % N}`, { type: 'custom' }));
    expect((await branch(w, 'ring', ring)).branch_count).toBe(0);
  });
});

describe('分类与未知键', () => {
  async function run(w: Work, id: string, lines: (Record<string, unknown> | string)[]) {
    const g = await genPiRaw(w.io, { root: w.sessions, cwd: '/w/p', id, lines });
    return readAll(await oneRef(g.file));
  }
  const m = (id: string, message: unknown) => piNode(id, null, { type: 'message', message });

  it('已知条目类型/role/块类型全部不计 unknown;system、bashExecution、custom 等 role 为 meta 且不计数', async () => {
    const w = await newWork('pi-known-');
    const entryTypes = [
      'custom_message',
      'context_edit',
      'custom',
      'model_change',
      'thinking_level_change',
      'compaction',
      'session_info',
      'usage',
      'branch_summary',
      'label',
    ];
    const roles = ['system', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary'];
    const { counts, events } = await run(w, 'k', [
      ...entryTypes.map((t, i) => piNode(`e${i}`, null, { type: t })),
      ...roles.map((r, i) => m(`r${i}`, { role: r, content: [{ type: 'toolCall', name: 'x' }] })),
      m('u', { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image' }] }),
      m('as', {
        role: 'assistant',
        content: [{ type: 'thinking' }, { type: 'text', text: 't' }, { type: 'image' }],
      }),
    ]);
    expect(counts.unknown_event_types).toEqual({});
    expect(counts.user_messages).toBe(1);
    expect(counts.tool_calls).toBe(0); // bashExecution/system 等 role 里的 toolCall 块不计
    // assistant 的 image 块:口径表 §2.3.2「其它 → unknown」事件,但它是已知块,不进 unknown_event_types
    expect(events.filter((e) => e.kind === 'unknown').map((e) => e.raw_type)).toEqual([
      'message.assistant.image',
    ]);
    // user 里的 image 块既无事件也无键;thinking → meta
    expect(events.filter((e) => e.kind === 'meta').length).toBe(
      entryTypes.length + roles.length + 1,
    );
  });

  it('未知键格式:message.(none) / message.<role> / message.<role>.<块> / (none) 块;块只在 user/assistant/toolResult 里查', async () => {
    const w = await newWork('pi-unkkeys-');
    const { counts, events } = await run(w, 'u', [
      piNode('x1', null, { type: 'message' }), // 没有 message
      m('x2', 'not-an-object'), // message 非对象
      m('x3', { content: 'no role' }),
      m('x4', { role: 7 }), // role 非字符串
      m('x5', { role: 'wizard' }),
      m('x6', {
        role: 'user',
        content: [{ type: 'audio' }, { text: 'no type' }, 'str', 5, null, [1]],
      }),
      m('x7', { role: 'assistant', content: [{ type: 'video' }, { type: 5 }] }),
      m('x8', { role: 'toolResult', content: [{ type: 'file' }] }),
      m('x9', { role: 'system', content: [{ type: 'file' }] }), // system 不查块
      m('y1', { role: 'user', content: 'string content is not blocks' }),
      m('y2', { role: 'assistant', content: { type: 'audio' } }), // 非数组内容不查块
    ]);
    expect(counts.unknown_event_types).toEqual({
      'message.(none)': 4,
      'message.wizard': 1,
      'message.user.audio': 1,
      'message.user.(none)': 1,
      'message.assistant.video': 1,
      'message.assistant.(none)': 1,
      'message.toolResult.file': 1,
    });
    // 未知块不影响所在条目的计数:x6 与 y1 仍是用户消息,x8 仍是 tool_result
    expect(counts.user_messages).toBe(2);
    expect(events.filter((e) => e.kind === 'tool_result')).toHaveLength(1);
    // 事件:未知条目/role 各一个 unknown 事件;「每块一事件」只限 assistant;user/toolResult 的未知块只记键
    expect(events.filter((e) => e.kind === 'unknown').map((e) => e.raw_type)).toEqual([
      'message.(none)',
      'message.(none)',
      'message.(none)',
      'message.(none)',
      'message.wizard',
      'message.assistant.video',
      'message.assistant.(none)',
    ]);
    expect(events.filter((e) => e.kind === 'user_message')).toHaveLength(2);
  });

  it('计数规则:toolCall 只数 assistant 的数组块;isError 只有 true 才算失败;user/toolResult 里的 toolCall 块不计', async () => {
    const w = await newWork('pi-rules-');
    const { counts, events } = await run(w, 'r', [
      m('a1', {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'bash', arguments: { c: 1 } },
          { type: 'toolCall', arguments: {} },
          { type: 'text', text: 'x' },
        ],
      }),
      m('a2', { role: 'assistant', content: 'toolCall' }), // 字符串内容 → 0
      m('u1', { role: 'user', content: [{ type: 'toolCall', name: 'bash' }] }), // user 里的不计
      m('t1', {
        role: 'toolResult',
        toolName: 'bash',
        isError: true,
        content: [{ type: 'toolCall', name: 'z' }],
      }),
      m('t2', { role: 'toolResult', toolName: 'bash', isError: 'true' }),
      m('t3', { role: 'toolResult', toolName: 'bash', isError: 1 }),
      m('t4', { role: 'toolResult', toolName: 'read' }),
      m('t5', { role: 'toolResult', isError: false }),
    ]);
    expect(counts.tool_calls).toBe(2);
    expect(counts.tool_failures).toBe(1);
    const calls = events.filter((e) => e.kind === 'tool_call');
    expect(calls.map((e) => e.tool_name)).toEqual(['bash', undefined]);
    const results = events.filter((e) => e.kind === 'tool_result');
    expect(results.map((e) => e.tool_failed)).toEqual([true, false, false, false, false]);
    expect(results.map((e) => e.tool_name)).toEqual(['bash', 'bash', 'bash', 'read', undefined]);
    // tool_call 事件不设 tool_failed(契约:只在 tool_result 上设置)
    expect(calls.every((e) => e.tool_failed === undefined)).toBe(true);
  });

  it('畸形行 / 非对象行 / 空白行', async () => {
    const w = await newWork('pi-mal-');
    const { counts } = await run(w, 'm', [
      piNode('a1', null, piUserMsg('x')),
      '[1,2]',
      '"s"',
      '   ',
      '{"type":"message","id":"zz","message":{"role":"user","content":"trunc',
    ]);
    expect(counts.unknown_event_types).toEqual({ '<malformed>': 3 });
    expect(counts.user_messages).toBe(1);
    expect(counts.branch_count).toBe(0); // 畸形行不是节点
  });

  it('超长行:计数与未知键不随 maxEventBytes 改变,树也照常记节点(C8)', async () => {
    const w = await newWork('pi-big-');
    const g = await genPiRaw(w.io, {
      root: w.sessions,
      cwd: '/w/p',
      id: 'big',
      lines: [
        piNode('a1', null, piUserMsg('Z'.repeat(5000))),
        piNode('a2', 'a1', {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', name: 'bash', arguments: { c: 'Y'.repeat(5000) } }],
          },
        }),
        piNode('b1', 'a1', piUserMsg('branch')),
      ],
    });
    const ref = await oneRef(g.file);
    const roomy = await readAll(ref, 1_000_000);
    const tight = await readAll(ref, 1000);
    expect(roomy.counts.oversized_lines).toBe(0);
    expect(tight.counts.oversized_lines).toBe(2);
    const strip = (c: typeof roomy.counts) => ({ ...c, oversized_lines: 0 });
    expect(strip(tight.counts)).toEqual(strip(roomy.counts));
    expect(roomy.counts.branch_count).toBe(1);
    expect(roomy.counts.tool_calls).toBe(1);
    expect(tight.events.every((e) => e.text === undefined || e.text.length <= 1000)).toBe(true);
    expect(roomy.events.find((e) => e.kind === 'user_message')?.text?.length).toBe(5000);
  });
});

describe('project_context 的加载文件列表(仅采集)', () => {
  async function metaOf(w: Work, id: string, content: unknown) {
    const g = await genPiRaw(w.io, {
      root: w.sessions,
      cwd: '/w/p',
      id,
      lines: [
        piNode('s1', null, {
          type: 'message',
          message: { role: 'system', content: 'sys', sections: { project_context: content } },
        }),
      ],
    });
    return readAll(await oneRef(g.file));
  }
  const tag = (p: string): string =>
    `<project_instructions path="${p}">\nbody\n</project_instructions>\n`;

  it('从 <project_instructions path="…"> 取绝对路径,去重保序;相对路径、过长路径不收;事件不带 system 正文', async () => {
    const w = await newWork('pi-rules-meta-');
    const long = '/' + 'a'.repeat(1100);
    const { meta, events, counts } = await metaOf(
      w,
      'p1',
      [
        tag('/w/p/AGENTS.md'),
        tag('/w/CLAUDE.md'),
        tag('/w/p/AGENTS.md'),
        tag('rel/AGENTS.md'),
        tag(long),
      ].join('SECRET-BODY'),
    );
    expect(meta.loaded_rule_paths).toEqual(['/w/p/AGENTS.md', '/w/CLAUDE.md']);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('meta');
    expect(events[0]?.text).toBeUndefined();
    expect(counts.user_messages).toBe(0);
  });

  it('结构不符(非字符串 / 无标签 / sections 缺失)→ 空列表,不抛错', async () => {
    const w = await newWork('pi-rules-bad-');
    for (const [i, v] of [undefined, 5, { a: 1 }, ['x'], 'no tags here'].entries()) {
      expect((await metaOf(w, `b${i}`, v)).meta.loaded_rule_paths, String(i)).toEqual([]);
    }
  });

  it('最多收 64 条', async () => {
    const w = await newWork('pi-rules-cap-');
    const many = Array.from({ length: 100 }, (_, i) => tag(`/w/f${i}.md`)).join('');
    expect((await metaOf(w, 'cap', many)).meta.loaded_rule_paths).toHaveLength(64);
  });

  it('重复路径不占 64 条的名额', async () => {
    const w = await newWork('pi-rules-dedupe-');
    const dupes = Array.from({ length: 100 }, () => tag('/w/same.md')).join('');
    const tail = ['/w/x1.md', '/w/x2.md', '/w/x3.md'].map(tag).join('');
    expect((await metaOf(w, 'dd', dupes + tail)).meta.loaded_rule_paths).toEqual([
      '/w/same.md',
      '/w/x1.md',
      '/w/x2.md',
      '/w/x3.md',
    ]);
  });

  it('只看 system 消息:其它 role 里出现同样的标签不收', async () => {
    const w = await newWork('pi-rules-role-');
    const g = await genPiRaw(w.io, {
      root: w.sessions,
      cwd: '/w/p',
      id: 'role',
      lines: [
        piNode('u1', null, {
          type: 'message',
          message: {
            role: 'user',
            content: tag('/w/evil.md'),
            sections: { project_context: tag('/w/evil.md') },
          },
        }),
      ],
    });
    expect((await readAll(await oneRef(g.file))).meta.loaded_rule_paths).toEqual([]);
  });
});

describe('discover', () => {
  async function put(w: Work, rel: string, content: string): Promise<string> {
    const f = path.join(w.sessions, rel);
    await mkdirp(w.io, path.dirname(f));
    await writeFile(w.io, f, content);
    return f;
  }
  const HEAD =
    '{"type":"session","version":3,"id":"x","timestamp":"2026-10-01T00:00:00.000Z","cwd":"/w"}\n';

  it('只收 --<路径>--/*.jsonl(深度 1);非 jsonl、普通目录、更深层都不收;结果有序', async () => {
    const w = await newWork('pi-disc-');
    const keepB = await put(w, '--b--/2.jsonl', HEAD);
    const keepA = await put(w, '--a--/1.jsonl', HEAD);
    await put(w, '--a--/notes.txt', 'x');
    await put(w, '--a--/1.jsonl.bak', HEAD);
    await put(w, 'plain/3.jsonl', HEAD);
    await put(w, '--c--/deep/4.jsonl', HEAD);
    await put(w, 'top.jsonl', HEAD);
    const refs = await reader.discover(w.sessions);
    expect(refs.map((r) => r.path)).toEqual([keepA, keepB]);
    expect(refs.every((r) => r.agent === 'pi' && r.bytes === HEAD.length)).toBe(true);
  });

  it('首行是另一种格式(type 为字符串且不是 session)的文件不收;空文件/首行畸形/BOM 头照收', async () => {
    const w = await newWork('pi-disc-head-');
    await put(w, '--a--/foreign.jsonl', '{"type":"user","message":{}}\n' + HEAD);
    const empty = await put(w, '--a--/empty.jsonl', '');
    const broken = await put(w, '--a--/broken.jsonl', '{"type":"sess\n' + HEAD);
    const bom = await put(w, '--a--/bom.jsonl', '﻿' + HEAD);
    const blankFirst = await put(w, '--a--/blank.jsonl', '\n  \n' + HEAD);
    const refs = await reader.discover(w.sessions);
    expect(refs.map((r) => path.basename(r.path)).sort()).toEqual(
      [bom, blankFirst, broken, empty].map((p) => path.basename(p)).sort(),
    );
  });

  it('符号链接(目录、文件)不跟随', async () => {
    const w = await newWork('pi-disc-link-');
    const real = await put(w, '--a--/1.jsonl', HEAD);
    const outside = await put(w, 'elsewhere/2.jsonl', HEAD);
    await symlink(w.io, path.join(w.sessions, 'elsewhere'), path.join(w.sessions, '--link--'));
    await symlink(w.io, outside, path.join(w.sessions, '--a--', 'ln.jsonl'));
    expect((await reader.discover(w.sessions)).map((r) => r.path)).toEqual([real]);
  });

  it('source 不存在:discover 以 ENOENT 拒绝(由 collect 命令映射成用法错误),不返回空列表', async () => {
    const w = await newWork('pi-disc-missing-');
    await expect(reader.discover(path.join(w.dir, 'nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('显式传入单个文件:原样接受(不按目录名/首行过滤)', async () => {
    const w = await newWork('pi-disc-file-');
    const f = await put(w, 'anywhere/x.jsonl', '{"type":"user"}\n');
    expect((await reader.discover(f)).map((r) => r.path)).toEqual([f]);
  });

  it('discover 与 read 不写盘:目录树前后一致,会话文件不变', async () => {
    const w = await newWork('pi-disc-ro-');
    const f = await put(w, '--a--/1.jsonl', HEAD);
    const before = await sha256File(f);
    await readAll((await reader.discover(w.sessions))[0] as never);
    expect(await sha256File(f)).toBe(before);
    expect(await exists(path.join(w.sessions, '--a--', '.lock'))).toBe(false);
    expect((await readText(f)).length).toBe(HEAD.length);
  });
});
