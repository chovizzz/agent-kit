/**
 * C1a:回合对象——试锁分类、`BothRound` 只由「个人锁试锁成功」构造、写适配器(单飞 + `finally` 推进 `gen`)、`safetyDirty` 与 `gen` 分开、判决 latch、`RoundBudget`。
 * 每条不变量带负向用例 + 正向对照。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError, type RsiLockErrorKind } from '../../../src/rsi/lock-error.js';
import {
  PersonalLockLost,
  DefinitelyNotWritten,
  RoundInternalError,
} from '../../../src/rsi/personal/stage/errors.js';
import {
  attemptPersonal,
  wrapPersonalLock,
} from '../../../src/rsi/personal/stage/lock-identity.js';
import {
  isWriteAdapted,
  judgeBlockedOf,
  markRoundUnsettled,
  openRound,
  recordJudgeBlocked,
} from '../../../src/rsi/personal/stage/round.js';
import {
  BUDGET_PORTS,
  ROUND_BUDGET_LIMITS,
  createRoundBudget,
} from '../../../src/rsi/personal/stage/settle.js';
import { DIRTY_KINDS, WRITE_KINDS } from '../../../src/rsi/personal/stage/types.js';
import { PERSONAL_NONCE, RSI_NONCE, asRaw, fakeLock, openBoth, openBusy } from './c1-fixture.js';

const never = (): Promise<never> => new Promise(() => undefined);

describe('attemptPersonal:试锁分类(锁忙只认 locked / locked_over_ttl)', () => {
  it('获取成功 = held,且句柄已包装(kind=personal、nonce 透出)', async () => {
    const raw = fakeLock(PERSONAL_NONCE);
    const a = await attemptPersonal(() => Promise.resolve(asRaw(raw)));
    expect(a.kind).toBe('held');
    if (a.kind !== 'held') return;
    expect(a.personal.kind).toBe('personal');
    expect(a.personal.nonce).toBe(PERSONAL_NONCE);
  });

  it.each(['locked', 'locked_over_ttl'] as const)('%s → busy(没有个人锁句柄)', async (kind) => {
    const a = await attemptPersonal(() => Promise.reject(new RsiLockError(kind)));
    expect(a.kind).toBe('busy');
    expect('personal' in a).toBe(false);
  });

  const FAULTS: RsiLockErrorKind[] = ['lock_lost', 'state_dir_unsafe', 'write_denied', 'internal'];
  it.each(FAULTS)(
    'RsiLockError(%s) → fault personal_lock_error:<同码>(不算跳过、不算忙)',
    async (kind) => {
      const a = await attemptPersonal(() => Promise.reject(new RsiLockError(kind)));
      expect(a.kind).toBe('fault');
      if (a.kind !== 'fault') return;
      expect(a.fault).toEqual({ code: `personal_lock_error:${kind}` });
    },
  );

  it('非 RsiLockError(普通 Error / 字符串)→ fault personal_lock_error:internal;永不抛', async () => {
    for (const thrown of [new Error('boom'), 'str', undefined]) {
      const a = await attemptPersonal(() => Promise.reject(thrown));
      expect(a.kind).toBe('fault');
      if (a.kind === 'fault') expect(a.fault.code).toBe('personal_lock_error:internal');
    }
    const sync = await attemptPersonal(() => {
      throw new Error('sync');
    });
    expect(sync.kind).toBe('fault');
  });
});

describe('wrapPersonalLock:个人锁丢失转型为 PersonalLockLost(不是 RsiLockError)', () => {
  it('assertHeld 抛 lock_lost → PersonalLockLost,且不是 RsiLockError', async () => {
    const raw = fakeLock(PERSONAL_NONCE);
    const w = wrapPersonalLock(asRaw(raw));
    await expect(w.assertHeld()).resolves.toBeUndefined(); // 正向对照
    raw.held = false;
    const err = await w.assertHeld().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonalLockLost);
    expect(err).not.toBeInstanceOf(RsiLockError);
  });

  it('其它错误原样透传;release 透传', async () => {
    const e = new RsiLockError('write_denied');
    const w = wrapPersonalLock({
      nonce: 'n',
      assertHeld: () => Promise.reject(e),
      release: () => Promise.resolve(),
    });
    await expect(w.assertHeld()).rejects.toBe(e);
    const raw = fakeLock(PERSONAL_NONCE);
    await wrapPersonalLock(asRaw(raw)).release();
    expect(raw.releases).toBe(1);
  });
});

describe('openRound:BothRound 只能由「个人锁试锁成功」构造', () => {
  it('held → both:带两把 nonce;round 冻结;id 取自 newId', async () => {
    const w = await openBoth({}, () => 'rid-1');
    expect(w.round.rsiNonce).toBe(RSI_NONCE);
    expect(w.round.personalNonce).toBe(PERSONAL_NONCE);
    expect(w.round.id).toBe('rid-1');
    expect(Object.isFrozen(w.round)).toBe(true);
    expect(w.round.gen()).toBe(0);
    expect(w.round.unsettled()).toEqual([]);
    expect(w.round.safetyDirty.isDirty()).toBe(false);
  });

  it('busy / fault → rsi_only:没有 personalNonce、没有个人锁句柄;deny 码 personal_busy / personal_fault', async () => {
    const b = await openBusy();
    expect(b.open.kind).toBe('rsi_only');
    if (b.open.kind !== 'rsi_only') return;
    expect(b.open.deny).toBe('personal_busy');
    expect(b.open.fault).toBeNull();
    expect('personalNonce' in b.round).toBe(false);
    expect('personal' in b.open).toBe(false);
    const rsi = fakeLock(RSI_NONCE);
    const f = openRound(
      rsi,
      await attemptPersonal(() => Promise.reject(new RsiLockError('state_dir_unsafe'))),
    );
    expect(f.kind).toBe('rsi_only');
    if (f.kind !== 'rsi_only') return;
    expect(f.deny).toBe('personal_fault');
    expect(f.fault).toEqual({ code: 'personal_lock_error:state_dir_unsafe' });
  });

  it('伪造的试锁结果(没经 attemptPersonal)→ RoundInternalError attempt_not_produced', async () => {
    const w = await openBoth();
    const forged = { kind: 'held', personal: w.personal } as unknown as Parameters<
      typeof openRound
    >[1];
    expect(() => openRound(fakeLock(RSI_NONCE), forged)).toThrow(RoundInternalError);
    expect(() => openRound(fakeLock(RSI_NONCE), forged)).toThrow(/attempt_not_produced/);
  });

  it('两把锁 nonce 相同(同一句柄当两把锁)/ nonce 空 → 拒绝', async () => {
    await expect(openBoth({ rsi: 'same', personal: 'same' })).rejects.toThrow(/same_nonce/);
    const attempt = await attemptPersonal(() => Promise.resolve(asRaw(fakeLock(''))));
    expect(() => openRound(fakeLock(RSI_NONCE), attempt)).toThrow(/personal_nonce_invalid/);
    const ok = await attemptPersonal(() => Promise.resolve(asRaw(fakeLock(PERSONAL_NONCE))));
    expect(() => openRound(fakeLock(''), ok)).toThrow(/rsi_nonce_invalid/);
  });
});

describe('写适配器:单飞 + finally 无条件推进 gen', () => {
  it('成功写 → gen+1;返回值与 this 透传;包装函数带标记', async () => {
    const { round } = await openBoth();
    const obj = {
      v: 41,
      async write(n: number): Promise<number> {
        await Promise.resolve();
        return this.v + n;
      },
    };
    obj.write = round.writeAdapter('audit_append', obj.write);
    expect(isWriteAdapted(obj.write)).toBe(true);
    expect(isWriteAdapted(() => 1)).toBe(false);
    expect(await obj.write(1)).toBe(42);
    expect(round.gen()).toBe(1);
  });

  it('write_then_throw_bumps_gen_and_unsettles:写成功后抛错也推进 gen,且本轮未决', async () => {
    const { round } = await openBoth();
    const w = round.writeAdapter('state_pause_flag', async () => {
      await Promise.resolve();
      throw new Error('after write');
    });
    await expect(w()).rejects.toThrow('after write');
    expect(round.gen()).toBe(1);
    expect(round.unsettled()).toEqual(['write_outcome_unknown:state_pause_flag']);
  });

  it('prevalidation_failure_not_unsettled:DefinitelyNotWritten 不使本轮未决(但仍保守推进 gen)', async () => {
    const { round } = await openBoth();
    const w = round.writeAdapter('revocation', () =>
      Promise.reject(new DefinitelyNotWritten('source_problem')),
    );
    await expect(w()).rejects.toBeInstanceOf(DefinitelyNotWritten);
    expect(round.unsettled()).toEqual([]);
    expect(round.gen()).toBe(1);
  });

  it('默认一律「不确定」:同步抛错 / 抛非 Error 也未决', async () => {
    const { round } = await openBoth();
    const w1 = round.writeAdapter('effects', (): Promise<void> => {
      throw new Error('sync');
    });
    await expect(w1()).rejects.toThrow('sync');
    const w2 = round.writeAdapter('compaction', () => Promise.reject('plain string'));
    await expect(w2()).rejects.toBe('plain string');
    expect(round.unsettled()).toEqual([
      'write_outcome_unknown:effects',
      'write_outcome_unknown:compaction',
    ]);
    expect(round.gen()).toBe(2);
  });

  it('授权写内看到的 gen 仍是本写之前的值(推进在 finally)', async () => {
    const { round } = await openBoth();
    let seen = -1;
    const w = round.writeAdapter('grant', async () => {
      seen = round.gen();
      await Promise.resolve();
    });
    await w();
    expect(seen).toBe(0);
    expect(round.gen()).toBe(1);
  });

  it('concurrent_write_port_use_is_internal_error:并发使用第二个写 → RoundInternalError,第一个照常完成', async () => {
    const { round } = await openBoth();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = round.writeAdapter('audit_append', () => gate);
    const other = round.writeAdapter('effects', () => Promise.resolve());
    const first = slow();
    await expect(other()).rejects.toThrow(/write_in_flight:effects/);
    expect(round.gen()).toBe(0); // 被拒的写没有推进
    release();
    await first;
    expect(round.gen()).toBe(1);
    await other(); // 正向对照:空闲后可用
    expect(round.gen()).toBe(2);
  });

  it('nested_adapter_is_internal_error:嵌套包装 → 内层被拒,外层按「写结果不确定」未决并推进 gen', async () => {
    const { round } = await openBoth();
    const inner = round.writeAdapter('effects', () => Promise.resolve());
    const outer = round.writeAdapter('state_pause_flag', async () => {
      await inner();
    });
    await expect(outer()).rejects.toThrow(/write_in_flight:effects/);
    expect(round.gen()).toBe(1);
    expect(round.unsettled()).toEqual(['write_outcome_unknown:state_pause_flag']);
    await expect(inner()).resolves.toBeUndefined(); // inFlight 已被外层 finally 复位
  });

  it('未知 kind / 非函数 impl → RoundInternalError(JS 调用方)', async () => {
    const { round } = await openBoth();
    expect(() => round.writeAdapter('nope' as never, () => Promise.resolve())).toThrow(
      /unknown_write_kind:nope/,
    );
    expect(() => round.writeAdapter('trip', 42 as never)).toThrow(/write_impl_not_function/);
  });
});

describe('safetyDirty 与 gen 分开', () => {
  it.each([...DIRTY_KINDS])('%s 写 → 置脏', async (kind) => {
    const { round } = await openBoth();
    await round.writeAdapter(kind, () => Promise.resolve())();
    expect(round.safetyDirty.isDirty()).toBe(true);
    expect(round.safetyDirty.kinds()).toEqual([kind]);
  });

  it.each(WRITE_KINDS.filter((k) => !(DIRTY_KINDS as readonly string[]).includes(k)))(
    '%s 写 → 不置脏(只推进 gen;审计补行 / 压缩 / effects 不触发扫尾)',
    async (kind) => {
      const { round } = await openBoth();
      await round.writeAdapter(kind, () => Promise.resolve())();
      expect(round.safetyDirty.isDirty()).toBe(false);
      expect(round.gen()).toBe(1);
    },
  );

  it('置脏标记在写失败时也置(写结果不确定,宁可多扫)', async () => {
    const { round } = await openBoth();
    await round
      .writeAdapter('trip', () => Promise.reject(new Error('x')))()
      .catch(() => undefined);
    expect(round.safetyDirty.isDirty()).toBe(true);
  });

  it('DIRTY_KINDS 是 WRITE_KINDS 的子集,且恰为四类', () => {
    expect([...DIRTY_KINDS]).toEqual([
      'state_pause_flag',
      'revocation',
      'rollback_transition',
      'trip',
    ]);
    for (const k of DIRTY_KINDS) expect(WRITE_KINDS).toContain(k);
  });
});

describe('判决 latch:单调只加严', () => {
  it('同一 id 已有码时保持原码(不被后来的码覆盖);其它 id 不受影响', async () => {
    const { round } = await openBoth();
    expect(judgeBlockedOf(round, 'a')).toBeNull();
    recordJudgeBlocked(round, [{ id: 'a', code: 'judge_signal_pending' }]);
    recordJudgeBlocked(round, [
      { id: 'a', code: 'judge_unavailable' },
      { id: 'b', code: 'judge_indeterminate' },
    ]);
    expect(judgeBlockedOf(round, 'a')).toBe('judge_signal_pending');
    expect(judgeBlockedOf(round, 'b')).toBe('judge_indeterminate');
    expect(judgeBlockedOf(round, 'c')).toBeNull();
  });
});

describe('RoundBudget:每轮端口调用上限', () => {
  it('持两锁的回合没给 startRollbackLimit(或非正整数)→ 拒绝构造(fail-closed,无缺省值)', async () => {
    const { round } = await openBoth();
    const loose = createRoundBudget as unknown as (r: unknown, o?: unknown) => unknown;
    expect(() => loose(round)).toThrow(/start_rollback_limit_required/);
    for (const n of [0, -1, 1.5, Number.NaN]) {
      expect(() => createRoundBudget(round, { startRollbackLimit: n })).toThrow(
        /start_rollback_limit_required/,
      );
    }
    expect(createRoundBudget(round, { startRollbackLimit: 4 }).limit('startRollback')).toBe(4); // 正向对照
  });

  it('上限表:持两锁 / 忙(逐项钉死具体取值)', async () => {
    const both = createRoundBudget((await openBoth()).round, { startRollbackLimit: 7 });
    expect(Object.fromEntries(BUDGET_PORTS.map((p) => [p, both.limit(p)]))).toEqual({
      enforceMute: 2,
      setFlagAndMute: 1,
      tripAndMute: 1,
      reconcileCaches: 2,
      applyAutoRelease: 1,
      evaluateTriggers: 1,
      startRollback: 7,
    });
    const busy = createRoundBudget((await openBusy()).round);
    expect(Object.fromEntries(BUDGET_PORTS.map((p) => [p, busy.limit(p)]))).toEqual({
      enforceMute: 2,
      setFlagAndMute: 0,
      tripAndMute: 1,
      reconcileCaches: 2,
      applyAutoRelease: 0,
      evaluateTriggers: 1,
      startRollback: 0,
    });
    expect(ROUND_BUDGET_LIMITS.rsi_only.applyAutoRelease).toBe(0);
  });

  it('port_call_budget_exceeded_is_fault:恰好用满不报错;再来一次 → RoundInternalError + 本轮未决', async () => {
    const { round } = await openBoth();
    const b = createRoundBudget(round, { startRollbackLimit: 2 });
    b.charge('enforceMute');
    b.charge('enforceMute'); // 用满(正向对照)
    expect(b.used('enforceMute')).toBe(2);
    expect(round.unsettled()).toEqual([]);
    expect(() => b.charge('enforceMute')).toThrow(RoundInternalError);
    expect(round.unsettled()).toEqual(['budget_exceeded:enforceMute']);
    b.charge('startRollback');
    b.charge('startRollback');
    expect(() => b.charge('startRollback')).toThrow(/budget_exceeded:startRollback/);
  });

  it('busy_round_has_no_release:忙 / 故障轮的 applyAutoRelease 与 setFlagAndMute 第一次就超限', async () => {
    const { round } = await openBusy();
    const b = createRoundBudget(round);
    expect(() => b.charge('applyAutoRelease')).toThrow(/budget_exceeded:applyAutoRelease/);
    expect(() => b.charge('setFlagAndMute')).toThrow(/budget_exceeded:setFlagAndMute/);
    expect(() => b.charge('startRollback')).toThrow(/budget_exceeded:startRollback/);
    b.charge('tripAndMute'); // 忙轮允许一次 T_rsi 的 tripAndMute
    expect(() => b.charge('tripAndMute')).toThrow(/budget_exceeded:tripAndMute/);
    expect(round.unsettled().length).toBe(4);
  });

  it('未知端口名 → RoundInternalError', async () => {
    const { round } = await openBoth();
    const b = createRoundBudget(round, { startRollbackLimit: 1 });
    expect(() => b.charge('nope' as never)).toThrow(/unknown_budget_port:nope/);
  });
});

describe('markRoundUnsettled', () => {
  it('去重;只对本模块开的回合有效', async () => {
    const { round } = await openBoth();
    markRoundUnsettled(round, 'compaction_failed');
    markRoundUnsettled(round, 'compaction_failed');
    expect(round.unsettled()).toEqual(['compaction_failed']);
    expect(() => markRoundUnsettled({} as unknown as typeof round, 'compaction_failed')).toThrow(
      /round_not_opened_here/,
    );
  });

  it('悬挂的写永不完成时,其它回合不受影响(回合状态互相独立)', async () => {
    const a = await openBoth();
    const b = await openBoth({ rsi: 'cccc3333cccc3333', personal: 'dddd4444dddd4444' });
    void a.round.writeAdapter('effects', never)();
    await b.round.writeAdapter('effects', () => Promise.resolve())();
    expect(b.round.gen()).toBe(1);
    expect(a.round.gen()).toBe(0);
  });
});
