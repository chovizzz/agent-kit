/**
 * W0-20(验收第 2 轮裁定:契约为准,加强校验):
 *  A. 新 journal 的写入边界:三项恢复字段齐备、事件过转移引擎 schema、`terminationReason(event) === reason`、与 `target_terminal` 相容;不满足 = refused,零副作用。
 *     `kind=reconcile` 不是例外:拿不到终止事实就不创建。
 *  B. 旧格式 journal(缺三键)在任何事务动作之前先收齐三项事实:`by` 只在 (kind, reason) 唯一时推出、`content_sha256` 只从撤销凭据 / head.json 记录的提交、
 *     `terminal_event` 只重建无证据要求的事件;任一项拿不到 = incomplete,**不写凭据**。
 */
import { describe, expect, it } from 'vitest';
import type { PersonalTxn, RsiRevocationLine } from '../../../src/contracts/rsi-personal.js';
import {
  resumeAll,
  rollbackTxnId,
  startRollback,
  type RollbackRequest,
} from '../../../src/rsi/personal/rollback.js';
import type { TransitionEvent } from '../../../src/rsi/personal/transition-table.js';
import { rec } from '../personal/transition-fixture.js';
import { HARM, ID, SHA, harmReq, recordOf, world7, type World7 } from './w7-fixture.js';

const TXN = rollbackTxnId(ID, SHA);
const ACTIONS = [
  'revoke.write',
  'cache.clean',
  'repo.remove',
  'payload.revoke',
  'effects.applyOnce',
];
const noActions = (w: World7): string[] => w.calls.filter((c) => ACTIONS.includes(c));

const harm = (metric: 'c1' | 'c2'): TransitionEvent => ({
  kind: 'harm',
  evidence: `analysis-v1:${metric}:look=1`,
  metric,
  worse: true,
});
const LIMIT: TransitionEvent = {
  kind: 'canary_limit',
  evidence: 'canary-limit:days=90',
  max_arm_sessions: 1,
};

describe('A. 新 journal 写入边界:事件与 reason / target_terminal 不一致 → refused,零副作用', () => {
  it.each([
    [
      'cleared 携带 veto 事件(会触发永久黑名单)',
      { kind: 'clear', reason: 'cleared', by: 'clear', event: { kind: 'veto', evidence: 'x' } },
      'event_reason_mismatch',
    ],
    [
      'vetoed 携带 clear 事件',
      { reason: 'vetoed', by: 'veto', event: { kind: 'clear', evidence: 'x' } },
      'event_reason_mismatch',
    ],
    ['harm_c1 携带 c2 指标事件', { event: harm('c2') }, 'event_reason_mismatch'],
    [
      'harm_c1 携带 judge 事件',
      {
        event: {
          kind: 'judge_reject',
          evidence: 'j',
          validated: true,
          verdict_reject: true,
          injection_suspected: false,
        },
      },
      'event_reason_mismatch',
    ],
    [
      'limit_reached 携带 harm 事件',
      { reason: 'limit_reached', target_terminal: 'expired' },
      'event_reason_mismatch',
    ],
    [
      'limit_reached 配 target_terminal=rolled_back(事件的目标是 expired)',
      { reason: 'limit_reached', event: LIMIT },
      'event_target_mismatch',
    ],
    [
      'harm_c1 配 target_terminal=expired(事件的目标是 rolled_back)',
      { target_terminal: 'expired' },
      'event_target_mismatch',
    ],
  ] as const)('%s', async (_n, over, why) => {
    const w = world7();
    const r = await startRollback(w.d, harmReq(over as Partial<RollbackRequest>));
    expect(r).toEqual({ status: 'refused', txn: null, why, cause: 'candidate_invalid' });
    expect(w.txns.size).toBe(0);
    expect(w.revs).toHaveLength(0);
    expect(w.calls).toEqual([]);
    expect(recordOf(w).lifecycle).toBe('canary');
    expect(w.store.commits).toHaveLength(0);
  });

  it('没有事件而原因不能无证据重建(harm / judge / limit)→ event_required,零副作用', async () => {
    for (const reason of ['harm_c3', 'judge_reject', 'judge_injection', 'limit_reached']) {
      const w = world7();
      const req = harmReq({ reason });
      delete req.event;
      expect(await startRollback(w.d, req), reason).toEqual({
        status: 'refused',
        txn: null,
        why: 'event_required',
        cause: 'manual_event_required',
      });
      expect(w.txns.size).toBe(0);
      expect(w.revs).toHaveLength(0);
    }
  });

  it.each([
    ['vetoed', 'veto', 'rollback', 'veto'],
    ['tainted', 'taint', 'rollback', 'worker'],
    ['cleared', 'clear', 'clear', 'clear'],
  ] as const)(
    '没有事件而原因本身就是完整事件(%s):由原因重建 %s 事件,journal 带齐三项',
    async (reason, evKind, kind, by) => {
      const w = world7();
      w.crashAt('journal:rollback_requested');
      const req = harmReq({ reason, kind, by });
      delete req.event;
      await expect(startRollback(w.d, req)).rejects.toThrow('injected crash');
      expect(w.txns.get(TXN)).toMatchObject({
        content_sha256: SHA,
        by,
        terminal_event: { kind: evKind, evidence: `txn:${TXN}` },
      });
    },
  );
});

describe('A. reconcile 不是例外:拿不到终止事实就不创建 journal', () => {
  const rolling = (reason: string) =>
    world7({
      record: rec('rolling_back', {
        deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
        rollback: { phase: 'injection_disabled', reason, target_terminal: 'rolled_back' },
      }),
    });

  it('harm_c1 的 rolling_back 记录没有 journal:refused event_required,不写 journal / 凭据', async () => {
    const w = rolling('harm_c1');
    const out = await resumeAll(w.d);
    expect(out).toEqual([
      { status: 'refused', txn: null, why: 'event_required', cause: 'manual_event_required' },
    ]);
    expect(w.txns.size).toBe(0);
    expect(w.revs).toHaveLength(0);
    expect(noActions(w)).toEqual([]);
  });

  it('cleared 的 rolling_back 记录没有 journal:来源有歧义(rollback_to / clear)→ refused by_ambiguous,零动作', async () => {
    const w = rolling('cleared');
    const out = await resumeAll(w.d);
    expect(out).toEqual([
      { status: 'refused', txn: null, why: 'by_ambiguous', cause: 'manual_by_ambiguous' },
    ]);
    expect(w.txns.size).toBe(0);
    expect(w.revs).toHaveLength(0);
  });
});

describe('B. 旧格式 journal(缺三键):先收齐三项事实,拿不到 → incomplete 且不写凭据', () => {
  const legacy = (over: Partial<PersonalTxn>): PersonalTxn => ({
    schema_version: 1,
    txn_id: TXN,
    candidate_id: ID,
    kind: 'rollback',
    reason: 'harm_c1',
    target_terminal: 'rolled_back',
    phase: 'rollback_requested',
    identity12: null,
    at: '2026-11-10T12:00:00.000Z',
    ...over,
  });
  const cred = (over: Partial<RsiRevocationLine> = {}): RsiRevocationLine => ({
    at: '2026-11-10T11:00:00.000Z',
    candidate_id: ID,
    content_sha256: SHA,
    identity12: null,
    reason: 'vetoed',
    by: 'veto',
    ...over,
  });

  it.each([
    ['vetoed', 'rollback', 'veto', 'vetoed'],
    ['cleared', 'clear', 'clear', 'cleared'],
    ['tainted', 'rollback', 'worker', 'tainted'],
  ] as const)(
    '可还原:原因 %s(kind=%s)→ 来源 %s、事件由原因重建、内容哈希来自 head.json 记录的提交 → 续做到终态',
    async (reason, kind, by, terminal) => {
      const w = world7();
      w.d.recordedSha = async () => SHA;
      await w.d.txns.write(legacy({ reason, kind }));
      const out = await resumeAll(w.d);
      expect(out.map((o) => o.status)).toEqual(['complete']);
      expect(w.revs).toHaveLength(1);
      expect(w.revs[0]).toMatchObject({ by, reason, content_sha256: SHA });
      expect(recordOf(w).terminal_reason).toBe(terminal);
    },
  );

  it('内容哈希也可来自撤销凭据(不需要 recordedSha、仓库读不到也行)', async () => {
    const w = world7();
    w.revs.push(cred());
    w.store.mode = 'deferred';
    await w.d.txns.write(legacy({ reason: 'vetoed' }));
    const out = await resumeAll(w.d);
    expect(out[0]).not.toMatchObject({ status: 'incomplete' });
    expect(w.revs).toHaveLength(1); // 已有凭据,不重复写
    expect(w.revs[0]).toMatchObject({ by: 'veto', content_sha256: SHA });
  });

  it.each([
    ['harm_c1', 'rollback', 'rolled_back'],
    ['harm_c6', 'rollback', 'rolled_back'],
    ['judge_reject', 'rollback', 'rolled_back'],
    ['judge_injection', 'rollback', 'rolled_back'],
    ['limit_reached', 'rollback', 'expired'],
    ['exec_post_check_failed', 'rollback', 'rolled_back'],
  ] as const)(
    '终止事件需要原始证据(%s):不伪造 → incomplete(terminal_event),不写凭据、记录不动、journal 保留',
    async (reason, kind, target_terminal) => {
      const w = world7();
      w.d.recordedSha = async () => SHA;
      await w.d.txns.write(legacy({ reason, kind, target_terminal }));
      const out = await resumeAll(w.d);
      expect(out).toEqual([
        {
          status: 'incomplete',
          txn: TXN,
          phase: 'rollback_requested',
          why: 'legacy_unrecoverable:terminal_event',
          cause: 'manual_event_required',
        },
      ]);
      expect(w.revs).toHaveLength(0);
      expect(noActions(w)).toEqual([]);
      expect(recordOf(w).lifecycle).toBe('canary');
      expect(w.txns.size).toBe(1);
    },
  );

  it('cleared 配 kind=rollback / reconcile 来源有歧义(rollback_to 或 clear):不推出 → incomplete(by),不写凭据', async () => {
    for (const kind of ['rollback', 'reconcile'] as const) {
      const w = world7();
      w.d.recordedSha = async () => SHA;
      await w.d.txns.write(legacy({ reason: 'cleared', kind }));
      const out = await resumeAll(w.d);
      expect(out, kind).toEqual([
        {
          status: 'incomplete',
          txn: TXN,
          phase: 'rollback_requested',
          why: 'legacy_unrecoverable:by',
          cause: 'manual_by_ambiguous',
        },
      ]);
      expect(w.revs, kind).toHaveLength(0);
      expect(noActions(w), kind).toEqual([]);
    }
  });

  it('内容哈希:不信权威副本的当前值(记录里有、但没有凭据也没有 recordedSha)→ incomplete(content_sha256),不写凭据', async () => {
    const w = world7(); // store 里的记录 content_sha256 == SHA,与 txn_id 对得上,但不是契约允许的来源
    await w.d.txns.write(legacy({ reason: 'vetoed' }));
    const out = await resumeAll(w.d);
    expect(out).toEqual([
      {
        status: 'incomplete',
        txn: TXN,
        phase: 'rollback_requested',
        why: 'legacy_unrecoverable:content_sha256',
        cause: 'txn_invalid',
      },
    ]);
    expect(w.revs).toHaveLength(0);
    expect(noActions(w)).toEqual([]);
  });

  it('内容哈希:recordedSha 对不上 txn_id 不采信;复用入口时请求带来的内容哈希也不是允许的来源', async () => {
    const w = world7();
    w.d.recordedSha = async () => 'f'.repeat(64);
    await w.d.txns.write(legacy({ reason: 'vetoed' }));
    expect((await resumeAll(w.d))[0]).toMatchObject({
      status: 'incomplete',
      why: 'legacy_unrecoverable:content_sha256',
    });
    const r = await startRollback(
      w.d,
      harmReq({ reason: 'vetoed', by: 'veto', event: { kind: 'veto', evidence: 'rsi veto' } }),
    );
    expect(r).toMatchObject({ status: 'incomplete', why: 'legacy_unrecoverable:content_sha256' });
    expect(w.revs).toHaveLength(0);
    expect(noActions(w)).toEqual([]);
  });

  it('多项缺失一并报告(by + content_sha256;cleared 的事件可重建,不在其列)', async () => {
    const w = world7();
    await w.d.txns.write(legacy({ reason: 'cleared', kind: 'rollback' }));
    expect((await resumeAll(w.d))[0]).toMatchObject({
      why: 'legacy_unrecoverable:by,content_sha256',
    });
  });

  it('凭据已写(旧 journal 在第三段)而终止事件拿不到:仍 incomplete,记录与仓库都不再动', async () => {
    const w = world7();
    w.revs.push(cred({ reason: 'harm_c1', by: 'worker' }));
    await w.d.txns.write(legacy({ phase: 'static_removal_pending' }));
    const out = await resumeAll(w.d);
    expect(out[0]).toMatchObject({
      status: 'incomplete',
      phase: 'static_removal_pending',
      why: 'legacy_unrecoverable:terminal_event',
    });
    expect(noActions(w)).toEqual([]);
    expect(recordOf(w).lifecycle).toBe('canary');
  });

  it('只带部分恢复键(sha + by,没有 terminal_event;0e9b1f7 写过这种 reconcile)按键逐个处理:harm_c1 拿不到事件 → incomplete(terminal_event)', async () => {
    const w = world7();
    await w.d.txns.write(legacy({ kind: 'reconcile', content_sha256: SHA, by: 'worker' }));
    const out = await resumeAll(w.d);
    expect(out[0]).toMatchObject({
      status: 'incomplete',
      why: 'legacy_unrecoverable:terminal_event',
    });
    expect(w.revs).toHaveLength(0);
    expect(noActions(w)).toEqual([]);
  });

  it('只带部分恢复键,缺的那项可重建(vetoed 缺事件)→ 续做到终态', async () => {
    const w = world7();
    await w.d.txns.write(
      legacy({ kind: 'reconcile', reason: 'vetoed', content_sha256: SHA, by: 'veto' }),
    );
    expect((await resumeAll(w.d)).map((o) => o.status)).toEqual(['complete']);
    expect(w.revs[0]).toMatchObject({ by: 'veto' });
  });

  it('带 HARM 事件但与 reason 不一致的新格式 journal 不被当作旧格式:txn_invalid', async () => {
    const w = world7();
    await w.d.txns.write(
      legacy({
        reason: 'vetoed',
        content_sha256: SHA,
        by: 'veto',
        terminal_event: HARM as unknown as Record<string, unknown>,
      }),
    );
    expect(await resumeAll(w.d)).toEqual([
      { status: 'refused', txn: null, journal: TXN, why: 'txn_invalid', cause: 'txn_invalid' },
    ]);
    expect(w.revs).toHaveLength(0);
  });
});

describe('A. 复用在途 txn 时较晚事件不合规', () => {
  it('较晚事件不合规(过不了转移引擎的事件 schema)→ refused event_invalid,journal 与记录都不动、零动作', async () => {
    const w = world7();
    w.crashAt('enter:injection_disabled');
    await expect(startRollback(w.d, harmReq())).rejects.toThrow('injected crash');
    const before = JSON.stringify(recordOf(w));
    w.calls.length = 0;
    const r = await startRollback(w.d, {
      ...harmReq(),
      event: { kind: 'limit', evidence: 'x' } as unknown as TransitionEvent,
    });
    expect(r).toEqual({
      status: 'refused',
      txn: null,
      why: 'event_invalid',
      cause: 'candidate_invalid',
    });
    expect(noActions(w)).toEqual([]);
    expect(JSON.stringify(recordOf(w))).toBe(before);
    expect(w.txns.size).toBe(1);
  });
});
