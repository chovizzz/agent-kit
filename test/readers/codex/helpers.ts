import type { Counts, NormEvent, SessionMeta, SessionRef } from '../../../src/contracts/reader.js';
import { createCodexReader } from '../../../src/readers/codex/index.js';

export const SALT = 'e'.repeat(64);
export const reader = createCodexReader();

export interface ReadResult {
  events: NormEvent[];
  counts: Counts;
  meta: SessionMeta;
}

export async function readFile(file: string, maxEventBytes?: number): Promise<ReadResult> {
  const refs = await reader.discover(file);
  if (refs.length !== 1) throw new Error(`discover(${file}) 应得到 1 个会话,实际 ${refs.length}`);
  return readRef(refs[0] as SessionRef, maxEventBytes);
}

export async function readRef(ref: SessionRef, maxEventBytes?: number): Promise<ReadResult> {
  const r = reader.read(ref, {
    salt: SALT,
    ...(maxEventBytes !== undefined ? { maxEventBytes } : {}),
  });
  const events: NormEvent[] = [];
  for await (const e of r.events) events.push(e);
  return { events, counts: r.counts(), meta: r.meta() };
}

export function triple(c: Counts): [number, number, number] {
  return [c.user_messages, c.tool_calls, c.tool_failures];
}
