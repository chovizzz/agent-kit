/**
 * C2 §7:`writeRevocationDetailed`(回读版;`writeRevocation` 不动)——已有同键凭据时返回已有行的 by / reason,零写入、不覆盖、不追加第二行。
 */
import { describe, expect, it } from 'vitest';
import type { RsiRevocationLine } from '../../../src/contracts/rsi-personal.js';
import { exists, readText } from '../../../src/io/read-fs.js';
import { readRevocations, statePath } from '../../../src/rsi/personal/home-state.js';
import {
  RevocationWriteError,
  writeRevocation,
  writeRevocationDetailed,
} from '../../../src/rsi/personal/revoke-write.js';
import { makeWorld } from '../personal/repo-helpers.js';

const line = (over: Partial<RsiRevocationLine> = {}): RsiRevocationLine => ({
  at: '2026-11-10T11:00:00Z',
  candidate_id: 'ra_0123456789ab',
  content_sha256: 'a'.repeat(64),
  identity12: null,
  reason: 'tainted',
  by: 'worker',
  ...over,
});
const held = async (): Promise<void> => undefined;

describe('writeRevocationDetailed', () => {
  it('无已有凭据 → written,盘上恰一行', async () => {
    const w = await makeWorld('c2-rev1-');
    expect(await writeRevocationDetailed(w.h, held, line())).toEqual({ kind: 'written' });
    const r = await readRevocations(w.h);
    expect(r).toMatchObject({ kind: 'ok', value: [{ by: 'worker', reason: 'tainted' }] });
  });

  it('同键同来源(worker / tainted)→ already 并带回已有行的 by / reason;不增行', async () => {
    const w = await makeWorld('c2-rev2-');
    await writeRevocationDetailed(w.h, held, line());
    expect(await writeRevocationDetailed(w.h, held, line())).toEqual({
      kind: 'already',
      existing: { by: 'worker', reason: 'tainted' },
    });
    const r = await readRevocations(w.h);
    expect(r.kind === 'ok' ? r.value : []).toHaveLength(1);
  });

  it('同键、已有凭据来源不同(veto / cleared):返回已有归因,字节不变(不覆盖、不追加)', async () => {
    const w = await makeWorld('c2-rev3-');
    await writeRevocation(w.h, held, line({ by: 'veto', reason: 'vetoed' }));
    const before = await readText(statePath(w.h, 'revocations.jsonl'));
    expect(await writeRevocationDetailed(w.h, held, line())).toEqual({
      kind: 'already',
      existing: { by: 'veto', reason: 'vetoed' },
    });
    expect(await readText(statePath(w.h, 'revocations.jsonl'))).toBe(before);
  });

  it('内容 sha 不同 = 新键 → written(两行)', async () => {
    const w = await makeWorld('c2-rev4-');
    await writeRevocationDetailed(w.h, held, line());
    expect(
      await writeRevocationDetailed(w.h, held, line({ content_sha256: 'b'.repeat(64) })),
    ).toEqual({
      kind: 'written',
    });
    const r = await readRevocations(w.h);
    expect(r.kind === 'ok' ? r.value : []).toHaveLength(2);
  });

  it('来源 / 原因不相符先于任何 IO 被拒(文件不创建);凭据文件损坏 → 抛 revocations_invalid、不写', async () => {
    const w = await makeWorld('c2-rev5-');
    await expect(
      writeRevocationDetailed(w.h, held, line({ by: 'worker', reason: 'cleared' })),
    ).rejects.toBeInstanceOf(RevocationWriteError);
    expect(await exists(statePath(w.h, 'revocations.jsonl'))).toBe(false);
  });

  it('assertHeld 失败 → 抛出且不写(锁前置在读之前)', async () => {
    const w = await makeWorld('c2-rev6-');
    const lost = async (): Promise<void> => {
      throw new Error('lost');
    };
    await expect(writeRevocationDetailed(w.h, lost, line())).rejects.toThrow('lost');
    expect(await exists(statePath(w.h, 'revocations.jsonl'))).toBe(false);
  });
});
