/** 经 B10b 管线(signals collect)端到端:reader 输出被脱敏落盘,秘密零命中;外部内容会话不留摘录。 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SignalSchema } from '../../../src/contracts/signal.js';
import { exists, readDir, readText } from '../../../src/io/read-fs.js';
import { signalsDir } from '../../../src/signals/state-store.js';
import { genClaude } from '../../fixtures/sessions/gen-claude.js';
import {
  allFilesText,
  recognizedSeeds,
  selftestOverlayToml,
  writeOverlay,
} from '../../signals/helpers.js';
import type { Work } from '../../signals/helpers.js';
import { newWork, runClaudeCollect } from './helpers.js';

const ARGS = (w: Work): string[] => ['--source', w.sessions, '--agent', 'claude'];

async function stateSignals(w: Work) {
  const dir = signalsDir(w.io, 'claude');
  if (!(await exists(dir))) return [];
  const rows = [];
  for (const e of await readDir(dir)) {
    const text = await readText(path.join(dir, e.name));
    for (const line of text.split('\n')) if (line) rows.push(SignalSchema.parse(JSON.parse(line)));
  }
  return rows;
}

describe('ClaudeReader × collect 管线', () => {
  it('种子秘密经 reader → 脱敏 → 落盘 零命中;信号非空;agent_version 来自会话(session_meta)', async () => {
    const w = await newWork('cl-pipe-');
    const seeds = recognizedSeeds().slice(0, 12);
    expect(seeds.length).toBe(12);
    await genClaude(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'p1',
      userTexts: seeds.map((s) => `看一下: ${s.input} 谢谢`),
      toolCalls: 1,
      failedResults: 0,
      version: '2.1.294',
    });
    const overlay = await writeOverlay(w, selftestOverlayToml());
    const r = await runClaudeCollect(w, [...ARGS(w), '--allow-project', 'proj-a'], overlay);
    expect(r.code, r.err).toBe(0);
    const rows = await stateSignals(w);
    expect(rows.length).toBeGreaterThanOrEqual(seeds.length);
    for (const row of rows) {
      expect(row.agent_version).toBe('2.1.294');
      expect(row.agent_version_source).toBe('session_meta');
      expect(row.session_ref).toMatch(/^s_[0-9a-f]{16}$/);
      expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    const leaked = (text: string) =>
      seeds.filter((s) => s.needles.some((n) => text.includes(n))).map((s) => s.id);
    for (const f of await allFilesText(w.state)) expect(leaked(f.text), f.file).toEqual([]);
    expect(leaked(r.out)).toEqual([]);
    // 工作目录 / 项目目录名只以哈希落盘:会话文件里确有它(正向对照),状态目录与 stdout 里没有
    const sessionFiles = await allFilesText(w.sessions);
    expect(sessionFiles.some((f) => f.text.includes('/work/proj-a'))).toBe(true);
    expect(sessionFiles.some((f) => f.file.includes('work-proj-a'))).toBe(true);
    for (const f of await allFilesText(w.state)) {
      expect(f.text, f.file).not.toContain('/work/proj-a');
      expect(f.text, f.file).not.toContain('work-proj-a');
    }
    expect(r.out).not.toContain('/work/proj-a');
  });

  it('子代理文件与 isSidechain 行不会流进信号库', async () => {
    const w = await newWork('cl-pipe-side-');
    await genClaude(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'p2',
      userTexts: ['main-only'],
      toolCalls: 0,
      failedResults: 0,
      version: '2.1.294',
      duplicates: true,
    });
    const r = await runClaudeCollect(w, [...ARGS(w), '--allow-project', 'proj-a']);
    expect(r.code, r.err).toBe(0);
    const text = (await allFilesText(w.state)).map((f) => f.text).join('\n');
    expect(text).not.toContain('sidechain line, not counted');
    expect(text).toContain('main-only');
  });
});
