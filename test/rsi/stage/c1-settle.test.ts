/**
 * C1a:`settleSafety` 单次扫尾协议(C v2 §4.3)——脏则重入 = 固定的一次扫尾,不循环、不重跑触发 / 自动解除;`safetyDirty` 与 `gen` 分开。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { PersonalLockLost } from '../../../src/rsi/personal/stage/errors.js';
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
    expect(again).toEqual({ kind: 'settled', swept: true }); // 已扫过:原样返回先前结果,不再扫
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
    expect(await settleSafety(round, p, budget)).toEqual({ kind: 'settled', swept: true });
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

  it('settle_once_per_round_failure_not_retried:失败后再调用 → 不再扫(先前的未决结果原样返回,脏标记保持置位),端口与预算都不再被动用', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const budget = createRoundBudget(round, { startRollbackLimit: 3 });
    const p = sweepPorts(round, {
      verifyMuted: () => {
        p.calls.push('verifyMuted');
        return Promise.resolve({ ok: false, why: 'unreadable' });
      },
    });
    const first = await settleSafety(round, p, budget);
    expect(first.kind).toBe('unsettled');
    const second = await settleSafety(round, p, budget);
    expect(second).toBe(first); // 同一个结果对象
    // 用一个全新的预算 + 全新的端口也绕不过:状态在回合上
    const p2 = sweepPorts(round);
    const third = await settleSafety(
      round,
      p2,
      createRoundBudget(round, { startRollbackLimit: 3 }),
    );
    expect(third).toBe(first);
    expect(p2.calls).toEqual([]);
    expect(p.calls.length).toBe(3);
    expect(budget.used('enforceMute')).toBe(1);
    expect(round.safetyDirty.isDirty()).toBe(true);
  });

  it('settle_concurrent_call_shares_in_flight_result:进行中再调用 → 等同一个结果(不会因脏标记已被取走而提前报 settled)', async () => {
    const { round } = await openBoth();
    await dirty(round);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = sweepPorts(round, {
      enforceMute: async () => {
        p.calls.push('enforceMute');
        await gate;
        return { mute: 'unreliable', fault: 'mute_unreliable' };
      },
    });
    const budget = createRoundBudget(round, { startRollbackLimit: 3 });
    const a = settleSafety(round, p, budget);
    const b = settleSafety(round, p, budget);
    expect(b).toBe(a);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.kind).toBe('unsettled'); // 第二个调用方也看到最终的失败,而不是「settled」
    expect(rb).toBe(ra);
    expect(p.calls.filter((c) => c === 'enforceMute').length).toBe(1);
  });

  it('首次调用时脏标记为空不算「已扫过」:其后真有脏写时仍可扫这一次;扫完成功后再出现新的脏写 → unsettled(不重扫)', async () => {
    const { round } = await openBoth();
    const budget = createRoundBudget(round, { startRollbackLimit: 3 });
    const p = sweepPorts(round);
    expect(await settleSafety(round, p, budget)).toEqual({ kind: 'settled', swept: false });
    expect(p.calls).toEqual([]);
    await dirty(round);
    expect(await settleSafety(round, p, budget)).toEqual({ kind: 'settled', swept: true });
    expect(p.calls.length).toBe(3);
    await dirty(round); // 扫尾之后又出现脏写
    const late = await settleSafety(round, p, budget);
    expect(late).toEqual({ kind: 'unsettled', reason: 'safety_not_settled', faults: [] });
    expect(p.calls.length).toBe(3); // 没有第二次扫尾
    expect(round.unsettled()).toContain('safety_not_settled');
  });

  it('settle_rejection_is_terminal:首次扫尾遇 rsi 失锁上抛 → 之后每次调用都得到同一个 rejection(不降级成普通 unsettled),端口零调用', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const lost = new RsiLockError('lock_lost');
    const p = sweepPorts(round, {
      enforceMute: () => {
        p.calls.push('enforceMute');
        return Promise.reject(lost);
      },
    });
    const budget = createRoundBudget(round, { startRollbackLimit: 3 });
    await expect(settleSafety(round, p, budget)).rejects.toBe(lost);
    const p2 = sweepPorts(round);
    await expect(
      settleSafety(round, p2, createRoundBudget(round, { startRollbackLimit: 3 })),
    ).rejects.toBe(lost);
    await expect(settleSafety(round, p, budget)).rejects.toBe(lost);
    expect(p2.calls).toEqual([]);
    expect(p.calls).toEqual(['enforceMute']);
  });

  it('settle_sync_prefix_reentry_shares_final_result:扫尾端口的同步前缀重入 settleSafety → 拿到的是最终的共享结果,不是占位的「已收敛」', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const budget = createRoundBudget(round, { startRollbackLimit: 3 });
    let inner: Promise<unknown> | undefined;
    const p = sweepPorts(round, {
      enforceMute: () => {
        p.calls.push('enforceMute');
        inner = settleSafety(round, p, budget); // 同步前缀内重入
        return Promise.resolve({ mute: 'unreliable', fault: 'mute_unreliable' });
      },
    });
    const outer = settleSafety(round, p, budget);
    expect(inner).toBe(outer);
    const r = await outer;
    expect(r.kind).toBe('unsettled'); // 最终失败,而不是重入者先看到的 settled
    expect(await inner).toBe(r);
    expect(p.calls.filter((c) => c === 'enforceMute').length).toBe(1);
  });
});

describe('settleSafety · H1:扫尾不吞个人失锁(PersonalLockLost 是终态,同一个错误对象向外传播)', () => {
  const step = ['enforceMute', 'reconcileCaches', 'verifyMuted'] as const;
  for (const at of step) {
    it(`${at} 抛 PersonalLockLost → 立即停止余下步骤、放回脏标记、本轮 unsettled,以同一错误对象拒绝;再调用得到同一个 rejection(端口零调用)`, async () => {
      const { round } = await openBoth();
      await dirty(round);
      const lost = new PersonalLockLost();
      const throwing = (): Promise<never> => Promise.reject(lost);
      // 只覆盖出错的那一个端口(不把其它端口显式设成 undefined)
      const over = {
        [at]: () => {
          p.calls.push(at);
          return throwing();
        },
      } as unknown as Partial<SweepPorts>;
      const p = sweepPorts(round, over);
      const budget = createRoundBudget(round, { startRollbackLimit: 3 });
      await expect(settleSafety(round, p, budget)).rejects.toBe(lost);
      // 失锁之后不再调用后面的步骤
      expect(p.calls).toEqual(step.slice(0, step.indexOf(at) + 1));
      expect(round.safetyDirty.kinds()).toEqual(['trip']); // 脏标记放回
      expect(round.unsettled()).toEqual(['safety_not_settled']);
      const p2 = sweepPorts(round);
      await expect(
        settleSafety(round, p2, createRoundBudget(round, { startRollbackLimit: 3 })),
      ).rejects.toBe(lost);
      await expect(settleSafety(round, p, budget)).rejects.toBe(lost);
      expect(p2.calls).toEqual([]);
    });
  }
  it('正向对照:普通错误仍尽力跑完后续步骤并以 unsettled 返回(不拒绝);rsi 失锁同样上抛但不另标未决', async () => {
    const a = await openBoth();
    await dirty(a.round);
    const pa = sweepPorts(a.round, { enforceMute: () => Promise.reject(new Error('io')) });
    const r = await settleSafety(
      a.round,
      pa,
      createRoundBudget(a.round, { startRollbackLimit: 3 }),
    );
    expect(r.kind).toBe('unsettled');
    expect(pa.calls).toEqual(['reconcileCaches', 'verifyMuted']);
    const b = await openBoth();
    await dirty(b.round);
    const rsiLost = new RsiLockError('lock_lost');
    const pb = sweepPorts(b.round, { enforceMute: () => Promise.reject(rsiLost) });
    await expect(
      settleSafety(b.round, pb, createRoundBudget(b.round, { startRollbackLimit: 3 })),
    ).rejects.toBe(rsiLost);
    expect(b.round.unsettled()).toEqual([]);
  });
});

describe('settleSafety · M4:扫尾只豁免「自己发起的写」,窗口内并发的其它写照常置脏', () => {
  interface Gate {
    readonly ports: SweepPorts;
    readonly entered: Promise<void>;
    release(): void;
  }
  /** verifyMuted 挂起在 gate 上;`entered` 在核验已开始(读取已发起)后兑现 */
  function gated(round: BothRound): Gate {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const base = sweepPorts(round, {
      verifyMuted: async () => {
        enter();
        await gate;
        return { ok: true };
      },
    });
    return { ports: base, entered, release };
  }
  it('核验等待期间(测试自己的上下文)发起 state_pause_flag 写 → 脏标记非空 → unsettled(不是 settled),脏标记保持置位', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const g = gated(round);
    const pending = settleSafety(
      round,
      g.ports,
      createRoundBudget(round, { startRollbackLimit: 3 }),
    );
    await g.entered;
    await round.writeAdapter('state_pause_flag', () => Promise.resolve())(); // 不在扫尾上下文内
    g.release();
    expect(await pending).toEqual({ kind: 'unsettled', reason: 'safety_not_settled', faults: [] });
    expect([...round.safetyDirty.kinds()].sort()).toEqual(['state_pause_flag', 'trip']);
    expect(round.unsettled()).toEqual(['safety_not_settled']);
  });
  it('revocation 写同理;正向对照:同一流程无外部写 → settled', async () => {
    const a = await openBoth();
    await dirty(a.round);
    const ga = gated(a.round);
    const pa = settleSafety(
      a.round,
      ga.ports,
      createRoundBudget(a.round, { startRollbackLimit: 3 }),
    );
    await ga.entered;
    await a.round.writeAdapter('revocation', () => Promise.resolve())();
    ga.release();
    expect((await pa).kind).toBe('unsettled');
    const b = await openBoth();
    await dirty(b.round);
    const gb = gated(b.round);
    const pb = settleSafety(
      b.round,
      gb.ports,
      createRoundBudget(b.round, { startRollbackLimit: 3 }),
    );
    await gb.entered;
    gb.release();
    expect(await pb).toEqual({ kind: 'settled', swept: true });
    expect(b.round.safetyDirty.isDirty()).toBe(false);
  });
  it('扫尾端口调用链上(含跨 await / 定时器之后)的脏种类写仍是扫尾自己的写:不置脏', async () => {
    const { round } = await openBoth();
    await dirty(round);
    const p = sweepPorts(round, {
      enforceMute: async () => {
        await new Promise<void>((r) => setTimeout(r, 0));
        await round.writeAdapter('revocation', () => Promise.resolve())();
        return { mute: 'muted', fault: null };
      },
    });
    expect(
      await settleSafety(round, p, createRoundBudget(round, { startRollbackLimit: 3 })),
    ).toEqual({ kind: 'settled', swept: true });
    expect(round.safetyDirty.isDirty()).toBe(false);
  });
  it('一个回合的扫尾上下文不豁免另一个回合的写', async () => {
    const a = await openBoth();
    const b = await openBoth({ rsi: 'cccc3333cccc3333', personal: 'dddd4444dddd4444' });
    await dirty(a.round);
    const p = sweepPorts(a.round, {
      enforceMute: async () => {
        await b.round.writeAdapter('trip', () => Promise.resolve())(); // 另一回合的写
        return { mute: 'muted', fault: null };
      },
    });
    await settleSafety(a.round, p, createRoundBudget(a.round, { startRollbackLimit: 3 }));
    expect(b.round.safetyDirty.kinds()).toEqual(['trip']);
  });
});
