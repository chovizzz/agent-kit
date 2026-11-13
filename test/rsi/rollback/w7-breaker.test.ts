/**
 * R21-10 熔断 `auto_paused`:码表、触发(日期差口径)、只禁增加影响、自动解除与 resume 的区分、按期过滤、落地顺序与崩溃补做。
 */
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_PAUSE_REASONS, type RsiAutoPauseReason } from '../../../src/contracts/rsi.js';
import {
  NO_PAUSE,
  RSI_AUTO_RELEASE_REASONS,
  RSI_RESUME_RECHECK,
  applyAutoRelease,
  applyResume,
  autoRelease,
  enforceMute,
  evaluateTriggers,
  isAutoPaused,
  resume,
  tripAndMute,
  tripBreaker,
  type AutoPauseState,
  type BreakerDeps,
  type BreakerMarkerPort,
  type PauseMarker,
  type TriggerFacts,
} from '../../../src/rsi/personal/breaker.js';
import { transition, isRefusal } from '../../../src/rsi/personal/transition.js';
import { ctxFor, rec } from '../personal/transition-fixture.js';
import { V1A, V1B } from './w7-fixture.js';

const S = (reasons: RsiAutoPauseReason[], over: Partial<AutoPauseState> = {}): AutoPauseState => ({
  reasons,
  diverged: false,
  owner_changed: false,
  ...over,
});

const facts = (over: Partial<TriggerFacts> = {}): TriggerFacts => ({
  today: '2026-11-10',
  autoRollbackDays: [],
  proxyEventDays: [],
  vetoDays: [],
  lastObservedDay: '2026-11-09',
  l0HasRuns: true,
  budgetUsedPct: 10,
  budgetCausedByThisLoop: false,
  costOverLegacy: false,
  ...over,
});

describe('R21-10.2 触发条件(日期差口径:今天 − 事件日 < N)', () => {
  it('rollback_storm:30 个 UTC 日内自动回滚 ≥ 3 次;第 30 天前(差 29)算、差 30 不算;2 次不触发', () => {
    expect(
      evaluateTriggers(facts({ autoRollbackDays: ['2026-10-12', '2026-11-01', '2026-11-10'] })),
    ).toContain('rollback_storm'); // 差 29
    expect(
      evaluateTriggers(facts({ autoRollbackDays: ['2026-10-11', '2026-11-01', '2026-11-10'] })),
    ).not.toContain('rollback_storm'); // 差 30
    expect(
      evaluateTriggers(facts({ autoRollbackDays: ['2026-11-01', '2026-11-10'] })),
    ).not.toContain('rollback_storm');
  });
  it('rollback_storm:R21-7.12 上线代理事件 30 日内 ≥ 2 次触发,1 次不触发;未来日期不计', () => {
    expect(evaluateTriggers(facts({ proxyEventDays: ['2026-11-01', '2026-11-10'] }))).toContain(
      'rollback_storm',
    );
    expect(evaluateTriggers(facts({ proxyEventDays: ['2026-11-10'] }))).not.toContain(
      'rollback_storm',
    );
    expect(evaluateTriggers(facts({ proxyEventDays: ['2026-11-11', '2026-11-12'] }))).not.toContain(
      'rollback_storm',
    );
  });
  it('user_vetoes:7 个 UTC 日内 veto ≥ 2(差 6 算、差 7 不算)', () => {
    expect(evaluateTriggers(facts({ vetoDays: ['2026-11-04', '2026-11-10'] }))).toContain(
      'user_vetoes',
    );
    expect(evaluateTriggers(facts({ vetoDays: ['2026-11-03', '2026-11-10'] }))).not.toContain(
      'user_vetoes',
    );
  });
  it('no_observation:7 个 UTC 日无观测而 L0 有运行记录(差 7 触发、差 6 不触发;L0 无运行不触发;从未观测且 L0 有运行触发)', () => {
    expect(evaluateTriggers(facts({ lastObservedDay: '2026-11-03' }))).toContain('no_observation');
    expect(evaluateTriggers(facts({ lastObservedDay: '2026-11-04' }))).not.toContain(
      'no_observation',
    );
    expect(
      evaluateTriggers(facts({ lastObservedDay: '2026-11-01', l0HasRuns: false })),
    ).not.toContain('no_observation');
    expect(evaluateTriggers(facts({ lastObservedDay: null }))).toContain('no_observation');
  });
  it('budget_high_legacy:占用 ≥ 90% 且不是本代循环造成(89 不触发、本代造成不触发);cost_high_legacy 按遗留超限', () => {
    expect(evaluateTriggers(facts({ budgetUsedPct: 90 }))).toContain('budget_high_legacy');
    expect(evaluateTriggers(facts({ budgetUsedPct: 89 }))).not.toContain('budget_high_legacy');
    expect(
      evaluateTriggers(facts({ budgetUsedPct: 95, budgetCausedByThisLoop: true })),
    ).not.toContain('budget_high_legacy');
    expect(evaluateTriggers(facts({ costOverLegacy: true }))).toContain('cost_high_legacy');
    expect(evaluateTriggers(facts())).toEqual([]);
  });
});

describe('tripBreaker:码表、幂等、按期过滤', () => {
  it('触发 = 写入 reasons(按码表顺序、不重复);再次触发同一码 → already', () => {
    const a = tripBreaker(NO_PAUSE, 'user_vetoes', V1B);
    expect(a).toEqual({ kind: 'tripped', state: S(['user_vetoes']) });
    const b = tripBreaker(a.state, 'rollback_storm', V1B);
    expect(b.state.reasons).toEqual(['rollback_storm', 'user_vetoes']);
    expect(tripBreaker(b.state, 'user_vetoes', V1B).kind).toBe('already');
  });
  it('本期不发的码:apply_failed(V2)与 isolation_unverified(V6b)在 V1b 相位 → phase_not_available,状态不变', () => {
    for (const r of ['apply_failed', 'isolation_unverified'] as const) {
      expect(tripBreaker(NO_PAUSE, r, V1B)).toEqual({
        kind: 'phase_not_available',
        state: NO_PAUSE,
      });
    }
    expect(tripBreaker(NO_PAUSE, 'apply_failed', 4).kind).toBe('tripped');
  });
  it('rollback_storm 属 V1b:V1a 相位不发(W0-1 订正)', () => {
    expect(tripBreaker(NO_PAUSE, 'rollback_storm', V1A).kind).toBe('phase_not_available');
    expect(tripBreaker(NO_PAUSE, 'gate_internal', V1A).kind).toBe('tripped');
  });
  it('码表完整:12 个码,自动解除 4 个,其余 8 个只能 resume', () => {
    expect(RSI_AUTO_PAUSE_REASONS).toHaveLength(12);
    expect([...RSI_AUTO_RELEASE_REASONS].sort()).toEqual(
      ['budget_high_legacy', 'cost_high_legacy', 'isolation_unverified', 'no_observation'].sort(),
    );
    expect(Object.keys(RSI_RESUME_RECHECK).sort()).toEqual([...RSI_AUTO_PAUSE_REASONS].sort());
  });
});

describe('isAutoPaused:只看「有暂停原因」,diverged / owner_changed 与 AUTO_PAUSE 标记同样算', () => {
  it('四种来源各自成立,全无则不暂停', () => {
    expect(isAutoPaused(NO_PAUSE)).toBe(false);
    expect(isAutoPaused(S(['gate_internal']))).toBe(true);
    expect(isAutoPaused(S([], { diverged: true }))).toBe(true);
    expect(isAutoPaused(S([], { owner_changed: true }))).toBe(true);
    expect(isAutoPaused(NO_PAUSE, true)).toBe(true);
  });
});

describe('R21-10.1 只禁「增加影响」,撤销 / 减少影响的转移不受阻挡(与转移引擎联动)', () => {
  it('auto_paused=true:canary 上的 harm / veto / clear 仍进入 rolling_back', () => {
    const c = rec('canary');
    for (const ev of [
      { kind: 'harm', evidence: 'e', metric: 'c1', worse: true },
      { kind: 'veto', evidence: 'e' },
      { kind: 'clear', evidence: 'e' },
    ] as const) {
      const r = transition(c, ev, { ...ctxFor(c, { phase: V1B }), auto_paused: true });
      expect(isRefusal(r), ev.kind).toBe(false);
      if (!isRefusal(r)) expect(r.next.lifecycle).toBe('rolling_back');
    }
  });
});

describe('R21-10.4 自动解除与 resume 的区分', () => {
  it('worker 自动解除:只清条件已不成立的自动码;人工码不动;条件仍成立的自动码保留', () => {
    const s = S(['rollback_storm', 'budget_high_legacy', 'no_observation', 'cost_high_legacy']);
    const r = autoRelease(s, (c) => c === 'no_observation');
    expect(r.released.sort()).toEqual(['budget_high_legacy', 'cost_high_legacy']);
    expect(r.state.reasons).toEqual(['rollback_storm', 'no_observation']);
  });
  it('resume 只清人工码;自动码保留(交给 worker);diverged / owner_changed 不动', () => {
    const s = S(['redaction_changed', 'budget_high_legacy', 'user_vetoes'], {
      diverged: true,
      owner_changed: true,
    });
    const r = resume(s, () => false);
    expect(r.cleared.sort()).toEqual(['redaction_changed', 'user_vetoes']);
    expect(r.state).toEqual(S(['budget_high_legacy'], { diverged: true, owner_changed: true }));
    expect(r.blocked).toEqual([]);
  });
  it('resume:rollback_storm / gate_internal 重查四项,任一仍成立 → 保留并报 blocked(reason = 仍成立的码);都不成立 → 清除', () => {
    for (const code of ['rollback_storm', 'gate_internal'] as const) {
      for (const holding of [
        'gate_internal',
        'apply_failed',
        'personal_repo_invalid',
        'budget_high_legacy',
      ] as const) {
        const r = resume(S([code]), (c) => c === holding);
        expect(r.cleared, `${code}/${holding}`).toEqual([]);
        expect(r.blocked, `${code}/${holding}`).toEqual([{ code, reason: holding }]);
        expect(r.state.reasons).toEqual([code]);
      }
      expect(resume(S([code]), () => false).cleared).toEqual([code]);
    }
    // 不在四项内的码仍成立不阻挡 rollback_storm
    expect(resume(S(['rollback_storm']), (c) => c === 'no_observation').cleared).toEqual([
      'rollback_storm',
    ]);
  });
  it('resume:apply_failed / personal_repo_invalid 重查自己;其余人工码无条件可清', () => {
    expect(
      resume(S(['personal_repo_invalid']), (c) => c === 'personal_repo_invalid').blocked,
    ).toEqual([{ code: 'personal_repo_invalid', reason: 'personal_repo_invalid' }]);
    expect(resume(S(['apply_failed']), (c) => c === 'apply_failed').cleared).toEqual([]);
    expect(
      resume(
        S(['kit_major_changed', 'redaction_changed', 'user_vetoes']),
        () => true,
      ).cleared.sort(),
    ).toEqual(['kit_major_changed', 'redaction_changed', 'user_vetoes']);
  });
  it('W0-21:resume 不据 state 里的 user_paused 清码(判据是 U 存在,命令层处理);清掉熔断码且只剩 user_paused → 仍通知 worker 路径删 B;没清则不', () => {
    const only = resume(S(['user_paused']), () => false);
    expect(only.cleared).toEqual([]); // 原语义「清掉 user_paused」已废止
    expect(only.blocked).toEqual([]);
    expect(only.state.reasons).toEqual(['user_paused']);
    expect(only.clearMarker).toBe(false);
    expect(resume(S(['gate_internal', 'user_paused']), () => false).clearMarker).toBe(true);
    expect(resume(S(['gate_internal']), () => true).clearMarker).toBe(false);
  });
});

/** 内存 B(`AUTO_PAUSE_BREAKER`)端口(与 `makeBreakerMarkerPort` 同一份契约:独占创建不覆盖、读不到 = null、remove 返回是否删了;真文件实现见 w7-pause-marker.test.ts) */
function memMarker(calls: string[]): {
  port: BreakerMarkerPort;
  cell: { value: PauseMarker | null };
} {
  const cell: { value: PauseMarker | null } = { value: null };
  return {
    cell,
    port: {
      async ensure(reason) {
        calls.push('marker.ensure');
        if (cell.value !== null) return 'exists';
        cell.value = { by: 'breaker', reason };
        return 'created';
      },
      async read() {
        return cell.value;
      },
      async remove() {
        calls.push('marker.remove');
        if (cell.value === null) return false;
        cell.value = null;
        return true;
      },
    },
  };
}

describe('落地:先写 B 标记(AUTO_PAUSE_BREAKER)、再写状态、后置 canary 不注入;崩溃后每次 worker 步骤补做', () => {
  function rig(): {
    d: BreakerDeps;
    calls: string[];
    state: { value: AutoPauseState };
    marker: { value: PauseMarker | null };
    user: { value: boolean };
    failMute: { value: boolean };
    failWrite: { value: boolean };
  } {
    const calls: string[] = [];
    const state = { value: NO_PAUSE as AutoPauseState };
    const failMute = { value: false };
    const failWrite = { value: false };
    const user = { value: false };
    const m = memMarker(calls);
    return {
      calls,
      state,
      marker: m.cell,
      user,
      failMute,
      failWrite,
      d: {
        phase: V1B,
        marker: { breaker: m.port, user: { exists: async () => user.value } },
        state: {
          read: async () => state.value,
          write: async (s) => {
            calls.push('state.write');
            if (failWrite.value) throw new Error('crash');
            state.value = s;
          },
        },
        canary: {
          mute: async () => {
            calls.push('canary.mute');
            if (failMute.value) throw new Error('crash');
            return true;
          },
        },
      },
    };
  }
  it('触发:marker.ensure 先于 state.write 先于 canary.mute', async () => {
    const r = rig();
    await tripAndMute(r.d, 'user_vetoes');
    expect(r.calls).toEqual(['marker.ensure', 'state.write', 'canary.mute']);
    expect(r.marker.value).toEqual({ by: 'breaker', reason: 'user_vetoes' });
  });
  it('状态写入崩溃:标记已在盘上(hint 看得到),状态没写;下一次 enforceMute 补码、不删标记、补 mute', async () => {
    const r = rig();
    r.failWrite.value = true;
    await expect(tripAndMute(r.d, 'gate_internal')).rejects.toThrow('crash');
    expect(r.marker.value).toEqual({ by: 'breaker', reason: 'gate_internal' });
    expect(r.state.value.reasons).toEqual([]);
    r.failWrite.value = false;
    r.calls.length = 0;
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.state.value.reasons).toEqual(['gate_internal']); // 标记里的原因补回状态
    expect(r.marker.value).not.toBeNull(); // 不删标记
    expect(r.calls).toEqual(['state.write', 'canary.mute']);
  });
  it('W0-21:U(用户标记)存在而状态没码:worker 不补 user_paused、不写 state,但仍 mute', async () => {
    const r = rig();
    r.user.value = true;
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.state.value.reasons).toEqual([]);
    expect(r.calls).toEqual(['canary.mute']);
    expect(r.marker.value).toBeNull(); // 也不替用户补 B
  });
  it('B 的内容不是 by=breaker(by=user / 读不出)时 enforceMute 不据此补码', async () => {
    for (const by of ['user', 'unknown'] as const) {
      const r = rig();
      r.marker.value = { by, reason: null };
      expect(await enforceMute(r.d)).toBe(true);
      expect(r.state.value.reasons, by).toEqual([]);
    }
  });
  it('有码而没有标记(状态已写、标记缺):enforceMute 补 B', async () => {
    const r = rig();
    r.state.value = S(['gate_internal']);
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.marker.value).toEqual({ by: 'breaker', reason: 'gate_internal' });
    expect(r.calls).toEqual(['marker.ensure', 'canary.mute']);
  });
  it('状态已写、mute 崩溃:下一次 enforceMute 补做(熔断仍在 → mute),无熔断则不 mute', async () => {
    const r = rig();
    r.failMute.value = true;
    await expect(tripAndMute(r.d, 'gate_internal')).rejects.toThrow('crash');
    expect(r.state.value.reasons).toEqual(['gate_internal']);
    r.failMute.value = false;
    r.calls.length = 0;
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.calls).toEqual(['canary.mute']);
    const r2 = rig();
    expect(await enforceMute(r2.d)).toBe(false);
    expect(r2.calls).toEqual([]);
    expect(await enforceMute(r2.d, true)).toBe(true); // 调用方已读到某个标记存在
  });
  it('本期不发的码:不写标记、不写状态、不 mute', async () => {
    const r = rig();
    expect((await tripAndMute(r.d, 'apply_failed')).kind).toBe('phase_not_available');
    expect(r.calls).toEqual([]);
    expect(r.marker.value).toBeNull();
  });
  it('已处于该码:不重写状态,但仍补标记与 mute(幂等)', async () => {
    const r = rig();
    await tripAndMute(r.d, 'gate_internal');
    r.calls.length = 0;
    expect((await tripAndMute(r.d, 'gate_internal')).kind).toBe('already');
    expect(r.calls).toEqual(['marker.ensure', 'canary.mute']);
  });
  it('W0-21:U 已存在时熔断照写 B(不碰 U、不读 U 的内容)', async () => {
    const r = rig();
    r.user.value = true;
    await tripAndMute(r.d, 'gate_internal');
    expect(r.marker.value).toEqual({ by: 'breaker', reason: 'gate_internal' });
    expect(r.user.value).toBe(true);
  });
  it('自动解除:先写状态、后删 B;只在没有剩余码且确有码被清时删;U 无论如何不删', async () => {
    const r = rig();
    r.state.value = S(['no_observation', 'budget_high_legacy']);
    r.marker.value = { by: 'breaker', reason: 'no_observation' };
    const part = autoRelease(r.state.value, (c) => c === 'budget_high_legacy');
    expect(part.clearMarker).toBe(false); // 还剩 budget_high_legacy
    await applyAutoRelease(r.d, part);
    expect(r.marker.value).not.toBeNull();
    r.calls.length = 0;
    const rest = autoRelease(r.state.value, () => false);
    expect(rest.clearMarker).toBe(true);
    await applyAutoRelease(r.d, rest);
    expect(r.calls).toEqual(['state.write', 'marker.remove']);
    expect(r.marker.value).toBeNull();
  });
  it('W0-21 契约用例:worker 熔断 → 用户暂停 → 熔断条件恢复(自动解除):B 删了,U 仍在,isAutoPaused 仍为真、状态里没有 user_paused', async () => {
    const r = rig();
    r.state.value = S(['no_observation']);
    r.marker.value = { by: 'breaker', reason: 'no_observation' };
    r.user.value = true; // 用户随后暂停
    await applyAutoRelease(
      r.d,
      autoRelease(r.state.value, () => false),
    );
    expect(r.marker.value).toBeNull(); // 自动解除只删 B
    expect(r.user.value).toBe(true); // U 仍在(worker 没有任何删 U 的端口)
    expect(r.state.value.reasons).toEqual([]);
    expect(await enforceMute(r.d)).toBe(true); // 仍处于暂停:mute
    expect(isAutoPaused(r.state.value, await r.d.marker.user.exists())).toBe(true);
  });
  it('人工 resume(worker 侧):没有剩余熔断码时删 B;仍有码时 B 保留(hint 继续停注入);U 不归这里', async () => {
    const r = rig();
    r.state.value = S(['gate_internal', 'budget_high_legacy']);
    r.marker.value = { by: 'breaker', reason: 'gate_internal' };
    r.user.value = true;
    const keep = resume(r.state.value, () => false);
    expect(keep.clearMarker).toBe(false);
    await applyResume(r.d, keep);
    expect(r.marker.value).not.toBeNull();
    r.state.value = S(['gate_internal']);
    r.calls.length = 0;
    await applyResume(
      r.d,
      resume(r.state.value, () => false),
    );
    expect(r.calls).toEqual(['state.write', 'marker.remove']);
    expect(r.marker.value).toBeNull();
    expect(r.user.value).toBe(true);
  });
  it('部分解除后标记仍在:enforceMute 不复活已被清掉的码(标记只记首个原因;状态里已有别的码时不补)', async () => {
    const r = rig();
    r.marker.value = { by: 'breaker', reason: 'user_vetoes' };
    r.state.value = S(['no_observation']); // user_vetoes 已被人工 resume 清掉,标记因仍有剩余码而保留
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.state.value.reasons).toEqual(['no_observation']);
    expect(r.marker.value).not.toBeNull();
  });
  it('内容读不出的 B(创建后写内容前被杀)而状态没有码:人工 resume 可清除;仍有码时不清;自动解除不碰', async () => {
    const r = rig();
    r.marker.value = { by: 'unknown', reason: null };
    await applyResume(
      r.d,
      resume(r.state.value, () => false),
    );
    expect(r.marker.value).toBeNull();
    const r2 = rig();
    r2.marker.value = { by: 'unknown', reason: null };
    r2.state.value = S(['budget_high_legacy']);
    await applyResume(
      r2.d,
      resume(r2.state.value, () => false),
    );
    expect(r2.marker.value).not.toBeNull();
    const r3 = rig();
    r3.marker.value = { by: 'unknown', reason: null };
    await applyAutoRelease(
      r3.d,
      autoRelease(r3.state.value, () => false),
    );
    expect(r3.marker.value).not.toBeNull();
  });
  it('残余窗口(如实钉住):resume 写了状态、删标记前崩溃 → 下一次 enforceMute 由标记补回码(安全方向:不会少停注入)', async () => {
    const r = rig();
    r.state.value = S(['gate_internal']);
    r.marker.value = { by: 'breaker', reason: 'gate_internal' };
    const res = resume(r.state.value, () => false);
    expect(res.clearMarker).toBe(true);
    await r.d.state.write(res.state); // 状态已清、标记还在(崩溃)
    expect(r.state.value.reasons).toEqual([]);
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.state.value.reasons).toEqual(['gate_internal']);
  });
});
