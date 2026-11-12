/**
 * 缩减入口的报告模型(内存端口):先续做在途 journal、再枚举;枚举不可用时 `unavailable` 只说明「没有处理新候选」,此前续做的结果在 `outcomes` 里。
 */
import { describe, expect, it } from 'vitest';
import { rsiAutoClear, type ClearDeps } from '../../../src/rsi/personal/clear.js';
import { startRollback } from '../../../src/rsi/personal/rollback.js';
import { resumeAll } from '../../../src/rsi/personal/rollback.js';
import {
  Crash,
  ID,
  SHA,
  V1B,
  canaryRec,
  harmReq,
  recordOf,
  world7,
  type World7,
} from './w7-fixture.js';

const clearDeps = (w: World7): ClearDeps => ({
  store: w.d.store,
  revocations: w.d.revocations,
  locks: w.d.locks,
  txns: w.d.txns,
  revoker: w.d.revoker,
  repo: w.d.repo,
  payload: w.d.payload,
  now: w.d.now,
  phase: V1B,
  syncLock: { withLock: (fn) => fn() },
  // 仓库读不到时 content_sha256 的兜底(生产 = head.json 记录的提交,`recordedShaReader`)
  recordedSha: async () => SHA,
});

describe('rsiAutoClear 报告模型', () => {
  it('有在途 journal 而候选全集读不到:先续做(已写凭据),再报 unavailable;两者都在报告里,不承诺「没有写入」', async () => {
    const w = world7();
    w.crashAt('journal:rollback_requested');
    await expect(startRollback(w.d, harmReq())).rejects.toBeInstanceOf(Crash);
    w.store.mode = 'invalid';
    const report = await rsiAutoClear(clearDeps(w), { write: true });
    expect(report.unavailable).toMatch(/^repo_unreadable:/);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({ status: 'incomplete' });
    expect(w.revs).toHaveLength(1); // 续做确实写了凭据
    expect(report.candidates).toEqual([]); // 没有处理任何新候选
  });

  it('干跑:在途 journal 只列出(inFlight),不续做、不写', async () => {
    const w = world7();
    w.crashAt('journal:rollback_requested');
    await expect(startRollback(w.d, harmReq())).rejects.toBeInstanceOf(Crash);
    const report = await rsiAutoClear(clearDeps(w), { write: false });
    expect(report.inFlight).toHaveLength(1);
    expect(report.outcomes).toEqual([]);
    expect(w.revs).toHaveLength(0);
  });
});

describe('H2:分叉下撤销四段完成即算完成(revocation_complete),仓库 / 记录部分推迟并留下待补记任务', () => {
  const TXN_COUNT = (w: World7): number => w.txns.size;

  it('clear 遇人工分叉(记录读不到,候选改从 head.json 的只读读取):凭据落盘、HOME 清理完成 → revocation_complete,journal 保留,workingMarked=false,报告列出 repoRemovalPending', async () => {
    const w = world7();
    w.store.mode = 'deferred';
    const d: ClearDeps = {
      ...clearDeps(w),
      recordedRecords: async () => ({ kind: 'ok', head: 'h', value: [canaryRec()] }),
    };
    const report = await rsiAutoClear(d, { write: true });
    expect(report.unavailable).toBeNull();
    expect(report.outcomes).toEqual([
      {
        status: 'revocation_complete',
        txn: expect.any(String),
        candidate_id: ID,
        repoRemoval: 'deferred',
        why: expect.stringMatching(/^repo_deferred/),
        workingMarked: false,
      },
    ]);
    expect(report.repoRemovalPending).toEqual([ID]);
    expect(w.revs).toHaveLength(1);
    expect(w.revs[0]).toMatchObject({ by: 'clear', reason: 'cleared' });
    expect(w.payload.revoked.length).toBeGreaterThan(0); // 第四段 HOME 清理做了
    expect(TXN_COUNT(w)).toBe(1); // 待补记任务
    expect(recordOf(w).lifecycle).toBe('canary'); // 记录推进被推迟,没有宣称已处理
  });

  it('没有分叉的 clear:repoRemovalPending 为空', async () => {
    const w = world7();
    const report = await rsiAutoClear(clearDeps(w), { write: true });
    expect(report.outcomes.map((o) => o.status)).toEqual(['complete']);
    expect(report.repoRemovalPending).toEqual([]);
  });

  it('worker 路径(装配 deferralMark):写 repo_removal_deferred 标记 → workingMarked=true;分叉解除后 resumeAll(仍带 deferralMark)→ complete、journal 删、记录到终态', async () => {
    const w = world7();
    w.d.deferralMark = w.markDeferral;
    w.store.mode = 'deferred';
    const r = await startRollback(w.d, harmReq());
    expect(r).toMatchObject({
      status: 'revocation_complete',
      repoRemoval: 'deferred',
      workingMarked: true,
    });
    expect(w.deferralMarks).toEqual([ID]);
    expect(w.txns.size).toBe(1);
    w.store.mode = 'ok';
    const out = await resumeAll(w.d);
    expect(out.map((o) => o.status)).toEqual(['complete']);
    expect(w.txns.size).toBe(0);
    expect(recordOf(w).lifecycle).toBe('rolled_back');
    expect(w.deferralMarks).toEqual([ID]); // 完成后不再标记
  });

  it('deferralMark 落地失败:异常向上(journal 保留,凭据已落盘),不返回 workingMarked=true', async () => {
    const w = world7();
    w.d.deferralMark = {
      mark: async () => {
        throw new Error('working copy down');
      },
    };
    w.store.mode = 'deferred';
    await expect(startRollback(w.d, harmReq())).rejects.toThrow('working copy down');
    expect(w.txns.size).toBe(1);
    expect(w.revs).toHaveLength(1);
  });
});
