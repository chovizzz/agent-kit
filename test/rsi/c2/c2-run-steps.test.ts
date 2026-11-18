/**
 * C2:`createPersonalStage` 接入 S2R / S1 / 压缩 / S2P / 扫尾(`deps.steps`)——顺序、忙 / 故障轮只跑 S2R + T_rsi、失锁分类、
 * 扫尾只在脏时跑一次、写适配器经 `round.writeAdapter` 包装后 `gen` 推进、`steps` 缺省 = C1b 行为。端口全为假件。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { PersonalLockLost } from '../../../src/rsi/personal/stage/errors.js';
import type { PersonalLockHandle } from '../../../src/rsi/personal/personal-lock.js';
import type { S0Ports } from '../../../src/rsi/personal/stage/ladder.js';
import { createPersonalStage } from '../../../src/rsi/personal/stage/personal-stage.js';
import type {
  FallbackPorts,
  ReducePort,
  SafetyPort,
  StepOutcome,
} from '../../../src/rsi/personal/stage/ports.js';
import type { BothRound } from '../../../src/rsi/personal/stage/round.js';
import type { PersonalCtx } from '../../../src/rsi/personal/stage/types.js';
import type { BothPorts } from '../../../src/rsi/personal/steps/run-steps.js';
import { UNAVAILABLE_JUDGE } from '../../../src/rsi/personal/judge-slot.js';
import { PERSONAL_NONCE, RSI_NONCE, asRaw, fakeLock } from '../stage/c1-fixture.js';

const DONE: StepOutcome = { kind: 'done' };

function ctxOf(lock: ReturnType<typeof fakeLock> = fakeLock(RSI_NONCE)): PersonalCtx {
  return {
    sctx: {} as PersonalCtx['sctx'],
    lock,
    obs: {} as PersonalCtx['obs'],
    now: () => new Date(0),
    nowMs: () => 0,
    updateBusy: false,
  } as PersonalCtx;
}

interface Sc {
  acquire?: () => Promise<PersonalLockHandle>;
  /** 让某个会置脏的写端口被调用(经 `round.writeAdapter` 包装) */
  dirtyWrite?: boolean;
  verifyOk?: boolean;
  compactor?: boolean;
  trig?: readonly string[];
  stepsThrow?: boolean;
  /** `recoverRepo` 抛个人失锁 */
  repoLost?: boolean;
  /** W9 槽返回 `halted: lock_lost`(`onJudge` 先执行,测试借它让某把锁真丢) */
  judgeLockLost?: { onJudge(): void };
  /** 压缩返回值 */
  compactResult?: unknown;
  /** 扫尾的 `enforceMute` 抛普通错误(扫尾细项应进 faults) */
  enforceThrows?: boolean;
}
function mk(sc: Sc = {}) {
  const log: string[] = [];
  const personal = fakeLock(PERSONAL_NONCE);
  let roundSeen: BothRound | null = null;
  const safetyOf = (round: { writeAdapter: BothRound['writeAdapter'] }): SafetyPort => {
    const enforce = round.writeAdapter('safety_mute', async () => {
      log.push('sweep:enforce');
      if (sc.enforceThrows) throw new Error('enforce boom');
      return { mute: 'nothing' as const, fault: null };
    });
    const reconcile = round.writeAdapter('safety_mute', async () => (log.push('caches'), DONE));
    return {
      enforceMute: () => enforce(),
      reconcileCaches: () => reconcile(),
      verifyMuted: async () => (
        log.push('verify'),
        sc.verifyOk === false ? { ok: false, why: 'unreadable' } : { ok: true }
      ),
      evaluateRsiTriggers: async () => (log.push('t_rsi'), (sc.trig ?? []) as never),
      tripAndMute: async (r) => (
        log.push(`trip_rsi:${r.join()}`),
        { tripped: true, mute: 'muted' }
      ),
      stopExistingInjection: async () => 'nothing',
    };
  };
  const stage = createPersonalStage({
    eligible: () => true,
    s0Ports: (): S0Ports => ({
      enforceFull: async () => (log.push('s0'), false),
      stateKind: async () => 'valid',
      muteCanary: async () => true,
      removeCanary: async () => true,
      ensureBreakerMarker: async () => 'created',
      assertHeld: async () => undefined,
    }),
    fallbackPorts: (): FallbackPorts => {
      throw new Error('unused');
    },
    acquirePersonal: () => sc.acquire ?? (() => Promise.resolve(asRaw(personal))),
    l0DueNow: async () => true,
    steps: {
      both(_ctx, round): BothPorts {
        if (sc.stepsThrow) throw new Error('factory boom');
        roundSeen = round;
        const write = round.writeAdapter(
          'state_pause_flag',
          async () => (log.push('dirty_write'), DONE),
        );
        const reduce: ReducePort = {
          applyTaint: async () => DONE,
          runAnalysis: async () => DONE,
          expireCandidates: async () => (log.push('expire'), sc.dirtyWrite ? write() : DONE),
          reconcileRevocations: async () => DONE,
          evaluateTriggers: async () => (log.push('triggers'), []),
          tripAndMute: async () => ({ tripped: false, mute: 'nothing' }),
          applyAutoRelease: async () => (log.push('release'), DONE),
          startRollback: async () => DONE,
        };
        return {
          recovery: {
            recoverRepo: async () => {
              log.push('s1:repo');
              if (sc.repoLost) throw new PersonalLockLost();
              return { kind: 'absent' };
            },
            setFlagAndMute: async () => DONE,
            resumeRollbacks: async () => DONE,
            recoverTerminalEffects: async () => DONE,
            reconcileRevocations: async () => DONE,
          },
          s2: {
            reduce,
            safety: safetyOf(round),
            scanner: { scan: async () => ({ kind: 'ok', tainted: [], unknown: [] }) },
            candidates: { list: async () => ({ kind: 'ok', cands: [], canaryIds: [] }) },
            rescan: { rescan: async () => DONE },
            judge:
              sc.judgeLockLost === undefined
                ? UNAVAILABLE_JUDGE.reduce
                : {
                    run: async () => {
                      sc.judgeLockLost?.onJudge();
                      return {
                        evaluated: 0,
                        transitioned: [],
                        blocked: [],
                        deferred: [],
                        halted: 'lock_lost' as const,
                        unavailable: false,
                      };
                    },
                  },
          },
          ...(sc.compactor
            ? {
                compactor: {
                  compact: async () => (
                    log.push('compact'),
                    (sc.compactResult ?? { kind: 'noop' as const }) as never
                  ),
                },
              }
            : {}),
        };
      },
      rsiOnly: (_ctx, round) => safetyOf(round),
      // 只在失锁归属用例里记录「读标志」(它在 rsi 失锁解析之后、最终复核之前:证明上抛发生在解析处而不是靠最终复核)
      ...(sc.judgeLockLost !== undefined ? { flags: async () => (log.push('flags'), null) } : {}),
    },
  });
  return { stage, log, personal, round: () => roundSeen };
}

describe('持两锁的回合', () => {
  it('顺序:S0 → S2R(caches)→ S1 → 压缩 → S2P → (不脏则无扫尾);个人锁恰释放一次', async () => {
    const { stage, log, personal } = mk({ compactor: true });
    const r = await stage.run(ctxOf());
    expect(log).toEqual(['s0', 'caches', 's1:repo', 'compact', 'expire', 'triggers', 'release']);
    expect(r.growth.kind).toBe('open');
    expect(r.faults).toEqual([]);
    expect(r.unsettled).toEqual([]);
    expect(personal.releases).toBe(1);
  });

  it('会置脏的写(state_pause_flag)→ 扫尾恰一次(enforce → caches → verify);扫尾自己的写不再置脏;不循环', async () => {
    const { stage, log } = mk({ dirtyWrite: true });
    const r = await stage.run(ctxOf());
    expect(log.filter((x) => x === 'dirty_write')).toHaveLength(1);
    expect(log.slice(log.indexOf('release') + 1)).toEqual(['sweep:enforce', 'caches', 'verify']);
    expect(r.unsettled).toEqual([]);
  });

  it('扫尾核验失败 → 本轮 safety_not_settled(verdict 拒绝的依据),且不再扫第二次', async () => {
    const { stage, log } = mk({ dirtyWrite: true, verifyOk: false });
    const r = await stage.run(ctxOf());
    expect(r.unsettled).toContain('safety_not_settled');
    expect(log.filter((x) => x === 'sweep:enforce')).toHaveLength(1);
  });

  it('端口工厂抛错 → 记故障 + 本轮未决;个人锁仍释放;不崩', async () => {
    const { stage, personal } = mk({ stepsThrow: true });
    const r = await stage.run(ctxOf());
    expect(r.faults.some((f) => f.code === 'step_threw')).toBe(true);
    expect(r.unsettled).toContain('safety_not_settled');
    expect(personal.releases).toBe(1);
  });
});

describe('失锁与日志 / 扫尾细项(验收评审修复)', () => {
  const S2P_CALLS = ['expire', 'triggers', 'release', 'compact', 'sweep:enforce', 'verify'];

  it('recoverRepo 抛 PersonalLockLost → 压缩 / S2P / 扫尾零调用;回合 unsettled 且 growth = lock_lost;个人锁仍释放一次', async () => {
    const { stage, log, personal } = mk({ compactor: true, repoLost: true, dirtyWrite: true });
    const r = await stage.run(ctxOf());
    expect(log).toEqual(['s0', 'caches', 's1:repo']);
    for (const x of S2P_CALLS) expect(log, x).not.toContain(x);
    expect(r.unsettled).toContain('safety_not_settled');
    expect(r.growth).toEqual({ kind: 'denied', code: 'lock_lost' });
    expect(personal.releases).toBe(1);
  });

  it('W9 槽 halted=lock_lost 且 rsi 锁实际已丢 → 原样上抛(resolveLockLoss 解析),S2P 余下步骤(触发 / 解除)不跑;个人锁仍释放一次', async () => {
    const rsi = fakeLock(RSI_NONCE);
    const { stage, log, personal } = mk({
      judgeLockLost: {
        onJudge: () => {
          rsi.held = false;
        },
      },
    });
    await expect(stage.run(ctxOf(rsi))).rejects.toBeInstanceOf(RsiLockError);
    expect(log).not.toContain('flags'); // 解析处就上抛,没走到读标志 / 最终复核
    expect(log).not.toContain('triggers');
    expect(log).not.toContain('release');
    expect(personal.releases).toBe(1);
  });

  it('W9 槽 halted=lock_lost 且个人锁实际已丢 → 结束个人轮(不上抛):unsettled 含 lock_loss_unresolved,growth = lock_lost,余下步骤不跑', async () => {
    const holder: { personal?: ReturnType<typeof fakeLock> } = {};
    const { stage, log, personal } = mk({
      judgeLockLost: {
        onJudge: () => {
          if (holder.personal !== undefined) holder.personal.held = false;
        },
      },
    });
    holder.personal = personal;
    const r = await stage.run(ctxOf());
    expect(r.unsettled).toEqual(
      expect.arrayContaining(['lock_loss_unresolved', 'safety_not_settled']),
    );
    expect(r.growth).toEqual({ kind: 'denied', code: 'lock_lost' });
    expect(log).not.toContain('triggers');
    expect(log).not.toContain('release');
  });

  it('W9 槽 halted=lock_lost 但两把锁都在(查不出是哪一把)→ 按个人轮结束 + 未决,不上抛', async () => {
    const { stage, log } = mk({ judgeLockLost: { onJudge: () => undefined } });
    const r = await stage.run(ctxOf());
    expect(r.unsettled).toContain('lock_loss_unresolved');
    expect(log).not.toContain('triggers');
  });

  it('压缩日志码只经 faults 流向日志摘要:audit_full → step_halted:compact_audit_full,不未决(没有并行的 logCodes / storeFull 字段)', async () => {
    const { stage } = mk({
      compactor: true,
      compactResult: { kind: 'compact_blocked', cause: 'audit_full' },
    });
    const r = await stage.run(ctxOf());
    expect(r.faults).toContainEqual({ code: 'step_halted', detail: 'compact_audit_full' });
    expect(r.unsettled).toEqual([]);
  });

  it('扫尾细项不丢:扫尾 enforceMute 抛错 → faults 含 step_threw,回合 safety_not_settled', async () => {
    const { stage, log } = mk({ dirtyWrite: true, enforceThrows: true });
    const r = await stage.run(ctxOf());
    expect(log).toContain('sweep:enforce');
    expect(r.faults).toContainEqual({ code: 'step_threw', detail: 'Error' });
    expect(r.unsettled).toContain('safety_not_settled');
  });
});

describe('忙 / 故障轮(没有 BothRound)', () => {
  it('只跑 S2R + T_rsi + 扫尾:S1 / 压缩 / S2P 零调用;verdict personal_busy;命中码经 tripAndMute', async () => {
    const { stage, log } = mk({
      acquire: () => Promise.reject(new RsiLockError('locked')),
      trig: ['no_observation'],
    });
    const r = await stage.run(ctxOf());
    expect(r.growth).toEqual({ kind: 'denied', code: 'personal_busy' });
    expect(log).toEqual(['s0', 'caches', 't_rsi', 'trip_rsi:no_observation']);
    expect(log).not.toContain('s1:repo');
    expect(log).not.toContain('release');
  });
});

describe('缺省', () => {
  it('不给 steps = C1b 行为:只有 S0 与试锁', async () => {
    const stage = createPersonalStage({
      eligible: () => true,
      s0Ports: (): S0Ports => ({
        enforceFull: async () => false,
        stateKind: async () => 'valid',
        muteCanary: async () => true,
        removeCanary: async () => true,
        ensureBreakerMarker: async () => 'created',
        assertHeld: async () => undefined,
      }),
      fallbackPorts: (): FallbackPorts => {
        throw new Error('unused');
      },
      acquirePersonal: () => () => Promise.resolve(asRaw(fakeLock(PERSONAL_NONCE))),
      l0DueNow: async () => true,
    });
    const r = await stage.run(ctxOf());
    expect(r.growth.kind).toBe('open');
    expect(r.flags).toEqual({ diverged: false, owner_changed: false });
  });
});
