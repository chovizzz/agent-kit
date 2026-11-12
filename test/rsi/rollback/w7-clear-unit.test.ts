/**
 * 缩减入口的报告模型(内存端口):先续做在途 journal、再枚举;枚举不可用时 `unavailable` 只说明「没有处理新候选」,此前续做的结果在 `outcomes` 里。
 */
import { describe, expect, it } from 'vitest';
import { rsiAutoClear, type ClearDeps } from '../../../src/rsi/personal/clear.js';
import { startRollback } from '../../../src/rsi/personal/rollback.js';
import { Crash, SHA, V1B, harmReq, world7, type World7 } from './w7-fixture.js';

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
