import type { NormEvent, SessionRef } from '../../../src/contracts/reader.js';
import { createPiReader } from '../../../src/readers/pi/index.js';
import { newWork } from '../../signals/helpers.js';
import type { Work } from '../../signals/helpers.js';

export { newWork };
export type { Work };

export const SALT = 'p'.repeat(64);
export const reader = createPiReader();

export async function oneRef(file: string): Promise<SessionRef> {
  const refs = await reader.discover(file);
  expectLen1(refs);
  return refs[0] as SessionRef;
}
function expectLen1(refs: unknown[]): void {
  if (refs.length !== 1) throw new Error(`期望 1 个会话,实得 ${refs.length}`);
}

export async function readAll(ref: SessionRef, maxEventBytes?: number) {
  const r = reader.read(ref, {
    salt: SALT,
    ...(maxEventBytes !== undefined ? { maxEventBytes } : {}),
  });
  const events: NormEvent[] = [];
  for await (const e of r.events) events.push(e);
  return { events, counts: r.counts(), meta: r.meta() };
}
