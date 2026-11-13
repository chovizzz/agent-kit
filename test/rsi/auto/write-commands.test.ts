/**
 * W8b 写命令(contracts R21-12.2–12.7、§21.24 W0-22 第 1–4、9、10 条、W0-23):经入口 `runAutoFamily`(相位 2)跑处理函数,端口全是内存假件(通过 `port-contract.test.ts` 的写侧套件)。
 * 期望值手写。分组:pause / resume / clear / veto / rollback --to / rebase-baseline / 预检与零写入 / 输出归并。
 */
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_LABEL } from '../../../src/contracts/rsi.js';
import { emitOutcomes } from '../../../src/rsi/auto/write/outcome-output.js';
import type { RollbackOutcome } from '../../../src/rsi/personal/rollback.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { canaryRec, world7, ID, SHA } from '../rollback/w7-fixture.js';
import { entry, rec } from '../personal/transition-fixture.js';
import { B_MARKER, makeFx, runWrite } from './write-fixture.js';

const ID2 = 'ra_bbbbbbbbbbbb';
const SHA2 = 'b'.repeat(64);

describe('rsi auto pause(R21-12.2):独占创建用户暂停文件', () => {
  it('pause 创建 U:不拿锁、不要 TTY、只碰 U(不写 state、不 bump、不碰熔断标记)', async () => {
    const fx = makeFx();
    const r = await runWrite('auto', ['pause'], fx, { tty: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain('auto_pause=created');
    expect(fx.user.creates).toBe(1);
    expect(fx.locks.log).toEqual([]);
    expect(fx.pause.writes).toEqual([]);
    expect(fx.marks.gen).toBe(0);
    expect(fx.events).toEqual([]);
  });

  it('pause 已存在时不覆盖:输出「已暂停(已存在)」,退 0,实例不变', async () => {
    const fx = makeFx();
    await runWrite('auto', ['pause'], fx);
    const ino = fx.user.file?.ino;
    const r = await runWrite('auto', ['pause'], fx);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已暂停(已存在)');
    expect(fx.user.creates).toBe(1);
    expect(fx.user.file?.ino).toBe(ino);
  });

  it('pause 在 [rsi] 关闭时退 4 off,不写 U;未知参数退 2', async () => {
    const fx = makeFx();
    fx.rsiOn.value = false;
    const r = await runWrite('auto', ['pause'], fx);
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(fx.user.creates).toBe(0);
    const r2 = await runWrite('auto', ['pause', '--x'], fx);
    expect([r2.code, r2.err]).toEqual([2, 'RSI_USAGE reason=unknown_arg\n']);
  });
});

describe('rsi auto resume(R21-12.3 / W0-22 第 1、2 条 / W0-23):线性化与结果表', () => {
  it('resume 清掉条件已不成立的人工码,写解除证据,bump,按指纹删 U;B 在 → PENDING 退 0,不得输出 RESUMED,不碰 B', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: ['redaction_changed'], diverged: false, owner_changed: false };
    fx.breaker.marker = B_MARKER();
    await fx.user.ensureUser();
    const r = await runWrite('auto', ['resume'], fx);
    expect(r.code).toBe(0);
    expect(r.err).toBe('RSI_AUTO_RESUME_PENDING breaker_marker=pending paused=yes\n');
    expect(r.err).not.toContain('RSI_AUTO_RESUMED');
    expect(fx.pause.writes).toHaveLength(1);
    expect(fx.pause.writes[0]).toMatchObject({ reasons: [], released_marker_id: 'b'.repeat(16) });
    expect(fx.marks.gen).toBe(1);
    expect(fx.user.file).toBeNull();
    expect(fx.breaker.marker).not.toBeNull();
    expect(fx.locks.log).toEqual([
      'acquire:rsi',
      'acquire:personal',
      'acquire:sync',
      'release:sync',
      'release:personal',
      'release:rsi',
    ]);
  });

  it('resume 在无剩余码、U 与 B 都不在时才输出 RESUMED(退 0)', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: ['kit_major_changed'], diverged: false, owner_changed: false };
    const r = await runWrite('auto', ['resume'], fx);
    expect([r.code, r.err]).toEqual([0, 'RSI_AUTO_RESUMED\n']);
    // B 不存在:证据为 null(不是缺键;`null` 与 `null` 不算相等,由 worker 侧判)
    expect(fx.pause.writes[0]).toMatchObject({ reasons: [], released_marker_id: null });
  });

  it('resume 不清仍成立的码:退 1,逐行 BLOCKED,不写证据,已清的码照实列出', async () => {
    const fx = makeFx();
    fx.pause.state = {
      reasons: ['rollback_storm', 'redaction_changed'],
      diverged: false,
      owner_changed: false,
    };
    fx.holds.add('gate_internal');
    const r = await runWrite('auto', ['resume'], fx);
    expect(r.code).toBe(1);
    expect(r.err).toBe('RSI_AUTO_RESUME_BLOCKED reason=rollback_storm\n');
    expect(r.out).toContain('cleared=redaction_changed');
    expect(fx.pause.writes[0]?.reasons).toEqual(['rollback_storm']);
    expect(fx.pause.writes[0]?.released_marker_id).toBeUndefined();
  });

  it('resume 对自动解除码不动:仍在 state 里,BLOCKED 行带 auto_release=yes,退 1,不输出 RESUMED', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: ['budget_high_legacy'], diverged: false, owner_changed: false };
    const r = await runWrite('auto', ['resume'], fx);
    expect(r.code).toBe(1);
    expect(r.err).toBe('RSI_AUTO_RESUME_BLOCKED reason=budget_high_legacy auto_release=yes\n');
    expect(fx.pause.writes).toEqual([]);
  });

  it('resume 不碰 diverged / owner_changed:退 1,提示 rebase-baseline,按码表顺序', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: ['kit_major_changed'], diverged: true, owner_changed: true };
    const r = await runWrite('auto', ['resume'], fx);
    expect(r.code).toBe(1);
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([
      'RSI_AUTO_RESUME_BLOCKED reason=personal_repo_diverged hint=rsi_auto_rebase-baseline',
      'RSI_AUTO_RESUME_BLOCKED reason=personal_owner_changed hint=rsi_auto_rebase-baseline',
    ]);
    expect(fx.pause.state.diverged && fx.pause.state.owner_changed).toBe(true);
  });

  it('resume 的顺序:先写 state(带证据),再 bump,最后删 U', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: ['user_vetoes'], diverged: false, owner_changed: false };
    await fx.user.ensureUser();
    await runWrite('auto', ['resume'], fx);
    expect(fx.events).toEqual(['state.write', 'marks.bump', 'user.remove']);
  });

  it('resume 指纹为空(快照时没有 U)永不删:步骤 ② 之后新建的 U′ 保留,结果行 BLOCKED user_paused new=yes,退 1', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: ['user_vetoes'], diverged: false, owner_changed: false };
    fx.marks.after = () => void fx.user.ensureUser();
    const r = await runWrite('auto', ['resume'], fx);
    expect(r.code).toBe(1);
    expect(r.err).toBe('RSI_AUTO_RESUME_BLOCKED reason=user_paused new=yes\n');
    expect(fx.user.file).not.toBeNull();
    expect(fx.user.removes).toBe(0);
    expect(r.err).not.toContain('RSI_AUTO_RESUMED');
  });

  it('resume 指纹不符(步骤 ② 之后 U 被换实例)保留并报 changed;U′ 与 B 同在时追加 breaker_marker=pending', async () => {
    const fx = makeFx();
    await fx.user.ensureUser();
    fx.breaker.marker = B_MARKER();
    fx.marks.after = () => fx.user.replace();
    const r = await runWrite('auto', ['resume'], fx);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      'RSI_AUTO_RESUME_BLOCKED reason=user_paused changed=yes breaker_marker=pending\n',
    );
    expect(fx.user.file).not.toBeNull();
  });

  it('resume:U 存在时历史遗留的 state 码 user_paused 一并清;U 不存在时它仍算剩余(不得谎报 RESUMED)', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: ['user_paused'], diverged: false, owner_changed: false };
    const r0 = await runWrite('auto', ['resume'], fx);
    expect([r0.code, r0.err]).toEqual([1, 'RSI_AUTO_RESUME_BLOCKED reason=user_paused\n']);
    await fx.user.ensureUser();
    const r1 = await runWrite('auto', ['resume'], fx);
    expect([r1.code, r1.err]).toEqual([0, 'RSI_AUTO_RESUMED\n']);
  });

  it('resume:U 的 lstat 非 ENOENT 失败 → 退 3,U 不动,state 不写,不 bump', async () => {
    const fx = makeFx();
    await fx.user.ensureUser();
    fx.pause.state = { reasons: ['user_vetoes'], diverged: false, owner_changed: false };
    fx.user.snapshotError = new Error('EACCES');
    const r = await runWrite('auto', ['resume'], fx);
    expect(r.code).toBe(3);
    expect(fx.pause.writes).toEqual([]);
    expect(fx.marks.gen).toBe(0);
    expect(fx.user.file).not.toBeNull();
  });

  it('resume 中途失败:已落盘的先输出(已完成:cleared=…),再退 3,可重跑', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: ['user_vetoes'], diverged: false, owner_changed: false };
    fx.marks.fail = new Error('disk');
    const r = await runWrite('auto', ['resume'], fx);
    expect(r.code).toBe(3);
    expect(r.out).toContain('已完成:cleared=user_vetoes');
    expect(fx.pause.writes).toHaveLength(1);
  });

  it('resume 参数 / 环境:非 TTY 退 2 零写入;锁被占用退 4 locked 零写入;[rsi] 关闭退 4 off', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: ['user_vetoes'], diverged: false, owner_changed: false };
    const a = await runWrite('auto', ['resume'], fx, { tty: false });
    expect([a.code, a.err, a.built]).toEqual([2, 'RSI_USAGE reason=not_tty\n', 0]);
    fx.locks.denied = 'locked';
    const b = await runWrite('auto', ['resume'], fx);
    expect([b.code, b.err]).toEqual([4, 'RSI_NOT_RUN reason=locked\n']);
    fx.locks.denied = null;
    fx.rsiOn.value = false;
    const c = await runWrite('auto', ['resume'], fx);
    expect([c.code, c.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(fx.pause.writes).toEqual([]);
    expect(fx.marks.gen).toBe(0);
  });

  it('resume --json:追加 paused 与 request_done(PENDING 行:paused=true,request_done=true)', async () => {
    const fx = makeFx();
    fx.breaker.marker = B_MARKER();
    const r = await runWrite('auto', ['resume', '--json'], fx);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      paused: true,
      request_done: true,
      breaker_marker: 'pending',
    });
  });
});

describe('rsi auto clear --write(R21-12.4 / R21-9.5 缩减入口):只拿 personal → sync', () => {
  it('clear 撤销成功:退 0,RSI_CLEAR_DONE 先逐行输出,只拿 personal → sync(不取 rsi/lock),不要求 [rsi] 可用', async () => {
    const w7 = world7({ record: canaryRec() });
    const fx = makeFx(w7);
    fx.rsiOn.value = false;
    const r = await runWrite('auto', ['clear', '--write'], fx);
    expect(r.code).toBe(0);
    expect(r.err).toContain('RSI_CLEAR_DONE');
    expect(r.err).toContain('revoked=yes');
    expect(fx.locks.log.filter((l) => l.startsWith('acquire'))).toEqual([
      'acquire:personal',
      'acquire:sync',
    ]);
    expect(w7.revs.map((x) => [x.by, x.reason])).toEqual([['clear', 'cleared']]);
  });

  it('clear 非 TTY 退 2;未知参数退 2;零写入', async () => {
    const w7 = world7({ record: canaryRec() });
    const fx = makeFx(w7);
    const a = await runWrite('auto', ['clear', '--write'], fx, { tty: false });
    expect([a.code, a.err]).toEqual([2, 'RSI_USAGE reason=not_tty\n']);
    const b = await runWrite('auto', ['clear', '--write', '--x'], fx);
    expect([b.code, b.err]).toEqual([2, 'RSI_USAGE reason=unknown_arg\n']);
    expect(w7.revs).toEqual([]);
    expect(fx.locks.log).toEqual([]);
  });

  it('clear 仓库读不出(deferred 且无只读记录):没有处理任何新候选,退 3 personal_repo_invalid,不写凭据', async () => {
    const w7 = world7({ record: canaryRec() });
    w7.store.mode = 'deferred';
    const fx = makeFx(w7);
    const r = await runWrite('auto', ['clear', '--write'], fx);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=personal_repo_invalid\n']);
    expect(w7.revs).toEqual([]);
  });
});

describe('输出归并(emitOutcomes):完整性先于归并、同身份才消除、已完成项先输出', () => {
  const ctxOf = (): { ctx: RsiEarlyContext; err: () => string } => {
    let err = '';
    const ctx = {
      argv: [],
      stdout: () => undefined,
      stderr: (t: string) => void (err += t),
      env: {},
    } as unknown as RsiEarlyContext;
    return { ctx, err: () => err };
  };
  const refusedTxn = (txn: string): RollbackOutcome => ({
    status: 'refused',
    txn,
    why: 'x',
    cause: 'candidate_invalid',
  });
  const complete = (txn: string): RollbackOutcome => ({ status: 'complete', txn, effects: 'none' });

  it('早拒后成功(同一事务身份)不算失败:退 0', async () => {
    const { ctx } = ctxOf();
    const code = await emitOutcomes(ctx, {}, { outcomes: [refusedTxn('t1'), complete('t1')] }, []);
    expect(code).toBe(0);
  });

  it('journal 完整性错误(不带身份)不被另一份 journal 的 complete 消除:退 3 txn_invalid', async () => {
    const { ctx, err } = ctxOf();
    const integrity: RollbackOutcome = {
      status: 'refused',
      txn: null,
      journal: 'j1',
      why: 'x',
      cause: 'txn_invalid',
    };
    const code = await emitOutcomes(ctx, {}, { outcomes: [integrity, complete('t1')] }, []);
    expect(code).toBe(3);
    expect(err()).toBe('RSI_CLEAR_DONE txn=t1 revoked=yes\nRSI_FAIL_CLOSED reason=txn_invalid\n');
  });

  it('已完成的撤销先逐行输出,再出失败行;manual 类给固定处置文案', async () => {
    const { ctx, err } = ctxOf();
    const manual: RollbackOutcome = {
      status: 'incomplete',
      txn: 't2',
      phase: 'rollback_requested',
      why: 'event_required',
      cause: 'manual_event_required',
    };
    const code = await emitOutcomes(ctx, {}, { outcomes: [manual, complete('t1')] }, ['head']);
    expect(code).toBe(1);
    expect(err()).toBe(
      'RSI_CLEAR_DONE txn=t1 revoked=yes\nRSI_MANUAL txn=t2 cause=manual_event_required\n',
    );
  });
});

describe('rsi veto(R21-12.6 / R21-11.3):三把锁,持锁后重读再判', () => {
  it('veto 已部署候选:startRollback(kind=rollback, reason=vetoed, by=veto),三把锁,黑名单落 E1 键', async () => {
    const w7 = world7({ record: canaryRec() });
    const fx = makeFx(w7);
    const r = await runWrite('veto', [ID], fx);
    expect(r.code).toBe(0);
    expect(w7.revs.map((x) => [x.by, x.reason])).toEqual([['veto', 'vetoed']]);
    expect(fx.sink.keys.has(`veto:${ID}:${SHA}`)).toBe(true);
    expect(fx.sink.blacklist.size).toBe(1);
    expect(fx.locks.log.filter((l) => l.startsWith('acquire'))).toEqual([
      'acquire:rsi',
      'acquire:personal',
      'acquire:sync',
    ]);
  });

  it('veto 未部署(shadow)候选:引擎 veto 事件直接 rejected(vetoed),终态批次 E2 整批落地,不写撤销凭据', async () => {
    const w7 = world7({ record: rec('shadow') });
    const fx = makeFx(w7);
    const r = await runWrite('veto', [ID], fx);
    expect(r.code).toBe(0);
    expect(w7.store.records.get(ID)?.lifecycle).toBe('rejected');
    expect(w7.revs).toEqual([]);
    expect(fx.sink.keys.has(`terminal:${ID}:${SHA}`)).toBe(true);
    expect(fx.sink.blacklistCount).toBe(1);
  });

  it('veto 已终态候选只写黑名单:记录不动,没有 journal,没有撤销凭据', async () => {
    const w7 = world7({ record: rec('rejected') });
    const fx = makeFx(w7);
    const r = await runWrite('veto', [ID], fx);
    expect(r.code).toBe(0);
    expect(r.out).toContain('result=blacklist_only');
    expect(w7.store.records.get(ID)?.lifecycle).toBe('rejected');
    expect([...w7.txns.keys()]).toEqual([]);
    expect(w7.revs).toEqual([]);
    expect(fx.sink.blacklist.has(`${ID}:${SHA}`)).toBe(true);
  });

  it('veto 仓库 deferred / invalid 时不得判 unknown_id:退 3(不是 2),零写入', async () => {
    for (const mode of ['deferred', 'invalid'] as const) {
      const w7 = world7({ record: canaryRec() });
      w7.store.mode = mode;
      const fx = makeFx(w7);
      const r = await runWrite('veto', [ID], fx);
      expect([r.code, r.err], mode).toEqual([3, 'RSI_FAIL_CLOSED reason=personal_repo_invalid\n']);
      expect(fx.locks.log).toEqual([]);
      expect(w7.revs).toEqual([]);
    }
  });

  it('veto 仓库可读而确认没有该 id:退 2 unknown_id(不回显 id),不取锁;形状不对的 id 同样是 unknown_id', async () => {
    const fx = makeFx(world7({ record: canaryRec() }));
    const a = await runWrite('veto', [ID2], fx);
    expect([a.code, a.err]).toEqual([2, 'RSI_USAGE reason=unknown_id\n']);
    const b = await runWrite('veto', ['nope'], fx);
    expect([b.code, b.err]).toEqual([2, 'RSI_USAGE reason=unknown_id\n']);
    expect(fx.locks.log).toEqual([]);
  });

  it('veto 持锁后重读记录再判:锁外读到的是 canary,持锁时已是终态 → 只写黑名单,不新开回滚', async () => {
    const w7 = world7({ record: canaryRec() });
    const fx = makeFx(w7);
    const stale = canaryRec();
    // 锁外读(peek)看到 canary;持锁后的 `store.read` 已是终态
    fx.peek.override = async () => ({ kind: 'ok', head: 'f'.repeat(40), record: stale });
    w7.store.readOverride.set(ID, rec('rolled_back'));
    const r = await runWrite('veto', [ID], fx);
    expect(r.code).toBe(0);
    expect(r.out).toContain('result=blacklist_only');
    expect([...w7.txns.keys()]).toEqual([]);
    expect(w7.revs).toEqual([]);
  });

  it('veto 参数 / 环境:非 TTY 退 2;[rsi] 关闭退 4 off;缺 id 退 2 unknown_arg;零写入', async () => {
    const fx = makeFx(world7({ record: canaryRec() }));
    const a = await runWrite('veto', [ID], fx, { tty: false });
    expect([a.code, a.err]).toEqual([2, 'RSI_USAGE reason=not_tty\n']);
    const c = await runWrite('veto', [], fx);
    expect([c.code, c.err]).toEqual([2, 'RSI_USAGE reason=unknown_arg\n']);
    fx.rsiOn.value = false;
    const b = await runWrite('veto', [ID], fx);
    expect([b.code, b.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(fx.locks.log).toEqual([]);
  });

  it('veto --lift 只调黑名单解除端口:记录与 journal 不动', async () => {
    const w7 = world7({ record: rec('rejected') });
    const fx = makeFx(w7);
    const r = await runWrite('veto', ['--lift', ID], fx);
    expect(r.code).toBe(0);
    expect(fx.lifts).toEqual([ID]);
    expect(w7.store.records.get(ID)?.lifecycle).toBe('rejected');
    expect([...w7.txns.keys()]).toEqual([]);
  });
});

describe('rsi rollback --to <日期> --write(R21-12.7 / W0-22 第 4 条)', () => {
  const two = () => {
    const w7 = world7({ record: null });
    w7.store.put(
      canaryRec({
        transitions: [entry(1), entry(2, 'canary', '2026-11-03T00:00:00Z')],
      }),
    );
    w7.store.put(
      canaryRec({
        id: ID2,
        content_sha256: SHA2,
        target_paths: ['rules/ra_bbbbbbbbbbbb.md'],
        transitions: [entry(1), entry(2, 'canary', '2026-11-05T00:00:00Z')],
      }),
    );
    return w7;
  };

  it('rollback --to:by=rollback_to、reason=cleared,按生效逆序(进入 canary 晚者在前),三把锁', async () => {
    const w7 = two();
    const fx = makeFx(w7);
    const r = await runWrite('rollback', ['--to', '2026-11-01', '--write'], fx);
    expect(r.code).toBe(0);
    expect(w7.revs.map((x) => [x.candidate_id, x.by, x.reason])).toEqual([
      [ID2, 'rollback_to', 'cleared'],
      [ID, 'rollback_to', 'cleared'],
    ]);
    expect(fx.locks.log.filter((l) => l.startsWith('acquire'))).toEqual([
      'acquire:rsi',
      'acquire:personal',
      'acquire:sync',
    ]);
  });

  it('rollback --to 日期严格大于:进入日等于 D 的不纳入', async () => {
    const w7 = two();
    const fx = makeFx(w7);
    const r = await runWrite('rollback', ['--to', '2026-11-03', '--write'], fx);
    expect(r.code).toBe(0);
    expect(w7.revs.map((x) => x.candidate_id)).toEqual([ID2]);
  });

  it('rollback --to 日期不可知的候选单列纳入并展示(计数分开),排在日期可知者之后', async () => {
    const w7 = two();
    w7.store.put(
      canaryRec({
        id: 'ra_cccccccccccc',
        content_sha256: 'c'.repeat(64),
        target_paths: ['rules/ra_cccccccccccc.md'],
        transitions: [entry(1)],
        transitions_dropped: 3,
      }),
    );
    const fx = makeFx(w7);
    const r = await runWrite('rollback', ['--to', '2026-11-01', '--write'], fx);
    expect(r.out).toContain('日期不可知,按保守方向纳入: 1');
    expect(w7.revs.map((x) => x.candidate_id)).toEqual([ID2, ID, 'ra_cccccccccccc']);
  });

  it('rollback --to:[rsi] 关闭退 4 off 并提示改用 auto clear;坏日期退 2;非 TTY 退 2;零写入', async () => {
    const w7 = two();
    const fx = makeFx(w7);
    fx.rsiOn.value = false;
    const a = await runWrite('rollback', ['--to', '2026-11-01', '--write'], fx);
    expect([a.code, a.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(a.out).toContain('rsi auto clear');
    fx.rsiOn.value = true;
    const b = await runWrite('rollback', ['--to', '2026-13-45', '--write'], fx);
    expect([b.code, b.err]).toEqual([2, 'RSI_USAGE reason=bad_date\n']);
    const c = await runWrite('rollback', ['--to', '2026-11-01', '--write'], fx, { tty: false });
    expect([c.code, c.err]).toEqual([2, 'RSI_USAGE reason=not_tty\n']);
    expect(w7.revs).toEqual([]);
  });

  it('rollback --to 记录自相矛盾(无进入 canary 记录且没有丢弃转移):在任何写入之前退 3 candidate_invalid', async () => {
    const w7 = two();
    w7.store.put(
      canaryRec({
        id: 'ra_dddddddddddd',
        content_sha256: 'd'.repeat(64),
        target_paths: ['rules/ra_dddddddddddd.md'],
        transitions: [entry(1)],
      }),
    );
    const fx = makeFx(w7);
    const r = await runWrite('rollback', ['--to', '2026-11-01', '--write'], fx);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=candidate_invalid\n']);
    expect(w7.revs).toEqual([]);
  });
});

describe('rsi auto rebase-baseline(R21-12.5):只在分叉 / 换主可用,确认后才改写', () => {
  it('分叉:展示带标签的相对路径清单,输入 yes 才改写 head.json,并清 diverged 标志;三把锁', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: [], diverged: true, owner_changed: false };
    const r = await runWrite('auto', ['rebase-baseline'], fx, { input: ['yes'] });
    expect(r.code).toBe(0);
    expect(r.out).toContain(RSI_AUTO_LABEL);
    expect(r.out).toContain('  rules/new-1.md');
    expect(fx.rebase.headWrites).toEqual([['baseline', 'a'.repeat(40)]]);
    expect(fx.pause.state.diverged).toBe(false);
    expect(fx.locks.log.filter((l) => l.startsWith('acquire')).length).toBe(3);
  });

  it('拒绝(非 yes / EOF)退 1 RSI_CONFIRM_DECLINED,零写入、不取锁', async () => {
    for (const input of [['no'], ['yes '], [undefined]]) {
      const fx = makeFx();
      const r = await runWrite('auto', ['rebase-baseline'], fx, { input });
      expect([r.code, r.err], String(input)).toEqual([1, 'RSI_CONFIRM_DECLINED\n']);
      expect(fx.rebase.headWrites).toEqual([]);
      expect(fx.locks.log).toEqual([]);
    }
  });

  it('非分叉 / 非换主情形退 4 not_diverged(不提示、不取锁、不写);换主必须 --adopt-owner,分叉不接受 --adopt-owner', async () => {
    const fx = makeFx();
    fx.rebase.situation = { kind: 'ok' };
    const a = await runWrite('auto', ['rebase-baseline'], fx, { input: ['yes'] });
    expect([a.code, a.err]).toEqual([4, 'RSI_NOT_RUN reason=not_diverged\n']);
    fx.rebase.situation = { kind: 'owner_changed', head: 'a'.repeat(40) };
    const b = await runWrite('auto', ['rebase-baseline'], fx, { input: ['yes'] });
    expect(b.code).toBe(4);
    fx.rebase.situation = { kind: 'diverged', head: 'a'.repeat(40) };
    const c = await runWrite('auto', ['rebase-baseline', '--adopt-owner'], fx, { input: ['yes'] });
    expect(c.code).toBe(4);
    expect(fx.rebase.headWrites).toEqual([]);
    expect(fx.locks.log).toEqual([]);
  });

  it('换主 + --adopt-owner:改写 owner_repo_fp(kind=owner),清 owner_changed', async () => {
    const fx = makeFx();
    fx.rebase.situation = { kind: 'owner_changed', head: 'a'.repeat(40) };
    fx.pause.state = { reasons: [], diverged: false, owner_changed: true };
    const r = await runWrite('auto', ['rebase-baseline', '--adopt-owner'], fx, { input: ['yes'] });
    expect(r.code).toBe(0);
    expect(fx.rebase.headWrites).toEqual([['owner', 'a'.repeat(40)]]);
    expect(fx.pause.state.owner_changed).toBe(false);
  });

  it('持锁后重判:确认之后 HEAD 变了 → RSI_CONFIRM_STALE(退 1)零写入;不再分叉 → 退 4 not_diverged', async () => {
    const fx = makeFx();
    fx.rebase.classifyHook = (n) => {
      if (n === 2) fx.rebase.situation = { kind: 'diverged', head: 'c'.repeat(40) };
    };
    const a = await runWrite('auto', ['rebase-baseline'], fx, { input: ['yes'] });
    expect([a.code, a.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    const fx2 = makeFx();
    fx2.rebase.classifyHook = (n) => {
      if (n === 2) fx2.rebase.situation = { kind: 'ok' };
    };
    const b = await runWrite('auto', ['rebase-baseline'], fx2, { input: ['yes'] });
    expect([b.code, b.err]).toEqual([4, 'RSI_NOT_RUN reason=not_diverged\n']);
    expect(fx.rebase.headWrites).toEqual([]);
    expect(fx2.rebase.headWrites).toEqual([]);
  });

  it('路径清单过清洗:控制字符被替换,不能伪造行', async () => {
    const fx = makeFx();
    fx.rebase.paths = ['rules/a\nRSI_FAKE.md'];
    const r = await runWrite('auto', ['rebase-baseline'], fx, { input: ['no'] });
    expect(r.out).not.toContain('a\nRSI_FAKE');
    expect(r.out).toContain('rules/a?RSI_FAKE.md');
  });

  it('非 TTY 退 2;未知参数退 2', async () => {
    const fx = makeFx();
    const a = await runWrite('auto', ['rebase-baseline'], fx, { tty: false });
    expect([a.code, a.err]).toEqual([2, 'RSI_USAGE reason=not_tty\n']);
    const b = await runWrite('auto', ['rebase-baseline', '--x'], fx);
    expect([b.code, b.err]).toEqual([2, 'RSI_USAGE reason=unknown_arg\n']);
  });
});

describe('未接线预检:缺任一必需端口 → 退 3 internal,任何写入之前(零写入,pause 除外)', () => {
  const cases: [
    string,
    'auto' | 'veto' | 'rollback',
    string[],
    (keyof import('../../../src/rsi/auto/write/ports.js').WritePorts)[],
  ][] = [
    [
      'resume',
      'auto',
      ['resume'],
      ['locks', 'userMarker', 'breaker', 'pauseState', 'holds', 'marks'],
    ],
    ['clear --write', 'auto', ['clear', '--write'], ['locks', 'clearDeps']],
    ['rebase-baseline', 'auto', ['rebase-baseline'], ['locks', 'rebase', 'pauseState']],
    ['veto', 'veto', [ID], ['locks', 'rollbackDeps', 'peekRecord']],
    [
      'rollback --to --write',
      'rollback',
      ['--to', '2026-11-01', '--write'],
      ['locks', 'rollbackDeps'],
    ],
  ];
  for (const [name, family, argv, needs] of cases) {
    for (const miss of needs) {
      it(`${name}:缺 ${miss} → 退 3 internal;没有取锁、没有任何写入`, async () => {
        const w7 = world7({ record: canaryRec() });
        const fx = makeFx(w7);
        fx.rebase.situation = { kind: 'diverged', head: 'a'.repeat(40) };
        const ports = { ...fx.ports };
        delete ports[miss];
        const r = await runWrite(family, argv, fx, { ports, input: ['yes'] });
        expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=internal\n']);
        expect(fx.locks.log).toEqual([]);
        expect(fx.pause.writes).toEqual([]);
        expect(fx.rebase.headWrites).toEqual([]);
        expect(w7.revs).toEqual([]);
        expect([...w7.txns.keys()]).toEqual([]);
        expect(fx.user.creates + fx.user.removes + fx.marks.gen).toBe(0);
      });
    }
  }

  it('全部未接线(只有 userMarker 与 config):除 pause 外每个写命令退 3 零写入;pause 恰好写 U 一个文件', async () => {
    const w7 = world7({ record: canaryRec() });
    const fx = makeFx(w7);
    const ports = { config: fx.ports.config, userMarker: fx.ports.userMarker, outputForbidden: [] };
    const argvs: ['auto' | 'veto' | 'rollback', string[]][] = [
      ['auto', ['resume']],
      ['auto', ['clear', '--write']],
      ['auto', ['rebase-baseline']],
      ['veto', [ID]],
      ['rollback', ['--to', '2026-11-01', '--write']],
    ];
    for (const [family, argv] of argvs) {
      const r = await runWrite(family, argv, fx, { ports, input: ['yes'] });
      expect([r.code, r.err], argv.join(' ')).toEqual([3, 'RSI_FAIL_CLOSED reason=internal\n']);
    }
    expect(fx.user.creates).toBe(0);
    const p = await runWrite('auto', ['pause'], fx, { ports });
    expect(p.code).toBe(0);
    expect(fx.user.creates).toBe(1);
    expect(fx.locks.log).toEqual([]);
    expect(w7.revs).toEqual([]);
  });

  it('参数 / TTY 校验先于端口装配:坏参数、非 TTY 不会构造端口', async () => {
    const fx = makeFx();
    const a = await runWrite('auto', ['resume', '--x'], fx);
    const b = await runWrite('auto', ['resume'], fx, { tty: false });
    const c = await runWrite('veto', [], fx);
    expect([a.built, b.built, c.built]).toEqual([0, 0, 0]);
  });
});
