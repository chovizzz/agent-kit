/**
 * Pi 合成会话:`<root>/--<路径>--/<时间>_<uuid>.jsonl`(口径 §2.3)。
 * 首行是头(不是树节点);其余是树节点 `id/parentId/timestamp/type`。
 * `branchEntries` > 0 时插入一段被放弃的分支(用户消息条目,计入 user_messages,并计入 branch_count)。
 */
import * as path from 'node:path';
import type { IoContext } from '../../../src/io/paths.js';
import { BASE_MS, MALFORMED_LINE, chk, fakeUuid, iso, serialize, writeSession } from './common.js';
import type { GeneratedSession, SessionSpec } from './common.js';

export interface PiSpec extends SessionSpec {
  branchEntries?: number;
}

export async function genPi(ctx: IoContext, spec: PiSpec): Promise<GeneratedSession> {
  chk(spec);
  const base = spec.baseMs ?? BASE_MS;
  const uuid = fakeUuid(spec.id);
  let t = 0;
  const T = (): Record<string, string> =>
    spec.noTimestamps ? {} : { timestamp: iso(base + 1000 * t++) };
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: 'session',
      version: 3,
      id: uuid,
      ...(spec.noTimestamps ? {} : { timestamp: iso(base) }),
      cwd: spec.cwd,
    }),
  );
  let n = 0;
  let tip: string | null = null;
  const entry = (body: Record<string, unknown>): { id: string; line: string } => {
    const id = `e${n++}`;
    const line = JSON.stringify({ id, parentId: tip, ...T(), ...body });
    tip = id;
    return { id, line };
  };
  let firstId = '';
  for (const text of spec.userTexts) {
    const e = entry({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    if (firstId === '') firstId = e.id;
    lines.push(e.line);
  }
  const tool = spec.toolName ?? 'bash';
  for (let i = 0; i < spec.toolCalls; i++) {
    lines.push(
      entry({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            {
              type: 'toolCall',
              id: `tc${i}`,
              name: tool,
              arguments: { command: spec.toolInput ?? 'ls' },
            },
          ],
        },
      }).line,
    );
    lines.push(
      entry({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: `tc${i}`,
          toolName: tool,
          isError: i < spec.failedResults,
          content: [{ type: 'text', text: i < spec.failedResults ? 'error: boom' : 'done' }],
        },
      }).line,
    );
  }
  const branch = spec.branchEntries ?? 0;
  if (branch > 0 && firstId !== '') {
    // 被放弃的分支:挂在第一个条目下,不在「最后一个条目」的祖先链上
    let btip = firstId;
    const extra: string[] = [];
    for (let i = 0; i < branch; i++) {
      const id = `b${i}`;
      extra.push(
        JSON.stringify({
          id,
          parentId: btip,
          ...T(),
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'abandoned branch' }] },
        }),
      );
      btip = id;
    }
    lines.splice(lines.length - 1, 0, ...extra);
  }
  const unknown: Record<string, number> = {};
  if (spec.unknownEvent) {
    lines.splice(2, 0, JSON.stringify({ id: 'u0', parentId: null, ...T(), type: 'mystery_entry' }));
    unknown['mystery_entry'] = 1;
  }
  if (spec.malformedLine) {
    lines.splice(3, 0, MALFORMED_LINE);
    unknown['<malformed>'] = 1;
  }
  const dir = `--${spec.cwd.replaceAll('/', '-').replace(/^-/, '')}--`;
  const file = path.join(spec.root, dir, `${iso(base).replaceAll(':', '-')}_${uuid}.jsonl`);
  await writeSession(ctx, file, serialize(lines, spec));
  return {
    file,
    cwd: spec.cwd,
    expected: {
      user_messages: spec.userTexts.length + branch,
      tool_calls: spec.toolCalls,
      tool_failures: spec.failedResults,
      unknown_event_types: unknown,
      ...(branch > 0 ? { branch_count: branch } : {}),
    },
  };
}

/** 树结构用例的一行:对象会被 JSON.stringify,字符串原样写入(用来造畸形行)。 */
export type RawPiLine = Record<string, unknown> | string;

export interface RawPiSpec {
  root: string;
  /** 目录名 `--<...>--`;缺省按 cwd 生成 */
  dir?: string;
  cwd: string;
  id: string;
  /** 不含头;头由 `header` 控制 */
  lines: readonly RawPiLine[];
  /** false = 不写头行 */
  header?: boolean;
  eol?: '\n' | '\r\n';
  bom?: boolean;
  finalNewline?: boolean;
  baseMs?: number;
}

/** 树节点行:`piNode('a2', 'a1', {...})` → `{id,parentId,timestamp,...body}`。 */
export function piNode(
  id: string | undefined,
  parentId: unknown,
  body: Record<string, unknown>,
  tsMs?: number,
): Record<string, unknown> {
  return {
    ...(id !== undefined ? { id } : {}),
    parentId,
    ...(tsMs !== undefined ? { timestamp: iso(tsMs) } : {}),
    ...body,
  };
}

export const piUserMsg = (text: string): Record<string, unknown> => ({
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

/** 逐行精确控制的 Pi 会话文件(树结构边界用例);期望值由调用方按构造手算。 */
export async function genPiRaw(ctx: IoContext, spec: RawPiSpec): Promise<GeneratedSession> {
  const base = spec.baseMs ?? BASE_MS;
  const uuid = fakeUuid(spec.id);
  const lines: string[] = [];
  if (spec.header !== false) {
    lines.push(
      JSON.stringify({
        type: 'session',
        version: 3,
        id: uuid,
        timestamp: iso(base),
        cwd: spec.cwd,
      }),
    );
  }
  for (const l of spec.lines) lines.push(typeof l === 'string' ? l : JSON.stringify(l));
  const eol = spec.eol ?? '\n';
  const content =
    (spec.bom ? '﻿' : '') + lines.join(eol) + (spec.finalNewline === false ? '' : eol);
  const dir = spec.dir ?? `--${spec.cwd.replaceAll('/', '-').replace(/^-/, '')}--`;
  const file = path.join(spec.root, dir, `${iso(base).replaceAll(':', '-')}_${uuid}.jsonl`);
  await writeSession(ctx, file, content);
  return {
    file,
    cwd: spec.cwd,
    expected: { user_messages: 0, tool_calls: 0, tool_failures: 0, unknown_event_types: {} },
  };
}
