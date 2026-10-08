import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { createSignalsCollectCommand } from '../../../src/commands/signals-collect.js';
import { SignalSchema } from '../../../src/contracts/signal.js';
import { exists, readDir, readText } from '../../../src/io/read-fs.js';
import { createPiReader } from '../../../src/readers/pi/index.js';
import { signalsDir } from '../../../src/signals/state-store.js';
import { genPi } from '../../fixtures/sessions/gen-pi.js';
import {
  allFilesText,
  homeSnapshot,
  newWork,
  recognizedSeeds,
  selftestOverlayToml,
  writeOverlay,
} from '../../signals/helpers.js';
import type { Work } from '../../signals/helpers.js';

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
  const cmd = createSignalsCollectCommand({ readers: { pi: () => createPiReader() } });
  const code = await cmd.run({
    argv,
    io: w.io,
    overlayPath,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

async function stateRows(w: Work) {
  const dir = signalsDir(w.io, 'pi');
  if (!(await exists(dir))) return [];
  const rows = [];
  for (const e of await readDir(dir)) {
    for (const line of (await readText(path.join(dir, e.name))).split('\n'))
      if (line) rows.push(SignalSchema.parse(JSON.parse(line)));
  }
  return rows;
}

describe('Pi reader 经 B10b 管线(signals collect --agent pi)', () => {
  it('种子秘密(用户消息 + 工具参数)落盘零命中;agent_version 兜底标 collector_fallback;含分支会话照常产出', async () => {
    const w = await newWork('pi-e2e-');
    const seeds = recognizedSeeds().slice(0, 20);
    expect(seeds.length).toBe(20); // 防止种子集过滤后静默变空
    const g = await genPi(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'e2e',
      userTexts: seeds.map((s) => `看一下: ${s.input} 谢谢`),
      toolCalls: 1,
      failedResults: 0,
      toolInput: `export TOKEN=${seeds[0]?.input ?? ''}`,
      branchEntries: 2,
    });
    // 正向对照:会话原文里确实有秘密
    const raw = await readText(g.file);
    const leaked = (text: string) =>
      seeds.filter((s) => s.needles.some((n) => text.includes(n))).map((s) => s.id);
    expect(leaked(raw).length).toBeGreaterThan(0);

    const overlay = await writeOverlay(w, selftestOverlayToml('exclude_dirs = ["/clients/acme"]'));
    const r = await run(
      w,
      ['--source', w.sessions, '--agent', 'pi', '--cli-version', '0.87.1'],
      overlay,
    );
    expect(r.code, r.err).toBe(0);
    const rows = await stateRows(w);
    expect(rows.length).toBeGreaterThan(0); // 正向对照:确实落了盘
    expect(rows.every((x) => x.agent === 'pi')).toBe(true);
    expect(rows.every((x) => x.agent_version === '0.87.1')).toBe(true);
    expect(rows.every((x) => x.agent_version_source === 'collector_fallback')).toBe(true);
    for (const f of await allFilesText(w.state)) expect(leaked(f.text), f.file).toEqual([]);
    expect(leaked(r.out)).toEqual([]);
    // 报告里的会话计数 = 夹具构造期望(含分支)
    const o = JSON.parse(r.out) as { sessions: { counts: Record<string, unknown> }[] };
    expect(o.sessions).toHaveLength(1);
    expect(o.sessions[0]?.counts).toMatchObject({
      user_messages: 20 + 2,
      tool_calls: 1,
      tool_failures: 0,
      branch_count: 2,
    });
  });

  it('被排除目录的 Pi 会话整条跳过;未排除的落盘(正向对照)', async () => {
    const w = await newWork('pi-e2e-excl-');
    await genPi(w.io, {
      root: w.sessions,
      cwd: '/clients/acme/app',
      id: 'client',
      userTexts: ['客户的话'],
      toolCalls: 0,
      failedResults: 0,
    });
    await genPi(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'mine',
      userTexts: ['我的话'],
      toolCalls: 0,
      failedResults: 0,
    });
    const overlay = await writeOverlay(w, selftestOverlayToml('exclude_dirs = ["/clients/acme"]'));
    const r = await run(w, ['--source', w.sessions, '--agent', 'pi'], overlay);
    expect(r.code, r.err).toBe(0);
    const all = [r.out, ...(await allFilesText(w.state)).map((f) => f.text)].join('\n');
    expect(all.includes('客户的话')).toBe(false);
    const rows = await stateRows(w);
    expect(rows.map((x) => x.excerpt_redacted)).toEqual(['我的话']);
  });
});
