import * as path from 'node:path';
import type { NormEvent, SessionRef, TraceReader } from '../../../src/contracts/reader.js';
import { createKimiReader } from '../../../src/readers/kimi/index.js';
import { genKimiCustom } from '../../fixtures/sessions/gen-kimi.js';
import type { KimiCustomSpec } from '../../fixtures/sessions/gen-kimi.js';
import { newWork } from '../../signals/helpers.js';
import type { Work } from '../../signals/helpers.js';

export const SALT = 'c'.repeat(64);
export const T0 = 1767225600000; // 2026-01-01T00:00:00Z

/** 传给 userMsg 的第三参数:完全不带 origin 键(undefined 会触发默认值,所以要哨兵) */
export const NO_ORIGIN = Symbol('no-origin');

export const L = (o: unknown): string => JSON.stringify(o);

export const userMsg = (
  text: string,
  over: Record<string, unknown> = {},
  origin: unknown = { kind: 'user' },
): string =>
  L({
    type: 'context.append_message',
    time: T0 + 1000,
    message: {
      role: 'user',
      ...(origin !== NO_ORIGIN ? { origin } : {}),
      content: [{ type: 'text', text }],
    },
    ...over,
  });

export const loopEv = (event: unknown, over: Record<string, unknown> = {}): string =>
  L({ type: 'context.append_loop_event', time: T0 + 2000, event, ...over });

export const metadataLine = (over: Record<string, unknown> = {}): string =>
  L({ type: 'metadata', protocol_version: '1.5', created_at: T0, ...over });

export { newWork };
export type { Work };

export async function readAll(reader: TraceReader, ref: SessionRef, maxEventBytes?: number) {
  const r = reader.read(ref, {
    salt: SALT,
    ...(maxEventBytes !== undefined ? { maxEventBytes } : {}),
  });
  const events: NormEvent[] = [];
  for await (const e of r.events) events.push(e);
  return { events, counts: r.counts(), meta: r.meta() };
}

/** 写一个自定义 wire 会话并读完它。 */
export async function runCustom(
  w: Work,
  spec: Omit<KimiCustomSpec, 'root' | 'id'> & { id?: string },
  maxEventBytes?: number,
) {
  const reader = createKimiReader();
  const g = await genKimiCustom(w.io, { root: w.sessions, id: 'c1', ...spec });
  const refs = await reader.discover(w.sessions);
  const ref = refs.find((r) => r.path === g.file);
  if (!ref) throw new Error('主 wire 没被 discover 到');
  return { ...(await readAll(reader, ref, maxEventBytes)), g, ref, reader };
}

export const wireFile = (sessionDir: string): string =>
  path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
