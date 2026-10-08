/**
 * B12 测试用的 Codex 合成会话构造器:运行时写到临时目录,仓库里没有 .jsonl 字面量。
 * 行结构按 docs/reader-counting-spec.md §2.2/§7.2 的合成夹具;UserMessage 的文本位置
 * (`item.content[].text`)已用真实样本的键名核对。每行带递增时间戳(缺省)。
 */
import * as path from 'node:path';
import type { IoContext } from '../../../src/io/paths.js';
import { BASE_MS, fakeUuid, iso, writeSession } from '../../fixtures/sessions/common.js';

export type Line = Record<string, unknown> | string;

export class LineBuilder {
  private t = 0;
  readonly lines: Line[] = [];
  constructor(private readonly baseMs = BASE_MS) {}

  private stamp(o: Record<string, unknown>): Record<string, unknown> {
    return { timestamp: iso(this.baseMs + 1000 * this.t++), ...o };
  }
  /** 追加一行(带时间戳) */
  add(o: Record<string, unknown>): this {
    this.lines.push(this.stamp(o));
    return this;
  }
  /** 追加一行原样内容(畸形行、无时间戳行) */
  raw(l: Line): this {
    this.lines.push(l);
    return this;
  }
  meta(payload: Record<string, unknown> = {}): this {
    return this.add({
      type: 'session_meta',
      payload: {
        id: 'c1',
        cli_version: '0.154.0',
        cwd: '/work/proj-a',
        source: 'exec',
        ...payload,
      },
    });
  }
  userItem(text: string): this {
    return this.item({ type: 'UserMessage', content: [{ type: 'text', text }] });
  }
  respUser(text: string): this {
    return this.add({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
  }
  respAssistant(text: string): this {
    return this.add({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    });
  }
  call(type: string, extra: Record<string, unknown> = {}): this {
    return this.add({ type: 'response_item', payload: { type, ...extra } });
  }
  fn(name = 'exec_command', args = '{}'): this {
    return this.call('function_call', { name, arguments: args, call_id: 'k' });
  }
  item(item: Record<string, unknown>): this {
    return this.add({ type: 'event_msg', payload: { type: 'item_completed', item } });
  }
  toolItem(type: string, status: string): this {
    return this.item({ type, status });
  }
  event(type: string): this {
    return this.add({ type: 'event_msg', payload: { type } });
  }
  serialize(opts: { eol?: '\n' | '\r\n'; bom?: boolean; finalNewline?: boolean } = {}): string {
    const eol = opts.eol ?? '\n';
    const body = this.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join(eol);
    return (opts.bom ? '﻿' : '') + body + (opts.finalNewline === false ? '' : eol);
  }
}

export interface WriteOpts {
  id: string;
  eol?: '\n' | '\r\n';
  bom?: boolean;
  finalNewline?: boolean;
  baseMs?: number;
}

/** 写到 `<root>/Y/M/D/rollout-<时间>-<uuid>.jsonl`,返回绝对路径。 */
export async function writeRollout(
  ctx: IoContext,
  root: string,
  b: LineBuilder,
  o: WriteOpts,
): Promise<string> {
  const d = new Date(o.baseMs ?? BASE_MS);
  const file = path.join(
    root,
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
    `rollout-${iso(o.baseMs ?? BASE_MS).replaceAll(':', '-')}-${fakeUuid(o.id)}.jsonl`,
  );
  await writeSession(ctx, file, b.serialize(o));
  return file;
}

/** §7.2 的合成夹具(运行时版):期望 {1,3,1};unknown 与 ignored 见下。 */
export function specFixture(): LineBuilder {
  const b = new LineBuilder();
  b.meta();
  b.respUser('<environment_context>x</environment_context>');
  b.respUser('hello');
  b.userItem('hello');
  b.fn('exec_command');
  b.add({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'k1', output: 'x' },
  });
  b.add({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'CommandExecution', status: 'failed', exit_code: 1 },
    },
  });
  b.call('custom_tool_call', { name: 'apply_patch', call_id: 'k2', input: 'p' });
  b.toolItem('FileChange', 'completed');
  b.call('web_search_call', { status: 'completed' });
  b.item({ type: 'WebSearch' });
  b.toolItem('FutureThing', 'failed');
  b.event('brand_new_event');
  b.add({ type: 'brand_new_top' });
  b.raw('not json at all');
  return b;
}

export const SPEC_FIXTURE_EXPECTED = {
  user_messages: 1,
  tool_calls: 3,
  tool_failures: 1,
  unknown_event_types: {
    'event_msg.item_completed.FutureThing': 1,
    'event_msg.brand_new_event': 1,
    brand_new_top: 1,
    '<malformed>': 1,
  },
  ignored_duplicate_kinds: {
    'response_item.message.user': 2,
    'event_msg.item_completed.WebSearch': 1,
  },
} as const;
