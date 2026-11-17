/**
 * C1b:`createPersonalStage`(纯编排 + 假端口工厂)。
 * 覆盖:S0 → 试锁 → 回合 的状态机(持有 / 忙 / 故障 / update_busy / 失锁)、S0 非净 → 本轮未决 → `evaluateGrowth` 拒绝、个人锁在任何抛点都释放、
 * 返回前显式复核两把锁、`eligible` 抛错 = 假、`safetyFallback` 永不抛。期望值手写。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import type { PersonalLockHandle } from '../../../src/rsi/personal/personal-lock.js';
import { evaluateGrowth } from '../../../src/rsi/personal/stage/growth.js';
import type { S0Ports, S0StateKind } from '../../../src/rsi/personal/stage/ladder.js';
import { createPersonalStage } from '../../../src/rsi/personal/stage/personal-stage.js';
import type { FallbackPorts } from '../../../src/rsi/personal/stage/ports.js';
import type { FallbackCtx, PersonalCtx } from '../../../src/rsi/personal/stage/types.js';
import { PERSONAL_NONCE, RSI_NONCE, asRaw, fakeLock, readers } from './c1-fixture.js';

const lost = (): Error => new RsiLockError('lock_lost');
const eio = (): Error => Object.assign(new Error('eio'), { code: 'EIO' });

function ctxOf(over: Partial<PersonalCtx> & { rsiLock?: ReturnType<typeof fakeLock> } = {}): {
  ctx: PersonalCtx;
  rsi: ReturnType<typeof fakeLock>;
} {
  const rsi = over.rsiLock ?? fakeLock(RSI_NONCE);
  const ctx = {
    sctx: {} as PersonalCtx['sctx'],
    lock: rsi,
    obs: {} as PersonalCtx['obs'],
    now: () => new Date(0),
    nowMs: () => 0,
    updateBusy: over.updateBusy ?? false,
  } as PersonalCtx;
  return { ctx, rsi };
}

interface Sc {
  enforce?: () => Promise<boolean>;
  kind?: () => Promise<S0StateKind>;
  acquire?: () => Promise<PersonalLockHandle>;
  l0?: () => Promise<boolean>;
  eligible?: () => boolean;
  mute?: () => Promise<boolean>;
}
function mk(sc: Sc = {}): {
  stage: ReturnType<typeof createPersonalStage>;
  log: string[];
  personal: ReturnType<typeof fakeLock>;
} {
  const log: string[] = [];
  const personal = fakeLock(PERSONAL_NONCE);
  const stage = createPersonalStage({
    eligible: sc.eligible ?? ((): boolean => true),
    s0Ports: (): S0Ports => ({
      enforceFull: () => {
        log.push('enforce');
        return (sc.enforce ?? (() => Promise.resolve(false)))();
      },
      stateKind: () => (sc.kind ?? (() => Promise.resolve('valid' as const)))(),
      muteCanary: () => {
        log.push('mute');
        return (sc.mute ?? (() => Promise.resolve(true)))();
      },
      removeCanary: () => {
        log.push('remove');
        return Promise.resolve(true);
      },
      ensureBreakerMarker: () => {
        log.push('marker');
        return Promise.resolve('created' as const);
      },
      assertHeld: () => Promise.resolve(),
    }),
    fallbackPorts: (): FallbackPorts => {
      throw new Error('not used here');
    },
    acquirePersonal: () => sc.acquire ?? (() => Promise.resolve(asRaw(personal))),
    l0DueNow: sc.l0 ?? ((): Promise<boolean> => Promise.resolve(true)),
  });
  return { stage, log, personal };
}

describe('run:状态机', () => {
  it('持有:S0 一次 → 回合 open;个人锁在返回前释放恰好一次;flags / 事实字段是「未计算」的空值', async () => {
    const { stage, log, personal } = mk();
    const { ctx } = ctxOf();
    const r = await stage.run(ctx);
    expect(log).toEqual(['enforce']);
    expect(r.growth.kind).toBe('open');
    expect(r.faults).toEqual([]);
    expect(r.unsettled).toEqual([]);
    expect(r.l0DueNow).toBe(true);
    expect(r.flags).toEqual({ diverged: false, owner_changed: false });
    expect(r.rollback_stalled).toEqual([]);
    expect(r.protection_marks).toEqual([]);
    expect(personal.releases).toBe(1);
  });

  it('忙(locked / locked_over_ttl):S0 照跑,growth = denied personal_busy,没有 round', async () => {
    for (const kind of ['locked', 'locked_over_ttl'] as const) {
      const { stage, log } = mk({ acquire: () => Promise.reject(new RsiLockError(kind)) });
      const r = await stage.run(ctxOf().ctx);
      expect(log).toEqual(['enforce']);
      expect(r.growth).toEqual({ kind: 'denied', code: 'personal_busy' });
      expect(r.faults).toEqual([]);
    }
  });

  it('故障(其它 RsiLockError / 非 RsiLockError):denied personal_fault,faults 带 personal_lock_error 码;不算忙', async () => {
    const a = mk({ acquire: () => Promise.reject(new RsiLockError('state_dir_unsafe')) });
    const ra = await a.stage.run(ctxOf().ctx);
    expect(ra.growth).toEqual({ kind: 'denied', code: 'personal_fault' });
    expect(ra.faults).toEqual([{ code: 'personal_lock_error:state_dir_unsafe' }]);
    const b = mk({ acquire: () => Promise.reject(new TypeError('x')) });
    const rb = await b.stage.run(ctxOf().ctx);
    expect(rb.growth).toEqual({ kind: 'denied', code: 'personal_fault' });
    expect(rb.faults).toEqual([{ code: 'personal_lock_error:internal' }]);
  });

  it('update_busy:S0 照跑,growth = denied update_busy(S3 不可达);个人锁仍释放', async () => {
    const { stage, personal } = mk();
    const r = await stage.run(ctxOf({ updateBusy: true }).ctx);
    expect(r.growth).toEqual({ kind: 'denied', code: 'update_busy' });
    expect(personal.releases).toBe(1);
  });

  it('S0 先于试锁:acquire 被调用时 enforce 已经完成', async () => {
    const order: string[] = [];
    const { stage } = mk({
      enforce: () => {
        order.push('enforce');
        return Promise.resolve(false);
      },
      acquire: () => {
        order.push('acquire');
        return Promise.reject(new RsiLockError('locked'));
      },
    });
    await stage.run(ctxOf().ctx);
    expect(order).toEqual(['enforce', 'acquire']);
  });
});

describe('S0 非净 → 本轮未决 → 增影响被拒', () => {
  it('state 非法:faults 带 safety_fault:state_invalid:schema(step_halted + detail),本轮 unsettled=[safety_not_settled];evaluateGrowth 返回 unsettled', async () => {
    const { stage, log } = mk({ kind: () => Promise.resolve('schema') });
    const r = await stage.run(ctxOf().ctx);
    expect(log).toEqual(['mute']); // 直接走阶梯,没调 enforceFull
    expect(r.faults).toEqual([
      { code: 'step_halted', detail: 'safety_fault:state_invalid:schema' },
    ]);
    expect(r.unsettled).toEqual(['safety_not_settled']);
    if (r.growth.kind !== 'open') throw new Error('expected open');
    const v = await evaluateGrowth(r.growth.round, { op: 'admission' }, readers(), {
      ops: new Set(['admission'] as const),
    });
    expect(v).toMatchObject({ ok: false, code: 'unsettled' });
  });

  it('静音抛错 → 删除兜底成功:故障码仍是 state_invalid:schema(只有三级全败才改成 mute_unreliable,见 c1b-ladder)', async () => {
    const { stage } = mk({
      kind: () => Promise.resolve('schema'),
      mute: () => Promise.reject(eio()),
    });
    const r = await stage.run(ctxOf().ctx);
    expect(r.faults).toEqual([
      { code: 'step_halted', detail: 'safety_fault:state_invalid:schema' },
    ]);
    expect(r.unsettled).toEqual(['safety_not_settled']);
  });

  it('S0 内部非失锁的违约抛出(端口工厂抛)→ 记 fault、本轮未决,不上抛', async () => {
    const stage = createPersonalStage({
      eligible: () => true,
      s0Ports: () => {
        throw new TypeError('factory');
      },
      fallbackPorts: () => {
        throw new Error('x');
      },
      acquirePersonal: () => () => Promise.reject(new RsiLockError('locked')),
      l0DueNow: () => Promise.resolve(true),
    });
    const r = await stage.run(ctxOf().ctx);
    expect(r.faults).toEqual([{ code: 'step_threw', detail: 'TypeError' }]);
    expect(r.unsettled).toEqual(['safety_not_settled']);
  });

  it('S0 干净:本轮 unsettled 为空(正向对照);装配无 GrowthStage → verdict 恒 growth_unwired(占位期不可能放行)', async () => {
    const r = await mk().stage.run(ctxOf().ctx);
    expect(r.unsettled).toEqual([]);
    if (r.growth.kind !== 'open') throw new Error('expected open');
    for (const op of ['bootstrap', 'candidate_create', 'admission'] as const) {
      const v = await evaluateGrowth(r.growth.round, { op }, readers(), undefined);
      expect(v, op).toMatchObject({ ok: false, code: 'growth_unwired' });
    }
  });
});

describe('失锁与释放', () => {
  it('S0 内 rsi 失锁:原样上抛,没有试个人锁', async () => {
    let acquired = 0;
    const { stage } = mk({
      enforce: () => Promise.reject(lost()),
      acquire: () => {
        acquired += 1;
        return Promise.reject(new RsiLockError('locked'));
      },
    });
    await expect(stage.run(ctxOf().ctx)).rejects.toThrow('lock_lost');
    expect(acquired).toBe(0);
  });

  it('返回前复核 rsi 锁:取得个人锁后 rsi 锁丢失 → 上抛,个人锁仍释放(不靠 release 暴露失锁)', async () => {
    const { ctx, rsi } = ctxOf();
    const { stage, personal } = mk({
      l0: () => {
        rsi.held = false;
        return Promise.resolve(true);
      },
    });
    await expect(stage.run(ctx)).rejects.toThrow('lock_lost');
    expect(personal.releases).toBe(1);
  });

  it('个人锁在 S0 之后被夺:growth = denied lock_lost,本轮未决;不上抛', async () => {
    const { stage, personal } = mk();
    const { ctx } = ctxOf();
    personal.held = false;
    const r = await stage.run(ctx);
    expect(r.growth).toEqual({ kind: 'denied', code: 'lock_lost' });
    expect(r.unsettled).toEqual(['safety_not_settled']);
  });

  it('openRound 抛(两把锁 nonce 相同)→ 个人锁仍释放(整个 run 体在 finally 内)', async () => {
    const same = fakeLock(RSI_NONCE);
    const { stage } = mk({ acquire: () => Promise.resolve(asRaw(same)) });
    await expect(stage.run(ctxOf().ctx)).rejects.toThrow('same_nonce');
    expect(same.releases).toBe(1);
  });

  it('l0DueNow 抛错按「不到期」(不增影响);不影响其余结果', async () => {
    const { stage } = mk({ l0: () => Promise.reject(eio()) });
    const r = await stage.run(ctxOf().ctx);
    expect(r.l0DueNow).toBe(false);
  });

  it('个人锁释放失败被吞,不改变返回', async () => {
    const personal = fakeLock(PERSONAL_NONCE);
    personal.release = () => Promise.reject(eio());
    const { stage } = mk({ acquire: () => Promise.resolve(asRaw(personal)) });
    const r = await stage.run(ctxOf().ctx);
    expect(r.growth.kind).toBe('open');
  });
});

describe('eligible / safetyFallback', () => {
  it('eligible:抛错 = 假(fail-closed);非 true 的真值 = 假', () => {
    expect(
      mk({
        eligible: () => {
          throw new Error('x');
        },
      }).stage.eligible(),
    ).toBe(false);
    expect(mk({ eligible: () => 1 as unknown as boolean }).stage.eligible()).toBe(false);
    expect(mk({ eligible: () => true }).stage.eligible()).toBe(true);
  });

  it('safetyFallback 永不抛:端口工厂抛 → threw;工厂抛 rsi 失锁 → aborted', async () => {
    const fctx = {} as FallbackCtx;
    expect(await mk().stage.safetyFallback(fctx)).toEqual({ kind: 'threw', name: 'Error' });
    const stage = createPersonalStage({
      eligible: () => true,
      s0Ports: () => {
        throw new Error('x');
      },
      fallbackPorts: () => {
        throw lost();
      },
      acquirePersonal: () => () => Promise.reject(new RsiLockError('locked')),
      l0DueNow: () => Promise.resolve(true),
    });
    expect(await stage.safetyFallback(fctx)).toEqual({ kind: 'aborted', why: 'rsi_lock_lost' });
  });
});
