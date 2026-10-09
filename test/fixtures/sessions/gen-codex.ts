/**
 * Codex 合成会话:`<root>/Y/M/D/rollout-*.jsonl`(口径 §2.2)。
 * 用户消息计 `event_msg/item_completed(UserMessage)`;同一消息的 `response_item` 重复记录被忽略。
 * UserMessage 的文本载荷位置(`item.content[].text`)是**合成约定**,B12 以真实样本核实为准。
 */
import * as path from 'node:path';
import type { IoContext } from '../../../src/io/paths.js';
import { BASE_MS, MALFORMED_LINE, chk, fakeUuid, iso, serialize, writeSession } from './common.js';
import type { GeneratedSession, SessionSpec } from './common.js';

export async function genCodex(ctx: IoContext, spec: SessionSpec): Promise<GeneratedSession> {
  chk(spec);
  const base = spec.baseMs ?? BASE_MS;
  const id = fakeUuid(spec.id);
  let t = 0;
  const T = (): string => iso(base + 1000 * t++);
  const stamp = (o: Record<string, unknown>): Record<string, unknown> =>
    spec.noTimestamps ? o : { timestamp: T(), ...o };
  const lines: string[] = [];
  lines.push(
    JSON.stringify(
      stamp({
        type: 'session_meta',
        payload: {
          id,
          ...(spec.noTimestamps ? {} : { timestamp: iso(base) }),
          cwd: spec.cwd,
          ...(spec.version !== undefined ? { cli_version: spec.version } : {}),
          source: 'cli',
        },
      }),
    ),
  );
  const dupes: string[] = [];
  for (const text of spec.userTexts) {
    lines.push(
      JSON.stringify(
        stamp({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'UserMessage', content: [{ type: 'text', text }] },
          },
        }),
      ),
    );
    if (spec.duplicates) {
      lines.push(
        JSON.stringify(
          stamp({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text }],
            },
          }),
        ),
      );
      dupes.push('response_item.message.user');
    }
  }
  const tool = spec.toolName ?? 'shell';
  for (let i = 0; i < spec.toolCalls; i++) {
    lines.push(
      JSON.stringify(
        stamp({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: tool,
            arguments: JSON.stringify({ command: spec.toolInput ?? 'ls' }),
            call_id: `c${i}`,
          },
        }),
      ),
    );
    lines.push(
      JSON.stringify(
        stamp({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'CommandExecution',
              status: i < spec.failedResults ? 'failed' : 'completed',
            },
          },
        }),
      ),
    );
  }
  const unknown: Record<string, number> = {};
  if (spec.unknownEvent) {
    lines.splice(
      2,
      0,
      JSON.stringify(stamp({ type: 'event_msg', payload: { type: 'brand_new_event' } })),
    );
    unknown['event_msg.brand_new_event'] = 1;
  }
  if (spec.malformedLine) {
    lines.splice(3, 0, MALFORMED_LINE);
    unknown['<malformed>'] = 1;
  }
  const ignored: Record<string, number> = {};
  for (const k of dupes) ignored[k] = (ignored[k] ?? 0) + 1;
  const d = new Date(base);
  const file = path.join(
    spec.root,
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
    `rollout-${iso(base).replaceAll(':', '-')}-${id}.jsonl`,
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
      ...(Object.keys(ignored).length > 0 ? { ignored_duplicate_kinds: ignored } : {}),
    },
  };
}
