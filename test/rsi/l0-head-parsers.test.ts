/**
 * R20-A2 B4a:`parseHead`(R20-1.4 / D1,方案 §2.3)。Q17 三家真实形态的合成夹具 + 与 reader 的 cwd 口径对照。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RSI_ARMED_CLAUDE_MAX_LINES, RSI_ARMED_HEAD_BYTES } from '../../src/contracts/rsi.js';
import { readHeadLines } from '../../src/io/read-fs.js';
import { CodexReader } from '../../src/readers/codex/reader.js';
import { PiReader } from '../../src/readers/pi/reader.js';
import { createClaudeReader } from '../../src/readers/claude/reader.js';
import { parseHead } from '../../src/rsi/l0/head-parsers.js';
import type { TraceReader } from '../../src/contracts/reader.js';
import { sessionRefFor } from '../../src/signals/ids.js';
import { stat } from '../../src/io/read-fs.js';
import { claudeLine, jl, makeL0Fx, put, uuid } from './l0-fixture.js';

const B = (...ls: string[]): Buffer[] => ls.map((l) => Buffer.from(l, 'utf8'));
const j = (o: unknown): string => JSON.stringify(o);

afterEach(() => vi.restoreAllMocks());

describe('pi(K=1):type:"session" 首行的顶层 cwd', () => {
  it('真实形态:首行 session + cwd', () => {
    const m = parseHead(
      'pi',
      B(j({ type: 'session', version: 3, id: 'x', cwd: '/w/p' }), j({ type: 'message' })),
    );
    expect(m).toEqual({ cwd: '/w/p', notASession: false, linesSeen: 1 });
  });
  it('首行 type 是别的字符串 → notASession;无 type / 非对象 / 非法 JSON / 空白首行 → 无 cwd 且不是 notASession(更保守地计 U)', () => {
    expect(parseHead('pi', B(j({ type: 'message', cwd: '/leak' }))).notASession).toBe(true);
    expect(parseHead('pi', B(j({ type: 'message', cwd: '/leak' }))).cwd).toBeNull();
    for (const l of [j({ cwd: '/a' }), '[1]', '{bad', '   ', '']) {
      expect(parseHead('pi', B(l, j({ type: 'session', cwd: '/later' })))).toMatchObject({
        cwd: null,
        notASession: false,
      });
    }
  });
  it('cwd 为空串 / 非字符串 → null;第二行的 session 不看(K=1)', () => {
    expect(parseHead('pi', B(j({ type: 'session', cwd: '' }))).cwd).toBeNull();
    expect(parseHead('pi', B(j({ type: 'session', cwd: 5 }))).cwd).toBeNull();
    expect(
      parseHead('pi', B(j({ type: 'x' }), j({ type: 'session', cwd: '/later' }))).cwd,
    ).toBeNull();
  });
  it('BOM / CRLF 首行照常解析', () => {
    expect(parseHead('pi', B(`﻿${j({ type: 'session', cwd: '/w' })}\r`)).cwd).toBe('/w');
  });
});

describe('codex(K=1):session_meta 的 payload.cwd', () => {
  it('真实形态', () => {
    expect(
      parseHead('codex', B(j({ type: 'session_meta', payload: { cwd: '/w/c', id: 1 } }))).cwd,
    ).toBe('/w/c');
  });
  it('turn_context 首行 / session_meta 没有 cwd → null(armed 下记 U,reader 采集时能拿到,方向只会更保守)', () => {
    expect(
      parseHead('codex', B(j({ type: 'turn_context', payload: { cwd: '/w' } }))).cwd,
    ).toBeNull();
    expect(
      parseHead(
        'codex',
        B(
          j({ type: 'session_meta', payload: {} }),
          j({ type: 'turn_context', payload: { cwd: '/w' } }),
        ),
      ).cwd,
    ).toBeNull();
  });
  it('子代理会话:payload.source 有自有键 subagent(值为 null / false 也算)→ notASession,不取 cwd', () => {
    for (const v of [{ x: 1 }, null, false, 'a']) {
      const m = parseHead(
        'codex',
        B(j({ type: 'session_meta', payload: { cwd: '/w', source: { subagent: v } } })),
      );
      expect(m).toMatchObject({ cwd: null, notASession: true });
    }
    expect(
      parseHead('codex', B(j({ type: 'session_meta', payload: { cwd: '/w', source: 'cli' } }))).cwd,
    ).toBe('/w');
  });
});

describe('claude(K=32):前 32 个完整行里先到先得,跳侧链,找到即停', () => {
  it('真实形态:前 3 行是 mode / last-prompt / ai-title(无 cwd),第 4 行 user 带 cwd', () => {
    const m = parseHead(
      'claude',
      B(
        j({ type: 'mode' }),
        j({ type: 'last-prompt', lastPrompt: 'p' }),
        j({ type: 'ai-title', aiTitle: 't' }),
        j(claudeLine('/w/cl')),
      ),
    );
    expect(m).toEqual({ cwd: '/w/cl', notASession: false, linesSeen: 4 });
  });
  it('侧链行里的 cwd 不被采用;侧链之后第一个非侧链的 cwd 才算', () => {
    const m = parseHead(
      'claude',
      B(j(claudeLine('/side', { isSidechain: true })), j(claudeLine('/main'))),
    );
    expect(m.cwd).toBe('/main');
    expect(parseHead('claude', B(j(claudeLine('/side', { isSidechain: true })))).cwd).toBeNull();
  });
  it('先到先得:两行不同 cwd 取第一个;空串 / 非字符串 cwd 不算', () => {
    expect(parseHead('claude', B(j(claudeLine('/a')), j(claudeLine('/b')))).cwd).toBe('/a');
    expect(parseHead('claude', B(j(claudeLine('')), j({ cwd: 3 }), j(claudeLine('/c')))).cwd).toBe(
      '/c',
    );
  });
  it('BOM / CRLF / 空白行 / 非法行 / 过深行 / 非对象行都跳过,不终止扫描', () => {
    // 过深行(> 256 层)里带 cwd:reader 不解析它,所以这个 cwd 不能被采用
    const deep = `{"type":"user","cwd":"/deep","x":${'['.repeat(300)}${']'.repeat(300)}}`;
    expect(() => JSON.parse(deep)).not.toThrow(); // 正向前提:不跳过的话它能解析成功、会被取到
    const m = parseHead('claude', B('', '   ', '{bad', '[1]', deep, `﻿${j(claudeLine('/w'))}\r`));
    expect(m.cwd).toBe('/w');
    expect(parseHead('claude', B(`${j({ type: 'x' })}\r`, `﻿${j(claudeLine('/z'))}`)).cwd).toBe(
      '/z',
    );
  });
  it('边界:cwd 在第 32 行 → 取到;在第 33 行 → null(解析器自己也只看前 32 行)', () => {
    const filler = (n: number): string[] => Array.from({ length: n }, () => j({ type: 'mode' }));
    expect(RSI_ARMED_CLAUDE_MAX_LINES).toBe(32);
    expect(parseHead('claude', B(...filler(31), j(claudeLine('/l32')))).cwd).toBe('/l32');
    const m33 = parseHead('claude', B(...filler(32), j(claudeLine('/l33'))));
    expect(m33).toMatchObject({ cwd: null, linesSeen: 32 });
  });
  it('找到 cwd 即停:cwd 之后的行不被解码解析(JSON.parse 调用次数 = 行序号)', () => {
    const spy = vi.spyOn(JSON, 'parse');
    const m = parseHead(
      'claude',
      B(
        j({ type: 'a' }),
        j({ type: 'b' }),
        j(claudeLine('/w')),
        j(claudeLine('/later')),
        j({ type: 'e' }),
      ),
    );
    expect(m.cwd).toBe('/w');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(m.linesSeen).toBe(3);
  });
});

describe('经 readHeadLines 的真实文件:窗口内的完整行(含 32K–64K 首行、33 行边界)', () => {
  it('codex 首行 40KiB(32K–64K):窗口内是完整行,cwd 取到;首行超过 64KiB:窗口无 LF → 无行 → 记 U', async () => {
    const f = await makeL0Fx('hp-big-');
    const big = jl({
      type: 'session_meta',
      payload: { cwd: '/w/big', pad: 'x'.repeat(40 * 1024) },
    });
    const p1 = await put(f, 'codex', '2026/10/24/rollout-a.jsonl', big + jl({ type: 'x' }));
    const r1 = await readHeadLines(p1, RSI_ARMED_HEAD_BYTES, 1);
    expect(r1.kind === 'ok' && parseHead('codex', r1.lines).cwd).toBe('/w/big');
    const huge = jl({ type: 'session_meta', payload: { cwd: '/w/h', pad: 'x'.repeat(70 * 1024) } });
    const p2 = await put(f, 'codex', '2026/10/24/rollout-b.jsonl', huge);
    const r2 = await readHeadLines(p2, RSI_ARMED_HEAD_BYTES, 1);
    expect(r2.kind === 'ok' && r2.lines.length).toBe(0);
    expect(r2.kind === 'ok' && parseHead('codex', r2.lines).cwd).toBeNull();
  });
});

describe('与 reader 的 cwd_hint 口径对照(同一夹具)', () => {
  async function readerCwd(
    reader: TraceReader,
    agent: 'claude' | 'codex' | 'pi',
    file: string,
  ): Promise<string | null> {
    const salt = 'cd'.repeat(32);
    const ref = {
      agent,
      path: file,
      session_ref: sessionRefFor(salt, file),
      bytes: (await stat(file)).size,
    };
    const r = reader.read(ref, { salt });
    for await (const e of r.events) void e;
    return r.meta().cwd_hint;
  }
  const parseFile = async (
    agent: 'claude' | 'codex' | 'pi',
    file: string,
  ): Promise<string | null> => {
    const r = await readHeadLines(file, RSI_ARMED_HEAD_BYTES, agent === 'claude' ? 32 : 1);
    return r.kind === 'ok' ? parseHead(agent, r.lines).cwd : null;
  };

  it('claude:真实形态(前几行无 cwd、含侧链行、BOM、CRLF)armed 的 cwd == reader 的 cwd_hint', async () => {
    const f = await makeL0Fx('hp-rd-cl-');
    const body =
      `﻿${j({ type: 'mode' })}\r\n` +
      jl(
        { type: 'last-prompt' },
        claudeLine('/side', { isSidechain: true }),
        claudeLine('/real/proj'),
        claudeLine('/later'),
      );
    const p = await put(f, 'claude', `proj/${uuid(1)}.jsonl`, body);
    expect(await readerCwd(createClaudeReader(), 'claude', p)).toBe('/real/proj');
    expect(await parseFile('claude', p)).toBe('/real/proj');
  });
  it('pi:首行 session 的 cwd 一致', async () => {
    const f = await makeL0Fx('hp-rd-pi-');
    const p = await put(
      f,
      'pi',
      '--w-p--/a.jsonl',
      jl(
        { type: 'session', cwd: '/w/p', timestamp: '2026-10-01T00:00:00Z' },
        { type: 'message', id: 'm1' },
      ),
    );
    expect(await readerCwd(new PiReader(), 'pi', p)).toBe('/w/p');
    expect(await parseFile('pi', p)).toBe('/w/p');
  });
  it('codex:session_meta 有 cwd 时一致;只有 turn_context 的 cwd 时 reader 能取到而 armed 为 null(允许的偏差,方向保守)', async () => {
    const f = await makeL0Fx('hp-rd-cx-');
    const a = await put(
      f,
      'codex',
      '2026/10/24/rollout-a.jsonl',
      jl(
        { type: 'session_meta', payload: { cwd: '/w/c' } },
        { type: 'turn_context', payload: { cwd: '/other' } },
      ),
    );
    expect(await readerCwd(new CodexReader(), 'codex', a)).toBe('/w/c');
    expect(await parseFile('codex', a)).toBe('/w/c');
    const b = await put(
      f,
      'codex',
      '2026/10/24/rollout-b.jsonl',
      jl({ type: 'session_meta', payload: {} }, { type: 'turn_context', payload: { cwd: '/tc' } }),
    );
    expect(await readerCwd(new CodexReader(), 'codex', b)).toBe('/tc');
    expect(await parseFile('codex', b)).toBeNull();
  });
});
