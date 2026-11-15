/**
 * C1a:`settleSafety` 单次扫尾协议(C v2 §4.3)——脏则重入 = 固定的一次扫尾,不循环、不重跑触发 / 自动解除;`safetyDirty` 与 `gen` 分开。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import type { SweepPorts } from '../../../src/rsi/personal/stage/settle.js';
import { createRoundBudget, settleSafety } from '../../../src/rsi/personal/stage/settle.js';
import type { BothRound, RsiOnlyRound } from '../../../src/rsi/personal/stage/round.js';
import { openBoth, openBusy } from './c1-fixture.js';

interface Sweep extends SweepPorts {
  readonly calls: string[];
  dirtyAtFirstCall: boolean | null;
}
function sweepPorts(round: BothRound | RsiOnlyRound, over: Partial<SweepPorts> = {}): Sweep {
  const s: Sweep = {
    calls: [],
    dirtyAtFirstCall: null,
    enforceMute: () => {
      s.calls.push('enforceMute');
      s.dirtyAtFirstCall ??= round.safetyDirty.isDirty();
      return Promise.resolve({ mute: 'nothing', fault: null });
    },
    reconcileCaches: () => {
      s.calls.push('reconcileCaches');
      return Promise.resolve({ kind: 'done' });
    },
    verifyMuted: () => {
      s.calls.push('verifyMuted');
      return Promise.resolve({ ok: true });
    },
    ...over,
  };
  return s;
}
const dirty = async (round: BothRound | RsiOnlyRound): Promise<void> => {
  await round.writeAdapter('trip', () => Promise.resolve())();
};

describe('settleSafety', () => {
  it('safetyDirty 为空 → settled,零调用(审计补行 / 压缩 / effects 写使 gen 变化但不触发扫尾)', async () => {
    const { round } = await openBoth();
    await round.writeAdapter('audit_append', () => Promise.resolve())();
    await round.writeAdapter('compaction', () => Promise.resolve())();
    await round.writeAdapter('effects', () => Promise.resolve())();
    expect(round.gen()).toBe(3);
    const p = sweepPorts(round);
    const r = await settleSafety(round, p, createRoundBudget(round, { startRollbackLimit: 3 }));
    expect(r).toEqual({ kind: 'settled', swept: false });
    expect(p.calls).toEqual([]);
    expect(round.unsettled()).toEqual([]);
  });

  it('sweep_runs_at_most_once:脏 → 固定顺序各一次;再调一次零调用(不重入、不循环)', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const budget = createRoundBudget(round, { startRollbackLimit: 3 });
    const p = sweepPorts(round);
    const r = await settleSafety(round, p, budget);
    expect(r).toEqual({ kind: 'settled', swept: true });
    expect(p.calls).toEqual(['enforceMute', 'reconcileCaches', 'verifyMuted']);
    expect(round.safetyDirty.isDirty()).toBe(false);
    const again = await settleSafety(round, p, budget);
    expect(again).toEqual({ kind: 'settled', swept: false });
    expect(p.calls.length).toBe(3);
    expect(budget.used('enforceMute')).toBe(1);
    expect(budget.used('reconcileCaches')).toBe(1);
  });

  it('sweep_clears_dirty_before_run_and_does_not_reloop:第一次扫尾调用时脏标记已清零', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const p = sweepPorts(round);
    await settleSafety(round, p, createRoundBudget(round, { startRollbackLimit: 3 }));
    expect(p.dirtyAtFirstCall).toBe(false);
  });

  it('扫尾自己的写不再置脏(即使写的是 DIRTY 种类):不触发第二次扫尾', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const p = sweepPorts(round, {
      enforceMute: async () => {
        await round.writeAdapter('trip', () => Promise.resolve())();
        await round.writeAdapter('state_pause_flag', () => Promise.resolve())();
        return { mute: 'muted', fault: null };
      },
    });
    const budget = createRoundBudget(round, { startRollbackLimit: 3 });
    expect(await settleSafety(round, p, budget)).toEqual({ kind: 'settled', swept: true });
    expect(round.safetyDirty.isDirty()).toBe(false);
    expect(round.gen()).toBe(3); // gen 照常推进(1 次脏写 + 2 次扫尾写)
    expect(await settleSafety(round, p, budget)).toEqual({ kind: 'settled', swept: false });
    // 正向对照:扫尾之外同一种写会置脏
    await dirty(round);
    expect(round.safetyDirty.isDirty()).toBe(true);
  });

  it('sweep_verify_fails_unsettled:核验失败 → unsettled(safety_not_settled),脏标记保持置位,不再循环', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const p = sweepPorts(round, {
      verifyMuted: () => {
        p.calls.push('verifyMuted');
        return Promise.resolve({ ok: false, why: 'inject_present_while_paused' });
      },
    });
    const r = await settleSafety(round, p, createRoundBudget(round, { startRollbackLimit: 3 }));
    expect(r).toEqual({ kind: 'unsettled', reason: 'safety_not_settled', faults: [] });
    expect(p.calls).toEqual(['enforceMute', 'reconcileCaches', 'verifyMuted']);
    expect(round.safetyDirty.isDirty()).toBe(true);
    expect(round.safetyDirty.kinds()).toEqual(['trip']);
    expect(round.unsettled()).toEqual(['safety_not_settled']);
  });

  it('sweep_state_write_fails_still_mutes_no_reloop:enforceMute 抛错 → 记故障、后面两步照样各跑一次(尽力),未决', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const p = sweepPorts(round, {
      enforceMute: () => {
        p.calls.push('enforceMute');
        return Promise.reject(new Error('state write failed'));
      },
    });
    const r = await settleSafety(round, p, createRoundBudget(round, { startRollbackLimit: 3 }));
    expect(r).toEqual({
      kind: 'unsettled',
      reason: 'safety_not_settled',
      faults: [{ code: 'step_threw', detail: 'Error' }],
    });
    expect(p.calls).toEqual(['enforceMute', 'reconcileCaches', 'verifyMuted']);
  });

  it('enforceMute 返回故障码(mute_unreliable)/ reconcileCaches 失败或未完成 → 未决;skipped 不算失败', async () => {
    for (const over of [
      {
        enforceMute: () =>
          Promise.resolve({ mute: 'unreliable' as const, fault: 'mute_unreliable' as const }),
      },
      { reconcileCaches: () => Promise.resolve({ kind: 'failed' as const, why: 'x' }) },
      { reconcileCaches: () => Promise.resolve({ kind: 'incomplete' as const, why: 'x' }) },
    ]) {
      const { round } = await openBoth();
      await dirty(round);
      const r = await settleSafety(
        round,
        sweepPorts(round, over),
        createRoundBudget(round, { startRollbackLimit: 3 }),
      );
      expect(r.kind).toBe('unsettled');
    }
    const { round } = await openBoth();
    await dirty(round);
    const ok = await settleSafety(
      round,
      sweepPorts(round, {
        reconcileCaches: () => Promise.resolve({ kind: 'skipped', why: 'nothing' }),
      }),
      createRoundBudget(round, { startRollbackLimit: 3 }),
    );
    expect(ok).toEqual({ kind: 'settled', swept: true });
  });

  it('rsi 锁丢失(RsiLockError lock_lost)→ 原样上抛;后续步骤零调用;脏标记放回', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const p = sweepPorts(round, {
      enforceMute: () => {
        p.calls.push('enforceMute');
        return Promise.reject(new RsiLockError('lock_lost'));
      },
    });
    await expect(
      settleSafety(round, p, createRoundBudget(round, { startRollbackLimit: 3 })),
    ).rejects.toBeInstanceOf(RsiLockError);
    expect(p.calls).toEqual(['enforceMute']);
    expect(round.safetyDirty.isDirty()).toBe(true);
  });

  it('核验抛 rsi 失锁 → 上抛;核验抛普通错 → 未决 + 故障', async () => {
    const a = await openBoth();
    await dirty(a.round);
    await expect(
      settleSafety(
        a.round,
        sweepPorts(a.round, { verifyMuted: () => Promise.reject(new RsiLockError('lock_lost')) }),
        createRoundBudget(a.round, { startRollbackLimit: 3 }),
      ),
    ).rejects.toBeInstanceOf(RsiLockError);
    const b = await openBoth();
    await dirty(b.round);
    const r = await settleSafety(
      b.round,
      sweepPorts(b.round, { verifyMuted: () => Promise.reject(new Error('io')) }),
      createRoundBudget(b.round, { startRollbackLimit: 3 }),
    );
    expect(r.kind).toBe('unsettled');
    if (r.kind === 'unsettled') expect(r.faults).toEqual([{ code: 'step_threw', detail: 'Error' }]);
  });

  it('port_call_budget_exceeded_is_fault:预算已用满 → 扫尾那一步记 internal 故障 + 预算未决,整体未决;不调端口', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const budget = createRoundBudget(round, { startRollbackLimit: 3 });
    budget.charge('enforceMute');
    budget.charge('enforceMute');
    const p = sweepPorts(round);
    const r = await settleSafety(round, p, budget);
    expect(r.kind).toBe('unsettled');
    expect(p.calls).toEqual(['reconcileCaches', 'verifyMuted']);
    expect(round.unsettled()).toEqual(['budget_exceeded:enforceMute', 'safety_not_settled']);
    if (r.kind === 'unsettled')
      expect(r.faults).toEqual([{ code: 'internal', detail: 'budget_exceeded:enforceMute' }]);
  });

  it('忙 / 故障轮(rsi-only 回合)同样适用:一次扫尾', async () => {
    const { round } = await openBusy();
    await dirty(round);
    const p = sweepPorts(round);
    const r = await settleSafety(round, p, createRoundBudget(round));
    expect(r).toEqual({ kind: 'settled', swept: true });
    expect(p.calls).toEqual(['enforceMute', 'reconcileCaches', 'verifyMuted']);
  });

  it('dirty_flag_distinct_from_gen:只有 gen 变化(无脏写)→ 不扫;只有脏写 → 扫(两者互不推出)', async () => {
    const a = await openBoth();
    await a.round.writeAdapter('effects', () => Promise.resolve())();
    expect(a.round.gen()).toBe(1);
    const pa = sweepPorts(a.round);
    await settleSafety(a.round, pa, createRoundBudget(a.round, { startRollbackLimit: 1 }));
    expect(pa.calls).toEqual([]);
    const b = await openBoth();
    await dirty(b.round);
    const pb = sweepPorts(b.round);
    await settleSafety(b.round, pb, createRoundBudget(b.round, { startRollbackLimit: 1 }));
    expect(pb.calls.length).toBe(3);
  });
});
