/**
 * C2 S1:仓库恢复结果映射(D1b-1 起无前置守卫,bootstrap 类 journal 由 `complete_only` 端口处置,见 `test/rsi/d1b1/`)与五项恢复的编排(标志、失败隔离、失锁分类)。端口全为假件(与真端口同契约:读失败 = 抛错 / 返回 invalid)。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { PersonalLockLost } from '../../../src/rsi/personal/stage/errors.js';
import type {
  RecoveryPort,
  RepoRecovery,
  StepOutcome,
} from '../../../src/rsi/personal/stage/ports.js';
import { createRoundBudget } from '../../../src/rsi/personal/stage/settle.js';
import {
  createRepoRecovery,
  type OpenOutcome,
} from '../../../src/rsi/personal/steps/repo-recover.js';
import { runS1 } from '../../../src/rsi/personal/steps/s1-recover.js';
import { START_ROLLBACK_LIMIT } from '../../../src/rsi/personal/steps/steps-types.js';
import { openBoth } from '../stage/c1-fixture.js';

describe('S1 仓库恢复映射(createRepoRecovery:open 结果 → RepoRecovery)', () => {
  it('open 结果映射:absent / ready / invalid / deferred(两个原因)/ bootstrap_pending(incomplete,不熔断);open 恒被调用', async () => {
    let opens = 0;
    const mk = (o: OpenOutcome | Error) =>
      createRepoRecovery({
        open: async () => {
          opens += 1;
          if (o instanceof Error) throw o;
          return o;
        },
      });
    expect(await mk({ kind: 'ready' })()).toEqual({ kind: 'judged', judgement: 'at_record' });
    expect(await mk({ kind: 'absent' })()).toEqual({ kind: 'absent' });
    expect(await mk({ kind: 'invalid', why: 'x' })()).toEqual({ kind: 'invalid' });
    expect(await mk({ kind: 'deferred', reason: 'personal_repo_diverged' })()).toEqual({
      kind: 'judged',
      judgement: 'diverged',
    });
    expect(await mk({ kind: 'deferred', reason: 'personal_owner_changed' })()).toEqual({
      kind: 'judged',
      judgement: 'owner_changed',
    });
    // bootstrap 类 journal 未完成:S1 报 incomplete(只进 faults / incomplete,不熔断),不是 invalid
    expect(await mk({ kind: 'bootstrap_pending' })()).toEqual({
      kind: 'incomplete',
      why: 'bootstrap_pending',
    });
    expect(opens).toBe(6);
  });

  it('git 读失败(open 抛非锁错误)= 仓库不可用 invalid;锁错误 / 失锁原样上抛', async () => {
    const mk = (e: unknown) => createRepoRecovery({ open: async () => Promise.reject(e) });
    expect(await mk(new Error('git exploded'))()).toEqual({ kind: 'invalid' });
    await expect(mk(new RsiLockError('lock_lost'))()).rejects.toBeInstanceOf(RsiLockError);
    await expect(mk(new PersonalLockLost())()).rejects.toBeInstanceOf(PersonalLockLost);
  });
});

function ports(over: Partial<RecoveryPort> & { repo?: RepoRecovery | Error } = {}): {
  p: RecoveryPort;
  calls: string[];
  flags: unknown[];
} {
  const calls: string[] = [];
  const flags: unknown[] = [];
  const done: StepOutcome = { kind: 'done' };
  const p: RecoveryPort = {
    recoverRepo: async () => {
      calls.push('repo');
      const r = over.repo ?? { kind: 'absent' };
      if (r instanceof Error) throw r;
      return r;
    },
    setFlagAndMute: async (f) => {
      calls.push('flags');
      flags.push(f);
      return done;
    },
    resumeRollbacks: over.resumeRollbacks ?? (async () => (calls.push('resume'), done)),
    recoverTerminalEffects:
      over.recoverTerminalEffects ?? (async () => (calls.push('effects'), done)),
    reconcileRevocations:
      over.reconcileRevocations ?? (async () => (calls.push('reconcile'), done)),
  };
  return { p, calls, flags };
}

describe('runS1', () => {
  const budgetOf = async () => {
    const w = await openBoth();
    return createRoundBudget(w.round, { startRollbackLimit: START_ROLLBACK_LIMIT });
  };

  it('常态(absent):五项只调后三项,不写标志,无故障', async () => {
    const { p, calls } = ports();
    const r = await runS1({ recovery: p, budget: await budgetOf() });
    expect(calls).toEqual(['repo', 'resume', 'effects', 'reconcile']);
    expect(r).toMatchObject({ faults: [], flagsTarget: null, tripReasons: [], ended: false });
  });

  it('标志重算:① 清两标志;② 只置 diverged;④ 只置 owner_changed;③ / absent 不动(flag_not_cleared_on_unreadable)', async () => {
    const cases: [RepoRecovery, unknown][] = [
      [
        { kind: 'judged', judgement: 'at_record' },
        { diverged: false, owner_changed: false },
      ],
      [{ kind: 'judged', judgement: 'diverged' }, { diverged: true }],
      [{ kind: 'judged', judgement: 'owner_changed' }, { owner_changed: true }],
    ];
    for (const [repo, expected] of cases) {
      const { p, flags } = ports({ repo });
      const r = await runS1({ recovery: p, budget: await budgetOf() });
      expect(flags).toEqual([expected]);
      expect(r.flagsTarget).toEqual(expected);
    }
    for (const repo of [
      { kind: 'judged', judgement: 'indeterminate' } as const,
      { kind: 'absent' } as const,
      { kind: 'incomplete', why: 'x' } as const,
      new Error('boom'),
    ]) {
      const { p, flags } = ports({ repo });
      const r = await runS1({ recovery: p, budget: await budgetOf() });
      expect(flags, JSON.stringify(repo)).toEqual([]);
      expect(r.flagsTarget).toBeNull();
    }
  });

  it('仓库 invalid → 不在 S1 里 trip(预算每轮 ≤1),而是返回 tripReasons 并入 S2P 的单次 trip', async () => {
    const { p } = ports({ repo: { kind: 'invalid' } });
    const r = await runS1({ recovery: p, budget: await budgetOf() });
    expect(r.tripReasons).toEqual(['personal_repo_invalid']);
  });

  it('bootstrap_pending → 故障 + incomplete,其余三项照跑(不挡下一项)', async () => {
    const { p, calls } = ports({ repo: { kind: 'incomplete', why: 'bootstrap_pending' } });
    const r = await runS1({ recovery: p, budget: await budgetOf() });
    expect(calls).toEqual(['repo', 'resume', 'effects', 'reconcile']);
    expect(r.incomplete).toContain('repo:bootstrap_pending');
    expect(r.faults).toContainEqual({
      code: 'step_halted',
      detail: 'recovery_incomplete:bootstrap_pending',
    });
  });

  it('某项抛错 → 记故障、继续下一项;incomplete 的 halt 前缀进 unsettled', async () => {
    const { p, calls } = ports({
      resumeRollbacks: async () => {
        throw new Error('txn dir unreadable');
      },
      recoverTerminalEffects: async () => ({ kind: 'incomplete', why: 'halt:repo_invalid' }),
    });
    const r = await runS1({ recovery: p, budget: await budgetOf() });
    // resume 抛 / effects 返回 incomplete(两者的覆盖实现都不入 calls),所以 calls 只含真实现的 repo 与最后一项 reconcile:证明抛错不挡下一项
    expect(calls).toEqual(['repo', 'reconcile']);
    expect(r.faults.some((f) => f.code === 'step_threw')).toBe(true);
    expect(r.unsettled).toContain('step_integrity:repo_invalid');
    expect(r.ended).toBe(false);
  });

  it('recoverRepo(第 1 项)抛个人失锁 → ended = true、余下四项零调用(与 guarded 路径同)', async () => {
    const { p, calls } = ports({ repo: new PersonalLockLost() });
    const r = await runS1({ recovery: p, budget: await budgetOf() });
    expect(r.ended).toBe(true);
    expect(calls).toEqual(['repo']);
    await expect(
      runS1({
        recovery: ports({ repo: new RsiLockError('lock_lost') }).p,
        budget: await budgetOf(),
      }),
    ).rejects.toBeInstanceOf(RsiLockError);
  });

  it('某项返回 halt:lock_lost(归属未明)→ 未决 lock_loss_unresolved 且结束个人轮:余下步骤零调用', async () => {
    const { p, calls } = ports({
      resumeRollbacks: async () => ({ kind: 'incomplete', why: 'halt:lock_lost' }),
    });
    const r = await runS1({ recovery: p, budget: await budgetOf() });
    expect(r.unsettled).toContain('lock_loss_unresolved');
    expect(r.ended).toBe(true);
    expect(calls).toEqual(['repo']);
  });

  it('个人锁丢失 → 结束个人轮(余下步骤不调);rsi 锁丢失 → 原样上抛', async () => {
    const lost = ports({
      resumeRollbacks: async () => {
        throw new PersonalLockLost();
      },
    });
    const r = await runS1({ recovery: lost.p, budget: await budgetOf() });
    expect(r.ended).toBe(true);
    expect(lost.calls).not.toContain('effects');
    expect(lost.calls).not.toContain('reconcile');
    const rsiLost = ports({
      recoverTerminalEffects: async () => {
        throw new RsiLockError('lock_lost');
      },
    });
    await expect(runS1({ recovery: rsiLost.p, budget: await budgetOf() })).rejects.toBeInstanceOf(
      RsiLockError,
    );
  });

  it('setFlagAndMute 写失败 → 故障,标志目标仍报告(不清标志);不挡后续', async () => {
    const calls: string[] = [];
    const p: RecoveryPort = {
      recoverRepo: async () => ({ kind: 'judged', judgement: 'diverged' }),
      setFlagAndMute: async () => ({ kind: 'failed', why: 'state_write' }),
      resumeRollbacks: async () => (calls.push('resume'), { kind: 'done' }),
      recoverTerminalEffects: async () => ({ kind: 'done' }),
      reconcileRevocations: async () => ({ kind: 'done' }),
    };
    const r = await runS1({ recovery: p, budget: await budgetOf() });
    expect(r.faults).toContainEqual({
      code: 'step_halted',
      detail: 'set_flags_failed:state_write',
    });
    expect(calls).toEqual(['resume']);
  });
});
