/**
 * Kimi 合成会话:`<root>/<wd 键>/<session>/agents/main/wire.jsonl`(口径 §2.4),
 * 并写同级 `state.json`({cwd})。`duplicates` 时还会写一个子代理 wire(`agents/agent-1/wire.jsonl`,不是会话)
 * 并在主 wire 里为每条用户消息追加被忽略的 `turn.prompt` 记录。
 */
import * as path from 'node:path';
import type { IoContext } from '../../../src/io/paths.js';
import { BASE_MS, MALFORMED_LINE, chk, fakeUuid, serialize, writeSession } from './common.js';
import type { GeneratedSession, SessionSpec } from './common.js';

export interface KimiGenerated extends GeneratedSession {
  /** duplicates 时的子代理 wire 路径(应被 discover 排除) */
  decoyFile?: string;
}

export async function genKimi(ctx: IoContext, spec: SessionSpec): Promise<KimiGenerated> {
  chk(spec);
  const base = spec.baseMs ?? BASE_MS;
  let t = 0;
  const T = (): Record<string, number> => (spec.noTimestamps ? {} : { time: base + 1000 * t++ });
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: 'metadata',
      protocol_version: '1.5',
      ...(spec.noTimestamps ? {} : { created_at: base }),
    }),
  );
  const dupes: string[] = [];
  for (const text of spec.userTexts) {
    lines.push(
      JSON.stringify({
        type: 'context.append_message',
        ...T(),
        agentId: 'main',
        message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text }] },
      }),
    );
    if (spec.duplicates) {
      lines.push(JSON.stringify({ type: 'turn.prompt', ...T(), origin: { kind: 'user' }, text }));
      dupes.push('turn.prompt');
    }
  }
  const tool = spec.toolName ?? 'shell';
  for (let i = 0; i < spec.toolCalls; i++) {
    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        ...T(),
        agentId: 'main',
        event: {
          type: 'tool.call',
          name: tool,
          toolCallId: `t${i}`,
          args: { command: spec.toolInput ?? 'ls' },
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        ...T(),
        agentId: 'main',
        event: {
          type: 'tool.result',
          toolCallId: `t${i}`,
          // isError 键只在失败时出现
          result:
            i < spec.failedResults ? { isError: true, output: 'error: boom' } : { output: 'done' },
        },
      }),
    );
  }
  const unknown: Record<string, number> = {};
  if (spec.unknownEvent) {
    lines.splice(2, 0, JSON.stringify({ type: 'future.thing', ...T() }));
    unknown['future.thing'] = 1;
  }
  if (spec.malformedLine) {
    lines.splice(3, 0, MALFORMED_LINE);
    unknown['<malformed>'] = 1;
  }
  const ignored: Record<string, number> = {};
  for (const k of dupes) ignored[k] = (ignored[k] ?? 0) + 1;
  const sessionDir = path.join(
    spec.root,
    `wd_${path.basename(spec.cwd)}_h`,
    `session_${fakeUuid(spec.id).slice(0, 8)}`,
  );
  const file = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  await writeSession(ctx, file, serialize(lines, spec));
  await writeSession(
    ctx,
    path.join(sessionDir, 'state.json'),
    JSON.stringify({ version: 2, cwd: spec.cwd }),
  );
  let decoyFile: string | undefined;
  if (spec.duplicates) {
    decoyFile = path.join(sessionDir, 'agents', 'agent-1', 'wire.jsonl');
    await writeSession(
      ctx,
      decoyFile,
      `${JSON.stringify({ type: 'metadata', protocol_version: '1.5' })}\n${JSON.stringify({
        type: 'context.append_message',
        ...T(),
        agentId: 'agent-1',
        message: {
          role: 'user',
          origin: { kind: 'user' },
          content: [{ type: 'text', text: 'subagent' }],
        },
      })}\n`,
    );
  }
  return {
    file,
    cwd: spec.cwd,
    ...(decoyFile ? { decoyFile } : {}),
    expected: {
      user_messages: spec.userTexts.length,
      tool_calls: spec.toolCalls,
      tool_failures: spec.failedResults,
      unknown_event_types: unknown,
      ...(Object.keys(ignored).length > 0 ? { ignored_duplicate_kinds: ignored } : {}),
    },
  };
}

export interface KimiCustomSpec {
  root: string;
  /** 会话目录名后缀(决定 wd/session 目录) */
  id: string;
  /** 主 wire 的原始行(调用方负责 JSON 序列化;可以放畸形行) */
  lines: readonly string[];
  /** 同级 state.json 的原始文本;null = 不写该文件 */
  stateJson?: string | null;
  /** 子代理 wire(agents/agent-1/wire.jsonl)的原始行;缺省不写 */
  subagentLines?: readonly string[];
  /** 额外在 main 旁写的非 wire 文件名(应被忽略) */
  strayFiles?: readonly string[];
}

export interface KimiCustomGenerated {
  file: string;
  sessionDir: string;
  subagentFile?: string;
}

/** 任意行内容的 Kimi 会话(B14 追加):用来构造口径边界(agentId、origin、agentsMdPaths 等)。 */
export async function genKimiCustom(
  ctx: IoContext,
  spec: KimiCustomSpec,
): Promise<KimiCustomGenerated> {
  const sessionDir = path.join(
    spec.root,
    `wd_custom_${fakeUuid(spec.id).slice(0, 6)}`,
    `session_${fakeUuid(spec.id).slice(0, 8)}`,
  );
  const file = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  await writeSession(ctx, file, `${spec.lines.join('\n')}\n`);
  if (spec.stateJson !== null) {
    await writeSession(ctx, path.join(sessionDir, 'state.json'), spec.stateJson ?? '{}');
  }
  let subagentFile: string | undefined;
  if (spec.subagentLines) {
    subagentFile = path.join(sessionDir, 'agents', 'agent-1', 'wire.jsonl');
    await writeSession(ctx, subagentFile, `${spec.subagentLines.join('\n')}\n`);
  }
  for (const name of spec.strayFiles ?? []) {
    await writeSession(ctx, path.join(sessionDir, 'agents', 'main', name), '{"type":"metadata"}\n');
  }
  return { file, sessionDir, ...(subagentFile ? { subagentFile } : {}) };
}
