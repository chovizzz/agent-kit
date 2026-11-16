import { describe, it } from 'vitest';
import { classifyAuditFile } from '../../../src/rsi/store/audit-classify.js';
import { RsiAuditLineSchema } from '../../../src/contracts/rsi-personal.js';
import {
  FILES,
  fullAuditText,
  hex16,
  makeWorld,
  meta,
  seed,
  tomb,
  markEffect,
  trow,
  jsonLine,
} from './store-fixture.js';

const OUT: string[] = [];
const t = async <T>(label: string, f: () => Promise<T> | T): Promise<T> => {
  const s = performance.now();
  const r = await f();
  OUT.push(`DIAG ${label} ${(performance.now() - s).toFixed(0)}ms`);
  return r;
};

describe('perf diag', () => {
  it('stages', { timeout: 600000 }, async () => {
    const text = await t('build fullAuditText', () => fullAuditText());
    await t('build again(cached)', () => fullAuditText());
    await t('jsonLine x20000 only', () =>
      Array.from({ length: 20000 }, (_, i) => jsonLine(trow(hex16(i + 0x100000)))).join(''),
    );
    const lines = text.split('\n').slice(0, -1);
    await t('split+JSON.parse', () => lines.map((l) => JSON.parse(l)));
    const raws = lines.map((l) => JSON.parse(l));
    await t('zod safeParse x20000', () => raws.map((r) => RsiAuditLineSchema.safeParse(r)));
    await t('zod safeParse x20000 (2nd)', () => raws.map((r) => RsiAuditLineSchema.safeParse(r)));
    await t('classifyAuditFile', () => classifyAuditFile(text));
    await t('classifyAuditFile (2nd)', () => classifyAuditFile(text));
    for (const kind of ['mem', 'real'] as const) {
      const w = await t(`${kind} makeWorld`, () => makeWorld(kind));
      await t(`${kind} seed`, () => seed(w, FILES.audit, text));
      await t(`${kind} bytes`, () => w.bytes(FILES.audit));
      await t(`${kind} applyOnce audit_full`, () =>
        w.store.sink.applyOnce('terminal:t', [tomb(), markEffect(hex16(5))], meta()),
      );
    }
    throw new Error(OUT.join(' | '));
  });
});
