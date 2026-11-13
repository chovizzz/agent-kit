/**
 * W0-20 journal 自带恢复事实(H1 / M4)与审计行按键落地(M6;键 = 转移条目的 idem_key):
 *  - 首次落盘就带 content_sha256 / by / terminal_event(入口先过转移引擎的事件 schema);
 *  - 续做只从 journal 取这三项(不传 hint、不传 recordedSha、私有仓库读不到也要写出凭据),覆盖全部支持的终止原因 × 三个崩溃点;
 *  - 字段不合规 → refused txn_invalid 且零动作(旧格式 journal 的还原规则与新 journal 的写入边界见 w7-journal-boundary.test.ts);
 *  - 审计行经带键端口落地:键集合固定、每键恰好一次;落地失败由收尾 / recoverTerminalEffects 补做。
 */
import { describe, expect, it } from 'vitest';
import type { PersonalTxn } from '../../../src/contracts/rsi-personal.js';
import { recoverTerminalEffects } from '../../../src/rsi/personal/effects-recover.js';
import type { RevocationBy } from '../../../src/rsi/personal/revoke-write.js';
import {
  resumeAll,
  rollbackTxnId,
  startRollback,
  type RollbackRequest,
} from '../../../src/rsi/personal/rollback.js';
import { newJournal } from '../../../src/rsi/personal/rollback-journal.js';
import {
  isTerminationKind,
  type TransitionEvent,
} from '../../../src/rsi/personal/transition-table.js';
import { entry, rec } from '../personal/transition-fixture.js';
import { Crash, ID, SHA, recordOf, world7, type World7 } from './w7-fixture.js';

const TXN = rollbackTxnId(ID, SHA);

const harm = (metric: 'c1' | 'c2' | 'c3' | 'c4' | 'c6'): TransitionEvent => ({
  kind: 'harm',
  evidence: `analysis-v1:${metric}:look=1:t=0.500`,
  metric,
  worse: true,
});
const judge = (injection: boolean): TransitionEvent => ({
  kind: 'judge_reject',
  evidence: 'judge:e1',
  validated: true,
  verdict_reject: !injection,
  injection_suspected: injection,
});

interface Case {
  reason: string;
  by: RevocationBy;
  kind: 'rollback' | 'clear';
  ev: TransitionEvent;
  target: 'rolled_back' | 'expired';
  lifecycle: 'rolled_back' | 'expired';
  terminal: string;
}
const mk = (
  reason: string,
  by: RevocationBy,
  ev: TransitionEvent,
  terminal: string,
  over: Partial<Case> = {},
): Case => ({
  reason,
  by,
  kind: 'rollback',
  ev,
  target: 'rolled_back',
  lifecycle: 'rolled_back',
  terminal,
  ...over,
});

/** 固定事件表:每个支持的终止原因一行(不写循环找边界) */
const CASES: readonly Case[] = [
  mk('harm_c1', 'worker', harm('c1'), 'auto_rollback'),
  mk('harm_c2', 'worker', harm('c2'), 'auto_rollback'),
  mk('harm_c3', 'worker', harm('c3'), 'auto_rollback'),
  mk('harm_c4', 'worker', harm('c4'), 'auto_rollback'),
  mk('harm_c6', 'worker', harm('c6'), 'auto_rollback'),
  mk(
    'limit_reached',
    'worker',
    { kind: 'canary_limit', evidence: 'canary-limit:days=90', max_arm_sessions: 1_000_000 },
    'auto_expired',
    { target: 'expired', lifecycle: 'expired' },
  ),
  mk('vetoed', 'veto', { kind: 'veto', evidence: 'rsi veto' }, 'vetoed'),
  mk('tainted', 'worker', { kind: 'taint', evidence: 'taint:e1' }, 'tainted'),
  mk('cleared', 'clear', { kind: 'clear', evidence: 'rsi auto clear' }, 'cleared', {
    kind: 'clear',
  }),
  mk('cleared', 'rollback_to', { kind: 'clear', evidence: 'rsi rollback --to' }, 'cleared'),
  mk('judge_reject', 'worker', judge(false), 'judge_rejected'),
  mk('judge_injection', 'worker', judge(true), 'judge_rejected'),
];
const NAMED = CASES.map((c) => [`${c.reason}/${c.by}`, c] as const);

const reqOf = (c: Case): RollbackRequest => ({
  candidate_id: ID,
  content_sha256: SHA,
  kind: c.kind,
  reason: c.reason,
  by: c.by,
  target_terminal: c.target,
  event: c.ev,
});

function expectFinal(w: World7, c: Case, label: string): void {
  const rc = recordOf(w);
  expect(rc.lifecycle, label).toBe(c.lifecycle);
  expect(rc.terminal_reason, label).toBe(c.terminal);
  expect(w.txns.size, label).toBe(0);
  expect(w.revs, label).toHaveLength(1);
  expect(w.revs[0], label).toMatchObject({ by: c.by, reason: c.reason, content_sha256: SHA });
  expect([...w.effectApplied.values()], label).toEqual([1]);
  expect(
    rc.transitions.filter(
      (t) => t.dim === 'lifecycle' && t.from === 'canary' && t.to === 'rolling_back',
    ),
    label,
  ).toHaveLength(1);
  // 续做不触发 rolling_back 自环(自环是较晚到达的事件的事,不是 journal 自带事件的事)
  expect(
    rc.transitions.filter(
      (t) => t.dim === 'lifecycle' && t.from === 'rolling_back' && t.to === 'rolling_back',
    ),
    label,
  ).toHaveLength(0);
}

describe('H1 / M4:固定事件表覆盖全部终止事件种类', () => {
  it('表里的事件种类 == isTerminationKind 的全部种类(除 revocation_reconcile:它走对账路径,不经本入口)', () => {
    const ALL_KINDS = [
      'gates_passed',
      'gate_red',
      'shadow_no_hit',
      'shadow_queue_expired',
      'shadow_promote',
      'veto',
      'taint',
      'clear',
      'revocation_reconcile',
      'judge_reject',
      'harm',
      'canary_limit',
      'decide_better',
      'deploy_inject',
      'rollback_advance',
      'removal_done',
      'compensation_done',
    ] as const;
    const wanted = ALL_KINDS.filter(
      (k) => isTerminationKind(k) && k !== 'revocation_reconcile',
    ).sort();
    expect([...new Set(CASES.map((c) => c.ev.kind))].sort()).toEqual(wanted);
    expect(new Set(CASES.map((c) => c.reason)).size).toBe(11); // 11 个原因,cleared 两个来源
  });
});

describe('H1 / M4:journal 首次落盘带齐 content_sha256 / by / terminal_event', () => {
  it.each(NAMED)(
    '原因 %s:journal:rollback_requested 处崩溃,盘上 journal 带齐三项',
    async (_n, c) => {
      const w = world7();
      w.crashAt('journal:rollback_requested');
      await expect(startRollback(w.d, reqOf(c))).rejects.toBeInstanceOf(Crash);
      expect(w.txns.get(TXN)).toMatchObject({
        content_sha256: SHA,
        by: c.by,
        terminal_event: c.ev,
      });
    },
  );

  it('reconcile(kind=reconcile)的 journal 同样带齐三项:终止事实由原因重建(vetoed → veto 事件,证据 txn:<id>)', async () => {
    const w = world7({
      record: rec('rolling_back', {
        deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
        rollback: { phase: 'injection_disabled', reason: 'vetoed', target_terminal: 'rolled_back' },
      }),
    });
    w.crashAt('journal:rollback_requested');
    await expect(resumeAll(w.d)).rejects.toBeInstanceOf(Crash);
    expect(w.txns.get(TXN)).toMatchObject({
      content_sha256: SHA,
      by: 'veto',
      kind: 'reconcile',
      terminal_event: { kind: 'veto', evidence: `txn:${TXN}` },
    });
  });
});

describe('H1 / M4:全部支持原因 × 崩溃点 → 续做(不传 hint / recordedSha;仓库读不到也要写出凭据)→ 再崩 → 再续做', () => {
  it.each(NAMED)(
    '原因 %s:崩于凭据落盘前(journal:rollback_requested),仓库 deferred 下续做写出凭据,再崩于凭据后',
    async (_n, c) => {
      const w = world7();
      w.crashAt('journal:rollback_requested');
      await expect(startRollback(w.d, reqOf(c))).rejects.toBeInstanceOf(Crash);
      expect(w.revs).toHaveLength(0);
      w.store.mode = 'deferred'; // 私有仓库 / 权威记录读不到:凭据不能依赖它们
      w.crashAt('after:revocation');
      await expect(resumeAll(w.d)).rejects.toBeInstanceOf(Crash);
      expect(w.revs).toHaveLength(1);
      expect(w.revs[0]).toMatchObject({ by: c.by, reason: c.reason, content_sha256: SHA });
      w.store.mode = 'ok';
      const out = await resumeAll(w.d);
      expect(out.map((o) => o.status)).toEqual(['complete']);
      expectFinal(w, c, `${c.reason}/${c.by} A`);
    },
  );

  it.each(NAMED)(
    '原因 %s:崩于凭据落盘后(after:revocation),续做再崩于记录提交前(enter:static_removal_pending)',
    async (_n, c) => {
      const w = world7();
      w.crashAt('after:revocation');
      await expect(startRollback(w.d, reqOf(c))).rejects.toBeInstanceOf(Crash);
      expect(w.revs).toHaveLength(1);
      w.crashAt('enter:static_removal_pending');
      await expect(resumeAll(w.d)).rejects.toBeInstanceOf(Crash);
      expect(recordOf(w).lifecycle).toBe('canary'); // 记录还没提交
      expect(w.revs).toHaveLength(1);
      const out = await resumeAll(w.d);
      expect(out.map((o) => o.status)).toEqual(['complete']);
      expectFinal(w, c, `${c.reason}/${c.by} B`);
    },
  );

  it.each(NAMED)(
    '原因 %s:崩于记录提交前(enter:static_removal_pending),续做在仓库 deferred 下再崩,最后恢复续做到终态',
    async (_n, c) => {
      const w = world7();
      w.crashAt('enter:static_removal_pending');
      await expect(startRollback(w.d, reqOf(c))).rejects.toBeInstanceOf(Crash);
      expect(recordOf(w).lifecycle).toBe('canary');
      expect(w.revs).toHaveLength(1);
      w.store.mode = 'deferred';
      w.crashAt('after:record_event');
      await expect(resumeAll(w.d)).rejects.toBeInstanceOf(Crash);
      w.store.mode = 'ok';
      const out = await resumeAll(w.d);
      expect(out.map((o) => o.status)).toEqual(['complete']);
      expectFinal(w, c, `${c.reason}/${c.by} C`);
    },
  );
});

describe('journal 字段不合规 → refused txn_invalid,零动作(fail-closed)', () => {
  const base = (over: Partial<PersonalTxn>): PersonalTxn => ({
    schema_version: 1,
    txn_id: TXN,
    candidate_id: ID,
    kind: 'rollback',
    reason: 'harm_c1',
    target_terminal: 'rolled_back',
    phase: 'rollback_requested',
    identity12: null,
    at: '2026-11-10T12:00:00.000Z',
    content_sha256: SHA,
    by: 'worker',
    terminal_event: harm('c1'),
    ...over,
  });
  const ACTIONS = [
    'revoke.write',
    'cache.clean',
    'repo.remove',
    'payload.revoke',
    'effects.applyOnce',
  ];

  it.each([
    [
      'terminal_event 过不了转移引擎的事件 schema',
      { terminal_event: { kind: 'limit', evidence: 'x' } },
    ],
    ['terminal_event 缺必填字段', { terminal_event: { kind: 'harm', evidence: 'x' } }],
    ['content_sha256 与 txn_id 对不上', { content_sha256: 'c'.repeat(64) }],
    [
      'terminal_event 与 reason 不一致(harm_c1 的 journal 带 veto 事件)',
      { terminal_event: { kind: 'veto', evidence: 'x' } },
    ],
    [
      'terminal_event 与 reason 不一致(harm_c1 的 journal 带 c2 指标的事件)',
      { terminal_event: harm('c2') },
    ],
    [
      'terminal_event 与 target_terminal 不一致(harm 事件配 expired)',
      { target_terminal: 'expired' },
    ],
    ['by 与 (kind, reason) 不相容', { by: 'veto' }],
    ['kind=clear 而 by 不是 clear', { kind: 'clear', reason: 'cleared', by: 'worker' }],
  ] as const)('%s', async (_n, over) => {
    const w = world7();
    await w.d.txns.write(base(over as Partial<PersonalTxn>));
    w.calls.length = 0;
    const out = await resumeAll(w.d);
    // 完整性错误:不带事务身份(同 (id, sha) 的 complete 消除不了它)
    expect(out).toEqual([
      { status: 'refused', txn: null, journal: TXN, why: 'txn_invalid', cause: 'txn_invalid' },
    ]);
    expect(w.calls.filter((c) => ACTIONS.includes(c))).toEqual([]);
    expect(w.revs).toHaveLength(0);
    expect(recordOf(w).lifecycle).toBe('canary');
    expect(w.txns.size).toBe(1); // journal 保留
  });

  it('复用在途 txn 的入口读到不合规 journal 同样 refused,且不施加请求带来的较晚事件', async () => {
    const w = world7();
    await w.d.txns.write(base({ by: 'veto' }));
    const r = await startRollback(w.d, {
      candidate_id: ID,
      content_sha256: SHA,
      kind: 'rollback',
      reason: 'vetoed',
      by: 'veto',
      target_terminal: 'rolled_back',
      event: { kind: 'veto', evidence: 'rsi veto' },
    });
    expect(r).toEqual({
      status: 'refused',
      txn: null,
      journal: TXN,
      why: 'txn_invalid',
      cause: 'txn_invalid',
    });
    expect(w.revs).toHaveLength(0);
  });
});

describe('复用在途 txn:journal 语义校验先于任何副作用(较晚事件的施加会提交记录)', () => {
  const rollingBack = () =>
    rec('rolling_back', {
      deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
      rollback: { phase: 'injection_disabled', reason: 'harm_c1', target_terminal: 'rolled_back' },
    });
  const lateVeto: RollbackRequest = {
    candidate_id: ID,
    content_sha256: SHA,
    kind: 'rollback',
    reason: 'vetoed',
    by: 'veto',
    target_terminal: 'rolled_back',
    event: { kind: 'veto', evidence: 'rsi veto' },
  };
  const journal = (over: Partial<PersonalTxn>): PersonalTxn => ({
    schema_version: 1,
    txn_id: TXN,
    candidate_id: ID,
    kind: 'rollback',
    reason: 'harm_c1',
    target_terminal: 'rolled_back',
    phase: 'injection_disabled',
    identity12: null,
    at: '2026-11-10T12:00:00.000Z',
    content_sha256: SHA,
    by: 'worker',
    terminal_event: harm('c1'),
    ...over,
  });

  it.each([
    ['content_sha256 与 txn_id 对不上的 journal', { content_sha256: 'c'.repeat(64) }],
    [
      '旧的 identity_change journal',
      { kind: 'identity_change', reason: 'identity_changed', identity12: 'abcdef012345' },
    ],
  ] as const)('%s:较晚事件不施加(记录 / 审计 / 效果 / 凭据 / payload 零写入)', async (_n, over) => {
    const w = world7({ record: rollingBack() });
    await w.d.txns.write(journal(over as Partial<PersonalTxn>));
    w.calls.length = 0;
    const before = JSON.stringify(recordOf(w));
    const r = await startRollback(w.d, lateVeto);
    // sha 对不上 = 完整性错误(无事务身份);旧 identity_change journal = 合法但本期不支持(带 txn)
    expect(r).toMatchObject(
      'kind' in over
        ? { status: 'refused', txn: TXN, cause: 'candidate_invalid' }
        : { status: 'refused', txn: null, journal: TXN, cause: 'txn_invalid' },
    );
    expect(w.store.commits).toHaveLength(0);
    expect(JSON.stringify(recordOf(w))).toBe(before);
    expect(w.auditLog.size).toBe(0);
    expect(w.effectLog.size).toBe(0);
    expect(w.revs).toHaveLength(0);
    expect(w.calls.filter((c) => !c.startsWith('step:'))).toEqual([]);
  });
});

describe('入口校验:事件在写 journal 之前过转移引擎 schema', () => {
  it('事件不合规 → refused event_invalid,不写 journal、不写凭据', async () => {
    const w = world7();
    const r = await startRollback(w.d, {
      ...reqOf(CASES[0] as Case),
      event: { kind: 'limit', evidence: 'x' } as unknown as TransitionEvent,
    });
    expect(r).toEqual({
      status: 'refused',
      txn: null,
      why: 'event_invalid',
      cause: 'candidate_invalid',
    });
    // 创建函数自己也拒绝(不靠入口的同名检查兜住)
    expect(
      newJournal(
        { ...reqOf(CASES[0] as Case), event: { kind: 'limit', evidence: 'x' } },
        '2026-11-10T12:00:00.000Z',
      ),
    ).toEqual({ ok: false, why: 'event_invalid', cause: 'candidate_invalid' });
    expect(w.txns.size).toBe(0);
    expect(w.revs).toHaveLength(0);
    expect(w.calls).toEqual([]);
  });

  it('需要记录转移而又无法由原因还原事件(limit_reached 不带事件)→ refused event_required,零动作', async () => {
    const w = world7();
    const r = await startRollback(w.d, {
      candidate_id: ID,
      content_sha256: SHA,
      kind: 'rollback',
      reason: 'limit_reached',
      by: 'worker',
      target_terminal: 'expired',
    });
    expect(r).toEqual({
      status: 'refused',
      txn: null,
      why: 'event_required',
      cause: 'manual_event_required',
    });
    expect(w.txns.size).toBe(0);
    expect(w.revs).toHaveLength(0);
  });
});

describe('M6:审计行经带键端口落地,同一行只落一次', () => {
  const happy = (): Case => CASES[0] as Case;

  it('正常回滚:审计键集合固定(回滚路径 7 条转移条目 → 7 个键 = 条目的 idem_key),每键恰好落地一次', async () => {
    const w = world7();
    await startRollback(w.d, reqOf(happy()));
    const rc = recordOf(w);
    // 键 = audit:<候选>:<转移条目的 idem_key>(事件身份,不是行内容哈希);回滚路径从第一条进入 rolling_back 的条目起
    const from = rc.transitions.findIndex((e) => e.dim === 'lifecycle' && e.to === 'rolling_back');
    const expected = rc.transitions
      .slice(from)
      .map((e) => `audit:${ID}:${e.idem_key}`)
      .sort();
    expect(expected).toHaveLength(7); // lifecycle×2 + deploy×2 + rollback×3
    expect([...w.auditLog.keys()].sort()).toEqual(expected);
    expect([...w.auditApplied.values()]).toEqual(Array(7).fill(1));
    expect([...w.effectApplied.values()]).toEqual([1]); // 终态业务效果的键与审计键分开
  });

  it('提交后崩溃(after:record_terminal)续做:每个审计键仍只落地一次', async () => {
    const w = world7();
    w.crashAt('after:record_terminal');
    await expect(startRollback(w.d, reqOf(happy()))).rejects.toBeInstanceOf(Crash);
    await resumeAll(w.d);
    expect(w.auditLog.size).toBe(7);
    expect([...w.auditApplied.values()]).toEqual(Array(7).fill(1));
  });

  it('审计落地失败(提交之后):收尾抛错、journal 保留;修好后续做补齐全部审计键,各一次', async () => {
    const w = world7();
    w.auditMode.value = 'throw';
    await expect(startRollback(w.d, reqOf(happy()))).rejects.toThrow('audit down');
    expect(w.txns.size).toBe(1);
    expect(recordOf(w).lifecycle).toBe('rolled_back'); // 权威记录已提交
    expect(w.auditLog.size).toBe(0);
    w.auditMode.value = 'applied';
    expect((await resumeAll(w.d))[0]?.status).toBe('complete');
    expect(w.auditLog.size).toBe(7);
    expect([...w.auditApplied.values()]).toEqual(Array(7).fill(1));
  });

  it('recoverTerminalEffects 对执行器终态补审计(按键幂等,再跑不重复)', async () => {
    const w = world7();
    w.auditMode.value = 'throw';
    await expect(startRollback(w.d, reqOf(happy()))).rejects.toThrow('audit down');
    w.auditMode.value = 'applied';
    const r1 = await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect(r1.failed).toEqual([]);
    expect(w.auditLog.size).toBe(7);
    await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect([...w.auditApplied.values()]).toEqual(Array(7).fill(1));
  });

  it('非执行器终态理由(如 rejected_gate)不补审计:它们的审计行是转移当时直接追加的', async () => {
    const w = world7();
    w.store.put(rec('rejected', { transitions: [entry(1), entry(2, 'rejected')] }));
    await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect(w.auditLog.size).toBe(0);
  });
});

describe('M6 审计键 = 事件身份:同毫秒、同 from/to/reason、不同 evidence 的两条转移 → 两行审计', () => {
  it('rolling_back 上先后到达两个 evidence 不同的 harm_c1 事件(自环):两行内容完全相同的审计各落一次,恢复补做不再增加', async () => {
    const w = world7({
      record: rec('rolling_back', {
        deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
        rollback: {
          phase: 'rollback_requested',
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
      phase: 'rollback_requested',
      identity12: null,
      at: '2026-11-10T12:00:00.000Z',
      content_sha256: SHA,
      by: 'worker',
      terminal_event: harm('c1'),
    });
    const late = (n: number): RollbackRequest => ({
      candidate_id: ID,
      content_sha256: SHA,
      kind: 'rollback',
      reason: 'harm_c1',
      by: 'worker',
      target_terminal: 'rolled_back',
      event: { ...harm('c1'), evidence: `analysis-v1:c1:look=${n}:t=0.500` },
    });
    for (const n of [2, 3]) {
      w.crashAt('enter:injection_disabled'); // 较晚事件已施加(自环已提交)、撤销事务还没动
      await expect(startRollback(w.d, late(n))).rejects.toBeInstanceOf(Crash);
    }
    const loops = recordOf(w).transitions.filter(
      (t) => t.dim === 'lifecycle' && t.from === 'rolling_back' && t.to === 'rolling_back',
    );
    expect(loops).toHaveLength(2);
    expect(loops[0]?.at).toBe(loops[1]?.at); // NOW 固定:同毫秒
    expect(loops[0]?.idem_key).not.toBe(loops[1]?.idem_key);
    const loopKeys = loops.map((t) => `audit:${ID}:${t.idem_key}`);
    for (const k of loopKeys) expect(w.auditLog.has(k), k).toBe(true);
    const [a, b] = loopKeys.map((k) => w.auditLog.get(k));
    expect(a).toEqual(b); // 两行内容完全相同,但是两个事件
    expect((await resumeAll(w.d))[0]?.status).toBe('complete');
    const applied = [...w.auditApplied.entries()];
    expect(applied.every(([, n]) => n === 1)).toBe(true);
    const before = w.audits.length;
    await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect(w.audits).toHaveLength(before);
    for (const k of loopKeys) expect(w.auditApplied.get(k)).toBe(1);
  });
});
