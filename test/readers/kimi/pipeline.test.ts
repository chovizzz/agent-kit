/**
 * Kimi reader 接 B10b 管线(collect):脱敏、cwd 来自 state.json 的排除/放行、
 * 符号链接形式的 source。不改 src/signals/readers.ts:这里直接注入 reader。
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exists, readDir, readText } from '../../../src/io/read-fs.js';
import { mkdirp, symlink } from '../../../src/io/safe-fs.js';
import { createRedactor } from '../../../src/redact/index.js';
import { collect } from '../../../src/signals/collect.js';
import { createExcludePolicy } from '../../../src/signals/exclude.js';
import { signalsDir } from '../../../src/signals/state-store.js';
import { createKimiReader } from '../../../src/readers/kimi/index.js';
import { allFilesText, homeSnapshot, recognizedSeeds } from '../../signals/helpers.js';
import { genKimi, genKimiCustom } from '../../fixtures/sessions/gen-kimi.js';
import { L, loopEv, metadataLine, newWork, userMsg } from './util.js';
import type { Work } from './util.js';

let homeBefore = '';
beforeAll(async () => {
  homeBefore = await homeSnapshot();
});
afterAll(async () => {
  expect(await homeSnapshot()).toBe(homeBefore);
});

async function run(
  w: Work,
  source: string,
  policyOpts: { excludeDirs: string[]; allowProjects: string[] },
  dry = false,
) {
  const policy = await createExcludePolicy(policyOpts);
  return collect({
    reader: createKimiReader(),
    source,
    io: w.io,
    dry,
    redactor: createRedactor({ sensitive_words: ['张三科技'] }),
    policy,
    salt: 'd'.repeat(64),
    fallbackVersion: '2.0.0',
    maxEventBytes: undefined,
  });
}

async function stateRows(w: Work): Promise<string> {
  const dir = signalsDir(w.io, 'kimi');
  if (!(await exists(dir))) return '';
  const parts: string[] = [];
  for (const e of await readDir(dir)) parts.push(await readText(path.join(dir, e.name)));
  return parts.join('\n');
}

describe('管线接入', () => {
  it('state.json 的 cwd 决定排除/放行;缺 state.json → cwd 未知 → 保守跳过(正向对照:放行的会落盘)', async () => {
    const w = await newWork('kimi-pipe-excl-');
    const base = { root: w.sessions };
    await genKimi(w.io, {
      ...base,
      cwd: '/work/proj-ok',
      id: 'ok',
      userTexts: ['甲'],
      toolCalls: 1,
      failedResults: 0,
    });
    await genKimi(w.io, {
      ...base,
      cwd: '/clients/acme/app',
      id: 'bad',
      userTexts: ['乙'],
      toolCalls: 1,
      failedResults: 0,
    });
    await genKimiCustom(w.io, {
      root: w.sessions,
      id: 'nostate',
      lines: [metadataLine(), userMsg('丙')],
      stateJson: null,
    });
    const out = await run(w, w.sessions, {
      excludeDirs: ['/clients/acme'],
      allowProjects: ['proj-ok'],
    });
    expect(out.report.sessions_read).toBe(1);
    expect(out.report.sessions_skipped_excluded).toBe(2);
    expect(out.report.signals_emitted).toBeGreaterThan(0);
    const rows = await stateRows(w);
    expect(rows).not.toContain('乙');
    expect(rows).not.toContain('丙');
    // agent_version:会话里没有 → collector_fallback
    expect(out.report.agent_version_fallback_ratio).toBe(1);
    expect(rows).toContain('"agent_version_source":"collector_fallback"');
    expect(rows).toContain('"agent_version":"2.0.0"');
  });

  it('种子秘密经 kimi 会话 → 管线后,落盘文件与 stdout 样例对种子零命中(正向对照:原文里确有)', async () => {
    const w = await newWork('kimi-pipe-redact-');
    const seeds = recognizedSeeds().slice(0, 25);
    expect(seeds.length).toBeGreaterThanOrEqual(20);
    const g = await genKimi(w.io, {
      root: w.sessions,
      cwd: '/work/proj-ok',
      id: 'sec',
      userTexts: seeds.map((s) => `看一下: ${s.input} 谢谢`),
      toolCalls: 1,
      failedResults: 0,
      toolInput: `export TOKEN=${seeds[0]?.input ?? ''}`,
    });
    const raw = (await readText(g.file))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const o = JSON.parse(l) as { message?: { content?: { text?: string }[] } };
        return o.message?.content?.[0]?.text ?? '';
      })
      .join('\n');
    const leaked = (t: string) =>
      seeds.filter((s) => s.needles.some((n) => t.includes(n))).map((s) => s.id);
    expect(leaked(raw).length).toBe(seeds.length);
    const out = await run(w, w.sessions, { excludeDirs: [], allowProjects: ['proj-ok'] });
    expect(out.report.signals_emitted).toBeGreaterThan(0);
    for (const f of await allFilesText(w.state)) expect(leaked(f.text), f.file).toEqual([]);
    expect(leaked(JSON.stringify(out))).toEqual([]);
  });

  it('外部内容工具(浏览器 / MCP)的会话摘录为空,只留结构化计数', async () => {
    const w = await newWork('kimi-pipe-ext-');
    await genKimi(w.io, {
      root: w.sessions,
      cwd: '/work/proj-ok',
      id: 'ext',
      userTexts: ['用浏览器看一下'],
      toolCalls: 2,
      failedResults: 0,
      toolName: 'mcp__chrome__navigate',
    });
    const out = await run(w, w.sessions, { excludeDirs: [], allowProjects: ['proj-ok'] }, true);
    expect(out.report.signals_emitted).toBeGreaterThan(0);
    expect(out.samples).toEqual([]);
  });

  it('source 经符号链接传入:正常发现主 wire,子代理 wire 仍不收', async () => {
    const w = await newWork('kimi-pipe-link-');
    const g = await genKimi(w.io, {
      root: w.sessions,
      cwd: '/work/proj-ok',
      id: 'lk',
      userTexts: ['甲', '乙'],
      toolCalls: 1,
      failedResults: 0,
      duplicates: true,
    });
    const link = path.join(w.dir, 'sessions-link');
    await symlink(w.io, w.sessions, link);
    const reader = createKimiReader();
    const refs = await reader.discover(link);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe(g.file); // realpath 归一
    expect(g.decoyFile).toBeDefined();
    const out = await run(w, link, { excludeDirs: [], allowProjects: ['proj-ok'] }, true);
    expect(out.report.sessions_read).toBe(1);
    expect(out.sessions[0]?.counts.user_messages).toBe(2);
  });

  it('目录内的符号链接(会话目录 / wire 文件)不跟随', async () => {
    const w = await newWork('kimi-pipe-nofollow-');
    const g = await genKimi(w.io, {
      root: w.sessions,
      cwd: '/work/proj-ok',
      id: 'real',
      userTexts: ['甲'],
      toolCalls: 0,
      failedResults: 0,
    });
    const outside = path.join(w.dir, 'outside');
    await mkdirp(w.io, path.join(outside, 'agents', 'main'));
    // 指向真实 wire 的文件符号链接,放在另一个会话目录里
    const other = path.join(w.sessions, 'wd_x_h', 'session_link', 'agents', 'main');
    await mkdirp(w.io, other);
    await symlink(w.io, g.file, path.join(other, 'wire.jsonl'));
    // 指向目录的符号链接
    await symlink(w.io, outside, path.join(w.sessions, 'wd_dirlink'));
    const refs = await createKimiReader().discover(w.sessions);
    expect(refs.map((r) => r.path)).toEqual([g.file]);
  });
});

describe('未知与畸形不阻断管线', () => {
  it('未知事件与畸形行进入 report.unknown_event_types,不崩溃', async () => {
    const w = await newWork('kimi-pipe-unk-');
    await genKimiCustom(w.io, {
      root: w.sessions,
      id: 'u',
      lines: [
        metadataLine(),
        userMsg('hello'),
        L({ type: 'brand.new.type', time: 1767225611000 }),
        loopEv({ type: 'future.event' }),
        '{"type":"context.append_message","mes',
      ],
      stateJson: L({ cwd: '/work/proj-ok' }),
    });
    const out = await run(w, w.sessions, { excludeDirs: [], allowProjects: ['proj-ok'] }, true);
    expect(out.report.unknown_event_types).toEqual({
      'brand.new.type': 1,
      'context.append_loop_event.future.event': 1,
      '<malformed>': 1,
    });
  });
});
