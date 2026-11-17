/**
 * C2 S2 / 污染扫描 / 压缩调度 / 单次扫尾的编排(端口全为假件;每条新不变量一个负向用例)。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { PersonalLockLost } from '../../../src/rsi/personal/stage/errors.js';
import type {
  Compactor,
  ReducePort,
  SafetyPort,
  StepOutcome,
} from '../../../src/rsi/personal/stage/ports.js';
import { createRoundBudget } from '../../../src/rsi/personal/stage/settle.js';
import type { TaintCandidate } from '../../../src/rsi/personal/stage/taint-types.js';
import { runCompaction } from '../../../src/rsi/personal/steps/compact-sched.js';
import { runS2P, runS2R, runTRsi } from '../../../src/rsi/personal/steps/s2-reduce.js';
import {
  START_ROLLBACK_LIMIT,
  type CandidateListing,
  type PurgeJournalFacts,
  type RunTaintState,
  type S2Ports,
  type StagingBound,
} from '../../../src/rsi/personal/steps/steps-types.js';
import { createTaintScanner } from '../../../src/rsi/personal/steps/taint-scan.js';
import { UNAVAILABLE_JUDGE } from '../../../src/rsi/personal/judge-slot.js';
import { cand, openBoth, openBusy } from '../stage/c1-fixture.js';

const DONE: StepOutcome = { kind: 'done' };

function s2ports(
  over: {
    listing?: CandidateListing;
    log?: string[];
    reduce?: Partial<ReducePort>;
    safety?: Partial<SafetyPort>;
    scan?: S2Ports['scanner'];
  } = {},
): S2Ports {
  const log = over.log ?? [];
  const reduce: ReducePort = {
    applyTaint: async () => (log.push('applyTaint'), DONE),
    runAnalysis: async () => (log.push('analysis'), DONE),
    expireCandidates: async () => (log.push('expire'), DONE),
    reconcileRevocations: async () => (log.push('reconcile'), DONE),
    evaluateTriggers: async () => (log.push('triggers'), []),
    tripAndMute: async (r) => (log.push(`trip:${r.join('+')}`), { tripped: true, mute: 'muted' }),
    applyAutoRelease: async () => (log.push('release'), DONE),
    startRollback: async () => DONE,
    ...over.reduce,
  };
  const safety: SafetyPort = {
    enforceMute: async () => ({ mute: 'nothing', fault: null }),
    reconcileCaches: async () => (log.push('caches'), DONE),
    verifyMuted: async () => ({ ok: true }),
    evaluateRsiTriggers: async () => [],
    tripAndMute: async () => ({ tripped: false, mute: 'nothing' }),
    stopExistingInjection: async (c) => (log.push(`stop:${c}`), 'muted'),
    ...over.safety,
  };
  return {
    reduce,
    safety,
    scanner: over.scan ?? {
      scan: async () => (log.push('scan'), { kind: 'ok', tainted: [], unknown: [] }),
    },
    candidates: {
      list: async () => (
        log.push('list'),
        over.listing ?? { kind: 'ok', cands: [], canaryIds: [] }
      ),
    },
    rescan: { rescan: async () => (log.push('rescan'), DONE) },
    judge: UNAVAILABLE_JUDGE.reduce,
  };
}
const budget = async () => {
  const w = await openBoth();
  return { w, b: createRoundBudget(w.round, { startRollbackLimit: START_ROLLBACK_LIMIT }) };
};

describe('runS2P 顺序与「唯一一次」', () => {
  it('顺序:污染 → 分析(有 canary)→ 到期 → 对账 → 触发 → 解除;触发评估 / 自动解除各恰一次', async () => {
    const log: string[] = [];
    const { w, b } = await budget();
    const r = await runS2P({
      ports: s2ports({ log, listing: { kind: 'ok', cands: [cand()], canaryIds: ['ra_1'] } }),
      round: w.round,
      budget: b,
      l0DueNow: false,
      tripSeed: [],
    });
    expect(log).toEqual(['list', 'scan', 'analysis', 'expire', 'reconcile', 'triggers', 'release']);
    expect(r.faults).toEqual([]);
    expect(b.used('evaluateTriggers')).toBe(1);
    expect(b.used('applyAutoRelease')).toBe(1);
  });

  it('exclude_rescan_only_when_due:仅 l0DueNow 的轮在扫描前先重扫', async () => {
    for (const due of [false, true]) {
      const log: string[] = [];
      const { w, b } = await budget();
      await runS2P({
        ports: s2ports({ log }),
        round: w.round,
        budget: b,
        l0DueNow: due,
        tripSeed: [],
      });
      expect(log.includes('rescan'), String(due)).toBe(due);
      if (due) expect(log.indexOf('rescan')).toBeLessThan(log.indexOf('scan'));
    }
  });

  it('无 canary 记录 → 不跑分析链', async () => {
    const log: string[] = [];
    const { w, b } = await budget();
    await runS2P({
      ports: s2ports({ log }),
      round: w.round,
      budget: b,
      l0DueNow: false,
      tripSeed: [],
    });
    expect(log).not.toContain('analysis');
  });

  it('命中污染 → applyTaint(凭据先于转移的实现在端口里);unknown 的 canary → 只停注入(不转移)', async () => {
    const log: string[] = [];
    const { w, b } = await budget();
    const t = cand({ id: 'ra_aaaaaaaaaaaa' });
    await runS2P({
      ports: s2ports({
        log,
        listing: { kind: 'ok', cands: [t], canaryIds: ['ra_bbbbbbbbbbbb'] },
        scan: {
          scan: async () => ({
            kind: 'ok',
            tainted: [t],
            unknown: [{ id: 'ra_bbbbbbbbbbbb', why: 'source_missing' }],
          }),
        },
      }),
      round: w.round,
      budget: b,
      l0DueNow: false,
      tripSeed: [],
    });
    expect(log).toContain('applyTaint');
    expect(log).toContain('stop:source_unknown');
    // unknown 的非 canary 候选不触发停注入
    const log2: string[] = [];
    const x = await budget();
    await runS2P({
      ports: s2ports({
        log: log2,
        listing: { kind: 'ok', cands: [], canaryIds: [] },
        scan: {
          scan: async () => ({
            kind: 'ok',
            tainted: [],
            unknown: [{ id: 'ra_cccccccccccc', why: 'run_dir_missing' }],
          }),
        },
      }),
      round: x.w.round,
      budget: x.b,
      l0DueNow: false,
      tripSeed: [],
    });
    expect(log2).not.toContain('stop:source_unknown');
  });

  it('扫描 unavailable → 故障、不判、不 applyTaint;其余步照跑', async () => {
    const log: string[] = [];
    const { w, b } = await budget();
    const r = await runS2P({
      ports: s2ports({
        log,
        scan: { scan: async () => ({ kind: 'unavailable', why: 'journal_invalid' }) },
      }),
      round: w.round,
      budget: b,
      l0DueNow: false,
      tripSeed: [],
    });
    expect(log).not.toContain('applyTaint');
    expect(log).toContain('release');
    expect(r.faults).toContainEqual({
      code: 'step_halted',
      detail: 'taint_unavailable:journal_invalid',
    });
  });

  it('S1 的 personal_repo_invalid 与触发评估的码合并成**一次** tripAndMute;无码不调', async () => {
    const log: string[] = [];
    const { w, b } = await budget();
    await runS2P({
      ports: s2ports({ log, reduce: { evaluateTriggers: async () => ['user_vetoes'] } }),
      round: w.round,
      budget: b,
      l0DueNow: false,
      tripSeed: ['personal_repo_invalid'],
    });
    expect(log.filter((x) => x.startsWith('trip:'))).toEqual([
      'trip:personal_repo_invalid+user_vetoes',
    ]);
    expect(b.used('tripAndMute')).toBe(1);
    const log2: string[] = [];
    const y = await budget();
    await runS2P({
      ports: s2ports({ log: log2 }),
      round: y.w.round,
      budget: y.b,
      l0DueNow: false,
      tripSeed: [],
    });
    expect(log2.some((x) => x.startsWith('trip:'))).toBe(false);
  });

  it('候选列表不可用 → 故障;污染 / 分析不做,到期 / 对账 / 触发 / 解除仍做(减影响必须跑)', async () => {
    const log: string[] = [];
    const { w, b } = await budget();
    const r = await runS2P({
      ports: s2ports({ log, listing: { kind: 'unavailable', why: 'repo_invalid' } }),
      round: w.round,
      budget: b,
      l0DueNow: true,
      tripSeed: [],
    });
    expect(log).toEqual(['list', 'expire', 'reconcile', 'triggers', 'release']);
    expect(r.faults).toContainEqual({
      code: 'step_halted',
      detail: 'candidates_unavailable:repo_invalid',
    });
  });

  it('隔离:某步抛错 → 记故障、后面照跑;个人失锁 → ended 且后面不跑;rsi 失锁原样上抛', async () => {
    const log: string[] = [];
    const { w, b } = await budget();
    const r = await runS2P({
      ports: s2ports({
        log,
        reduce: { expireCandidates: async () => Promise.reject(new Error('x')) },
      }),
      round: w.round,
      budget: b,
      l0DueNow: false,
      tripSeed: [],
    });
    expect(r.faults.some((f) => f.code === 'step_threw')).toBe(true);
    expect(log).toContain('release');
    const log2: string[] = [];
    const y = await budget();
    const r2 = await runS2P({
      ports: s2ports({
        log: log2,
        reduce: { runAnalysis: async () => Promise.reject(new PersonalLockLost()) },
        listing: { kind: 'ok', cands: [], canaryIds: ['ra_1'] },
      }),
      round: y.w.round,
      budget: y.b,
      l0DueNow: false,
      tripSeed: [],
    });
    expect(r2.ended).toBe(true);
    expect(log2).not.toContain('release');
    const z = await budget();
    await expect(
      runS2P({
        ports: s2ports({
          reduce: { tripAndMute: async () => Promise.reject(new RsiLockError('lock_lost')) },
          safety: {},
          listing: { kind: 'ok', cands: [], canaryIds: [] },
          scan: undefined,
        }),
        round: z.w.round,
        budget: z.b,
        l0DueNow: false,
        tripSeed: ['gate_internal'],
      }),
    ).rejects.toBeInstanceOf(RsiLockError);
  });

  it('halt 前缀:repo_invalid 类 → step_integrity 未决;lock_lost → 未决 lock_loss_unresolved', async () => {
    const { w, b } = await budget();
    const r = await runS2P({
      ports: s2ports({
        reduce: {
          reconcileRevocations: async () => ({ kind: 'incomplete', why: 'halt:repo_invalid' }),
          expireCandidates: async () => ({ kind: 'incomplete', why: 'halt:lock_lost' }),
        },
      }),
      round: w.round,
      budget: b,
      l0DueNow: false,
      tripSeed: [],
    });
    expect(r.unsettled).toContain('step_integrity:repo_invalid');
    expect(r.unsettled).toContain('lock_loss_unresolved');
  });
});

describe('S2R / T_rsi', () => {
  it('S2R:reconcileCaches 恰一次;T_rsi:命中码才 trip,且预算 ≤1', async () => {
    const w = await openBusy();
    const b = createRoundBudget(w.round);
    const log: string[] = [];
    await runS2R({ safety: s2ports({ log }).safety, budget: b });
    expect(log).toEqual(['caches']);
    const calls: string[] = [];
    await runTRsi({
      safety: {
        evaluateRsiTriggers: async () => ['no_observation'],
        tripAndMute: async (r) => (calls.push(r.join()), { tripped: true, mute: 'muted' }),
      },
      budget: b,
    });
    expect(calls).toEqual(['no_observation']);
    // 无命中不 trip
    const c2: string[] = [];
    const w2 = await openBusy();
    await runTRsi({
      safety: {
        evaluateRsiTriggers: async () => [],
        tripAndMute: async () => (c2.push('x'), { tripped: false, mute: 'nothing' }),
      },
      budget: createRoundBudget(w2.round),
    });
    expect(c2).toEqual([]);
  });

  it('忙 / 故障轮预算:自动解除 0 次、setFlagAndMute 0 次(调用即 RoundInternalError)', async () => {
    const w = await openBusy();
    const b = createRoundBudget(w.round);
    expect(b.limit('applyAutoRelease')).toBe(0);
    expect(() => b.charge('applyAutoRelease')).toThrow();
  });
});

describe('污染扫描器(TaintScanner)', () => {
  const facts = (
    o: {
      journal?: PurgeJournalFacts;
      runs?: Record<string, RunTaintState>;
      bound?: StagingBound;
    } = {},
  ) => ({
    journal: async () => o.journal ?? ({ kind: 'absent' } as const),
    runState: async (id: string) => o.runs?.[id] ?? 'clean',
    stagingBound: async () => o.bound ?? 'ok',
  });
  const src = (run: string) => ({ run_id: run, proposal_id: 'p' });
  it('标记命中 → tainted;journal 目标命中 → tainted(目录已被清走也是);clean 不入', async () => {
    const { w } = await budget();
    const a = cand({ id: 'ra_a', source: src('r1') });
    const b2 = cand({ id: 'ra_b', source: src('r2') });
    const c3 = cand({ id: 'ra_c', source: src('r3') });
    const s = createTaintScanner(
      facts({
        journal: { kind: 'ok', runs: ['r2'] },
        runs: { r1: 'tainted', r2: 'missing', r3: 'clean' },
      }),
    );
    const r = await s.scan(w.round, [a, b2, c3]);
    expect(r).toMatchObject({ kind: 'ok', unknown: [] });
    expect(r.kind === 'ok' ? r.tainted.map((x) => x.id) : []).toEqual(['ra_a', 'ra_b']);
  });
  it('unknown 三态不当 clean、不当 tainted:来源缺失 / run 目录不存在 / 标记读不出', async () => {
    const { w } = await budget();
    const s = createTaintScanner(facts({ runs: { r2: 'missing', r3: 'unreadable' } }));
    const r = await s.scan(w.round, [
      cand({ id: 'ra_a', source: null }),
      cand({ id: 'ra_b', source: undefined }),
      cand({ id: 'ra_c', source: src('r2') }),
      cand({ id: 'ra_d', source: src('r3') }),
    ]);
    expect(r).toEqual({
      kind: 'ok',
      tainted: [],
      unknown: [
        { id: 'ra_a', why: 'source_missing' },
        { id: 'ra_b', why: 'source_missing' },
        { id: 'ra_c', why: 'run_dir_missing' },
        { id: 'ra_d', why: 'mark_unreadable' },
      ],
    });
  });
  it('journal invalid / unreadable、暂存区超限 / 不可信 → unavailable(不臆测任何候选干净)', async () => {
    const { w } = await budget();
    const c = [cand({ id: 'ra_a', source: src('r1') })];
    expect(
      await createTaintScanner(facts({ journal: { kind: 'invalid' } })).scan(w.round, c),
    ).toEqual({ kind: 'unavailable', why: 'journal_invalid' });
    expect(
      await createTaintScanner(facts({ journal: { kind: 'unreadable' } })).scan(w.round, c),
    ).toEqual({ kind: 'unavailable', why: 'journal_unreadable' });
    expect(await createTaintScanner(facts({ bound: 'too_large' })).scan(w.round, c)).toEqual({
      kind: 'unavailable',
      why: 'staging_too_large',
    });
    for (const bound of ['unsafe_entry', 'untrusted'] as const) {
      expect(await createTaintScanner(facts({ bound })).scan(w.round, c)).toEqual({
        kind: 'unavailable',
        why: 'rsi_dir_untrusted',
      });
    }
  });
  it('扫描器只读:不调用任何写方法(端口里没有写成员)', async () => {
    const f = facts();
    expect(Object.keys(f).sort()).toEqual(['journal', 'runState', 'stagingBound']);
  });
});

describe('压缩调度', () => {
  const comp = (r: unknown | Error): Compactor => ({
    compact: async () => {
      if (r instanceof Error) throw r;
      return r as never;
    },
  });
  it('缺省(B1b 未装配)= compact_unwired,不是故障、不未决', async () => {
    const { w } = await budget();
    expect(await runCompaction(undefined, w.round)).toMatchObject({
      logCode: 'compact_unwired',
      fault: null,
      unsettled: [],
      storeFull: false,
    });
  });
  it('noop / compacted 无事;audit_full / effects_full → storeFull(不未决、不停 S2);region_open / store_io / 非法 / 抛错 → 未决 compaction_failed', async () => {
    const { w } = await budget();
    for (const k of ['noop', 'compacted']) {
      expect(await runCompaction(comp({ kind: k }), w.round)).toMatchObject({
        logCode: null,
        unsettled: [],
      });
    }
    for (const cause of ['audit_full', 'effects_full']) {
      expect(await runCompaction(comp({ kind: 'compact_blocked', cause }), w.round)).toMatchObject({
        logCode: `compact_${cause}`,
        storeFull: true,
        unsettled: [],
      });
    }
    for (const cause of ['region_open', 'store_io']) {
      expect(await runCompaction(comp({ kind: 'compact_blocked', cause }), w.round)).toMatchObject({
        storeFull: false,
        unsettled: ['compaction_failed'],
      });
    }
    expect(await runCompaction(comp({ kind: 'weird' }), w.round)).toMatchObject({
      unsettled: ['compaction_failed'],
    });
    expect(await runCompaction(comp(new Error('x')), w.round)).toMatchObject({
      unsettled: ['compaction_failed'],
      fault: { code: 'step_threw' },
    });
  });
  it('个人失锁 → ended;rsi 失锁原样上抛', async () => {
    const { w } = await budget();
    expect(await runCompaction(comp(new PersonalLockLost()), w.round)).toMatchObject({
      ended: true,
    });
    await expect(
      runCompaction(comp(new RsiLockError('lock_lost')), w.round),
    ).rejects.toBeInstanceOf(RsiLockError);
  });
});

describe('常量', () => {
  it('START_ROLLBACK_LIMIT = 4(全局评估名额 1 × 三个调用方 + 1 个 S1 对账余量);变动 = 回主代理', () => {
    expect(START_ROLLBACK_LIMIT).toBe(4);
  });
});
