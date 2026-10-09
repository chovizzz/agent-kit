import * as path from 'node:path';
import type { Counts, NormEvent, SessionMeta, SessionRef } from '../../../src/contracts/reader.js';
import { createSignalsCollectCommand } from '../../../src/commands/signals-collect.js';
import { createClaudeReader } from '../../../src/readers/claude/index.js';
import { writeClaudeLines } from '../../fixtures/sessions/gen-claude.js';
import type { ClaudeRawSpec } from '../../fixtures/sessions/gen-claude.js';
import { newWork } from '../../signals/helpers.js';
import type { RunResult, Work } from '../../signals/helpers.js';

export { newWork };
export type { Work };

export const SALT = 'c'.repeat(64);

export interface ReadResult {
  events: NormEvent[];
  counts: Counts;
  meta: SessionMeta;
}

export async function oneRef(source: string): Promise<SessionRef> {
  const refs = await createClaudeReader().discover(source);
  if (refs.length !== 1) throw new Error(`期望 1 个会话文件,实际 ${refs.length}`);
  return refs[0] as SessionRef;
}

/** discover 一个文件 → read 完 → 事件 + 计数 + 元数据。 */
export async function readFile(file: string, maxEventBytes?: number): Promise<ReadResult> {
  const reader = createClaudeReader();
  const refs = await reader.discover(file);
  const read = reader.read(refs[0] as SessionRef, {
    salt: SALT,
    ...(maxEventBytes !== undefined ? { maxEventBytes } : {}),
  });
  const events: NormEvent[] = [];
  for await (const e of read.events) events.push(e);
  return { events, counts: read.counts(), meta: read.meta() };
}

let counter = 0;

/** 写一个手工行的会话并读回。每次调用换一个 id,同一 Work 内可多次调用。 */
export async function readLines(
  w: Work,
  lines: ClaudeRawSpec['lines'],
  over: Partial<ClaudeRawSpec> = {},
): Promise<ReadResult & { file: string }> {
  const file = await writeClaudeLines(w.io, {
    root: w.sessions,
    cwd: '/work/proj-a',
    id: `h${counter++}`,
    lines,
    ...over,
  });
  return { ...(await readFile(file)), file };
}

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
let tick = 0;
export const stamp = (): { timestamp: string } => ({
  timestamp: new Date(T0 + 1000 * tick++).toISOString(),
});

type Obj = Record<string, unknown>;

/** user 行:content 可为字符串或块数组;extra 追加/覆盖顶层字段。 */
export function userLine(content: unknown, extra: Obj = {}): Obj {
  return {
    type: 'user',
    isSidechain: false,
    ...stamp(),
    message: { role: 'user', content },
    ...extra,
  };
}

export function assistantLine(content: unknown, extra: Obj = {}): Obj {
  return {
    type: 'assistant',
    isSidechain: false,
    ...stamp(),
    message: { role: 'assistant', content },
    ...extra,
  };
}

export const toolUse = (id: string, name = 'Bash'): Obj => ({
  type: 'tool_use',
  id,
  name,
  input: { command: 'ls' },
});
export const toolResult = (id: string, extra: Obj = {}): Obj => ({
  type: 'tool_result',
  tool_use_id: id,
  content: 'out',
  ...extra,
});
export const textBlock = (text: string): Obj => ({ type: 'text', text });

export async function runClaudeCollect(
  w: Work,
  argv: string[],
  overlayPath?: string,
): Promise<RunResult> {
  let out = '';
  let err = '';
  const cmd = createSignalsCollectCommand({ readers: { claude: () => createClaudeReader() } });
  const code = await cmd.run({
    argv,
    io: w.io,
    overlayPath,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

export const projDir = (w: Work): string => path.join(w.sessions);
