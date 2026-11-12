/**
 * W0-17 / R21-9.5 撤销凭据写入方(真 HOME、真 home-fs):按 by 约束 reason、幂等、读坏拒写、identity_changed 不写、凭据单独即可让 hint 停止注入。
 */
import { describe, expect, it } from 'vitest';
import type { RsiRevocationLine } from '../../../src/contracts/rsi-personal.js';
import { RSI_REVOCATION_BY } from '../../../src/contracts/rsi.js';
import { exists, readText } from '../../../src/io/read-fs.js';
import { writeFile } from '../../../src/io/home-fs.js';
import { homeFsFor, readRevocations, statePath } from '../../../src/rsi/personal/home-state.js';
import {
  ROLLBACK_TO_REASONS,
  RevocationWriteError,
  byFromReason,
  revocationSourceProblem,
  writeRevocation,
} from '../../../src/rsi/personal/revoke-write.js';
import { makePermitPort } from '../../../src/rsi/canary/permit-read.js';
import { makeWorld } from '../personal/repo-helpers.js';

const line = (over: Partial<RsiRevocationLine> = {}): RsiRevocationLine => ({
  at: '2026-11-10T11:00:00Z',
  candidate_id: 'ra_0123456789ab',
  content_sha256: 'a'.repeat(64),
  identity12: null,
  reason: 'cleared',
  by: 'clear',
  ...over,
});
const held = async (): Promise<void> => undefined;

describe('writeRevocation', () => {
  it('写入后凭据行在盘上(0600 原子重写),hint 的许可端口读到它;同一 (候选, 内容) 再写 → already_present 不增行', async () => {
    const w = await makeWorld('w7-rev-');
    expect(await writeRevocation(w.h, held, line())).toBe('written');
    expect(await writeRevocation(w.h, held, line({ by: 'veto', reason: 'vetoed' }))).toBe(
      'already_present',
    );
    const r = await readRevocations(w.h);
    expect(r).toMatchObject({ kind: 'ok', value: [{ by: 'clear', reason: 'cleared' }] }); // 首个写入者的来源保留
    const port = makePermitPort(w.rsiRepo, w.home);
    const seen = await port.revocations();
    expect(seen).toMatchObject({ kind: 'ok', value: [{ candidate_id: 'ra_0123456789ab' }] });
  });

  it('内容变了必须写新凭据(幂等键含 content_sha256)', async () => {
    const w = await makeWorld('w7-rev2-');
    await writeRevocation(w.h, held, line());
    expect(await writeRevocation(w.h, held, line({ content_sha256: 'b'.repeat(64) }))).toBe(
      'written',
    );
    const r = await readRevocations(w.h);
    expect(r.kind === 'ok' ? r.value : []).toHaveLength(2);
  });

  it.each([
    ['clear', 'vetoed'],
    ['veto', 'cleared'],
    ['exec_event', 'harm_c1'],
    ['worker', 'cleared'],
    ['worker', 'compensation_done'],
    ['worker', 'g4_near_duplicate'],
    ['rollback_to', 'harm_c1'],
    ['rollback_to', 'vetoed'],
  ] as const)('(by=%s, reason=%s) 被拒:RevocationWriteError,文件不创建', async (by, reason) => {
    const w = await makeWorld('w7-rev3-');
    await expect(writeRevocation(w.h, held, line({ by, reason }))).rejects.toBeInstanceOf(
      RevocationWriteError,
    );
    expect(await exists(statePath(w.h, 'revocations.jsonl'))).toBe(false);
  });

  it('identity_changed 永远不写凭据(R21-9.1 例外)', async () => {
    const w = await makeWorld('w7-rev4-');
    for (const by of RSI_REVOCATION_BY) {
      await expect(
        writeRevocation(w.h, held, line({ by, reason: 'identity_changed' })),
      ).rejects.toMatchObject({
        kind: 'identity_changed',
      });
    }
    expect(await exists(statePath(w.h, 'revocations.jsonl'))).toBe(false);
  });

  it('现有凭据文件不合规 → 抛错、不写、不改原文件(R21-6.11 第 4a 行按读取失败处理)', async () => {
    const w = await makeWorld('w7-rev5-');
    await writeFile(
      homeFsFor(w.h, ['revocations.jsonl']),
      '.local/state/agent-kit/rsi-personal/revocations.jsonl',
      'not json\n',
      {
        mode: 0o600,
        dirMode: 0o700,
      },
    );
    await expect(writeRevocation(w.h, held, line())).rejects.toMatchObject({
      kind: 'revocations_invalid',
    });
    expect(await readText(statePath(w.h, 'revocations.jsonl'))).toBe('not json\n');
  });

  it('写点之前复核锁:assertHeld 抛 lock_lost → 不写', async () => {
    const w = await makeWorld('w7-rev6-');
    await expect(
      writeRevocation(
        w.h,
        async () => {
          throw new Error('lock_lost');
        },
        line(),
      ),
    ).rejects.toThrow('lock_lost');
    expect(await exists(statePath(w.h, 'revocations.jsonl'))).toBe(false);
  });
});

describe('来源与原因的对应', () => {
  it('byFromReason:cleared→clear、vetoed→veto、exec_*→exec_event、其余→worker(rollback_to 与 worker 恢复后不可区分:已知限制)', () => {
    expect(byFromReason('cleared')).toBe('clear');
    expect(byFromReason('vetoed')).toBe('veto');
    expect(byFromReason('exec_post_check_failed')).toBe('exec_event');
    expect(byFromReason('exec_timeout_unclean')).toBe('exec_event');
    expect(byFromReason('harm_c3')).toBe('worker');
    expect(byFromReason('limit_reached')).toBe('worker');
  });
  it('rollback_to 只产出 cleared(收窄);契约允许的其余终止原因在本写入方被拒', () => {
    expect(ROLLBACK_TO_REASONS).toEqual(['cleared']);
    expect(revocationSourceProblem('rollback_to', 'cleared')).toBeNull();
    expect(revocationSourceProblem('rollback_to', 'harm_c1')).toBe('reason_not_allowed');
    expect(revocationSourceProblem('worker', 'harm_c1')).toBeNull();
    expect(revocationSourceProblem('worker', 'identity_changed')).toBe('identity_changed');
  });
});
