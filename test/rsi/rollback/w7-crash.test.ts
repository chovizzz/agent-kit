/**
 * R21-9.6:回滚每个子状态都可注入崩溃并续做;续做再崩溃同样可续。
 * 固定数组 `ROLLBACK_STEPS` 的每个命名步骤点各崩一次(`it.each`),再对每个点配一个「续做时再崩」的点;不写循环找边界。
 * 终态断言(每个用例):凭据恰好一行、journal 已删、记录到终态且转移条目不重复、终态效果按键只生效一次、`canary → rolling_back` 只出现一次。
 */
import { describe, expect, it } from 'vitest';
import {
  ROLLBACK_STEPS,
  resumeAll,
  rollbackTxnId,
  startRollback,
} from '../../../src/rsi/personal/rollback.js';
import { rec } from '../personal/transition-fixture.js';
import { Crash, HARM, ID, SHA, harmReq, recordOf, world7, type World7 } from './w7-fixture.js';

const TXN = rollbackTxnId(ID, SHA);

function expectFinal(w: World7, label: string): void {
  const rc = recordOf(w);
  expect(rc.lifecycle, label).toBe('rolled_back');
  expect(rc.terminal_reason, label).toBe('auto_rollback');
  expect(rc.deploy, label).toEqual({ claude: 'none', pi: 'none', codex: 'none' });
  expect(w.txns.size, label).toBe(0);
  expect(w.revs, label).toHaveLength(1);
  expect(w.revs[0], label).toMatchObject({ by: 'worker', reason: 'harm_c1', content_sha256: SHA });
  expect([...w.effectApplied.values()], label).toEqual([1]);
  expect(
    rc.transitions.filter((t) => t.from === 'canary' && t.to === 'rolling_back'),
    label,
  ).toHaveLength(1);
  expect(
    rc.transitions.filter((t) => t.dim === 'rollback'),
    label,
  ).toHaveLength(3);
  expect(
    rc.transitions.filter((t) => t.dim === 'deploy'),
    label,
  ).toHaveLength(2); // injected→removal_pending→none
  expect(
    rc.transitions.filter((t) => t.to === 'rolled_back'),
    label,
  ).toHaveLength(1);
  expect(w.repoFiles.size, label).toBe(0);
}

const FIRST = ROLLBACK_STEPS.map((s) => [s] as const);
/** 续做时再崩的点:与首次错开(固定映射,不是循环) */
const PAIRS = ROLLBACK_STEPS.map(
  (s, i) => [s, ROLLBACK_STEPS[(i * 7 + 5) % ROLLBACK_STEPS.length] as string] as const,
);

describe('R21-9.6 崩溃矩阵:每个命名步骤点崩一次 → 续做', () => {
  it('步骤点表覆盖四个子状态与收尾(防止有人删点而测试照绿)', () => {
    expect(ROLLBACK_STEPS).toEqual(
      expect.arrayContaining([
        'journal:rollback_requested',
        'journal:injection_disabled',
        'journal:static_removal_pending',
        'journal:rollback_complete',
        'after:revocation',
        'after:record_event',
        'after:repo_removal',
        'after:payload',
        'after:record_terminal',
        'after:effects',
        'before:journal_remove',
      ]),
    );
    expect(new Set(ROLLBACK_STEPS).size).toBe(ROLLBACK_STEPS.length);
  });

  it.each(FIRST)('崩溃于 %s → resumeAll 续做到终态(只出现一次凭据 / 转移 / 效果)', async (step) => {
    const w = world7();
    w.crashAt(step);
    await expect(startRollback(w.d, harmReq())).rejects.toBeInstanceOf(Crash);
    if (w.txns.size === 0 && w.revs.length === 0) {
      // journal 落盘之前崩溃:什么都没发生(记录仍在 canary、没有凭据),重新发起即可
      expect(recordOf(w).lifecycle).toBe('canary');
      expect((await startRollback(w.d, harmReq())).status).toBe('complete');
    } else {
      const out = await resumeAll(w.d);
      expect(
        out.every((o) => o.status === 'complete'),
        JSON.stringify(out),
      ).toBe(true);
    }
    expectFinal(w, step);
  });

  it.each(PAIRS)('崩溃于 %s,续做时再崩于 %s → 第三次续做仍到终态', async (first, second) => {
    const w = world7();
    w.crashAt(first);
    await expect(startRollback(w.d, harmReq())).rejects.toBeInstanceOf(Crash);
    if (w.txns.size === 0 && w.revs.length === 0) {
      w.crashAt(second);
      try {
        await startRollback(w.d, harmReq());
      } catch (e) {
        expect(e).toBeInstanceOf(Crash);
      }
      w.crashAt(null);
      await startRollback(w.d, harmReq());
    } else {
      w.crashAt(second);
      try {
        await resumeAll(w.d);
      } catch (e) {
        expect(e).toBeInstanceOf(Crash); // 没走到 second 就完成了也算(该点不在这条续做路径上)
      }
      w.crashAt(null);
      await resumeAll(w.d);
    }
    expectFinal(w, `${first} / ${second}`);
  });

  it('journal 落盘之前崩溃:没有任何影响被改动(无凭据、记录不动、无仓库操作)', async () => {
    const w = world7();
    w.crashAt('before:journal_requested');
    await expect(startRollback(w.d, harmReq())).rejects.toBeInstanceOf(Crash);
    expect(w.txns.size).toBe(0);
    expect(w.revs).toHaveLength(0);
    expect(recordOf(w).lifecycle).toBe('canary');
    expect(w.calls).not.toContain('repo.remove');
  });
});

describe('来源保留(W0-17):崩溃恢复后 by 不变', () => {
  it('前台 veto 发起、凭据写入前崩溃、由 worker 续做 → 凭据仍是 by=veto(从 reason 还原)', async () => {
    const w = world7();
    w.crashAt('enter:injection_disabled');
    const req = harmReq({
      reason: 'vetoed',
      by: 'veto',
      event: { kind: 'veto', evidence: 'rsi veto' },
    });
    await expect(startRollback(w.d, req)).rejects.toBeInstanceOf(Crash);
    expect(w.revs).toHaveLength(0);
    await resumeAll(w.d);
    expect(w.revs).toHaveLength(1);
    expect(w.revs[0]).toMatchObject({ by: 'veto', reason: 'vetoed' });
  });

  it('clear 发起的 txn(kind=clear)续做 → by=clear', async () => {
    const w = world7();
    w.crashAt('enter:injection_disabled');
    const req = harmReq({
      kind: 'clear',
      reason: 'cleared',
      by: 'clear',
      event: { kind: 'clear', evidence: 'rsi auto clear' },
    });
    await expect(startRollback(w.d, req)).rejects.toBeInstanceOf(Crash);
    await resumeAll(w.d);
    expect(w.revs[0]).toMatchObject({ by: 'clear', reason: 'cleared' });
  });

  it('rollback_to 发起(kind=rollback ∧ reason=cleared)、凭据写入前崩溃、续做 → 凭据仍是 by=rollback_to', async () => {
    const w = world7();
    w.crashAt('enter:injection_disabled');
    const req = harmReq({
      reason: 'cleared',
      by: 'rollback_to',
      event: { kind: 'clear', evidence: 'x' },
    });
    await expect(startRollback(w.d, req)).rejects.toBeInstanceOf(Crash);
    expect(w.revs).toHaveLength(0);
    await resumeAll(w.d);
    expect(w.revs[0]).toMatchObject({ by: 'rollback_to', reason: 'cleared' });
  });

  it('同一候选在 rollback_to 的 txn 在途时 clear 再来:复用该 txn,来源取 journal 的(rollback_to),不新开、凭据一行', async () => {
    const w = world7();
    w.crashAt('after:cache');
    const rt = harmReq({
      reason: 'cleared',
      by: 'rollback_to',
      event: { kind: 'clear', evidence: 'x' },
    });
    await expect(startRollback(w.d, rt)).rejects.toBeInstanceOf(Crash);
    const r = await startRollback(w.d, {
      candidate_id: ID,
      content_sha256: SHA,
      kind: 'clear',
      reason: 'cleared',
      by: 'clear',
      target_terminal: 'rolled_back',
    });
    expect(r.status).toBe('complete');
    expect(w.revs).toHaveLength(1);
    expect(w.revs[0]?.by).toBe('rollback_to');
  });

  it('rollback_to 的 txn 在凭据写入前崩溃、clear 再来:凭据的来源仍取 journal 的(rollback_to),不取请求的', async () => {
    const w = world7();
    w.crashAt('enter:injection_disabled');
    const rt = harmReq({
      reason: 'cleared',
      by: 'rollback_to',
      event: { kind: 'clear', evidence: 'x' },
    });
    await expect(startRollback(w.d, rt)).rejects.toBeInstanceOf(Crash);
    expect(w.revs).toHaveLength(0);
    const r = await startRollback(w.d, {
      candidate_id: ID,
      content_sha256: SHA,
      kind: 'clear',
      reason: 'cleared',
      by: 'clear',
      target_terminal: 'rolled_back',
    });
    expect(r.status).toBe('complete');
    expect(w.revs).toHaveLength(1);
    expect(w.revs[0]).toMatchObject({ by: 'rollback_to', reason: 'cleared' });
  });

  it('exec_event 原因没有对应的终止事件(terminationReason 不产出 exec_*):新 journal 一律拒绝,不写 journal / 凭据(W0-20:terminal_event 必须与 reason 一致)', async () => {
    const w = world7();
    for (const reason of ['exec_post_check_failed', 'exec_timeout_unclean']) {
      const withEvent = await startRollback(w.d, harmReq({ reason, by: 'exec_event' }));
      expect(withEvent, reason).toEqual({
        status: 'refused',
        txn: null,
        why: 'event_reason_mismatch',
      });
      const noEvent = harmReq({ reason, by: 'exec_event' });
      delete noEvent.event;
      expect(await startRollback(w.d, noEvent), reason).toEqual({
        status: 'refused',
        txn: null,
        why: 'event_required',
      });
    }
    expect(w.txns.size).toBe(0);
    expect(w.revs).toHaveLength(0);
    expect(w.calls).toEqual([]);
  });
});

describe('journal 与记录的进度互不信任', () => {
  it('journal 领先于记录(journal 已到 rollback_complete,记录还在 canary):续做按盘上判据补齐,不回退 journal', async () => {
    const w = world7();
    w.store.mode = 'deferred';
    await startRollback(w.d, harmReq()); // deferred:journal 走到 rollback_complete,记录没动
    expect(w.txns.get(TXN)?.phase).toBe('rollback_complete');
    expect(recordOf(w).lifecycle).toBe('canary');
    w.store.mode = 'ok';
    const out = await resumeAll(w.d);
    expect(out[0]?.status).toBe('complete');
    expectFinal(w, 'journal ahead');
  });

  it('记录领先于 journal(记录已在 static_removal_pending,journal 还在 injection_disabled):记录不回退,journal 追上', async () => {
    const w = world7({
      record: rec('rolling_back', {
        content_sha256: SHA,
        deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
        rollback: {
          phase: 'static_removal_pending',
          reason: 'harm_c1',
          target_terminal: 'rolled_back',
        },
      }),
    });
    await w.d.txns.write({
      schema_version: 1,
      txn_id: TXN,
      candidate_id: ID,
      kind: 'rollback',
      reason: 'harm_c1',
      target_terminal: 'rolled_back',
      phase: 'injection_disabled',
      identity12: null,
      at: '2026-11-10T12:00:00.000Z',
      // 新格式 journal(带恢复三项);旧格式的还原规则在 w7-journal-boundary 单独覆盖
      content_sha256: SHA,
      by: 'worker',
      terminal_event: HARM,
    });
    const out = await resumeAll(w.d);
    expect(out.map((o) => o.status)).toEqual(['complete']);
    const rc = recordOf(w);
    expect(rc.lifecycle).toBe('rolled_back');
    // 记录不回退:只补了最后一段(static_removal_pending → rollback_complete)
    expect(rc.transitions.filter((t) => t.dim === 'rollback').map((t) => t.to)).toEqual([
      'rollback_complete',
    ]);
    expect(w.revs).toHaveLength(1);
  });
});
