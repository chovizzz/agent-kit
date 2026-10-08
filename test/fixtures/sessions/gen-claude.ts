/** Claude Code 合成会话:`<root>/<项目目录>/<UUID>.jsonl`(口径 §2.1)。 */
import * as path from 'node:path';
import type { IoContext } from '../../../src/io/paths.js';
import { BASE_MS, MALFORMED_LINE, chk, fakeUuid, iso, serialize, writeSession } from './common.js';
import type { GeneratedSession, SessionSpec } from './common.js';

export async function genClaude(ctx: IoContext, spec: SessionSpec): Promise<GeneratedSession> {
  chk(spec);
  const base = spec.baseMs ?? BASE_MS;
  const sid = fakeUuid(spec.id);
  let t = 0;
  const ts = (): Record<string, string> =>
    spec.noTimestamps ? {} : { timestamp: iso(base + 1000 * t++) };
  const common = {
    sessionId: sid,
    cwd: spec.cwd,
    ...(spec.version !== undefined ? { version: spec.version } : {}),
  };
  const lines: string[] = [];
  // 首批元数据行没有时间戳与 version(口径 §2.1.5)
  lines.push(JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }));
  for (const text of spec.userTexts) {
    lines.push(
      JSON.stringify({
        type: 'user',
        ...ts(),
        ...common,
        message: { role: 'user', content: text },
      }),
    );
  }
  const tool = spec.toolName ?? 'Bash';
  for (let i = 0; i < spec.toolCalls; i++) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        ...ts(),
        ...common,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            {
              type: 'tool_use',
              id: `tu_${i}`,
              name: tool,
              input: { command: spec.toolInput ?? 'ls' },
            },
          ],
        },
      }),
    );
    const failed = i < spec.failedResults;
    lines.push(
      JSON.stringify({
        type: 'user',
        ...ts(),
        ...common,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `tu_${i}`,
              content: failed ? 'error: boom' : 'done',
              ...(failed ? { is_error: true } : {}),
            },
          ],
        },
      }),
    );
  }
  const unknown: Record<string, number> = {};
  if (spec.unknownEvent) {
    lines.splice(2, 0, JSON.stringify({ type: 'weird-new-type', ...ts() }));
    unknown['weird-new-type'] = 1;
  }
  if (spec.malformedLine) {
    lines.splice(3, 0, MALFORMED_LINE);
    unknown['<malformed>'] = 1;
  }
  let ignored: Record<string, number> | undefined;
  if (spec.duplicates) {
    lines.splice(
      2,
      0,
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        ...ts(),
        ...common,
        message: { role: 'user', content: 'sidechain line, not counted' },
      }),
    );
    ignored = { 'claude.sidechain_line': 1 };
  }
  const file = path.join(
    spec.root,
    `-${spec.cwd.replaceAll('/', '-').replace(/^-/, '')}`,
    `${sid}.jsonl`,
  );
  await writeSession(ctx, file, serialize(lines, spec));
  return {
    file,
    cwd: spec.cwd,
    expected: {
      user_messages: spec.userTexts.length,
      tool_calls: spec.toolCalls,
      tool_failures: spec.failedResults,
      unknown_event_types: unknown,
      ...(ignored ? { ignored_duplicate_kinds: ignored } : {}),
    },
  };
}

export interface ClaudeRawSpec {
  root: string;
  cwd: string;
  id: string;
  /** 每个元素是一行:对象(JSON.stringify)或原样字符串(畸形行、空白行等) */
  lines: readonly (Record<string, unknown> | string)[];
  eol?: '\n' | '\r\n';
  bom?: boolean;
  finalNewline?: boolean;
  /** 相对 `<root>/<项目目录>/` 的文件路径,缺省 `<UUID>.jsonl`(用来放 subagents/ 等非主文件) */
  relPath?: string;
}

/** 追加(B11):按手写的行写一个 Claude 会话文件,用于谓词/鲁棒性用例;返回绝对路径。 */
export async function writeClaudeLines(ctx: IoContext, spec: ClaudeRawSpec): Promise<string> {
  const eol = spec.eol ?? '\n';
  const body =
    spec.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join(eol) +
    (spec.finalNewline === false ? '' : eol);
  const dir = path.join(spec.root, `-${spec.cwd.replaceAll('/', '-').replace(/^-/, '')}`);
  const file = path.join(dir, spec.relPath ?? `${fakeUuid(spec.id)}.jsonl`);
  await writeSession(ctx, file, (spec.bom ? '\uFEFF' : '') + body);
  return file;
}
