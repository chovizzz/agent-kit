/**
 * C1a:类型层证明(由 `tsc` 检查——`pnpm run typecheck` 覆盖 `test/**`;vitest 本身不做类型检查,所以每条类型断言都配一个运行期断言)。
 *
 * 核心证明:**rsi-only 的轮次造不出 `BothRound`,从而造不出 `GrowthPass`**——
 *  ① `BothRound` 与 `RsiOnlyRound` 互不可赋值(私有 unique-symbol 品牌 + `personalNonce`);
 *  ② 试锁结果是判别联合:`busy` / `fault` 分支没有个人锁句柄;`openRound` 的 `rsi_only` 变体没有 `personal`;`PersonalRound.growth` 的 `denied` 变体没有 `round`;
 *  ③ `evaluateGrowth(round: BothRound, …)` 是 `GrowthPass` 的唯一铸造点,`GrowthPass` 外部不可构造(品牌),强转造出的对象在运行期过不了登记表(`c1-growth.test.ts`)。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RsiLockHandle } from '../../../src/rsi/lock.js';
import type { PersonalLockHandle } from '../../../src/rsi/personal/personal-lock.js';
import type { JudgeGrowthVerdict } from '../../../src/rsi/personal/judge-slot.js';
import { createRoundBudget } from '../../../src/rsi/personal/stage/settle.js';
import {
  evaluateGrowth,
  requireGrowth,
  type GrowthOp,
  type GrowthPass,
  type GrowthReq,
  type GrowthVerdict,
} from '../../../src/rsi/personal/stage/growth.js';
import {
  wrapPersonalLock,
  type HeldPersonal,
  type HeldRsi,
  type PersonalAttempt,
} from '../../../src/rsi/personal/stage/lock-identity.js';
import type { FallbackPorts, SafetyPort } from '../../../src/rsi/personal/stage/ports.js';
import {
  openRound,
  type BothRound,
  type RoundOpen,
  type RsiOnlyRound,
} from '../../../src/rsi/personal/stage/round.js';
import type {
  GrowthAccess,
  RsiOnlyTripReason,
  UnsettledReason,
  WriteKind,
} from '../../../src/rsi/personal/stage/types.js';
import { readers, openBusy, openBoth } from './c1-fixture.js';

type Assignable<A, B> = [A] extends [B] ? true : false;

describe('rsi-only 轮次造不出 GrowthPass(类型证明)', () => {
  it('① BothRound 与 RsiOnlyRound 互不可赋值', async () => {
    expectTypeOf<Assignable<RsiOnlyRound, BothRound>>().toEqualTypeOf<false>();
    expectTypeOf<Assignable<BothRound, RsiOnlyRound>>().toEqualTypeOf<false>();
    expectTypeOf<Assignable<BothRound, BothRound>>().toEqualTypeOf<true>(); // 正向对照
    const proofs = (busy: RsiOnlyRound): void => {
      // @ts-expect-error RsiOnlyRound 不是 BothRound
      const bad: BothRound = busy;
      void bad;
      // @ts-expect-error evaluateGrowth 不接受 rsi-only 回合
      void evaluateGrowth(busy, { op: 'bootstrap' }, readers(), undefined);
    };
    expect(typeof proofs).toBe('function');
    // 运行期第二道:强转绕过类型也会被拒(回合内部记录了自己的形态)
    const b = await openBusy();
    await expect(
      evaluateGrowth(b.round as unknown as BothRound, { op: 'bootstrap' }, readers(), undefined),
    ).rejects.toThrow(/round_not_both/);
  });

  it('② 试锁结果 / RoundOpen / GrowthAccess 的 busy 与 denied 变体没有句柄、没有 round', async () => {
    type Busy = Extract<PersonalAttempt, { kind: 'busy' }>;
    type Fault = Extract<PersonalAttempt, { kind: 'fault' }>;
    type Held = Extract<PersonalAttempt, { kind: 'held' }>;
    expectTypeOf<'personal' extends keyof Busy ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'personal' extends keyof Fault ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'personal' extends keyof Held ? true : false>().toEqualTypeOf<true>(); // 正向对照
    type RsiOnlyOpen = Extract<RoundOpen, { kind: 'rsi_only' }>;
    expectTypeOf<'personal' extends keyof RsiOnlyOpen ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<RsiOnlyOpen['round']>().toEqualTypeOf<RsiOnlyRound>();
    type BothOpen = Extract<RoundOpen, { kind: 'both' }>;
    expectTypeOf<BothOpen['round']>().toEqualTypeOf<BothRound>();
    type Denied = Extract<GrowthAccess, { kind: 'denied' }>;
    type Open = Extract<GrowthAccess, { kind: 'open' }>;
    expectTypeOf<'round' extends keyof Denied ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<Open['round']>().toEqualTypeOf<BothRound>();
    const proofs = (a: PersonalAttempt, acc: GrowthAccess): void => {
      if (a.kind === 'busy') {
        // @ts-expect-error busy 分支没有个人锁句柄
        void a.personal;
      }
      if (acc.kind === 'denied') {
        // @ts-expect-error denied 分支没有 round
        void acc.round;
      }
    };
    expect(typeof proofs).toBe('function');
    // 运行期:忙时 round 里没有个人 nonce
    const b = await openBusy();
    expect('personalNonce' in b.round).toBe(false);
  });

  it('③ GrowthPass 外部不可构造;GrowthVerdict 的拒绝变体不是 pass', () => {
    const proofs = (): void => {
      // @ts-expect-error 缺品牌:对象字面量不是 GrowthPass
      const forged: GrowthPass = {
        rsiNonce: 'a',
        personalNonce: 'b',
        gen: 0,
        op: { cap: 'bootstrap' },
      };
      void forged;
    };
    expect(typeof proofs).toBe('function');
    expectTypeOf<Assignable<{ ok: false; code: 'phase' }, GrowthPass>>().toEqualTypeOf<false>();
    expectTypeOf<Assignable<GrowthPass, GrowthVerdict>>().toEqualTypeOf<true>();
  });

  it('④ openRound 不接受字面量的试锁结果(品牌);requireGrowth 不接受 rsi-only 回合', async () => {
    const w = await openBoth();
    const proofs = (rsi: HeldRsi, busy: RsiOnlyRound, p: GrowthPass): void => {
      // @ts-expect-error 试锁结果只能由 attemptPersonal 产生
      void openRound(rsi, { kind: 'busy' });
      // @ts-expect-error rsi-only 回合不能消费 pass
      requireGrowth(p, busy, { cap: 'bootstrap' });
    };
    expect(typeof proofs).toBe('function');
    expect(w.round.personalNonce).toBe('bbbb2222bbbb2222');
  });
});

describe('候选类 op 强制带候选(省略 = 类型错误)', () => {
  it('GrowthReq / GrowthOp', () => {
    const proofs = (): void => {
      // @ts-expect-error 候选类 op 必须带 cand
      const r1: GrowthReq = { op: 'grant' };
      // @ts-expect-error 同上(shadow_to_canary)
      const r2: GrowthReq = { op: 'shadow_to_canary' };
      // @ts-expect-error 同上(deploy_inject)
      const r3: GrowthReq = { op: 'deploy_inject' };
      // @ts-expect-error GrowthOp 候选类必须带候选
      const o1: GrowthOp = { cap: 'grant' };
      // @ts-expect-error 非候选类不得带候选
      const o2: GrowthOp = { cap: 'bootstrap', cand: { id: 'a', content_sha256: 'b' } };
      void [r1, r2, r3, o1, o2];
    };
    expect(typeof proofs).toBe('function');
    // 正向对照:这些形状合法
    const ok: GrowthReq[] = [
      { op: 'bootstrap' },
      { op: 'candidate_create' },
      { op: 'admission' },
      {
        op: 'grant',
        cand: { id: 'a', content_sha256: 'b', lifecycle: 'canary', source: null },
      },
    ];
    expect(ok.length).toBe(4);
    const ops: GrowthOp[] = [
      { cap: 'bootstrap' },
      { cap: 'grant', cand: { id: 'a', content_sha256: 'b' } },
    ];
    expect(ops.length).toBe(2);
  });
});

describe('其它类型钉子', () => {
  it('WriteKind / UnsettledReason 的取值受限', () => {
    const proofs = (r: BothRound): void => {
      // @ts-expect-error 同步实现不可包装(包装后一定是异步,类型必须如实)
      void r.writeAdapter('effects', () => 42);
      // @ts-expect-error 未知写种类
      void r.writeAdapter('nope', () => Promise.resolve());
      // @ts-expect-error 未决原因的模板受 WriteKind 约束
      const u: UnsettledReason = 'write_outcome_unknown:nope';
      void u;
    };
    expect(typeof proofs).toBe('function');
    const ok: UnsettledReason[] = [
      'write_outcome_unknown:trip',
      'safety_not_settled',
      'step_integrity:repo_invalid',
    ];
    expect(ok.length).toBe(3);
    expectTypeOf<WriteKind>().toEqualTypeOf<
      | 'state_pause_flag'
      | 'revocation'
      | 'rollback_transition'
      | 'trip'
      | 'safety_mute'
      | 'audit_append'
      | 'compaction'
      | 'effects'
      | 'candidate_record'
      | 'grant'
      | 'bootstrap'
      | 'admission'
    >();
  });

  it('持两锁的回合必须给 startRollbackLimit(类型必填);rsi-only 回合不需要', () => {
    const proofs = (both: BothRound, busy: RsiOnlyRound): void => {
      // @ts-expect-error 持两锁的回合缺 startRollbackLimit
      void createRoundBudget(both);
      void createRoundBudget(both, { startRollbackLimit: 3 }); // 正向对照
      void createRoundBudget(busy); // rsi-only 不需要
    };
    expect(typeof proofs).toBe('function');
  });

  it('rsi-only 的 tripAndMute 只收 RsiOnlyTripReason:个人侧码在类型上不可传入', () => {
    expectTypeOf<RsiOnlyTripReason>().toEqualTypeOf<
      'no_observation' | 'redaction_changed' | 'kit_major_changed'
    >();
    const proofs = (sp: SafetyPort): void => {
      void sp.tripAndMute(['no_observation', 'kit_major_changed']); // 正向对照:合法
      // @ts-expect-error 个人侧熔断码不可传入仅 rsi 锁的 tripAndMute
      void sp.tripAndMute(['rollback_storm']);
      // @ts-expect-error 第二个个人侧码同样不可传入
      void sp.tripAndMute(['personal_repo_invalid']);
    };
    expect(typeof proofs).toBe('function');
  });

  it('FallbackPorts 没有任何写 state / 清单的成员', () => {
    expectTypeOf<keyof FallbackPorts>().toEqualTypeOf<
      | 'readStateRaw'
      | 'markers'
      | 'muteCanary'
      | 'removeCanary'
      | 'ensureBreakerMarker'
      | 'assertHeld'
    >();
    expectTypeOf<FallbackPorts>().not.toHaveProperty('writeStateFile');
    expectTypeOf<FallbackPorts>().not.toHaveProperty('commitUnderLockWith');
    expectTypeOf<FallbackPorts>().not.toHaveProperty('recoverSnapshot');
  });

  it('JudgeGrowthVerdict 的拒绝码受限', () => {
    const proofs = (): void => {
      // @ts-expect-error 码不在三码之内
      const v: JudgeGrowthVerdict = { ok: false, code: 'nope' };
      void v;
    };
    expect(typeof proofs).toBe('function');
  });

  it('真实锁句柄可赋给适配点的结构类型(两边漂移就会变红);rsi 句柄不能冒充个人句柄', () => {
    expectTypeOf<Assignable<RsiLockHandle, HeldRsi>>().toEqualTypeOf<true>();
    expectTypeOf<
      Assignable<PersonalLockHandle, Parameters<typeof wrapPersonalLock>[0]>
    >().toEqualTypeOf<true>();
    expectTypeOf<Assignable<RsiLockHandle, HeldPersonal>>().toEqualTypeOf<false>();
    expectTypeOf<Assignable<PersonalLockHandle, HeldPersonal>>().toEqualTypeOf<false>(); // 必须经 wrapPersonalLock
    expect(true).toBe(true);
  });
});
