/** W4:契约追加的可选键、向后兼容(旧信号 / 旧计数行缺键照常通过)、旧库重采升级路径。 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStatSchema, SESSION_MARKERS_MAX } from '../../src/contracts/session-stat.js';
import { SignalSchema } from '../../src/contracts/signal.js';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { sessionStatsDir } from '../../src/signals/session-stats.js';
import { signalsDir } from '../../src/signals/state-store.js';
import { writeClaudeLines } from '../fixtures/sessions/gen-claude.js';
import { assistantLine, newWork, runClaudeCollect, userLine } from '../readers/claude/helpers.js';
import { selftestOverlayToml, writeOverlay } from './helpers.js';
import { REPO_ROOT } from './helpers.js';
import { controlBlock } from './w4-helpers.js';
import { RSI_MARK_PREFIX } from '../../src/contracts/rsi.js';

const sigBase = {
  sig_id: 'sig_0123456789abcdef',
  agent: 'claude',
  agent_version: '1.2.3',
  agent_version_source: 'session_meta',
  session_ref: 's_0123456789abcdef',
  project_key: 'p_fedcba9876543210',
  ts: '2026-10-12T00:00:00Z',
  type: 'event',
  excerpt_redacted: '',
  external_content: false,
  confidence: 1,
  loaded_rule_ids: [],
};
const statBase = {
  session_ref: 's_0123456789abcdef',
  project_key: 'p_fedcba9876543210',
  ts: '2026-10-12T00:00:00Z',
  external_content: false,
  counts: { user_messages: 1, tool_calls: 0, tool_failures: 0, unknown_event_types: {} },
};
const CTX = { cwd: '/work/proj-a', version: '2.1.294' };
const M = (c: string): string => `rsm_${c.repeat(16)}`;

describe('Signal 追加键', () => {
  it('旧信号(缺新键)仍通过;新键合法值通过(正向)', () => {
    expect(SignalSchema.safeParse(sigBase).success).toBe(true);
    for (const tool_error_class of [
      'timeout',
      'not_found',
      'permission',
      'network',
      'conflict',
      'syntax',
      'other',
    ]) {
      expect(
        SignalSchema.safeParse({ ...sigBase, tool_error_class, retry_chain_len: 3 }).success,
      ).toBe(true);
    }
  });
  it('非法值被拒:未知类、0 / 负 / 小数链长;仍是 strictObject', () => {
    for (const extra of [
      { tool_error_class: 'bogus' },
      { tool_error_class: '' },
      { retry_chain_len: 0 },
      { retry_chain_len: -1 },
      { retry_chain_len: 1.5 },
      { retry_chain_len: '2' },
      { phase_sequence: [] },
    ]) {
      expect(SignalSchema.safeParse({ ...sigBase, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });
});

describe('SessionStat 追加键', () => {
  it('旧计数行(缺三键)仍通过;新键合法值通过(正向)', () => {
    expect(SessionStatSchema.safeParse(statBase).success).toBe(true);
    expect(
      SessionStatSchema.safeParse({
        ...statBase,
        rsi_markers: [M('0'), M('1')],
        retry_chain_max: 0,
        injection_excluded: 2,
      }).success,
    ).toBe(true);
    expect(SessionStatSchema.safeParse({ ...statBase, rsi_markers: [] }).success).toBe(true);
  });
  it('非法值被拒:标记形状、重复、> 4 个、负数 / 小数;仍是 strictObject', () => {
    expect(SESSION_MARKERS_MAX).toBe(4);
    const five = ['0', '1', '2', '3', '4'].map(M);
    for (const extra of [
      { rsi_markers: ['rsm_xyz'] },
      { rsi_markers: [M('A')] },
      { rsi_markers: [M('0'), M('0')] },
      { rsi_markers: five },
      { retry_chain_max: -1 },
      { retry_chain_max: 1.5 },
      { injection_excluded: -1 },
      { marker_count: 1 },
    ]) {
      expect(
        SessionStatSchema.safeParse({ ...statBase, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
    expect(
      SessionStatSchema.safeParse({ ...statBase, rsi_markers: five.slice(0, 4) }).success,
    ).toBe(true);
  });
});

describe('升级路径:旧库(无新键)被新代码重采', () => {
  it('信号按 sig_id 去重、不报错、旧行不被改写;会话计数行补上三键、ts 钉死', async () => {
    const w = await newWork('w4-upgrade-');
    await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'up1',
      // collect 靠行内的 cwd 判定项目归属,所以每行都带 cwd(版本号同理,走 session_meta)
      lines: [
        userLine(controlBlock(), { isMeta: true, ...CTX }),
        userLine('你好', CTX),
        assistantLine([{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'x' } }], CTX),
        userLine(
          [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'timeout' }],
          CTX,
        ),
      ],
    });
    const overlay = await writeOverlay(w, selftestOverlayToml());
    const argv = ['--source', w.sessions, '--agent', 'claude', '--allow-project', 'proj-a'];
    const r1 = await runClaudeCollect(w, argv, overlay);
    expect(r1.code, r1.err).toBe(0);

    const files = async (dir: string): Promise<string[]> =>
      (await exists(dir)) ? (await readDir(dir)).map((e) => path.join(dir, e.name)) : [];
    const sigFiles = await files(signalsDir(w.io, 'claude'));
    const statFiles = await files(sessionStatsDir(w.io, 'claude'));
    expect(sigFiles).toHaveLength(1);
    expect(statFiles).toHaveLength(1);

    // 把库改回「W4 之前」的形状:删掉全部新键
    const strip = (obj: Record<string, unknown>, keys: string[]): string => {
      for (const k of keys) delete obj[k];
      return JSON.stringify(obj);
    };
    const sigText = await readText(sigFiles[0] as string);
    const sigLines = sigText
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // 正向:新库里确有新键(否则下面的剥离什么都没测)
    expect(sigLines.some((l) => 'tool_error_class' in l && 'retry_chain_len' in l)).toBe(true);
    const oldSig = `${sigLines.map((l) => strip(l, ['tool_error_class', 'retry_chain_len'])).join('\n')}\n`;
    await writeFile(w.io, sigFiles[0] as string, oldSig, { mode: 0o600 });
    const stat = JSON.parse((await readText(statFiles[0] as string)).trim()) as Record<
      string,
      unknown
    >;
    expect(stat['rsi_markers']).toEqual(['rsm_0123456789abcdef']);
    const oldStat = `${strip({ ...stat }, ['rsi_markers', 'retry_chain_max', 'injection_excluded'])}\n`;
    await writeFile(w.io, statFiles[0] as string, oldStat, { mode: 0o600 });

    const r2 = await runClaudeCollect(w, argv, overlay);
    expect(r2.code, r2.err).toBe(0);
    // 信号:同 sig_id 全部去重,旧行逐字节不变(新代码不回填旧行)
    expect(await readText(sigFiles[0] as string)).toBe(oldSig);
    // 计数行:同一 session_ref 就地更新成带三键的形状,ts 沿用
    const after = JSON.parse((await readText(statFiles[0] as string)).trim()) as Record<
      string,
      unknown
    >;
    expect(after['rsi_markers']).toEqual(['rsm_0123456789abcdef']);
    expect(after['retry_chain_max']).toBe(1);
    expect(after['ts']).toBe(stat['ts']);
  });
});

describe('jq oracle 夹具不含 RSI 注入块(spec §12:oracle 不建模排除)', () => {
  it('test/fixtures/sessions 下的生成器源码不含 RSI_MARK_PREFIX;正向:目录里确有 reader 夹具生成器', async () => {
    const dir = path.join(REPO_ROOT, 'test', 'fixtures', 'sessions');
    const files = (await readDir(dir)).filter((e) => e.isFile && e.name.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(RSI_MARK_PREFIX.length).toBeGreaterThan(8);
    for (const f of files) {
      const text = await readText(path.join(dir, f.name));
      expect(text.includes(RSI_MARK_PREFIX), f.name).toBe(false);
      expect(text.includes('RSI_MARK_PREFIX'), f.name).toBe(false);
    }
  });
});
