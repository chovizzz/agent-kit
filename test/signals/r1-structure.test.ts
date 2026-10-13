/**
 * R1:信号补结构字段(event_kind / event_index / tool_name)+ 会话计数库 + 自身会话排除 + hasStructureFields。
 * 全部使用合成会话(test/fixtures/sessions/gen-*.ts)与仓库外临时目录;不读任何真实会话。
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentId } from '../../src/contracts/common.js';
import type { TraceReader } from '../../src/contracts/reader.js';
import { SessionStatSchema, sessionStatRelPath } from '../../src/contracts/session-stat.js';
import type { SessionStat } from '../../src/contracts/session-stat.js';
import { SignalSchema } from '../../src/contracts/signal.js';
import type { Signal } from '../../src/contracts/signal.js';
import { createClaudeReader } from '../../src/readers/claude/index.js';
import { createCodexReader } from '../../src/readers/codex/index.js';
import { createKimiReader } from '../../src/readers/kimi/index.js';
import { createPiReader } from '../../src/readers/pi/index.js';
import { createRedactor } from '../../src/redact/index.js';
import { exists, lstat, readDir, readText } from '../../src/io/read-fs.js';
import { mkdirp, symlink, writeFile } from '../../src/io/safe-fs.js';
import { collect } from '../../src/signals/collect.js';
import type { CollectOutput } from '../../src/signals/collect.js';
import { createExcludePolicy, withSelfExclusion } from '../../src/signals/exclude.js';
import { sigIdFor } from '../../src/signals/ids.js';
import { UNPRINTABLE_KEY } from '../../src/signals/pipeline.js';
import { SignalStoreError } from '../../src/signals/state-store.js';
import { buildSessionStat } from '../../src/signals/session-stats.js';
import { hasStructureFields, partitionByStructure } from '../../src/signals/structure.js';
import { signalsDir } from '../../src/signals/state-store.js';
import { genClaude, writeClaudeLines } from '../fixtures/sessions/gen-claude.js';
import { genCodex } from '../fixtures/sessions/gen-codex.js';
import { genKimi } from '../fixtures/sessions/gen-kimi.js';
import { genPi } from '../fixtures/sessions/gen-pi.js';
import type { GeneratedSession, SessionSpec } from '../fixtures/sessions/common.js';
import { homeSnapshot, newWork, runCollect } from './helpers.js';
import type { Work } from './helpers.js';

const SALT = 'e'.repeat(64);

let homeBefore = '';
beforeAll(async () => {
  homeBefore = await homeSnapshot();
});
afterAll(async () => {
  expect(await homeSnapshot()).toBe(homeBefore);
});

const READERS: Record<'claude' | 'codex' | 'pi' | 'kimi', () => TraceReader> = {
  claude: createClaudeReader,
  codex: createCodexReader,
  pi: createPiReader,
  kimi: createKimiReader,
};
const GENS: Record<
  'claude' | 'codex' | 'pi' | 'kimi',
  (w: Work, s: SessionSpec) => Promise<GeneratedSession>
> = {
  claude: (w, s) => genClaude(w.io, s),
  codex: (w, s) => genCodex(w.io, s),
  pi: (w, s) => genPi(w.io, s),
  kimi: (w, s) => genKimi(w.io, s),
};

function spec(w: Work, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    root: w.sessions,
    cwd: '/work/proj-a',
    id: 's1',
    userTexts: ['你好,帮我看看这个', '再看一个'],
    toolCalls: 3,
    failedResults: 1,
    version: '2.1.294',
    ...over,
  };
}

async function run(
  w: Work,
  agent: 'claude' | 'codex' | 'pi' | 'kimi',
  opts: { dry?: boolean; self?: boolean; allow?: string[]; exclude?: string[] } = {},
): Promise<CollectOutput> {
  const base = await createExcludePolicy({
    excludeDirs: opts.exclude ?? [],
    allowProjects: opts.allow ?? ['proj-a'],
  });
  return collect({
    reader: READERS[agent](),
    source: w.sessions,
    io: w.io,
    dry: opts.dry ?? false,
    redactor: createRedactor({ sensitive_words: ['张三科技'], timeout_ms: 5000 }),
    policy: opts.self === false ? base : withSelfExclusion(base, w.io.stateDir),
    salt: SALT,
    fallbackVersion: '2.0.0',
    maxEventBytes: undefined,
  });
}

async function readJsonl(dir: string): Promise<unknown[]> {
  if (!(await exists(dir))) return [];
  const rows: unknown[] = [];
  for (const e of (await readDir(dir)).sort((a, b) => a.name.localeCompare(b.name))) {
    for (const line of (await readText(path.join(dir, e.name))).split('\n'))
      if (line) rows.push(JSON.parse(line));
  }
  return rows;
}
const signalRows = async (w: Work, a: AgentId): Promise<Signal[]> =>
  (await readJsonl(signalsDir(w.io, a))).map((r) => SignalSchema.parse(r));
const statDir = (w: Work, a: AgentId): string =>
  path.dirname(path.join(w.io.stateDir, sessionStatRelPath(a, '202610')));
const statRows = async (w: Work, a: AgentId): Promise<SessionStat[]> =>
  (await readJsonl(statDir(w, a))).map((r) => SessionStatSchema.parse(r));
async function dirText(dir: string): Promise<string> {
  if (!(await exists(dir))) return '';
  const parts: string[] = [];
  for (const e of (await readDir(dir)).sort((a, b) => a.name.localeCompare(b.name)))
    parts.push(`${e.name}\n${await readText(path.join(dir, e.name))}`);
  return parts.join('\n');
}

describe.each(['claude', 'codex', 'pi', 'kimi'] as const)('结构字段:%s', (agent) => {
  it('event_kind / event_index / tool_name 按 reader 事件派生,sig_id 序号与 event_index 一致', async () => {
    const w = await newWork(`r1-fields-${agent}-`);
    const g = await GENS[agent](w, spec(w, { toolName: 'Bash' }));
    const out = await run(w, agent);
    const rows = await signalRows(w, agent);
    // 正向对照:信号确实产出了
    expect(rows.length).toBeGreaterThan(0);
    const c = g.expected;
    const kinds = (k: string) => rows.filter((r) => r.event_kind === k).length;
    expect(kinds('user_message')).toBe(c.user_messages);
    expect(kinds('tool_call')).toBe(c.tool_calls);
    // 失败信号数与 counts.tool_failures 一一对应(四个 reader 只在 tool_result 上设 tool_failed;合成夹具无脱敏丢弃)
    expect(c.tool_failures).toBeGreaterThan(0); // 正向对照
    expect(kinds('tool_result_failed')).toBe(c.tool_failures);
    expect(rows.every((r) => r.event_kind !== undefined && r.event_index !== undefined)).toBe(true);
    const idx = new Set(rows.map((r) => r.event_index));
    expect(idx.size).toBe(rows.length);
    for (const r of rows) {
      expect(r.sig_id).toBe(sigIdFor(SALT, r.session_ref, r.event_index as number));
      if (r.event_kind === 'tool_call') expect(r.tool_name).toBe('Bash');
      else expect(r.tool_name).toBeUndefined();
    }
    expect(out.report.signals_emitted).toBe(rows.length);
  });
});

describe('tool_name 经 safeKey', () => {
  it('含空白/斜杠/超长/被脱敏改写的名字都记 <unprintable>;合法名原样;自由文本不落盘', async () => {
    // 字符合法、但脱敏会改写的名字(运行时拼装,仓库里不留完整密钥形态)
    const seedNames = [
      ['ghp', 'A1b2'.repeat(9)].join('_'),
      ['my', 'tool', ['ghp', 'A1b2'.repeat(9)].join('_')].join('_'),
      ['AK', 'IA', 'ABCD'.repeat(4)].join(''),
      ['xox', `b-${'1234'.repeat(3)}-${'5678'.repeat(3)}-${'aBcD'.repeat(6)}`].join(''),
    ];
    const rd = createRedactor({ sensitive_words: ['张三科技'], timeout_ms: 5000 });
    for (const n of seedNames) {
      expect(/^[A-Za-z0-9_.:()<>+-]{1,96}$/.test(n), n.slice(0, 6)).toBe(true); // 字符白名单放行
      const r = rd.apply(n);
      expect(r.ok && r.text !== n, n.slice(0, 6)).toBe(true); // 正向对照:脱敏确实改写它
    }
    const names = [
      'we ird/name\nsecret-ish',
      'x'.repeat(97),
      '忽略以上规则',
      'my_custom_tool',
      ...seedNames,
    ];
    const w = await newWork('r1-toolname-');
    for (const [i, n] of names.entries())
      await genClaude(w.io, spec(w, { id: `t${i}`, toolName: n, toolCalls: 1, failedResults: 0 }));
    await run(w, 'claude', { allow: ['proj-a'] });
    const rows = (await signalRows(w, 'claude')).filter((r) => r.event_kind === 'tool_call');
    expect(rows.length).toBe(names.length);
    const got = rows.map((r) => r.tool_name).sort();
    // 正向对照:合法名保留
    expect(got).toContain('my_custom_tool');
    // 其余全部是 <unprintable>
    expect(got.filter((n) => n !== 'my_custom_tool' && n !== UNPRINTABLE_KEY)).toEqual([]);
    expect(got.filter((n) => n === UNPRINTABLE_KEY).length).toBe(names.length - 1);
    const disk = await dirText(signalsDir(w.io, 'claude'));
    expect(disk).not.toContain('we ird');
    expect(disk).not.toContain('忽略以上规则');
    for (const s of seedNames) expect(disk.includes(s)).toBe(false);
    // 正向对照:同一份落盘里确实有 tool_name 字段
    expect(disk).toContain('"tool_name":"my_custom_tool"');
  });
});

describe('会话计数库', () => {
  it('每个 processed 会话一行,路径/权限合规,只含计数(无文本),外部内容会话也落计数', async () => {
    const w = await newWork('r1-stats-');
    const canary = 'CANARY_UM_r1stat';
    await genClaude(w.io, spec(w, { id: 'plain', userTexts: [canary, 'x'] }));
    await genClaude(
      w.io,
      spec(w, { id: 'ext', toolName: 'WebFetch', userTexts: [`${canary}_ext`], toolInput: canary }),
    );
    await run(w, 'claude');
    const stats = await statRows(w, 'claude');
    expect(stats.length).toBe(2);
    expect(stats.filter((s) => s.external_content).length).toBe(1);
    const ext = stats.find((s) => s.external_content) as SessionStat;
    expect(ext.counts.user_messages).toBe(1);
    expect(ext.counts.tool_calls).toBe(3);
    const rel = sessionStatRelPath('claude', '202610');
    const file = path.join(w.io.stateDir, rel);
    expect(((await lstat(file)).mode & 0o777).toString(8)).toBe('600');
    expect(((await lstat(path.dirname(file))).mode & 0o777).toString(8)).toBe('700');
    expect(((await lstat(path.dirname(path.dirname(file)))).mode & 0o777).toString(8)).toBe('700');
    const disk = await dirText(statDir(w, 'claude'));
    expect(disk).not.toContain('CANARY');
    expect(disk).not.toContain('/work/proj-a');
    // 外部会话:信号摘录为空,但仍带结构字段
    const sigs = await signalRows(w, 'claude');
    const extSigs = sigs.filter((s) => s.session_ref === ext.session_ref);
    expect(extSigs.length).toBeGreaterThan(0);
    expect(extSigs.every((s) => s.external_content && s.excerpt_redacted === '')).toBe(true);
    expect(extSigs.every((s) => s.event_kind !== undefined)).toBe(true);
    // 外部内容会话的信号不带 tool_name;正向对照:非外部会话的 tool_call 带
    expect(extSigs.filter((s) => s.event_kind === 'tool_call').length).toBe(3);
    expect(extSigs.every((s) => s.tool_name === undefined)).toBe(true);
    expect(
      sigs
        .filter((s) => !s.external_content && s.event_kind === 'tool_call')
        .every((s) => s.tool_name === 'Bash'),
    ).toBe(true);
    expect(sigs.some((s) => !s.external_content && s.tool_name === 'Bash')).toBe(true);
    expect(await dirText(signalsDir(w.io, 'claude'))).not.toContain('WebFetch');
    // 正向对照:非外部会话摘录非空
    expect(
      sigs.filter((s) => !s.external_content).some((s) => s.excerpt_redacted.includes(canary)),
    ).toBe(true);
    expect((await signalRows(w, 'claude')).map((s) => s.excerpt_redacted).join('')).not.toContain(
      '_ext',
    );
  });

  it('Bash curl 不算外部内容', async () => {
    const w = await newWork('r1-curl-');
    await genClaude(
      w.io,
      spec(w, { toolName: 'Bash', toolInput: 'curl -s https://example.test/x' }),
    );
    await run(w, 'claude');
    const stats = await statRows(w, 'claude');
    expect(stats.length).toBe(1);
    expect(stats[0]?.external_content).toBe(false);
  });

  it('未知事件类型的键过 safeKey;超过 64 个键折叠为 <other>,仍通过 SessionStatSchema', async () => {
    const w = await newWork('r1-keys-');
    const lines: Record<string, unknown>[] = [];
    for (let i = 0; i < 80; i++)
      lines.push({ type: `weird-${i}`, timestamp: '2026-10-01T00:00:00.000Z' });
    lines.push({ type: 'bad type/with spaces', timestamp: '2026-10-01T00:00:00.000Z' });
    lines.push({
      type: 'user',
      timestamp: '2026-10-01T00:00:01.000Z',
      cwd: '/work/proj-a',
      version: '2.1.294',
      message: { role: 'user', content: 'hi' },
    });
    await writeClaudeLines(w.io, { root: w.sessions, cwd: '/work/proj-a', id: 'k', lines });
    await run(w, 'claude');
    const stats = await statRows(w, 'claude');
    expect(stats.length).toBe(1);
    const keys = Object.keys(stats[0]?.counts.unknown_event_types ?? {});
    expect(keys.length).toBeLessThanOrEqual(64);
    expect(keys).toContain('<other>');
    const total = Object.values(stats[0]?.counts.unknown_event_types ?? {}).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBe(81); // 折叠不丢计数
    expect(await dirText(statDir(w, 'claude'))).not.toContain('with spaces');
  });

  it('幂等:重采不重复追加、文件逐字节不变;--dry 不写计数库', async () => {
    const w = await newWork('r1-idem-');
    await genClaude(w.io, spec(w, { id: 'a' }));
    await genClaude(w.io, spec(w, { id: 'b', toolName: 'WebFetch' }));
    await run(w, 'claude', { dry: true });
    expect(await exists(path.join(w.io.stateDir, 'sessions'))).toBe(false);
    const first = await run(w, 'claude');
    expect(first.statWrite?.written).toBe(2);
    const before = await dirText(statDir(w, 'claude'));
    const sigBefore = await dirText(signalsDir(w.io, 'claude'));
    const second = await run(w, 'claude');
    expect(second.statWrite).toMatchObject({ written: 0, updated: 0, unchanged: 2 });
    expect(await dirText(statDir(w, 'claude'))).toBe(before);
    expect(await dirText(signalsDir(w.io, 'claude'))).toBe(sigBefore);
    expect((await statRows(w, 'claude')).length).toBe(2);
  });

  it('会话增长后重采:同一 session_ref 的计数行被原地更新,仍只有一行,与信号库一致', async () => {
    const w = await newWork('r1-grow-');
    await genClaude(w.io, spec(w, { id: 'g', toolCalls: 1, failedResults: 0 }));
    await run(w, 'claude');
    const one = (await statRows(w, 'claude'))[0] as SessionStat;
    await genClaude(w.io, spec(w, { id: 'g', toolCalls: 4, failedResults: 2 }));
    const out = await run(w, 'claude');
    expect(out.statWrite).toMatchObject({ written: 0, updated: 1 });
    const rows = await statRows(w, 'claude');
    expect(rows.length).toBe(1);
    expect(rows[0]?.session_ref).toBe(one.session_ref);
    expect(rows[0]?.counts.tool_calls).toBe(4);
    const sigs = (await signalRows(w, 'claude')).filter((s) => s.event_kind === 'tool_call');
    expect(sigs.length).toBe(4);
  });

  it('计数库里有坏行 → fail-closed(抛错),不再追加', async () => {
    const w = await newWork('r1-corrupt-');
    await genClaude(w.io, spec(w, { id: 'c' }));
    const dir = statDir(w, 'claude');
    await mkdirp(w.io, dir, 0o700);
    await writeFile(w.io, path.join(dir, '202610.jsonl'), '{not json\n', { mode: 0o600 });
    await expect(run(w, 'claude')).rejects.toBeInstanceOf(SignalStoreError);
  });
});

describe('会话计数库:ts 首写钉死 / 无时间不写 / 预检', () => {
  it('会话增长且首事件时间变了:计数更新,但 ts 与所在月份沿用首写;仍只有一行', async () => {
    const w = await newWork('r1-pin-');
    await genClaude(w.io, spec(w, { id: 'p', toolCalls: 1, failedResults: 0 }));
    await run(w, 'claude');
    const first = (await statRows(w, 'claude'))[0] as SessionStat;
    // 重写同一会话文件,基准时间推到下个月:首事件 ts 变了
    await genClaude(
      w.io,
      spec(w, { id: 'p', toolCalls: 2, failedResults: 0, baseMs: Date.UTC(2026, 10, 15) }),
    );
    const out = await run(w, 'claude');
    expect(out.statWrite).toMatchObject({ updated: 1, written: 0 });
    const rows = await statRows(w, 'claude');
    expect(rows.length).toBe(1);
    expect(rows[0]?.ts).toBe(first.ts);
    expect(rows[0]?.counts.tool_calls).toBe(2);
    expect((await readDir(statDir(w, 'claude'))).map((e) => e.name)).toEqual(['202610.jsonl']);
  });

  it('会话时间取不到(无 sessionTs)不生成计数行,不用当前时钟兜底;有时间则生成(正向对照)', () => {
    const base = {
      status: 'processed' as const,
      sessionRef: 's_0123456789abcdef',
      eventsSeen: 0,
      signals: [],
      dropped: 0,
      dropReasons: {},
      projectKey: 'p_0123456789abcdef',
      external: false,
      counts: { user_messages: 0, tool_calls: 0, tool_failures: 0, unknown_event_types: {} },
    };
    expect(buildSessionStat(base)).toBeUndefined();
    expect(buildSessionStat({ ...base, sessionTs: '2026-10-01T00:00:00.000Z' })?.ts).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(
      buildSessionStat({ ...base, status: 'excluded', sessionTs: '2026-10-01T00:00:00.000Z' }),
    ).toBeUndefined();
  });

  it('计数库带病时在写信号之前就 fail-closed:信号库一行也没写', async () => {
    const w = await newWork('r1-preflight-');
    await genClaude(w.io, spec(w, { id: 'c' }));
    const dir = statDir(w, 'claude');
    await mkdirp(w.io, dir, 0o700);
    await writeFile(w.io, path.join(dir, '202610.jsonl'), '{"bad":1}\n', { mode: 0o600 });
    await expect(run(w, 'claude')).rejects.toBeInstanceOf(SignalStoreError);
    expect(await exists(signalsDir(w.io, 'claude'))).toBe(false);
  });

  it('同一 session_ref 在两个月份文件里各有一行 → fail-closed', async () => {
    const w = await newWork('r1-dupref-');
    await genClaude(w.io, spec(w, { id: 'd' }));
    await run(w, 'claude');
    const row = (await statRows(w, 'claude'))[0] as SessionStat;
    const dir = statDir(w, 'claude');
    await writeFile(w.io, path.join(dir, '202611.jsonl'), `${JSON.stringify(row)}\n`, {
      mode: 0o600,
    });
    await expect(run(w, 'claude')).rejects.toBeInstanceOf(SignalStoreError);
  });
});

describe('会话计数库:月份文件异常 / dry / external 只升不降', () => {
  it('月份文件名被目录占位 → plan 阶段 fail-closed,信号库一行也没写', async () => {
    const w = await newWork('r1-dirslot-');
    await genClaude(w.io, spec(w, { id: 'x' }));
    await mkdirp(w.io, path.join(statDir(w, 'claude'), '202610.jsonl'), 0o700);
    await expect(run(w, 'claude')).rejects.toBeInstanceOf(SignalStoreError);
    expect(await exists(signalsDir(w.io, 'claude'))).toBe(false);
  });

  it('月份文件是符号链接 → fail-closed,指向的库外文件不被改动', async () => {
    const w = await newWork('r1-linkslot-');
    await genClaude(w.io, spec(w, { id: 'x' }));
    const outside = path.join(w.dir, 'outside.jsonl');
    await writeFile(w.io, outside, 'KEEP\n', { mode: 0o600 });
    await mkdirp(w.io, statDir(w, 'claude'), 0o700);
    await symlink(w.io, outside, path.join(statDir(w, 'claude'), '202610.jsonl'));
    await expect(run(w, 'claude')).rejects.toBeInstanceOf(SignalStoreError);
    expect(await readText(outside)).toBe('KEEP\n');
  });

  it('--dry 也预检计数库:坏库在 dry 下同样暴露;好库的 dry 不创建 sessions 目录', async () => {
    const w = await newWork('r1-drycheck-');
    await genClaude(w.io, spec(w, { id: 'x' }));
    await run(w, 'claude', { dry: true });
    expect(await exists(path.join(w.state, 'sessions'))).toBe(false);
    await mkdirp(w.io, statDir(w, 'claude'), 0o700);
    await writeFile(w.io, path.join(statDir(w, 'claude'), '202610.jsonl'), 'oops\n', {
      mode: 0o600,
    });
    await expect(run(w, 'claude', { dry: true })).rejects.toBeInstanceOf(SignalStoreError);
  });

  it('曾判为外部内容的会话,后续重采即使不再命中外部判定,计数行仍保持 external_content=true', async () => {
    const w = await newWork('r1-sticky-');
    await genClaude(w.io, spec(w, { id: 'e', toolName: 'WebFetch' }));
    await run(w, 'claude');
    expect((await statRows(w, 'claude'))[0]?.external_content).toBe(true);
    await genClaude(w.io, spec(w, { id: 'e', toolName: 'Bash' }));
    await run(w, 'claude');
    const rows = await statRows(w, 'claude');
    expect(rows.length).toBe(1);
    expect(rows[0]?.external_content).toBe(true);
  });
});

describe('reader 不变量:tool_call 事件不带 tool_failed(event_kind 与 counts 口径一致的前提)', () => {
  it.each(['claude', 'codex', 'pi', 'kimi'] as const)('%s', async (agent) => {
    const w = await newWork(`r1-inv-${agent}-`);
    await GENS[agent](w, spec(w, { toolCalls: 3, failedResults: 2 }));
    const reader = READERS[agent]();
    const refs = await reader.discover(w.sessions);
    expect(refs.length).toBe(1);
    const evs = [];
    for await (const ev of reader.read(refs[0] as never, { salt: SALT }).events) evs.push(ev);
    const calls = evs.filter((e) => e.kind === 'tool_call');
    expect(calls.length).toBe(3); // 正向对照
    expect(calls.every((e) => e.tool_failed === undefined)).toBe(true);
    expect(evs.filter((e) => e.kind === 'tool_result' && e.tool_failed === true).length).toBe(2);
  });
});

describe('存量信号兼容', () => {
  it('旧格式信号行仍通过校验、重采不回填;新信号带字段;hasStructureFields 区分两者', async () => {
    const w = await newWork('r1-legacy-');
    const g = await genClaude(w.io, spec(w, { id: 'old' }));
    expect(g.expected.user_messages).toBe(2);
    // 第一次采集:拿到真实的 sig_id / session_ref,再把它改写成「旧格式」(去掉三个新字段)
    await run(w, 'claude');
    const dir = signalsDir(w.io, 'claude');
    const file = path.join(dir, (await readDir(dir))[0]?.name as string);
    const legacy = (await readText(file))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const o = JSON.parse(l) as Record<string, unknown>;
        delete o['event_kind'];
        delete o['event_index'];
        delete o['tool_name'];
        return JSON.stringify(o);
      });
    await writeFile(w.io, file, `${legacy.join('\n')}\n`, { mode: 0o600 });
    const legacyText = await readText(file);
    for (const l of legacy) SignalSchema.parse(JSON.parse(l)); // 旧信号通过校验
    // 再采一次 + 另一个新会话
    await genClaude(w.io, spec(w, { id: 'new' }));
    const out = await run(w, 'claude');
    expect(out.write?.deduplicated).toBe(legacy.length);
    const rows = await signalRows(w, 'claude');
    const old = rows.filter((r) =>
      legacy.some((l) => (JSON.parse(l) as Signal).sig_id === r.sig_id),
    );
    expect(old.length).toBe(legacy.length);
    expect(old.every((r) => r.event_kind === undefined)).toBe(true);
    expect(old.every((r) => !hasStructureFields(r))).toBe(true);
    const fresh = rows.filter((r) => !old.includes(r));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((r) => hasStructureFields(r))).toBe(true);
    // 旧行逐字不变(不回填)
    const afterText = await readText(file);
    expect(afterText.startsWith(legacyText)).toBe(true);
    const part = partitionByStructure(rows);
    expect(part.usable.length).toBe(fresh.length);
    expect(part.unknown).toBe(old.length);
  });
});

describe('hasStructureFields', () => {
  const base = {
    sig_id: 'sig_0123456789abcdef',
    agent: 'claude',
    agent_version: '1',
    agent_version_source: 'session_meta',
    session_ref: 's_0123456789abcdef',
    project_key: 'p_0123456789abcdef',
    ts: '2026-10-01T00:00:00.000Z',
    type: 'event',
    excerpt_redacted: '',
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
  } as const;
  const mk = (o: Record<string, unknown>): Signal => SignalSchema.parse({ ...base, ...o });
  it('只有 event_kind+event_index 同时存在才可用;tool_name 只允许出现在 tool_call 上', () => {
    expect(hasStructureFields(mk({}))).toBe(false);
    expect(hasStructureFields(mk({ event_kind: 'user_message' }))).toBe(false);
    expect(hasStructureFields(mk({ event_index: 3 }))).toBe(false);
    expect(hasStructureFields(mk({ event_kind: 'user_message', event_index: 0 }))).toBe(true);
    expect(
      hasStructureFields(mk({ event_kind: 'tool_call', event_index: 1, tool_name: 'Bash' })),
    ).toBe(true);
    expect(hasStructureFields(mk({ event_kind: 'tool_call', event_index: 1 }))).toBe(true);
    expect(
      hasStructureFields(mk({ event_kind: 'user_message', event_index: 1, tool_name: 'Bash' })),
    ).toBe(false);
  });
});

describe('排除反思器自己的会话', () => {
  it('cwd 落在 .state/ 之下 → 跳过、不产信号/计数、计入 excluded_self_sessions;普通项目照常(正向对照)', async () => {
    const w = await newWork('r1-self-');
    await genClaude(w.io, spec(w, { id: 'self1', cwd: path.join(w.state, 'reflect', 'cwd') }));
    await genClaude(w.io, spec(w, { id: 'self2', cwd: w.state }));
    await genClaude(w.io, spec(w, { id: 'ok', cwd: '/work/proj-a' }));
    const out = await run(w, 'claude', { allow: [], exclude: ['/clients/acme'] });
    expect(out.excludedSelfSessions).toBe(2);
    expect(out.report.sessions_read).toBe(1);
    expect(out.report.sessions_skipped_excluded).toBe(2);
    expect((await statRows(w, 'claude')).length).toBe(1);
    const sessions = new Set((await signalRows(w, 'claude')).map((s) => s.session_ref));
    expect(sessions.size).toBe(1);
  });

  it('绕过尝试:符号链接、大小写、..、尾斜杠都仍被排除;state 的兄弟目录与父目录不误伤', async () => {
    const w = await newWork('r1-self2-');
    const inner = path.join(w.state, 'reflect', 'cwd');
    await mkdirp(w.io, inner);
    const link = path.join(w.dir, 'innocent-link');
    await symlink(w.io, inner, link);
    const sibling = path.join(w.dir, 'state-sibling');
    // 近似名但不是三段全中:不得误伤
    const lookalike = path.join(w.dir, 'work', 'reflect', 'cwd');
    await mkdirp(w.io, lookalike);
    await mkdirp(w.io, sibling);
    const cases: [string, string][] = [
      ['link', link],
      ['upper', inner.toUpperCase()],
      ['dots', `${w.state}/x/../reflect/cwd/.`],
      ['slash', `${inner}/`],
      ['deleted', path.join(w.state, 'gone', 'dir')],
      // 另一棵 worktree / 另一个 KIT_STATE_DIR 里的反思器会话:按 .state/reflect/cwd 三段兜底
      ['otherwt', path.join(w.dir, 'wt-other', '.state', 'reflect', 'cwd')],
      // 反思器用 KIT_STATE_DIR=<tmp>/state 的布局(父目录叫 state)
      ['otherstate', path.join(w.dir, 'other-kit', 'state', 'reflect', 'cwd')],
    ];
    for (const [id, cwd] of cases) await genClaude(w.io, spec(w, { id, cwd }));
    await genClaude(w.io, spec(w, { id: 'sib', cwd: sibling }));
    await genClaude(w.io, spec(w, { id: 'look', cwd: lookalike }));
    await genClaude(w.io, spec(w, { id: 'parent', cwd: w.dir }));
    const out = await run(w, 'claude', { allow: [], exclude: ['/clients/acme'] });
    expect(out.excludedSelfSessions).toBe(cases.length);
    expect(out.report.sessions_read).toBe(3); // sibling + lookalike + parent
    // 正向对照:withSelfExclusion 关掉时同一批会话都被处理
    const w2 = await newWork('r1-self2b-');
    await genClaude(w2.io, spec(w2, { id: 'x', cwd: path.join(w2.state, 'reflect', 'cwd') }));
    const off = await run(w2, 'claude', { allow: [], exclude: ['/clients/acme'], self: false });
    expect(off.excludedSelfSessions).toBe(0);
    expect(off.report.sessions_read).toBe(1);
  });

  it('命令层默认启用:stdout 顶层带 excluded_self_sessions', async () => {
    const w = await newWork('r1-self-cmd-');
    await genClaude(w.io, spec(w, { id: 's', cwd: path.join(w.state, 'reflect', 'cwd') }));
    await genClaude(w.io, spec(w, { id: 'o', cwd: '/work/proj-a' }));
    const r = await runCollect(w, [
      '--source',
      w.sessions,
      '--agent',
      'claude',
      '--allow-project',
      'proj-a',
      '--allow-project',
      'cwd',
    ]);
    expect(r.code, r.err).toBe(0);
    const parsed = JSON.parse(r.out) as {
      excluded_self_sessions: number;
      report: { sessions_read: number };
    };
    expect(parsed.excluded_self_sessions).toBe(1);
    expect(parsed.report.sessions_read).toBe(1);
  });
});
