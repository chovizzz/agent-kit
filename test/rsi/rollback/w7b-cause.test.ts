/**
 * W7b ③:`RollbackOutcome.cause`(additive)。失败 variant(`incomplete` / `refused`)必填封闭枚举 `cause`,成功 variant(`complete` / `revocation_complete`)没有;
 * 每个真实失败返回点各有明确映射,不靠兜底;journal 完整性错误(`txn_invalid`)与事务结果分开:不带事务身份(`txn: null`)。
 * 完备性**按 variant 穷举**:`Record<RollbackFailureStatus, Case[]>` 漏一个 variant 即编译失败;运行时每个枚举值至少被一个真实触发点覆盖。
 */
import { describe, expect, it } from 'vitest';
import { RSI_ROLLBACK_CAUSES } from '../../../src/contracts/rsi.js';
import {
  resumeAll,
  resumeTxn,
  rollbackTxnId,
  startRollback,
  type RollbackFailureStatus,
  type RollbackOutcome,
} from '../../../src/rsi/personal/rollback.js';
import {
  unwiredCacheCleanup,
  unwiredPayloadSync,
} from '../../../src/rsi/personal/rollback-ports.js';
import { PERSONAL_REPO_INVALID } from '../../../src/rsi/personal/commit.js';
import { rec } from '../personal/transition-fixture.js';
import { ID, SHA, V1A, harmReq, world7 } from './w7-fixture.js';

interface Case {
  name: string;
  cause: (typeof RSI_ROLLBACK_CAUSES)[number];
  run: () => Promise<RollbackOutcome>;
}

const CASES: Record<RollbackFailureStatus, Case[]> = {
  incomplete: [
    {
      name: '凭据读不到(revocations_invalid)',
      cause: 'credentials_invalid',
      run: () => {
        const w = world7();
        w.d.revocations = { read: async () => ({ kind: 'invalid', why: 'x' }) };
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '凭据写入「成功」但盘上没有(revocation_missing)',
      cause: 'credentials_invalid',
      run: () => {
        const w = world7();
        const orig = w.d.revoker.write.bind(w.d.revoker);
        w.d.revoker = {
          write: async (l) => {
            await orig(l);
            w.revs.length = 0;
            return 'written';
          },
        };
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '端口没装配(runGuarded 包成的 port_not_wired)',
      cause: 'not_wired',
      run: () => {
        const w = world7();
        w.d.cache = unwiredCacheCleanup;
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: 'payload 端口没装配',
      cause: 'not_wired',
      run: () => {
        const w = world7();
        w.d.payload = unwiredPayloadSync;
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '私有仓库不可读(repo_invalid)',
      cause: 'repo_unreadable',
      run: () => {
        const w = world7();
        w.repoMode.value = 'invalid';
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '收尾时权威记录读不到(finish 的 repo_invalid)',
      cause: 'repo_unreadable',
      run: () => {
        const w = world7();
        const orig = w.d.onStep;
        w.d.onStep = async (s) => {
          await orig?.(s);
          if (s === 'before:finish') w.store.mode = 'invalid';
        };
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '撤销路径 payload 不可用(payload_unavailable)',
      cause: 'repo_unreadable',
      run: () => {
        const w = world7();
        w.payload.mode = 'unavailable';
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '用户改过的块(drift)',
      cause: 'retryable',
      run: () => {
        const w = world7();
        w.payload.mode = 'drift';
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: 'deferred 下撤销后 payload 仍含该候选',
      cause: 'retryable',
      run: () => {
        const w = world7();
        w.repoMode.value = 'deferred';
        w.payload.has.add(ID);
        w.payload.stuck.add(ID);
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '第四段 payload 仍含该候选',
      cause: 'retryable',
      run: () => {
        const w = world7();
        w.payload.has.add(ID);
        w.payload.stuck.add(ID);
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '记录提交失败(record_halt:commit_failed)',
      cause: 'retryable',
      run: () => {
        const w = world7();
        w.store.failCommit = { status: 'cas_failed', expected: 'x', actual: null };
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '记录快照在读与提交之间变了(record_stale)',
      cause: 'retryable',
      run: () => {
        const w = world7();
        const orig = w.store.read.bind(w.store);
        let n = 0;
        w.store.read = async (id) => {
          n += 1;
          const r = await orig(id);
          return n === 2 && r.kind === 'ok'
            ? { ...r, record: { ...r.record, cluster_id: 'x' } }
            : r;
        };
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '收尾时终态提交失败(finish 的 record_halt)',
      cause: 'retryable',
      run: () => {
        const w = world7();
        const orig = w.store.commit.bind(w.store);
        w.store.commit = async (spec) =>
          spec.upserts.some(
            (u) => (JSON.parse(u.content) as { lifecycle?: string }).lifecycle === 'rolled_back',
          )
            ? { status: 'cas_failed', expected: 'x', actual: null }
            : orig(spec);
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '收尾时引擎 halt 为仓库不可读(finish 的 record_halt:repo_invalid)',
      cause: 'repo_unreadable',
      run: () => {
        const w = world7();
        const orig = w.store.commit.bind(w.store);
        w.store.commit = async (spec) =>
          spec.upserts.some(
            (u) => (JSON.parse(u.content) as { lifecycle?: string }).lifecycle === 'rolled_back',
          )
            ? { status: 'invalid', why: 'git_read_failed', breaker: PERSONAL_REPO_INVALID }
            : orig(spec);
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '收尾时记录推进落后(record_lagging)',
      cause: 'retryable',
      run: () => {
        const w = world7();
        const orig = w.d.onStep;
        w.d.onStep = async (s) => {
          await orig?.(s);
          if (s === 'before:finish')
            w.store.failCommit = { status: 'cas_failed', expected: 'x', actual: null };
        };
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: '相位闸:引擎拒绝(record_refused)',
      cause: 'candidate_invalid',
      run: () => startRollback(world7({ phase: V1A }).d, harmReq()),
    },
    {
      name: '旧格式 journal 缺原始证据(legacy_unrecoverable:terminal_event)',
      cause: 'manual_event_required',
      run: async () => {
        const w = world7();
        w.d.recordedSha = async () => SHA;
        await w.d.txns.write(legacyJournal());
        return (await resumeAll(w.d))[0] as RollbackOutcome;
      },
    },
    {
      name: '旧格式 journal 缺来源(legacy_unrecoverable:by)',
      cause: 'manual_by_ambiguous',
      run: async () => {
        const w = world7();
        w.d.recordedSha = async () => SHA;
        await w.d.txns.write({ ...legacyJournal(), reason: 'cleared', kind: 'rollback' });
        return (await resumeAll(w.d))[0] as RollbackOutcome;
      },
    },
    {
      name: '旧格式 journal 缺内容哈希且凭据 / head.json 都取不回(legacy_unrecoverable:content_sha256;W0-20:缺失不可恢复 = incomplete,带事务身份)',
      cause: 'manual_event_required',
      run: async () => {
        const w = world7();
        await w.d.txns.write(legacyJournal());
        return (await resumeAll(w.d))[0] as RollbackOutcome;
      },
    },
    {
      name: '旧格式 journal 缺内容哈希且凭据读不到',
      cause: 'credentials_invalid',
      run: async () => {
        const w = world7();
        w.d.revocations = { read: async () => ({ kind: 'invalid', why: 'x' }) };
        await w.d.txns.write(legacyJournal());
        return (await resumeAll(w.d))[0] as RollbackOutcome;
      },
    },
  ],
  refused: [
    {
      name: 'identity_kind_mismatch',
      cause: 'candidate_invalid',
      run: () => startRollback(world7().d, harmReq({ kind: 'identity_change' })),
    },
    {
      name: 'identity12_mismatch',
      cause: 'candidate_invalid',
      run: () => startRollback(world7().d, harmReq({ identity12: 'abcdef012345' })),
    },
    {
      name: 'identity_not_available_before_v6a',
      cause: 'candidate_invalid',
      run: () =>
        startRollback(
          world7().d,
          harmReq({
            kind: 'identity_change',
            reason: 'identity_changed',
            identity12: 'abcdef012345',
          }),
        ),
    },
    {
      name: 'event_invalid(入口)',
      cause: 'candidate_invalid',
      run: () => startRollback(world7().d, harmReq({ event: { kind: 'nope' } as never })),
    },
    {
      name: '来源与原因不相容(newJournal 的 sourceProblem)',
      cause: 'candidate_invalid',
      run: () => startRollback(world7().d, harmReq({ by: 'veto' })),
    },
    {
      name: '事件与原因不一致(event_reason_mismatch)',
      cause: 'candidate_invalid',
      run: () => startRollback(world7().d, harmReq({ reason: 'harm_c2' })),
    },
    {
      name: 'event_required(需要原始证据而没带事件)',
      cause: 'manual_event_required',
      run: () => {
        const req = harmReq();
        delete req.event;
        return startRollback(world7().d, req);
      },
    },
    {
      name: 'by_ambiguous(rolling_back 记录无 journal,来源有歧义)',
      cause: 'manual_by_ambiguous',
      run: async () => {
        const w = world7({
          record: rec('rolling_back', {
            rollback: {
              phase: 'injection_disabled',
              reason: 'cleared',
              target_terminal: 'rolled_back',
            },
          }),
        });
        return (await resumeAll(w.d))[0] as RollbackOutcome;
      },
    },
    {
      name: 'txn_absent(在途应有 journal 而无)',
      cause: 'txn_absent',
      run: () => resumeTxn(world7().d, 'nope'),
    },
    {
      name: 'journal 读不出(完整性错误,resumeTxn)',
      cause: 'txn_invalid',
      run: () => {
        const w = world7();
        w.d.txns = { ...w.d.txns, read: async () => ({ kind: 'invalid', why: 'parse' }) };
        return resumeTxn(w.d, 'x');
      },
    },
    {
      name: 'journal 读不出(完整性错误,startRollback 复用入口)',
      cause: 'txn_invalid',
      run: () => {
        const w = world7();
        w.d.txns = { ...w.d.txns, read: async () => ({ kind: 'invalid', why: 'parse' }) };
        return startRollback(w.d, harmReq());
      },
    },
    {
      name: 'journal 的 content_sha256 与 txn_id 对不上(语义不合规)',
      cause: 'txn_invalid',
      run: async () => {
        const w = world7();
        await w.d.txns.write({ ...legacyJournal(), content_sha256: 'c'.repeat(64) });
        return (await resumeAll(w.d))[0] as RollbackOutcome;
      },
    },
    {
      name: 'journal 的 by 与 (kind, reason) 不相容(字段存在但不合规 = txn_invalid)',
      cause: 'txn_invalid',
      run: async () => {
        const w = world7();
        await w.d.txns.write({ ...legacyJournal(), content_sha256: SHA, by: 'veto' });
        return (await resumeAll(w.d))[0] as RollbackOutcome;
      },
    },
    {
      name: '旧 identity_change journal(本期不支持,合法但不动)',
      cause: 'candidate_invalid',
      run: async () => {
        const w = world7();
        await w.d.txns.write({
          ...legacyJournal(),
          kind: 'identity_change',
          reason: 'identity_changed',
          identity12: 'abcdef012345',
          target_terminal: 'shadow',
        });
        return (await resumeAll(w.d))[0] as RollbackOutcome;
      },
    },
  ],
};

/** 旧格式 journal(缺 content_sha256 / by / terminal_event) */
function legacyJournal() {
  return {
    schema_version: 1 as const,
    txn_id: txnIdOf(),
    candidate_id: ID,
    kind: 'rollback' as const,
    reason: 'harm_c1',
    target_terminal: 'rolled_back' as const,
    phase: 'rollback_requested' as const,
    identity12: null,
    at: '2026-11-10T12:00:00.000Z',
  };
}
const txnIdOf = (): string => rollbackTxnId(ID, SHA);

describe('RollbackOutcome.cause:每个失败返回点各有明确映射(按 variant 穷举)', () => {
  for (const status of Object.keys(CASES) as RollbackFailureStatus[]) {
    for (const c of CASES[status]) {
      it(`${status}: ${c.name} → ${c.cause}`, async () => {
        const out = await c.run();
        expect(out.status).toBe(status);
        expect((out as { cause?: unknown }).cause).toBe(c.cause);
        expect(RSI_ROLLBACK_CAUSES).toContain(c.cause);
      });
    }
  }

  it('每个枚举值至少被一个真实触发点覆盖(漏一个 cause 即红)', () => {
    const used = new Set(Object.values(CASES).flatMap((cs) => cs.map((c) => c.cause)));
    expect([...used].sort()).toEqual([...RSI_ROLLBACK_CAUSES].sort());
  });

  it('not_wired 不被归成 retryable;失败 variant 不带 cause 以外的兜底(每个 case 的 cause 与 why 对得上)', async () => {
    const wired = CASES.incomplete.filter((c) => c.cause === 'not_wired');
    expect(wired.length).toBeGreaterThan(0);
    for (const c of wired) {
      const out = (await c.run()) as { cause: string; why: string };
      expect(out.why).toMatch(/^port_not_wired:/);
      expect(out.cause).not.toBe('retryable');
    }
  });

  it('成功 variant 没有 cause:complete / revocation_complete(后者携 repoRemoval=deferred)不被归成失败', async () => {
    const w = world7();
    const done = await startRollback(w.d, harmReq());
    expect(done.status).toBe('complete');
    expect(done).not.toHaveProperty('cause');
    const w2 = world7();
    w2.repoMode.value = 'deferred';
    const rc = await startRollback(w2.d, harmReq());
    expect(rc.status).toBe('revocation_complete');
    expect(rc).not.toHaveProperty('cause');
  });

  it('不变量:cause=txn_invalid 的 outcome 一律是 refused、txn=null、journal 句柄为字符串(逐 case 校验;失败 variant incomplete 永不带 txn_invalid)', async () => {
    let seen = 0;
    for (const status of Object.keys(CASES) as RollbackFailureStatus[]) {
      for (const c of CASES[status]) {
        if (c.cause !== 'txn_invalid') continue;
        const out = (await c.run()) as { status: string; txn: unknown; journal?: unknown };
        expect(out.status, c.name).toBe('refused');
        expect(out.txn, c.name).toBeNull();
        expect(typeof out.journal, c.name).toBe('string');
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(3);
    expect(CASES.incomplete.some((c) => c.cause === 'txn_invalid')).toBe(false);
  });

  it('journal 完整性错误不带事务身份(txn: null,journal 句柄单给):同 (id, sha) 的 complete 消除不了它', async () => {
    const w = world7();
    w.d.txns = { ...w.d.txns, read: async () => ({ kind: 'invalid', why: 'parse' }) };
    const bad = await startRollback(w.d, harmReq());
    expect(bad).toMatchObject({ status: 'refused', txn: null, cause: 'txn_invalid' });
    expect((bad as { journal?: string }).journal).toBe(txnIdOf());
    // 事务结果(非完整性)保留 txn 身份
    const w2 = world7();
    w2.payload.mode = 'drift';
    expect(await startRollback(w2.d, harmReq())).toMatchObject({
      status: 'incomplete',
      txn: txnIdOf(),
      cause: 'retryable',
    });
  });
});
