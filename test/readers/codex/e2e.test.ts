/**
 * Codex reader 经 `signals collect` 管线的端到端:合成会话(含运行时拼装的种子秘密)→ 读取 → 排除判定 →
 * 脱敏 → 落盘。真实 HOME 前后无变化。
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignalSchema } from '../../../src/contracts/signal.js';
import { createSignalsCollectCommand } from '../../../src/commands/signals-collect.js';
import { exists, readDir, readText } from '../../../src/io/read-fs.js';
import { createCodexReader } from '../../../src/readers/codex/index.js';
import { signalsDir } from '../../../src/signals/state-store.js';
import {
  allFilesText,
  homeSnapshot,
  newWork,
  recognizedSeeds,
  selftestOverlayToml,
  writeOverlay,
} from '../../signals/helpers.js';
import type { Work } from '../../signals/helpers.js';
import { LineBuilder, writeRollout } from './build.js';

let homeBefore = '';
beforeAll(async () => {
  homeBefore = await homeSnapshot();
});
afterAll(async () => {
  expect(await homeSnapshot()).toBe(homeBefore);
});

async function run(w: Work, argv: string[], overlayPath?: string) {
  let out = '';
  let err = '';
  const cmd = createSignalsCollectCommand({ readers: { codex: () => createCodexReader() } });
  const code = await cmd.run({
    argv: ['--source', w.sessions, '--agent', 'codex', ...argv],
    io: w.io,
    overlayPath,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

async function stateSignals(w: Work) {
  const dir = signalsDir(w.io, 'codex');
  if (!(await exists(dir))) return [];
  const rows = [];
  for (const e of await readDir(dir)) {
    const text = await readText(path.join(dir, e.name));
    for (const line of text.split('\n')) if (line) rows.push(SignalSchema.parse(JSON.parse(line)));
  }
  return rows;
}

describe('collect 端到端(codex)', () => {
  it('种子秘密(用户消息 + 工具调用参数)经管线后 .state 与 stdout 零命中;侧链会话不被读;版本来自会话', async () => {
    const w = await newWork('cx-e2e-');
    const seeds = recognizedSeeds();
    expect(seeds.length).toBeGreaterThanOrEqual(20);
    const b = new LineBuilder().meta({ cli_version: '0.161.0' });
    for (const s of seeds) b.userItem(`看一下这个: ${s.input} 谢谢`);
    b.fn('exec_command', JSON.stringify({ cmd: `export TOKEN=${seeds[0]?.input ?? ''}` }));
    b.toolItem('CommandExecution', 'failed');
    await writeRollout(w.io, w.sessions, b, { id: 'main' });
    await writeRollout(
      w.io,
      w.sessions,
      new LineBuilder().meta({ source: { subagent: 1 } }).userItem('侧链'),
      {
        id: 'side',
        baseMs: Date.UTC(2026, 9, 2),
      },
    );
    const overlay = await writeOverlay(w, selftestOverlayToml('exclude_dirs = ["/clients/acme"]'));
    const r = await run(w, [], overlay);
    expect(r.code, r.err).toBe(0);
    const o = JSON.parse(r.out) as {
      report: {
        sessions_read: number;
        signals_emitted: number;
        agent_version_fallback_ratio: number;
        unknown_event_types: Record<string, number>;
      };
      sessions: { counts: { user_messages: number; tool_calls: number; tool_failures: number } }[];
    };
    expect(o.report.sessions_read).toBe(1); // 侧链没有被当成会话
    expect(o.report.agent_version_fallback_ratio).toBe(0);
    expect(o.report.unknown_event_types).toEqual({});
    expect(o.sessions[0]?.counts).toMatchObject({
      user_messages: seeds.length,
      tool_calls: 1,
      tool_failures: 1,
    });
    const rows = await stateSignals(w);
    // 正向前提:信号真的落盘了(每条用户消息 + 工具调用 + 失败的结果)
    expect(rows.length).toBe(seeds.length + 2);
    expect(rows.every((x) => x.agent === 'codex' && x.agent_version === '0.161.0')).toBe(true);
    expect(rows.filter((x) => x.excerpt_redacted !== '').length).toBeGreaterThan(seeds.length);
    const leaked = (text: string) =>
      seeds.filter((s) => s.needles.some((n) => text.includes(n))).map((s) => s.id);
    for (const f of await allFilesText(w.state)) expect(leaked(f.text), f.file).toEqual([]);
    expect(leaked(rows.map((x) => x.excerpt_redacted).join('\n'))).toEqual([]);
    expect(leaked(r.out)).toEqual([]);
    expect(leaked(r.err)).toEqual([]);
  });

  it('含 web_search 的会话按外部内容处理:摘录为空,只保留结构化信息', async () => {
    const w = await newWork('cx-e2e-ext-');
    const b = new LineBuilder().meta().userItem('普通问题');
    b.call('web_search_call', { action: { type: 'search', query: 'q' } });
    await writeRollout(w.io, w.sessions, b, { id: 'ext' });
    const r = await run(w, ['--allow-project', 'proj-a']);
    expect(r.code, r.err).toBe(0);
    const rows = await stateSignals(w);
    expect(rows.length).toBe(2);
    expect(rows.every((x) => x.excerpt_redacted === '' && x.external_content === true)).toBe(true);
  });

  it('读不到 cli_version 时由 collector 兜底(此处没有 CLI → unknown),reader 本身不兜底', async () => {
    const w = await newWork('cx-e2e-ver-');
    const b = new LineBuilder().add({
      type: 'session_meta',
      payload: { source: 'cli', cwd: '/work/proj-a' },
    });
    b.userItem('x');
    await writeRollout(w.io, w.sessions, b, { id: 'nov' });
    const r = await run(w, ['--allow-project', 'proj-a']);
    expect(r.code, r.err).toBe(0);
    const o = JSON.parse(r.out) as { report: { agent_version_fallback_ratio: number } };
    expect(o.report.agent_version_fallback_ratio).toBe(1);
  });
});
