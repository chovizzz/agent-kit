/**
 * C1b:监测信号的判定内核(`stage/residual.ts`,纯函数)。四个信号逐个有成立 / 不成立 / 边界夹具;输入是已探测好的只读事实,函数本身不做 I/O。
 * 本文件只证明判定内核;采集端与承载入口 = doctor D18(W0-29 ⑥;`test/rsi/c2/c2-doctor-d18.test.ts`)。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateSafetyResidual,
  type ResidualFacts,
} from '../../../src/rsi/personal/stage/residual.js';
import { MONITOR_THRESHOLDS } from '../../../src/rsi/personal/stage/monitoring.js';

const NOW = 1_800_000_000_000;
const base: ResidualFacts = {
  nowMs: NOW,
  lock: 'free',
  skippedLockedTail: { count: 0, firstAtMs: null, lastAtMs: null },
  state: {
    breakerKind: null,
    breakerOpen: false,
    pauseReasonsNonEmpty: false,
    flagsSet: false,
    lastTickCompletedAtMs: NOW - 1000,
    rsiOn: true,
  },
  canary: { agentsInjectNonEmpty: false },
  markers: { B: false, U: false },
  hintReadsPauseState: false,
};
const withState = (o: Partial<NonNullable<ResidualFacts['state']>>): ResidualFacts => ({
  ...base,
  state: { ...(base.state as NonNullable<ResidualFacts['state']>), ...o },
});

describe('lock_starvation', () => {
  const tail = (n: number, span: number): ResidualFacts['skippedLockedTail'] => ({
    count: n,
    firstAtMs: NOW - span,
    lastAtMs: NOW,
  });
  const span = MONITOR_THRESHOLDS.skippedLockedMinSpanMs;
  it('held_over_ttl / stale + ≥3 条 + 跨度 ≥ 30 分钟 → 成立', () => {
    for (const lock of ['held_over_ttl', 'stale']) {
      expect(evaluateSafetyResidual({ ...base, lock, skippedLockedTail: tail(3, span) })).toEqual([
        'lock_starvation',
      ]);
    }
  });
  it('任一条件差一点就不成立:条数 2、跨度差 1ms、锁 held / free、尾部无时刻', () => {
    expect(
      evaluateSafetyResidual({ ...base, lock: 'held_over_ttl', skippedLockedTail: tail(2, span) }),
    ).toEqual([]);
    expect(
      evaluateSafetyResidual({
        ...base,
        lock: 'held_over_ttl',
        skippedLockedTail: tail(3, span - 1),
      }),
    ).toEqual([]);
    for (const lock of ['held', 'free', 'unsafe']) {
      expect(
        evaluateSafetyResidual({ ...base, lock, skippedLockedTail: tail(9, span * 3) }),
      ).toEqual([]);
    }
    expect(
      evaluateSafetyResidual({
        ...base,
        lock: 'stale',
        skippedLockedTail: { count: 5, firstAtMs: null, lastAtMs: null },
      }),
    ).toEqual([]);
  });
});

describe('safety_breaker_inject', () => {
  it('breaker.kind=safety ∧ canary 仍可注入 ∧ B/U 皆不在 → 成立', () => {
    expect(
      evaluateSafetyResidual({
        ...withState({ breakerKind: 'safety', breakerOpen: true }),
        canary: { agentsInjectNonEmpty: true },
      }),
    ).toEqual(['safety_breaker_inject']);
  });
  it('B 或 U 在 / canary 已不注入 / canary 缺失 / 非 safety / state 读不出 → 不成立', () => {
    const inject = { agentsInjectNonEmpty: true };
    const s = withState({ breakerKind: 'safety', breakerOpen: true });
    expect(
      evaluateSafetyResidual({ ...s, canary: inject, markers: { B: true, U: false } }),
    ).toEqual([]);
    expect(
      evaluateSafetyResidual({ ...s, canary: inject, markers: { B: false, U: true } }),
    ).toEqual([]);
    expect(evaluateSafetyResidual({ ...s, canary: { agentsInjectNonEmpty: false } })).toEqual([]);
    expect(evaluateSafetyResidual({ ...s, canary: null })).toEqual([]);
    expect(
      evaluateSafetyResidual({
        ...withState({ breakerKind: 'other', breakerOpen: true }),
        canary: inject,
      }),
    ).toEqual([]);
    expect(evaluateSafetyResidual({ ...base, state: null, canary: inject })).toEqual([]);
  });
});

describe('p_heartbeat_approx', () => {
  const max = MONITOR_THRESHOLDS.lastTickMaxAgeMs;
  it('last_tick 年龄 > 24 小时 ∧ rsi on ∧ 熔断未打开 → 成立(严格大于)', () => {
    expect(evaluateSafetyResidual(withState({ lastTickCompletedAtMs: NOW - max - 1 }))).toEqual([
      'p_heartbeat_approx',
    ]);
    expect(evaluateSafetyResidual(withState({ lastTickCompletedAtMs: NOW - max }))).toEqual([]);
  });
  it('rsi 未开 / 熔断已打开 / 从未完成过(null)→ 不成立', () => {
    const old = NOW - max - 1;
    expect(evaluateSafetyResidual(withState({ lastTickCompletedAtMs: old, rsiOn: false }))).toEqual(
      [],
    );
    expect(
      evaluateSafetyResidual(withState({ lastTickCompletedAtMs: old, breakerOpen: true })),
    ).toEqual([]);
    expect(evaluateSafetyResidual(withState({ lastTickCompletedAtMs: null }))).toEqual([]);
  });
});

describe('state_written_not_muted(仅「hint 读 state」未采纳时计入)', () => {
  const inject = { agentsInjectNonEmpty: true };
  it('暂停码或标志 ∧ canary 可注入 ∧ B/U 皆不在 → 成立', () => {
    for (const o of [{ pauseReasonsNonEmpty: true }, { flagsSet: true }]) {
      expect(evaluateSafetyResidual({ ...withState(o), canary: inject })).toEqual([
        'state_written_not_muted',
      ]);
    }
  });
  it('已采纳问题 1(hintReadsPauseState)/ 有标记 / canary 不注入 / state 读不出 → 不成立', () => {
    const s = withState({ pauseReasonsNonEmpty: true });
    expect(evaluateSafetyResidual({ ...s, canary: inject, hintReadsPauseState: true })).toEqual([]);
    expect(
      evaluateSafetyResidual({ ...s, canary: inject, markers: { B: true, U: false } }),
    ).toEqual([]);
    expect(evaluateSafetyResidual({ ...s, canary: { agentsInjectNonEmpty: false } })).toEqual([]);
    expect(evaluateSafetyResidual({ ...base, state: null, canary: inject })).toEqual([]);
  });
  it('正常状态(无任何成立条件)→ 空集', () => {
    expect(evaluateSafetyResidual(base)).toEqual([]);
  });
});
