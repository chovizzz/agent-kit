/**
 * 生成器自检:每个 gen-* 的输出按口径文档的规则被**独立的极简计数器**数一遍,必须等于生成器声明的期望;
 * 并核对格式变体(BOM/CRLF/末行无换行)与「不含 .jsonl 字面量入仓」(A10)。
 * 这些计数器只是自检,不是 reader:真正的口径验收在 B11–B14。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { genCodex } from '../fixtures/sessions/gen-codex.js';
import { genKimi } from '../fixtures/sessions/gen-kimi.js';
import { genPi } from '../fixtures/sessions/gen-pi.js';
import type { GeneratedSession, SessionSpec } from '../fixtures/sessions/common.js';
import { REPO_ROOT, newWork } from './helpers.js';
import type { Work } from './helpers.js';
import { readDir } from '../../src/io/read-fs.js';

type Obj = Record<string, unknown>;

async function lines(file: string): Promise<{ objs: Obj[]; malformed: number }> {
  const text = (await readText(file)).replace(/^\uFEFF/, '');
  const objs: Obj[] = [];
  let malformed = 0;
  for (const l of text.split('\n')) {
    if (!/\S/.test(l)) continue;
    try {
      const v: unknown = JSON.parse(l);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) objs.push(v as Obj);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { objs, malformed };
}

const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});

const COUNTERS: Record<string, (objs: Obj[]) => { u: number; c: number; f: number }> = {
  claude(objs) {
    let u = 0;
    let c = 0;
    let f = 0;
    for (const o of objs) {
      if (o['isSidechain'] === true) continue;
      const content = obj(o['message'])['content'];
      if (o['type'] === 'assistant')
        c += arr(content).filter((b) => b['type'] === 'tool_use').length;
      if (o['type'] === 'user') {
        const results = arr(content).filter((b) => b['type'] === 'tool_result');
        f += results.filter((b) => b['is_error'] === true).length;
        if (results.length === 0 && (typeof content === 'string' || Array.isArray(content))) u++;
      }
    }
    return { u, c, f };
  },
  codex(objs) {
    let u = 0;
    let c = 0;
    let f = 0;
    for (const o of objs) {
      const p = obj(o['payload']);
      if (o['type'] === 'event_msg' && p['type'] === 'item_completed') {
        const it = obj(p['item']);
        if (it['type'] === 'UserMessage') u++;
        if (it['type'] === 'CommandExecution' && it['status'] === 'failed') f++;
      }
      if (
        o['type'] === 'response_item' &&
        ['function_call', 'custom_tool_call', 'web_search_call', 'tool_search_call'].includes(
          String(p['type']),
        )
      )
        c++;
    }
    return { u, c, f };
  },
  pi(objs) {
    let u = 0;
    let c = 0;
    let f = 0;
    for (const o of objs) {
      if (o['type'] !== 'message') continue;
      const m = obj(o['message']);
      if (m['role'] === 'user') u++;
      if (m['role'] === 'assistant')
        c += arr(m['content']).filter((b) => b['type'] === 'toolCall').length;
      if (m['role'] === 'toolResult' && m['isError'] === true) f++;
    }
    return { u, c, f };
  },
  kimi(objs) {
    let u = 0;
    let c = 0;
    let f = 0;
    for (const o of objs) {
      const ev = obj(o['event']);
      if (o['type'] === 'context.append_message') {
        const m = obj(o['message']);
        if (m['role'] === 'user' && obj(m['origin'])['kind'] === 'user') u++;
      }
      if (o['type'] === 'context.append_loop_event') {
        if (ev['type'] === 'tool.call') c++;
        if (ev['type'] === 'tool.result' && obj(ev['result'])['isError'] === true) f++;
      }
    }
    return { u, c, f };
  },
};

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  if (!(await exists(dir))) return out;
  for (const e of await readDir(dir)) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await walk(abs)));
    else out.push(abs);
  }
  return out;
}

function spec(w: Work, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    root: w.sessions,
    cwd: '/work/proj-a',
    id: 'g1',
    userTexts: ['一', '二', '三'],
    toolCalls: 4,
    failedResults: 2,
    version: '1.2.3',
    unknownEvent: true,
    malformedLine: true,
    duplicates: true,
    ...over,
  };
}

const GENS: Record<string, (w: Work, s: SessionSpec) => Promise<GeneratedSession>> = {
  claude: (w, s) => genClaude(w.io, s),
  codex: (w, s) => genCodex(w.io, s),
  pi: (w, s) => genPi(w.io, s),
  kimi: (w, s) => genKimi(w.io, s),
};

describe.each(Object.keys(GENS))('生成器 %s', (name) => {
  it('独立计数器 = 声明的期望(三个计数 + 畸形行 + 未知事件);期望非零(正向前提)', async () => {
    const w = await newWork(`gen-${name}-`);
    const g = await (GENS[name] as (w: Work, s: SessionSpec) => Promise<GeneratedSession>)(
      w,
      spec(w),
    );
    const { objs, malformed } = await lines(g.file);
    const got = (COUNTERS[name] as (o: Obj[]) => { u: number; c: number; f: number })(objs);
    expect(g.expected.user_messages).toBe(3);
    expect(g.expected.tool_calls).toBe(4);
    expect(g.expected.tool_failures).toBe(2);
    expect(got).toEqual({ u: 3, c: 4, f: 2 });
    expect(malformed).toBe(1);
    expect(g.expected.unknown_event_types['<malformed>']).toBe(1);
    expect(Object.keys(g.expected.unknown_event_types).length).toBe(2);
  });

  it('BOM / CRLF / 末行无换行变体:逐行解析结果不变', async () => {
    const w = await newWork(`gen-${name}-fmt-`);
    const gen = GENS[name] as (w: Work, s: SessionSpec) => Promise<GeneratedSession>;
    const base = await lines((await gen(w, spec(w, { id: 'a' }))).file);
    const variant = await gen(w, spec(w, { id: 'b', bom: true, eol: '\r\n', finalNewline: false }));
    const raw = await readText(variant.file);
    expect(raw.startsWith('\uFEFF')).toBe(true);
    expect(raw.includes('\r\n')).toBe(true);
    expect(raw.endsWith('\n')).toBe(false);
    const v = await lines(variant.file);
    // CR 当空白,BOM 忽略:对象数/畸形数相同(id 不同只影响 sessionId 字段)
    expect(v.objs.length).toBe(base.objs.length);
    expect(v.malformed).toBe(base.malformed);
  });
});

describe('生成器的特例', () => {
  it('kimi:duplicates 写子代理 wire 与同级 state.json;主 wire 里的 turn.prompt 不是用户消息', async () => {
    const w = await newWork('gen-kimi-decoy-');
    const g = await genKimi(w.io, spec(w));
    expect(g.decoyFile).toBeDefined();
    expect(g.decoyFile?.includes(`${path.sep}agent-1${path.sep}`)).toBe(true);
    expect(g.expected.ignored_duplicate_kinds).toEqual({ 'turn.prompt': 3 });
    const state = JSON.parse(
      await readText(path.join(path.dirname(path.dirname(path.dirname(g.file))), 'state.json')),
    ) as Obj;
    expect(state['cwd']).toBe('/work/proj-a');
  });

  it('pi:branchEntries 造出分支;期望 branch_count 与用户消息数同步', async () => {
    const w = await newWork('gen-pi-branch-');
    const g = await genPi(w.io, { ...spec(w), branchEntries: 2, duplicates: false });
    expect(g.expected.branch_count).toBe(2);
    expect(g.expected.user_messages).toBe(5);
    const { objs } = await lines(g.file);
    expect(COUNTERS['pi']?.(objs).u).toBe(5);
  });

  it('noTimestamps:没有任何时间戳字段', async () => {
    const w = await newWork('gen-nots-');
    for (const [n, gen] of Object.entries(GENS)) {
      const g = await gen(
        w,
        spec(w, { id: `nt-${n}`, noTimestamps: true, root: path.join(w.sessions, n) }),
      );
      const text = await readText(g.file);
      expect(/"timestamp"|"time":|"created_at"/.test(text), n).toBe(false);
    }
  });

  it('A10:仓库里 test/fixtures/sessions 只有生成器源码,没有 .jsonl', async () => {
    const files = await walk(path.join(REPO_ROOT, 'test', 'fixtures', 'sessions'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files.filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))).toEqual([]);
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true);
  });
});
