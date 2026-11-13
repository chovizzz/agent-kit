/**
 * `rsi auto clear` 退出码映射(contracts R21-12.4、§21.24 W0-22 第 3 条):按「事务身份」归并 + 按优先级匹配 + 完整性错误单列;匹配对象是 `cause` 不是 `why` 文案。
 * 11 行逐格各一例、优先级交换、身份归并、按 variant × cause 穷举。
 */
import { describe, expect, it } from 'vitest';
import { RSI_ROLLBACK_CAUSES } from '../../../src/contracts/rsi.js';
import { mapClearExit } from '../../../src/rsi/auto/exit-map.js';
import type { RollbackOutcome } from '../../../src/rsi/personal/rollback.js';

type Cause = (typeof RSI_ROLLBACK_CAUSES)[number];
const complete = (txn: string): RollbackOutcome => ({
  status: 'complete',
  txn,
  effects: 'applied',
});
const revoked = (txn: string, id = 'ra_aaaaaaaaaaaa'): RollbackOutcome => ({
  status: 'revocation_complete',
  txn,
  candidate_id: id,
  repoRemoval: 'deferred',
  why: 'diverged',
  workingMarked: false,
});
const incomplete = (
  txn: string,
  cause: Cause,
  phase: 'rollback_requested' | 'static_removal_pending' = 'rollback_requested',
  why = 'x',
): RollbackOutcome => ({ status: 'incomplete', txn, phase, why, cause });
const refused = (
  txn: string | null,
  cause: Cause,
  why = 'x',
  journal?: string,
): RollbackOutcome => ({
  status: 'refused',
  txn,
  ...(journal !== undefined ? { journal } : {}),
  why,
  cause,
});

describe('11 行逐格', () => {
  const rows: [string, RollbackOutcome[], number, string | null][] = [
    ['1 not_wired', [incomplete('t1', 'not_wired')], 3, 'internal'],
    ['2 credentials_invalid', [incomplete('t1', 'credentials_invalid')], 3, 'revocations_invalid'],
    ['3a txn_invalid', [refused('t1', 'txn_invalid')], 3, 'txn_invalid'],
    ['3b txn_absent', [incomplete('t1', 'txn_absent')], 3, 'txn_invalid'],
    ['4 candidate_invalid', [refused('t1', 'candidate_invalid')], 3, 'candidate_invalid'],
    ['5 repo_unreadable', [incomplete('t1', 'repo_unreadable')], 3, 'personal_repo_invalid'],
    ['9a manual_event_required', [incomplete('t1', 'manual_event_required')], 1, null],
    ['9b manual_by_ambiguous', [incomplete('t1', 'manual_by_ambiguous')], 1, null],
    ['9c retryable', [incomplete('t1', 'retryable')], 1, null],
    [
      '9d static_removal_pending',
      [incomplete('t1', 'retryable', 'static_removal_pending')],
      1,
      null,
    ],
    ['10 revocation_complete', [revoked('t1')], 0, null],
    ['11 complete', [complete('t1')], 0, null],
  ];
  for (const [name, outcomes, exit, reason] of rows) {
    it(`${name} → 退 ${exit}${reason === null ? '' : ` reason=${reason}`}`, () => {
      const r = mapClearExit({ outcomes });
      expect(r.exit).toBe(exit);
      expect(r.errors).toEqual(reason === null ? [] : [`RSI_FAIL_CLOSED reason=${reason}`]);
    });
  }

  it('7 / 8 命令级前置:locked / off / not_diverged → 退 4 RSI_NOT_RUN;快照协议用尽 → 退 4 RSI_SNAPSHOT_BUSY', () => {
    for (const p of ['locked', 'off', 'not_diverged'] as const) {
      const r = mapClearExit({ outcomes: [], precondition: p });
      expect([r.exit, r.errors, r.row]).toEqual([4, [`RSI_NOT_RUN reason=${p}`], 7]);
    }
    const b = mapClearExit({ outcomes: [], precondition: 'snapshot_busy' });
    expect([b.exit, b.errors, b.row]).toEqual([4, ['RSI_SNAPSHOT_BUSY'], 8]);
  });

  it('6 失败 variant 上缺失 / 未识别的 cause → 退 3 internal;成功 variant 无 cause 是正常(不打 3)', () => {
    const noCause = {
      status: 'incomplete',
      txn: 't1',
      phase: 'rollback_requested',
      why: 'x',
    } as unknown as RollbackOutcome;
    expect(mapClearExit({ outcomes: [noCause] })).toMatchObject({
      exit: 3,
      row: 6,
      errors: ['RSI_FAIL_CLOSED reason=internal'],
    });
    const weird = { ...noCause, cause: 'something_new' } as unknown as RollbackOutcome;
    expect(mapClearExit({ outcomes: [weird] }).exit).toBe(3);
    const refusedNoCause = { status: 'refused', txn: 't1', why: 'x' } as unknown as RollbackOutcome;
    expect(mapClearExit({ outcomes: [refusedNoCause] }).row).toBe(6);
    expect(mapClearExit({ outcomes: [complete('t1'), revoked('t2')] }).exit).toBe(0);
  });
});

describe('优先级', () => {
  it('取最小号:not_wired(1)压过 locked(7);locked(7)压过 manual(9);busy(8)压过 manual(9);cause 优先级 1<2<3<4<5<6', () => {
    expect(
      mapClearExit({ outcomes: [incomplete('a', 'not_wired')], precondition: 'locked' }).errors,
    ).toEqual(['RSI_FAIL_CLOSED reason=internal']);
    expect(
      mapClearExit({ outcomes: [incomplete('a', 'retryable')], precondition: 'locked' }).exit,
    ).toBe(4);
    expect(
      mapClearExit({ outcomes: [incomplete('a', 'retryable')], precondition: 'snapshot_busy' })
        .exit,
    ).toBe(4);
    const order: Cause[] = [
      'not_wired',
      'credentials_invalid',
      'txn_invalid',
      'candidate_invalid',
      'repo_unreadable',
    ];
    const reason = [
      'internal',
      'revocations_invalid',
      'txn_invalid',
      'candidate_invalid',
      'personal_repo_invalid',
    ];
    order.forEach((c, i) => {
      const later = order.slice(i + 1).map((x, k) => incomplete(`z${k}`, x));
      expect(mapClearExit({ outcomes: [...later, incomplete('a', c)] }).errors, c).toEqual([
        `RSI_FAIL_CLOSED reason=${reason[i] as string}`,
      ]);
    });
  });

  it('第 9 行退 1(不是 3);匹配 cause 而不是 why 前缀:why 写成 repo_unreadable:… 但 cause=retryable 仍是第 9 行', () => {
    const r = mapClearExit({
      outcomes: [incomplete('a', 'retryable', 'rollback_requested', 'repo_unreadable:x')],
    });
    expect([r.exit, r.row]).toEqual([1, 9]);
    expect(r.info).toEqual(['RSI_MANUAL txn=a cause=retryable']);
  });
});

describe('事务身份归并与完整性错误', () => {
  it('同一身份的后续 complete 消除此前的失败;同 id 不同 sha(不同 txn)互不消除', () => {
    expect(mapClearExit({ outcomes: [incomplete('a', 'not_wired'), complete('a')] }).exit).toBe(0);
    expect(mapClearExit({ outcomes: [refused('a', 'candidate_invalid'), revoked('a')] }).exit).toBe(
      0,
    );
    expect(mapClearExit({ outcomes: [incomplete('a', 'not_wired'), complete('b')] }).exit).toBe(3);
  });

  it('先 complete 后失败(同一身份)→ 失败仍未解决', () => {
    expect(
      mapClearExit({ outcomes: [complete('a'), incomplete('a', 'credentials_invalid')] }).exit,
    ).toBe(3);
  });

  it('journal 完整性错误(refused、txn=null、带 journal 句柄)不被任何 complete 消除;每份独立(同候选两份不一致 journal 各报一份)', () => {
    const integrity = refused(null, 'txn_invalid', 'conflict', 'j1');
    expect(mapClearExit({ outcomes: [integrity, complete('a'), revoked('b')] })).toMatchObject({
      exit: 3,
      errors: ['RSI_FAIL_CLOSED reason=txn_invalid'],
    });
    const two = mapClearExit({
      outcomes: [integrity, refused(null, 'txn_invalid', 'conflict', 'j2'), complete('a')],
    });
    expect(two.exit).toBe(3);
    // 命令级失败(identity 不符 / event 非法:txn=null 且无 journal)同样不被消除
    expect(
      mapClearExit({ outcomes: [refused(null, 'candidate_invalid', 'identity'), complete('a')] })
        .exit,
    ).toBe(3);
  });

  it('一事务 complete 而另一事务不合规 → 退 3(不是 0)', () => {
    expect(mapClearExit({ outcomes: [complete('a'), refused('b', 'txn_invalid')] }).exit).toBe(3);
  });

  it('候选枚举失败(含部分成功后)→ 退 3 personal_repo_invalid,不得退 0;已成功项先输出', () => {
    const r = mapClearExit({
      outcomes: [complete('a'), revoked('b', 'ra_bbbbbbbbbbbb')],
      enumerationFailed: true,
      candidateOf: (t) => (t === 'a' ? 'ra_aaaaaaaaaaaa' : undefined),
    });
    expect([r.exit, r.errors]).toEqual([3, ['RSI_FAIL_CLOSED reason=personal_repo_invalid']]);
    expect(r.info).toEqual([
      'RSI_CLEAR_DONE id=ra_aaaaaaaaaaaa revoked=yes',
      'RSI_CLEAR_DONE id=ra_bbbbbbbbbbbb revoked=yes repo_removal=deferred',
    ]);
  });

  it('失败时已完成的撤销仍先逐行输出(信息行在前,失败行在后);成功 variant 缺 txn 对应候选时以 txn= 代替', () => {
    const r = mapClearExit({ outcomes: [complete('a'), incomplete('b', 'manual_event_required')] });
    expect(r.exit).toBe(1);
    expect(r.info).toEqual([
      'RSI_CLEAR_DONE txn=a revoked=yes',
      'RSI_MANUAL txn=b cause=manual_event_required',
    ]);
  });

  it('revocation_complete 不使 clear 失败:退 0,信息行带 repo_removal=deferred', () => {
    const r = mapClearExit({ outcomes: [revoked('a')] });
    expect([r.exit, r.row]).toEqual([0, 10]);
    expect(r.info[0]).toContain('repo_removal=deferred');
  });
});

describe('按 variant × cause 穷举', () => {
  const expectedExit: Record<Cause, 1 | 3> = {
    not_wired: 3,
    credentials_invalid: 3,
    txn_invalid: 3,
    txn_absent: 3,
    candidate_invalid: 3,
    repo_unreadable: 3,
    retryable: 1,
    manual_event_required: 1,
    manual_by_ambiguous: 1,
  };
  for (const cause of RSI_ROLLBACK_CAUSES) {
    it(`incomplete × ${cause} → 退 ${expectedExit[cause]}`, () => {
      expect(mapClearExit({ outcomes: [incomplete('a', cause)] }).exit).toBe(expectedExit[cause]);
    });
    it(`refused(带事务身份)× ${cause} → 退 ${expectedExit[cause]}`, () => {
      expect(mapClearExit({ outcomes: [refused('a', cause)] }).exit).toBe(expectedExit[cause]);
    });
  }
});
