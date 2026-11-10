/**
 * W4 / R21-6.9、R21-6.6:reader 对 RSI 注入块及其复述的识别与排除、标记取回与归并。
 * 每条负向断言旁都钉一条正向对照(防静默变空,见记忆 assertions-that-silently-go-vacuous)。
 */
import { describe, expect, it } from 'vitest';
import type { SessionRef } from '../../src/contracts/reader.js';
import { RSI_MARK_PREFIX } from '../../src/contracts/rsi.js';
import { createClaudeReader } from '../../src/readers/claude/index.js';
import { createCodexReader } from '../../src/readers/codex/index.js';
import { createKimiReader } from '../../src/readers/kimi/index.js';
import { createPiReader } from '../../src/readers/pi/index.js';
import {
  blocksInString,
  classifyMarkerRetrieval,
  findInjectionBlocks,
  InjectionTracker,
  isInjectionAware,
  RECITAL_MIN_CHARS,
} from '../../src/signals/injection.js';
import { buildSessionStat } from '../../src/signals/session-stats.js';
import { writeClaudeLines } from '../fixtures/sessions/gen-claude.js';
import { genPiRaw, piNode, piUserMsg } from '../fixtures/sessions/gen-pi.js';
import { newWork } from './helpers.js';
import { assistantLine, userLine } from '../readers/claude/helpers.js';
import {
  BODY,
  controlBlock,
  longestCommonRun,
  MARKER_A,
  MARKER_B,
  runFile,
  treatBlock,
  W4_SALT,
} from './w4-helpers.js';

let n = 0;
const uid = (): string => `w4i${n++}`;

describe('块识别(纯函数)', () => {
  it('RECITAL_MIN_CHARS 是 16(契约 R21-6.9)', () => {
    expect(RECITAL_MIN_CHARS).toBe(16);
  });

  it('行首(允许空格 / 制表符)以前缀开头才是块;取回标记要求形状恰好;正文 = 标记行之后各行', () => {
    const [b] = blocksInString(treatBlock());
    expect(b?.marker).toBe(MARKER_A);
    expect(b?.body.split('\n')).toHaveLength(3);
    expect(b?.body.endsWith(BODY)).toBe(true);
    expect(blocksInString(`  \t${controlBlock(MARKER_B)}  `)[0]?.marker).toBe(MARKER_B);
    // 包装文字在前面、前缀在后面的行:不是行首 → 不是块
    expect(blocksInString(`hook 输出: ${controlBlock()}`)).toEqual([]);
    // 前缀开头但标记形状不对:仍是块(要排除),取不到标记
    for (const bad of [
      `${RSI_MARK_PREFIX} rsm_xyz`,
      `${RSI_MARK_PREFIX} rsm_0123456789ABCDEF`,
      `${RSI_MARK_PREFIX}rsm_0123456789abcdef`,
      `${RSI_MARK_PREFIX} rsm_0123456789abcdef0`,
    ]) {
      const bs = blocksInString(bad);
      expect(bs, bad).toHaveLength(1);
      expect(bs[0]?.marker, bad).toBeUndefined();
    }
    // 一个字符串里两个块:各自成块
    expect(blocksInString(`${controlBlock(MARKER_A)}\n${controlBlock(MARKER_B)}`)).toHaveLength(2);
  });

  it('只按 \\n 切行:U+2028 不是行分隔(同 reader 的 C2)', () => {
    const s = `前文 ${controlBlock()}`; // 前缀不在行首
    expect(blocksInString(s)).toEqual([]);
    expect(blocksInString(`${controlBlock()}\r\n正文`)[0]?.marker).toBe(MARKER_A); // \r\n 的 \r 被去掉
  });

  it('findInjectionBlocks 遍历任意深度的字符串值(数组、嵌套对象)', () => {
    const obj = { a: [{ b: { c: ['x', treatBlock(MARKER_B)] } }], d: 1 };
    expect(findInjectionBlocks(obj).map((x) => x.marker)).toEqual([MARKER_B]);
    expect(findInjectionBlocks({ a: 'plain' })).toEqual([]);
  });
});

describe('复述阈值:16 码点排除、15 码点不排除(边界各一例)', () => {
  const cps = Array.from(BODY);
  const seg = (len: number): string => cps.slice(10, 10 + len).join('');
  const tr = (): InjectionTracker => {
    const t = new InjectionTracker();
    t.addBlocks(blocksInString(treatBlock()));
    return t;
  };

  it('连续重合 16 码点 → 复述;15 码点 → 不是;17 → 是', () => {
    // 两侧用正文里没有的字符夹住,保证最长公共片段恰为 len
    const around = (len: number): string => `甲${seg(len)}乙`;
    expect(longestCommonRun(around(16), BODY)).toBe(16);
    expect(longestCommonRun(around(15), BODY)).toBe(15);
    expect(tr().isRecital(around(16))).toBe(true);
    expect(tr().isRecital(around(15))).toBe(false);
    expect(tr().isRecital(around(17))).toBe(true);
  });

  it('没有已登记的块 → 永不判复述(正向对照:有块才判)', () => {
    expect(new InjectionTracker().isRecital(`甲${seg(30)}乙`)).toBe(false);
    expect(tr().isRecital(`甲${seg(30)}乙`)).toBe(true);
  });

  it('按码点不是码元:代理对算一个字', () => {
    const t = new InjectionTracker();
    t.addBlocks(blocksInString(`${controlBlock()}\n${'😀'.repeat(16)}`));
    expect(t.isRecital(`x${'😀'.repeat(16)}y`)).toBe(true);
    expect(t.isRecital(`x${'😀'.repeat(15)}y`)).toBe(false);
  });

  it('不做空白 / 大小写归一:正文里加了空格就断开', () => {
    const broken = `${seg(8)} ${seg(8)}`;
    expect(tr().isRecital(`甲${broken}乙`)).toBe(false);
  });

  it('与朴素最长公共子串参考实现对拍(确定性伪随机,含拼接复述)', () => {
    let seed = 12345;
    const rnd = (k: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % k;
    };
    const alphabet = Array.from('甲乙丙丁戊己庚辛壬癸');
    const bodyText = Array.from({ length: 60 }, () => alphabet[rnd(alphabet.length)]).join('');
    const t = new InjectionTracker();
    t.addBlocks(blocksInString(`${controlBlock()}\n${bodyText}`));
    const bodyCps = Array.from(bodyText);
    let positives = 0;
    let negatives = 0;
    for (let i = 0; i < 400; i++) {
      const pre = Array.from({ length: rnd(12) }, () => alphabet[rnd(alphabet.length)]).join('');
      const take = 10 + rnd(10);
      const from = rnd(bodyCps.length - take);
      const mid = bodyCps.slice(from, from + take).join('');
      const post = Array.from({ length: rnd(12) }, () => alphabet[rnd(alphabet.length)]).join('');
      const text = `${pre}${mid}${post}`;
      const expected = longestCommonRun(text, bodyText) >= 16;
      expect(t.isRecital(text), text).toBe(expected);
      if (expected) positives++;
      else negatives++;
    }
    // 两个方向都真的出现过(防对拍退化成全真 / 全假)
    expect(positives).toBeGreaterThan(20);
    expect(negatives).toBeGreaterThan(20);
  });
});

describe('标记归并 R21-6.6', () => {
  it('0 个 → 关联失败;1 个 → ok;≥ 2 个不同 → 多标记;同一标记重复不算多;缺键 → 未采集', () => {
    expect(classifyMarkerRetrieval([])).toBe('correlation_failed');
    expect(classifyMarkerRetrieval([MARKER_A])).toBe('ok');
    expect(classifyMarkerRetrieval([MARKER_A, MARKER_A])).toBe('ok');
    expect(classifyMarkerRetrieval([MARKER_A, MARKER_B])).toBe('multi_marker');
    expect(classifyMarkerRetrieval(undefined)).toBe('not_collected');
  });

  it('追踪器:去重、升序、≤ 4', () => {
    const t = new InjectionTracker();
    const ms = [5, 4, 3, 2, 1, 0, 4].map((i) => `rsm_${String(i).repeat(16)}`);
    for (const m of ms) t.addBlocks([{ marker: m, body: '' }]);
    expect(t.report().markers).toEqual([
      'rsm_0000000000000000',
      'rsm_1111111111111111',
      'rsm_2222222222222222',
      'rsm_3333333333333333',
    ]);
  });
});

describe('claude:块所在事件与复述事件不计入计数 / 信号,标记被取回', () => {
  it('treat 块作为用户消息:不计 user_messages、不产信号;对照:去掉前缀就被计入', async () => {
    const w = await newWork('w4-cl-');
    const reader = createClaudeReader();
    const file = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: uid(),
      lines: [
        userLine(treatBlock()),
        userLine('真实的第一条用户消息'),
        // 对照:前缀出现在行中间(不是行首)→ 不是块,照常计入
        userLine(`请看 ${controlBlock()}`),
      ],
    });
    const r = await runFile(reader, file);
    expect(r.status).toBe('processed');
    // 正向:真实消息与对照消息被计入(2 条),且各有一条信号
    expect(r.counts?.user_messages).toBe(2);
    expect(r.signals.filter((s) => s.event_kind === 'user_message')).toHaveLength(1 + 1);
    expect(r.w4).toEqual({ markers: [MARKER_A], injectionExcluded: 1, retryChainMax: 0 });
  });

  it('control 块(只有标记行)作为用户消息:同样不计入、不产信号;标记照取', async () => {
    const w = await newWork('w4-cl-ctrl-');
    const file = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: uid(),
      lines: [userLine(controlBlock()), userLine('真实消息')],
    });
    const r = await runFile(createClaudeReader(), file);
    expect(r.counts?.user_messages).toBe(1);
    expect(r.signals.filter((s) => s.event_kind === 'user_message')).toHaveLength(1); // 正向:真实消息有信号
    expect(r.w4).toEqual({ markers: [MARKER_A], injectionExcluded: 1, retryChainMax: 0 });
  });

  it('复述:后续消息 / 助手文本 / 工具调用里与正文连续 ≥ 16 字重合的都被排除;15 字的不排除', async () => {
    const w = await newWork('w4-cl-rec-');
    const cps = Array.from(BODY);
    const seg = (len: number): string => `甲${cps.slice(10, 10 + len).join('')}乙`;
    const file = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: uid(),
      lines: [
        userLine(treatBlock()),
        userLine(`我想说:${seg(16)}`), // 复述 16 → 排除
        userLine(`我想说:${seg(15)}`), // 15 → 保留
        assistantLine([{ type: 'text', text: `复述一下 ${seg(20)}` }]), // 助手复述 → 排除(不影响用户计数)
        assistantLine([
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'Bash',
            input: { command: `echo ${seg(16)}` },
          },
        ]), // 工具调用里的复述 → 不计入 tool_calls
        assistantLine([{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } }]),
      ],
    });
    const r = await runFile(createClaudeReader(), file);
    expect(r.counts?.user_messages).toBe(1); // 只剩 15 字那条
    expect(r.counts?.tool_calls).toBe(1); // 只剩 ls
    // 正向:保留下来的两条确实各有信号
    expect(r.signals.filter((s) => s.event_kind === 'user_message')).toHaveLength(1);
    expect(r.signals.filter((s) => s.event_kind === 'tool_call')).toHaveLength(1);
    expect(r.w4?.injectionExcluded).toBe(1 + 1 + 1 + 1); // 块 + 用户复述 + 助手复述 + 工具调用复述
  });

  it('块在 meta 行(isMeta)里:标记照取,不排除任何计数事件(正向:真实消息仍计入)', async () => {
    const w = await newWork('w4-cl-meta-');
    const file = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: uid(),
      lines: [userLine(controlBlock(), { isMeta: true }), userLine('真实消息')],
    });
    const r = await runFile(createClaudeReader(), file);
    expect(r.counts?.user_messages).toBe(1);
    expect(r.w4?.markers).toEqual([MARKER_A]);
    expect(r.w4?.injectionExcluded).toBe(0);
  });

  it('工具结果里被引用的块(cat 了别的会话):排除计数但不取回标记(避免假「多标记」)', async () => {
    const w = await newWork('w4-cl-quoted-');
    const file = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: uid(),
      lines: [
        userLine(controlBlock(MARKER_A), { isMeta: true }),
        assistantLine([{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'cat x' } }]),
        userLine([
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            is_error: true,
            content: controlBlock(MARKER_B),
          },
        ]),
      ],
    });
    const r = await runFile(createClaudeReader(), file);
    expect(r.w4?.markers).toEqual([MARKER_A]); // 正向:真注入取到了
    expect(r.w4?.markers).not.toContain(MARKER_B);
    expect(r.counts?.tool_failures).toBe(0); // 被引用的块所在结果事件被排除
    expect(r.w4?.injectionExcluded).toBe(1);
  });

  it('同一会话两个不同标记 → 多标记;一个都没有 → 关联失败;恰一个 → ok', async () => {
    const w = await newWork('w4-cl-multi-');
    const mk = async (lines: Parameters<typeof writeClaudeLines>[1]['lines']) =>
      (
        await runFile(
          createClaudeReader(),
          await writeClaudeLines(w.io, {
            root: w.sessions,
            cwd: '/work/proj-a',
            id: uid(),
            lines,
          }),
        )
      ).w4?.markers;
    const two = await mk([
      userLine(controlBlock(MARKER_A), { isMeta: true }),
      userLine(controlBlock(MARKER_B), { isMeta: true }),
    ]);
    const none = await mk([userLine('只有普通消息')]);
    const one = await mk([
      userLine(controlBlock(MARKER_A), { isMeta: true }),
      userLine(controlBlock(MARKER_A), { isMeta: true }),
    ]);
    expect(classifyMarkerRetrieval(two)).toBe('multi_marker');
    expect(classifyMarkerRetrieval(none)).toBe('correlation_failed');
    expect(classifyMarkerRetrieval(one)).toBe('ok');
    expect(two).toEqual([MARKER_A, MARKER_B].sort());
  });

  it('前缀稳定:会话追加行后重读,前面各事件的信号逐条不变', async () => {
    const w = await newWork('w4-cl-prefix-');
    const id = uid();
    const base = [userLine(treatBlock()), userLine('第一条'), userLine(`复述 ${BODY}`)];
    const f1 = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id,
      lines: base,
    });
    const r1 = await runFile(createClaudeReader(), f1);
    const f2 = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id,
      lines: [...base, userLine('追加的一条')],
    });
    expect(f2).toBe(f1);
    const r2 = await runFile(createClaudeReader(), f2);
    expect(r1.signals).toHaveLength(1);
    expect(r2.signals.slice(0, r1.signals.length)).toEqual(r1.signals);
    expect(r2.signals).toHaveLength(2);
  });

  it('buildSessionStat:claude 行带三键(缺 = 未测);键只在识别注入的 reader 上出现', async () => {
    const w = await newWork('w4-cl-stat-');
    const file = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: uid(),
      lines: [userLine(controlBlock(), { isMeta: true }), userLine('hi')],
    });
    const stat = buildSessionStat(await runFile(createClaudeReader(), file));
    expect(stat).toMatchObject({
      rsi_markers: [MARKER_A],
      retry_chain_max: 0,
      injection_excluded: 0,
    });
  });
});

describe('pi:custom 消息里的块取回标记;用户消息里的块与复述被排除', () => {
  it('取回 + 排除 + 计数', async () => {
    const w = await newWork('w4-pi-');
    const g = await genPiRaw(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: uid(),
      lines: [
        piNode(
          'e1',
          null,
          {
            type: 'message',
            message: { role: 'custom', content: [{ type: 'text', text: treatBlock() }] },
          },
          1_770_000_001_000,
        ),
        piNode('e2', 'e1', piUserMsg(treatBlock(MARKER_A)), 1_770_000_002_000),
        piNode('e3', 'e2', piUserMsg('真实消息'), 1_770_000_003_000),
        piNode('e4', 'e3', piUserMsg(`复述:${BODY}`), 1_770_000_004_000),
      ],
    });
    const r = await runFile(createPiReader(), g.file);
    expect(r.counts?.user_messages).toBe(1);
    expect(r.signals.filter((s) => s.event_kind === 'user_message')).toHaveLength(1);
    expect(r.w4).toEqual({ markers: [MARKER_A], injectionExcluded: 2, retryChainMax: 0 });
  });
});

describe('codex / kimi 不识别注入(行为与引入前一致,不写三键)', () => {
  it('read() 不带 injection();claude / pi 带', () => {
    const ref = (agent: 'codex' | 'kimi' | 'claude' | 'pi'): SessionRef => ({
      agent,
      path: '/nonexistent/x.jsonl',
      session_ref: 's_0000000000000000',
      bytes: 0,
    });
    const opts = { salt: W4_SALT };
    expect(isInjectionAware(createCodexReader().read(ref('codex'), opts))).toBe(false);
    expect(isInjectionAware(createKimiReader().read(ref('kimi'), opts))).toBe(false);
    expect(isInjectionAware(createClaudeReader().read(ref('claude'), opts))).toBe(true);
    expect(isInjectionAware(createPiReader().read(ref('pi'), opts))).toBe(true);
  });
});
