/**
 * 验收 ②:口径表里每个例外谓词(U0–U9)各有「违规 → 不计」与「合规 → 计」的成对用例。
 * 每对只在被测谓词上不同;违规行必须仍产出一个 meta(raw_type=user),不能被静默丢掉。
 */
import { describe, expect, it } from 'vitest';
import {
  u0ContentShape,
  u1NoToolResult,
  u2NotMeta,
  u3NotCompactSummary,
  u4NotTranscriptOnly,
  u5NotInterrupted,
  u6NotScheduled,
  u7HumanOrigin,
  u8HumanTurn,
  u9NotCommandOutput,
} from '../../../src/readers/claude/predicates.js';
import { newWork, readLines, textBlock, toolResult, userLine } from './helpers.js';

type Obj = Record<string, unknown>;
interface Pair {
  id: string;
  /** 违规行(不计) */
  bad: Obj;
  /** 合规行(计) */
  good: Obj;
  /** 该谓词的直接单元断言 */
  pred: (line: Record<string, unknown>) => boolean;
}

const PAIRS: Pair[] = [
  {
    id: 'U0 message.content 形态',
    bad: userLine(null),
    good: userLine('hello'),
    pred: u0ContentShape,
  },
  {
    id: 'U0 message 不是对象',
    bad: { ...userLine('x'), message: 'not-an-object' },
    good: userLine([textBlock('hello')]),
    pred: u0ContentShape,
  },
  {
    id: 'U1 混合行(tool_result + text)',
    bad: userLine([toolResult('t1'), textBlock('mixed')]),
    good: userLine([textBlock('mixed')]),
    pred: u1NoToolResult,
  },
  {
    id: 'U2 isMeta',
    bad: userLine('hello', { isMeta: true }),
    good: userLine('hello', { isMeta: false }),
    pred: u2NotMeta,
  },
  {
    id: 'U3 isCompactSummary',
    bad: userLine('hello', { isCompactSummary: true }),
    good: userLine('hello', { isCompactSummary: false }),
    pred: u3NotCompactSummary,
  },
  {
    id: 'U4 isVisibleInTranscriptOnly',
    bad: userLine('hello', { isVisibleInTranscriptOnly: true }),
    good: userLine('hello', { isVisibleInTranscriptOnly: false }),
    pred: u4NotTranscriptOnly,
  },
  {
    id: 'U5 interruptedMessageId',
    bad: userLine('hello', { interruptedMessageId: 'm-1' }),
    good: userLine('hello', { interruptedMessageId: null }),
    pred: u5NotInterrupted,
  },
  {
    id: 'U6 scheduledTaskId',
    bad: userLine('hello', { scheduledTaskId: 'task-1' }),
    good: userLine('hello', { scheduledTaskId: null }),
    pred: u6NotScheduled,
  },
  {
    id: 'U7 origin.kind',
    bad: userLine('hello', { origin: { kind: 'task-notification' } }),
    good: userLine('hello', { origin: { kind: 'human' } }),
    pred: u7HumanOrigin,
  },
  {
    id: 'U8 turnOrigin',
    bad: userLine('hello', { turnOrigin: 'scheduled' }),
    good: userLine('hello', { turnOrigin: 'human' }),
    pred: u8HumanTurn,
  },
  {
    id: 'U9 local-command-stdout',
    bad: userLine('<local-command-stdout>out</local-command-stdout>'),
    good: userLine('see <local-command-stdout> in the log'),
    pred: u9NotCommandOutput,
  },
  {
    id: 'U9 local-command-caveat(含前导空白)',
    bad: userLine('  \n\t<local-command-caveat>c</local-command-caveat>'),
    good: userLine('x <local-command-caveat>c'),
    pred: u9NotCommandOutput,
  },
  {
    id: 'U9 [Request interrupted(块数组)',
    bad: userLine([textBlock('[Request interrupted by user for tool use]')]),
    good: userLine([textBlock('request interrupted? no: [Request interrupted is quoted')]),
    pred: u9NotCommandOutput,
  },
];

describe('U0–U9:违规 → 不计,合规 → 计(成对)', () => {
  for (const p of PAIRS) {
    it(p.id, async () => {
      const w = await newWork('cl-pred-');
      // 谓词本身
      expect(p.pred(p.bad), '违规行谓词应为 false').toBe(false);
      expect(p.pred(p.good), '合规行谓词应为 true').toBe(true);
      // 经 reader 端到端
      const bad = await readLines(w, [p.bad]);
      expect(bad.counts.user_messages).toBe(0);
      expect(bad.events.filter((e) => e.kind === 'user_message')).toHaveLength(0);
      const good = await readLines(w, [p.good]);
      expect(good.counts.user_messages).toBe(1);
      const ev = good.events.find((e) => e.kind === 'user_message');
      expect(ev?.raw_type).toBe('user');
      // 违规行没有被静默丢掉:变成一个 meta;也不进 unknown
      expect(bad.events.map((e) => `${e.kind}:${e.raw_type}`)).toContain(
        p.id.startsWith('U1') ? 'tool_result:user.tool_result' : 'meta:user',
      );
      expect(bad.counts.unknown_event_types).toEqual({});
      expect(good.counts.unknown_event_types).toEqual({});
    });
  }
});

describe('U 谓词的边界(缺失/null/奇形值)', () => {
  const countOf = async (line: Obj): Promise<number> => {
    const w = await newWork('cl-pred-edge-');
    return (await readLines(w, [line])).counts.user_messages;
  };

  it('缺 origin / origin 为 null / origin 非对象 / kind 缺失或 null:视为 human,计', async () => {
    expect(await countOf(userLine('x'))).toBe(1);
    expect(await countOf(userLine('x', { origin: null }))).toBe(1);
    expect(await countOf(userLine('x', { origin: 'peer' }))).toBe(1); // 非对象 → human
    expect(await countOf(userLine('x', { origin: ['peer'] }))).toBe(1); // 数组也是非对象 → human
    expect(await countOf(userLine('x', { origin: {} }))).toBe(1);
    expect(await countOf(userLine('x', { origin: { kind: null } }))).toBe(1);
  });

  it('origin.kind 为任何非 "human" 的值(含非字符串、未来新值):不计', async () => {
    for (const kind of ['peer', 'auto-continuation', 'Human', '', 5, false, ['human']]) {
      expect(await countOf(userLine('x', { origin: { kind } })), JSON.stringify(kind)).toBe(0);
    }
  });

  it('turnOrigin 缺失/null:计;任何非 "human" 的值:不计', async () => {
    expect(await countOf(userLine('x', { turnOrigin: null }))).toBe(1);
    for (const v of [
      'sdk',
      'task_notification',
      'system',
      'scheduled',
      'peer',
      'auto_continuation',
      'Human',
      1,
      true,
    ]) {
      expect(await countOf(userLine('x', { turnOrigin: v })), JSON.stringify(v)).toBe(0);
    }
  });

  it('isMeta 等布尔位只认严格 true("true" 字符串、1 不算)', async () => {
    for (const k of ['isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly']) {
      expect(await countOf(userLine('x', { [k]: 'true' })), k).toBe(1);
      expect(await countOf(userLine('x', { [k]: 1 })), k).toBe(1);
      expect(await countOf(userLine('x', { [k]: true })), k).toBe(0);
    }
  });

  it('interruptedMessageId / scheduledTaskId 只要「非 null 的值」就不计,包括空串和 0', async () => {
    for (const k of ['interruptedMessageId', 'scheduledTaskId']) {
      expect(await countOf(userLine('x', { [k]: '' })), k).toBe(0);
      expect(await countOf(userLine('x', { [k]: 0 })), k).toBe(0);
      expect(await countOf(userLine('x', { [k]: false })), k).toBe(0);
      expect(await countOf(userLine('x', { [k]: null })), k).toBe(1);
    }
  });

  it('U9 检查的是拼接后的整串,不是每个块:前块正常 + 后块以 <local-command-stdout 开头 → 计', async () => {
    expect(await countOf(userLine([textBlock('ok'), textBlock('<local-command-stdout>y')]))).toBe(
      1,
    );
    // 反过来:首块是命令输出 → 整串以它开头 → 不计
    expect(await countOf(userLine([textBlock('<local-command-stdout>y'), textBlock('ok')]))).toBe(
      0,
    );
    // 首块是空白,第二块是命令输出:拼接后是 "\n<local-command-stdout" → 前导空白允许 → 不计
    expect(await countOf(userLine([textBlock(' '), textBlock('<local-command-stdout>y')]))).toBe(0);
  });

  it('U9 的锚是整串开头,不是每行开头:第二行以 <local-command-stdout 开头 → 计', async () => {
    expect(await countOf(userLine('hello\n<local-command-stdout>y'))).toBe(1);
    expect(await countOf(userLine('hello\n[Request interrupted'))).toBe(1);
  });

  it('U9 只拼 text 块:image 块与缺 text 的 text 块不参与;全是 image 的内容仍计(拼接为空串)', async () => {
    expect(await countOf(userLine([{ type: 'image', source: {} }]))).toBe(1);
    expect(await countOf(userLine([{ type: 'text' }, textBlock('hi')]))).toBe(1);
    expect(
      await countOf(
        userLine([{ type: 'image', source: {} }, textBlock('[Request interrupted by user]')]),
      ),
    ).toBe(0);
  });

  it('U9 前导空白按 Unicode White_Space(含 U+0085、全角空格),不含 U+FEFF', async () => {
    // 取值已用本机 jq 1.7.1 的 test("^\\s*<local-command-stdout") 实测对拍:0085/00A0/2003/3000/000B 是空白,FEFF/200B/001C 不是
    expect(await countOf(userLine('\u0085<local-command-stdout>'))).toBe(0);
    expect(await countOf(userLine('\u00a0<local-command-stdout>'))).toBe(0);
    expect(await countOf(userLine('\u2003<local-command-stdout>'))).toBe(0);
    expect(await countOf(userLine('\u3000<local-command-stdout>'))).toBe(0);
    expect(await countOf(userLine('\u000b<local-command-stdout>'))).toBe(0);
    expect(await countOf(userLine('\ufeff<local-command-stdout>'))).toBe(1);
    expect(await countOf(userLine('\u200b<local-command-stdout>'))).toBe(1);
    expect(await countOf(userLine('\u001c<local-command-stdout>'))).toBe(1);
  });

  it('斜杠命令(<command-name>…)算用户消息;排队消息 / 接受建议也算', async () => {
    expect(await countOf(userLine('<command-name>/compact</command-name>'))).toBe(1);
    expect(await countOf(userLine('x', { promptSource: 'queued' }))).toBe(1);
    expect(await countOf(userLine('x', { promptSource: 'suggestion_accepted' }))).toBe(1);
  });

  it('queue-operation 行不算用户消息', async () => {
    const w = await newWork('cl-pred-queue-');
    const r = await readLines(w, [{ type: 'queue-operation', operation: 'enqueue', content: 'x' }]);
    expect(r.counts.user_messages).toBe(0);
    expect(r.counts.unknown_event_types).toEqual({});
    expect(r.events.map((e) => `${e.kind}:${e.raw_type}`)).toEqual(['meta:queue-operation']);
  });

  it('一行至多计 1(多个 text 块仍是 1 条)', async () => {
    expect(await countOf(userLine([textBlock('a'), textBlock('b'), textBlock('c')]))).toBe(1);
  });

  it('带 sessionKind 的 user 行按规则计(spec §8 D6,语义未核实,口径不排除)', async () => {
    expect(await countOf(userLine('x', { sessionKind: 'background' }))).toBe(1);
  });

  it('U9 拼接时 text 非字符串的块被跳过(不会拼出 "undefined" / "5");空内容数组仍计 1 条(拼接为空串)', async () => {
    expect(
      await countOf(userLine([{ type: 'text', text: 5 }, textBlock('[Request interrupted')])),
    ).toBe(0);
    expect(await countOf(userLine([{ type: 'text', text: 5 }, textBlock('ok')]))).toBe(1);
    expect(await countOf(userLine([]))).toBe(1);
    const w = await newWork('cl-pred-empty-');
    const r = await readLines(w, [userLine([])]);
    expect(r.events.find((e) => e.kind === 'user_message')?.text).toBe('');
  });
});
