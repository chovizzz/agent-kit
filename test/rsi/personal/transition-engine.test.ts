/**
 * W1 引擎行为:非终态 veto / taint / judge_reject、R21-4.4(必经 rolling_back)、R21-4.4a(重复终止事件、target_terminal 只升不降、
 * 终态理由优先级、终态 veto 只写黑名单)、正向链、拒绝顺序、纯度、256 条上限。
 */
import { describe, expect, it } from 'vitest';
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import {
  isRefusal,
  transition,
  type Transitioned,
  type TransitionResult,
} from '../../../src/rsi/personal/transition.js';
import {
  TERMINATION_KINDS,
  TRANSITION_TABLE,
  type TransitionCtx,
  type TransitionEvent,
} from '../../../src/rsi/personal/transition-table.js';
import {
  CANARY_AT,
  E,
  ID,
  SHA,
  TERMINALS,
  UNIMPLEMENTED,
  ctxFor,
  deepFreeze,
  entry,
  rec,
} from './transition-fixture.js';

function ok(res: TransitionResult): Transitioned {
  if (isRefusal(res)) throw new Error(`意外被拒:${JSON.stringify(res)}`);
  return res;
}
const step = (
  r: PersonalLifecycleRecord,
  e: TransitionEvent,
  o: Partial<TransitionCtx> = {},
): Transitioned => ok(transition(r, e, ctxFor(r, o)));
const run = (r: PersonalLifecycleRecord, ...evs: TransitionEvent[]): PersonalLifecycleRecord =>
  evs.reduce((cur, e) => step(cur, e).next, r);
const injected = (): PersonalLifecycleRecord =>
  rec('canary', { deploy: { claude: 'injected', pi: 'none', codex: 'none' } });

describe('R21-4.5 每个非终态各一个 veto 与 taint 用例', () => {
  for (const kind of ['veto', 'taint'] as const) {
    const mk = kind === 'veto' ? E.veto : E.taint;
    const reason = kind === 'veto' ? 'vetoed' : 'tainted';

    for (const lc of ['proposed', 'shadow'] as const) {
      it(`R21-4.5 ${lc} 收到 ${kind}:直接进 rejected(无部署,不经 rolling_back),终态理由 ${reason}`, () => {
        const r = rec(lc);
        const res = step(r, mk('x'));
        expect(res.next.lifecycle).toBe('rejected');
        expect(res.next.terminal_reason).toBe(reason);
        expect(res.next.rollback).toBeNull();
        expect(res.entries.map((e) => `${e.from}>${e.to}`)).toEqual([`${lc}>rejected`]);
        // 对照:veto 另发黑名单 effect,taint 不发
        expect(res.effects.some((e) => e.type === 'blacklist_veto')).toBe(kind === 'veto');
      });
    }

    it(`R21-4.5 canary 收到 ${kind}:经 rolling_back(R21-4.4),停注入的 deploy 改 removal_pending,目标 rolled_back`, () => {
      const res = step(injected(), mk('x'));
      expect(res.next.lifecycle).toBe('rolling_back');
      expect(res.next.rollback).toMatchObject({
        phase: 'rollback_requested',
        reason,
        target_terminal: 'rolled_back',
      });
      expect(res.next.deploy.claude).toBe('removal_pending');
      expect(res.next.terminal_reason).toBeNull();
      expect(res.effects.some((e) => e.type === 'blacklist_veto')).toBe(kind === 'veto');
    });

    it(`R21-4.5 rolling_back 收到 ${kind}:追加自环条目(from = to = rolling_back),不重置补偿阶段`, () => {
      const start = rec('rolling_back', {
        rollback: {
          phase: 'static_removal_pending',
          reason: 'static_sync_timeout',
          target_terminal: 'expired',
        },
        deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
      });
      const res = step(start, mk('x'));
      expect(res.next.lifecycle).toBe('rolling_back');
      expect(res.next.rollback).toEqual({
        phase: 'static_removal_pending',
        reason,
        target_terminal: 'rolled_back',
      });
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0]).toMatchObject({
        dim: 'lifecycle',
        from: 'rolling_back',
        to: 'rolling_back',
        reason,
      });
    });

    for (const lc of UNIMPLEMENTED) {
      it(`R21-4.5 ${lc}(V2 / V3 状态)收到 ${kind}:phase_not_available(默认拒绝,入参不变)`, () => {
        const r = deepFreeze(rec(lc));
        const res = transition(r, mk('x'), ctxFor(r, { phase: 9 }));
        expect(isRefusal(res) && res.refused).toBe('phase_not_available');
        // 对照:同一个事件在 proposed 上是被受理的(否则「拒绝」可能只是事件本身非法)
        expect(isRefusal(transition(rec('proposed'), mk('x'), ctxFor(rec('proposed'))))).toBe(
          false,
        );
      });
    }

    for (const lc of TERMINALS) {
      it(`R21-4.4a ② ${lc} 终态收到 ${kind}:状态不变、不写转移条目;veto 只出黑名单 effect,taint 只写审计`, () => {
        const r = rec(lc);
        const res = step(r, mk('late'));
        expect(res.outcome).toBe('noop');
        expect(res.noop_reason).toBe('terminal_state');
        expect(res.next).toEqual(r);
        expect(res.entries).toEqual([]);
        expect(res.effects.some((e) => e.type === 'blacklist_veto')).toBe(kind === 'veto');
        expect(res.effects.some((e) => e.type === 'append_audit')).toBe(true);
        expect(res.effects.some((e) => e.type === 'commit_lifecycle')).toBe(false);
      });
    }
  }

  it('R21-4.5 judge_reject:每个有行的非终态各一个(proposed / shadow 直接终态;canary 经 rolling_back;rolling_back 自环)', () => {
    for (const lc of ['proposed', 'shadow'] as const) {
      const res = step(rec(lc), E.judge());
      expect([res.next.lifecycle, res.next.terminal_reason]).toEqual([
        'rejected',
        'judge_rejected',
      ]);
    }
    const c = step(injected(), E.judge('j', { injection_suspected: true, verdict_reject: false }));
    expect(c.next.lifecycle).toBe('rolling_back');
    expect(c.next.rollback).toMatchObject({
      reason: 'judge_injection',
      target_terminal: 'rolled_back',
    });
    const rb = step(c.next, E.judge('j2'));
    expect(rb.entries[0]).toMatchObject({
      from: 'rolling_back',
      to: 'rolling_back',
      reason: 'judge_reject',
    });
    for (const lc of UNIMPLEMENTED) {
      const r = rec(lc);
      const res = transition(r, E.judge(), ctxFor(r));
      expect(isRefusal(res) && res.refused).toBe('phase_not_available');
    }
  });
});

describe('R21-4.4a 终态理由优先级与 judge_reject 并发', () => {
  it('R21-4.4a rolling_back 上 veto 与 judge_reject 两种到达顺序:最终 target、理由、补偿阶段一致,理由 = vetoed(vetoed > judge_rejected)', () => {
    const a = run(injected(), E.veto('v'), E.judge('j'));
    const b = run(injected(), E.judge('j'), E.veto('v'));
    for (const r of [a, b]) {
      expect(r.lifecycle).toBe('rolling_back');
      expect(r.rollback).toEqual({
        phase: 'rollback_requested',
        reason: 'vetoed',
        target_terminal: 'rolled_back',
      });
      expect(r.transitions.at(-1)?.from).toBe('rolling_back');
    }
    // 对照:确有两条历史(并发事件都被记录,只是理由取最高者)
    expect(a.transitions.length).toBe(b.transitions.length);
  });

  it('R21-4.4a judge_reject 与 harm 的两种顺序:理由 = judge_reject(judge_rejected > auto_rollback)', () => {
    const a = run(injected(), E.harm('h'), E.judge('j'));
    const b = run(injected(), E.judge('j'), E.harm('h'));
    for (const r of [a, b])
      expect(r.rollback).toMatchObject({ reason: 'judge_reject', target_terminal: 'rolled_back' });
  });

  it('R21-4.4a 完整优先级链(vetoed > tainted > cleared > judge_rejected > auto_rollback > static_sync_timeout > auto_expired):逐对,先来低后来高升级,先来高后来低不降', () => {
    const events: Array<[string, TransitionEvent]> = [
      ['vetoed', E.veto('p1')],
      ['tainted', E.taint('p2')],
      ['cleared', E.clear('p3')],
      ['judge_reject', E.judge('p4')],
      ['harm_c1', E.harm('p5')],
      ['limit_reached', E.limit('p6')],
    ];
    // 每个 reason 自己的优先级顺序 = events 的下标顺序(limit_reached → auto_expired 最低)
    for (let hi = 0; hi < events.length; hi++) {
      for (let lo = hi + 1; lo < events.length; lo++) {
        const [hiReason, hiEv] = events[hi] as [string, TransitionEvent];
        const [loReason, loEv] = events[lo] as [string, TransitionEvent];
        const up = run(injected(), loEv, hiEv);
        const down = run(injected(), hiEv, loEv);
        expect(up.rollback?.reason, `${loReason} 然后 ${hiReason}`).toBe(hiReason);
        expect(down.rollback?.reason, `${hiReason} 然后 ${loReason}`).toBe(hiReason);
      }
    }
  });

  it('R21-4.4a 优先级并列保留先到者(judge_reject 先于 judge_injection;两者都映射为 judge_rejected)', () => {
    const r = run(injected(), E.judge('a'), E.judge('b', { injection_suspected: true }));
    expect(r.rollback?.reason).toBe('judge_reject');
    const r2 = run(injected(), E.judge('a', { injection_suspected: true }), E.judge('b'));
    expect(r2.rollback?.reason).toBe('judge_injection');
  });

  it('R21-4.4a ① proposed 上 judge_reject 与 veto:先到者定终态,后到的 veto 只写黑名单(不改理由),后到的 judge 空操作', () => {
    const r1 = step(rec('proposed'), E.judge('j'));
    expect(r1.next.terminal_reason).toBe('judge_rejected');
    const late = step(r1.next, E.veto('v'));
    expect(late.outcome).toBe('noop');
    expect(late.next.terminal_reason).toBe('judge_rejected');
    expect(late.effects.some((e) => e.type === 'blacklist_veto')).toBe(true);

    const v1 = step(rec('proposed'), E.veto('v'));
    expect(v1.next.terminal_reason).toBe('vetoed');
    const lateJudge = step(v1.next, E.judge('j'));
    expect(lateJudge.outcome).toBe('noop');
    expect(lateJudge.next.terminal_reason).toBe('vetoed');
    expect(lateJudge.effects.some((e) => e.type === 'blacklist_veto')).toBe(false);
  });

  it('R21-4.4a 未映射的旧理由码按最低优先级处理(不会因 indexOf = -1 反而排到最前)', () => {
    const start = rec('rolling_back', {
      rollback: {
        phase: 'rollback_requested',
        reason: 'compensation_done',
        target_terminal: 'rolled_back',
      },
    });
    const r = step(start, E.limit('l'));
    expect(r.next.rollback?.reason).toBe('limit_reached');
  });
});

describe('R21-4.4a target_terminal 只升不降', () => {
  const targets = ['shadow', 'expired', 'rolled_back'] as const;
  const mkRolling = (target: (typeof targets)[number]): PersonalLifecycleRecord =>
    rec('rolling_back', {
      rollback: {
        phase: 'rollback_requested',
        reason: 'static_sync_timeout',
        target_terminal: target,
      },
    });
  it('R21-4.4a 目标 × 事件两两:最终目标 = 两者中优先级高者(rolled_back > expired > shadow),不降级', () => {
    const expected: Record<string, string> = {
      'shadow+limit': 'expired',
      'expired+limit': 'expired',
      'rolled_back+limit': 'rolled_back',
      'shadow+veto': 'rolled_back',
      'expired+veto': 'rolled_back',
      'rolled_back+veto': 'rolled_back',
    };
    for (const t of targets) {
      for (const [name, ev] of [
        ['limit', E.limit('l9')],
        ['veto', E.veto('v9')],
      ] as const) {
        const res = step(mkRolling(t), ev);
        expect(res.next.rollback?.target_terminal, `${t}+${name}`).toBe(expected[`${t}+${name}`]);
      }
    }
  });
});

describe('R21-4.4a 重复终止事件不重置已完成的补偿阶段', () => {
  for (const phase of [
    'rollback_requested',
    'injection_disabled',
    'static_removal_pending',
    'rollback_complete',
  ] as const) {
    it(`R21-4.4a rolling_back 处于 ${phase} 时再收到 veto:阶段不变、不回退,只追加自环条目`, () => {
      const start = rec('rolling_back', {
        rollback: { phase, reason: 'limit_reached', target_terminal: 'expired' },
        deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
      });
      const res = step(start, E.veto('late'));
      expect(res.next.rollback?.phase).toBe(phase);
      expect(res.next.rollback).toMatchObject({ reason: 'vetoed', target_terminal: 'rolled_back' });
      expect(res.next.deploy.claude).toBe('removal_pending');
      expect(res.entries).toHaveLength(1);
      expect(res.next.transitions.length).toBe(start.transitions.length + 1);
    });
  }

  it('R21-4.4a 同一个 veto 事件重复到达 = 空操作:自环上 transitions 只 +1', () => {
    const start = step(injected(), E.harm('h')).next;
    const first = step(start, E.veto('v'));
    expect(first.next.transitions.length).toBe(start.transitions.length + 1);
    const again = step(first.next, E.veto('v'));
    expect(again.outcome).toBe('noop');
    expect(again.next.transitions.length).toBe(first.next.transitions.length);
    // 新证据的 veto 不是重复:追加第二条自环(新的 idem_key 不被旧的吞掉)
    const fresh = step(first.next, E.veto('v-other'));
    expect(fresh.outcome).toBe('transitioned');
    expect(fresh.next.transitions.length).toBe(first.next.transitions.length + 1);
    // 同证据、不同种类(taint)不被 veto 的键吞掉
    expect(step(first.next, E.taint('v')).outcome).toBe('transitioned');
  });

  it('R21-4.4a 跨 agent 不互相去重:claude 的 removal_done 已执行,pi 的同证据同种事件仍转移', () => {
    const start = rec('rolling_back', {
      rollback: { phase: 'rollback_complete', reason: 'vetoed', target_terminal: 'rolled_back' },
      deploy: { claude: 'removal_pending', pi: 'removal_pending', codex: 'none' },
    });
    const a = step(start, E.removal('claude', 'same'));
    expect(a.next.deploy).toEqual({ claude: 'none', pi: 'removal_pending', codex: 'none' });
    const b = step(a.next, E.removal('pi', 'same'));
    expect(b.outcome).toBe('transitioned');
    expect(b.next.deploy).toEqual({ claude: 'none', pi: 'none', codex: 'none' });
  });
});

describe('R21-4.4 任何离开注入的路径必经 rolling_back', () => {
  it('R21-4.4 结构:表里没有任何一行从 canary(adopted / stable)的 lifecycle 直接到终态;正向对照:确有从 canary 到 rolling_back 的行', () => {
    const lifecycleRows = TRANSITION_TABLE.filter((r) => r.dim === 'lifecycle');
    const fromCanary = lifecycleRows.filter((r) => r.from === 'canary');
    expect(fromCanary.length).toBeGreaterThan(0);
    for (const r of fromCanary) expect(['rolling_back', 'adopted']).toContain(r.to);
    for (const r of lifecycleRows.filter((x) =>
      ['canary', 'adopted', 'stable', 'retiring'].includes(x.from),
    )) {
      expect(['rejected', 'expired', 'rolled_back', 'retired', 'shadow']).not.toContain(r.to);
    }
  });

  it('R21-4.4 负向:canary 收到只属于 proposed / shadow / rolling_back 的「直接进终态」事件 → illegal_transition,记录不变', () => {
    const c = deepFreeze(injected());
    const bad: TransitionEvent[] = [
      E.gateRed('g1_phrase'),
      E.noHit(),
      E.queueExpired(),
      E.done(),
      E.advance('injection_disabled'),
      E.gatesPassed(),
    ];
    for (const ev of bad) {
      const res = transition(c, ev, ctxFor(c));
      expect(isRefusal(res) && res.refused, ev.kind).toBe('illegal_transition');
    }
    // 正向对照:同一记录收到 veto 是被受理的,并且走的是 rolling_back
    expect(step(c, E.veto('ok')).next.lifecycle).toBe('rolling_back');
  });

  it('R21-4.4 每个终止事件从 canary 出来都是 rolling_back,且 deploy 不留 injected', () => {
    for (const ev of [E.harm(), E.veto(), E.taint(), E.clear(), E.judge(), E.limit()]) {
      const res = step(injected(), ev);
      expect(res.next.lifecycle, ev.kind).toBe('rolling_back');
      expect(Object.values(res.next.deploy), ev.kind).not.toContain('injected');
      expect(TERMINATION_KINDS.has(ev.kind)).toBe(true);
    }
  });

  it('R21-4.4 rolling_back 不能被非终止事件直接带到终态(没走完四段 / deploy 未清 → 拒)', () => {
    const r = rec('rolling_back', {
      deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
    });
    const res = transition(r, E.done(), ctxFor(r));
    expect(isRefusal(res) && res.guard).toBe('rollback_not_complete');
  });
});

describe('R21-4.4a ② 终态:终止事件只写审计 / 黑名单,非终止事件拒绝(终态不可复活)', () => {
  it('终态收到 harm / clear / judge_reject / canary_limit:空操作;veto 例外地带黑名单 effect;对照:同一事件在非终态会转移', () => {
    for (const lc of TERMINALS) {
      const r = rec(lc);
      for (const ev of [E.harm(), E.clear(), E.judge(), E.limit()]) {
        const res = step(r, ev);
        expect(res.outcome, `${lc}/${ev.kind}`).toBe('noop');
        expect(res.next).toEqual(r);
        expect(res.entries).toEqual([]);
        expect(res.effects.every((e) => e.type === 'append_audit')).toBe(true);
      }
    }
    expect(step(injected(), E.clear()).outcome).toBe('transitioned');
  });

  it('终态收到推进事件(gates_passed / shadow_promote / deploy_inject / compensation_done)→ illegal_transition', () => {
    for (const lc of TERMINALS) {
      const r = rec(lc);
      for (const ev of [E.gatesPassed('z'), E.promote('z'), E.inject('claude', 'z'), E.done('z')]) {
        const res = transition(r, ev, ctxFor(r));
        expect(isRefusal(res) && res.refused, `${lc}/${ev.kind}`).toBe('illegal_transition');
      }
    }
  });

  it('终态 veto 的三件事:next 与入参深相等、entries 为空、effects 含指向该候选的黑名单(正向锚点)', () => {
    const r = rec('rolled_back');
    const res = step(r, E.veto('late'));
    expect(res.next).toEqual(r);
    expect(res.entries).toEqual([]);
    expect(res.effects).toContainEqual({ type: 'blacklist_veto', id: ID, content_sha256: SHA });
  });
});

describe('R21-4.4a ② / R21-9.1 补充', () => {
  it('R21-4.4a ② 终态收到终止事件也受能力相位约束:相位 0 → phase_not_available;相位 1 → 空操作(正向对照)', () => {
    const r = rec('rejected');
    const low = transition(r, E.veto('late'), ctxFor(r, { phase: 0 }));
    expect(isRefusal(low) && low.refused).toBe('phase_not_available');
    expect(step(r, E.veto('late'), { phase: 1 }).outcome).toBe('noop');
  });

  it('R21-9.1 rollback 阶段只能顺序前进一步:跳段 / 逆序 / 原地 → illegal_transition;对照:下一段被受理', () => {
    const r = rec('rolling_back', {
      rollback: { phase: 'rollback_requested', reason: 'vetoed', target_terminal: 'rolled_back' },
    });
    for (const to of [
      'static_removal_pending',
      'rollback_complete',
      'rollback_requested',
    ] as const) {
      const res = transition(r, E.advance(to, `skip-${to}`), ctxFor(r));
      expect(isRefusal(res) && res.refused, to).toBe('illegal_transition');
    }
    const okRes = step(r, E.advance('injection_disabled', 'next'));
    expect(okRes.next.rollback?.phase).toBe('injection_disabled');
  });
});

describe('R21-4.1 正向合法链(每步通过)', () => {
  it('proposed → shadow → canary → rolling_back → rolled_back:含 deploy 注入、四段推进、removal_done、终态理由与 effects', () => {
    let r = rec('proposed');
    const trail: string[] = [];
    const go = (e: TransitionEvent, o: Partial<TransitionCtx> = {}): Transitioned => {
      const res = step(r, e, o);
      expect(res.outcome).toBe('transitioned');
      r = res.next;
      trail.push(`${r.lifecycle}/${r.rollback?.phase ?? '-'}/${r.deploy.claude}`);
      return res;
    };
    go(E.gatesPassed());
    go(E.promote());
    expect(r.lifecycle).toBe('canary');
    go(E.inject('claude'));
    go(E.harm('h', { metric: 'c2' }));
    go(E.advance('injection_disabled', 'a1'));
    go(E.advance('static_removal_pending', 'a2'));
    go(E.advance('rollback_complete', 'a3'));
    go(E.removal('claude'));
    const last = go(E.done());
    expect(trail).toEqual([
      'shadow/-/none',
      'canary/-/none',
      'canary/-/injected',
      'rolling_back/rollback_requested/removal_pending',
      'rolling_back/injection_disabled/removal_pending',
      'rolling_back/static_removal_pending/removal_pending',
      'rolling_back/rollback_complete/removal_pending',
      'rolling_back/rollback_complete/none',
      'rolled_back/rollback_complete/none',
    ]);
    expect(r.terminal_reason).toBe('auto_rollback');
    expect(r.rollback).toEqual({
      phase: 'rollback_complete',
      reason: 'harm_c2',
      target_terminal: 'rolled_back',
    });
    expect(last.effects).toContainEqual({
      type: 'write_tombstone',
      id: ID,
      terminal: 'rolled_back',
      reason: 'auto_rollback',
    });
    expect(last.effects).toContainEqual({
      type: 'start_cooldown',
      cluster_id: 'cluster-1',
      kind: 'auto_rollback',
      days: 90,
    });
    // 每个维度的变化都有条目:lifecycle 4 + deploy 3(注入、removal_pending、none)+ rollback 3
    const dims = r.transitions.slice(1).map((t) => t.dim);
    expect(dims.filter((d) => d === 'lifecycle')).toHaveLength(4);
    expect(dims.filter((d) => d === 'deploy')).toHaveLength(3);
    expect(dims.filter((d) => d === 'rollback')).toHaveLength(3);
  });

  it('shadow → expired(limit_reached):排队满 30 个 UTC 日,终态理由 auto_expired,冷却 30 日', () => {
    const r = rec('shadow');
    const res = step(r, E.queueExpired('2026-10-11'));
    expect(res.next.lifecycle).toBe('expired');
    expect(res.entries[0]).toMatchObject({
      from: 'shadow',
      to: 'expired',
      reason: 'limit_reached',
    });
    expect(res.next.terminal_reason).toBe('auto_expired');
    expect(res.effects).toContainEqual({
      type: 'start_cooldown',
      cluster_id: 'cluster-1',
      kind: 'expired',
      days: 30,
    });
  });

  it('canary 到上限(canary_limit)→ rolling_back(target expired)→ expired,终态理由 auto_expired;canary 不经 adopted', () => {
    let r = injected();
    r = step(r, E.limit('l')).next;
    expect(r.rollback?.target_terminal).toBe('expired');
    r = run(
      r,
      E.advance('injection_disabled'),
      E.advance('static_removal_pending', 'a2'),
      E.advance('rollback_complete', 'a3'),
      E.removal('claude'),
      E.done(),
    );
    expect(r.lifecycle).toBe('expired');
    expect(r.terminal_reason).toBe('auto_expired');
  });

  it('R21-4.1 canary 限期 90 个 UTC 日:进入 canary 第 89 日不触发,第 90 日触发(两侧各一例)', () => {
    const at = (iso: string): TransitionCtx => ctxFor(injected(), { now: iso });
    const c = injected();
    expect(CANARY_AT).toBe('2026-11-01T00:00:00Z');
    const d89 = transition(c, E.limit('l', 0), at('2027-01-29T10:00:00Z'));
    expect(isRefusal(d89) && d89.guard).toBe('limit_not_reached');
    const d90 = transition(c, E.limit('l', 0), at('2027-01-30T00:00:00Z'));
    expect(isRefusal(d90)).toBe(false);
  });
});

describe('R21-4.5 拒绝顺序(每一步各钉一例)', () => {
  it('入参 schema 先于一切:非法 record → candidate_invalid;非法 event / ctx → bad_input;gate_internal 不是闸原因码 → bad_input(永不产出 rejected)', () => {
    const r = rec('proposed');
    const c = ctxFor(r);
    expect(transition({ ...r, extra: 1 }, E.veto(), c)).toMatchObject({
      refused: 'candidate_invalid',
    });
    expect(transition(r, { kind: 'veto' }, c)).toMatchObject({ refused: 'bad_input' });
    expect(transition(r, E.veto(), { ...c, phase: undefined })).toMatchObject({
      refused: 'bad_input',
    });
    expect(
      transition(r, { kind: 'gate_red', evidence: 'x', gate_reason: 'gate_internal' }, c),
    ).toMatchObject({ refused: 'bad_input' });
    // 非法 record 与非法 event 并存:record 先
    expect(transition({}, { kind: 'nope' }, c)).toMatchObject({ refused: 'candidate_invalid' });
    // 对照:全部合法时被受理
    expect(isRefusal(transition(r, E.veto(), c))).toBe(false);
  });

  it('幂等先于查行:proposed → shadow 之后同一事件再来是 noop,而不是 illegal_transition(shadow × gates_passed 无行)', () => {
    const a = step(rec('proposed'), E.gatesPassed('same'));
    const again = transition(a.next, E.gatesPassed('same'), ctxFor(a.next));
    expect(isRefusal(again)).toBe(false);
    expect((again as Transitioned).outcome).toBe('noop');
    // 对照:新证据的 gates_passed 在 shadow 上才是 illegal_transition
    const fresh = transition(a.next, E.gatesPassed('other'), ctxFor(a.next));
    expect(isRefusal(fresh) && fresh.refused).toBe('illegal_transition');
  });

  it('查行先于能力:shadow × deploy_inject 在相位 0 也是 illegal_transition(不是 phase_not_available)', () => {
    const r = rec('shadow');
    const res = transition(r, E.inject(), ctxFor(r, { phase: 0 }));
    expect(isRefusal(res) && res.refused).toBe('illegal_transition');
  });

  it('能力先于守卫:相位 1 的 shadow_promote 即使守卫也为假,仍是 phase_not_available', () => {
    const r = rec('shadow');
    const res = transition(r, E.promote('p', { config_valid: false }), ctxFor(r, { phase: 1 }));
    expect(isRefusal(res) && res.refused).toBe('phase_not_available');
    const res2 = transition(r, E.promote('p', { config_valid: false }), ctxFor(r, { phase: 2 }));
    expect(isRefusal(res2) && [res2.refused, res2.guard]).toEqual([
      'guard_false',
      'config_invalid',
    ]);
  });

  it('未实现状态先于终态 / 查行:blocked / adopted / stable / retiring 收到任何事件(含非终止事件)→ phase_not_available', () => {
    for (const lc of UNIMPLEMENTED) {
      const r = rec(lc);
      for (const ev of [E.gatesPassed('u'), E.done('u'), E.promote('u'), E.decide('u')]) {
        const res = transition(r, ev, ctxFor(r, { phase: 9 }));
        expect(isRefusal(res) && res.refused, `${lc}/${ev.kind}`).toBe('phase_not_available');
      }
    }
  });

  it('category=exec 在本期没有能力键:shadow_promote → phase_not_available(相位 2 亦然);非 exec 对照可转移', () => {
    const r = rec('shadow', { category: 'exec' });
    const res = transition(r, E.promote(), ctxFor(r));
    expect(isRefusal(res) && res.refused).toBe('phase_not_available');
    expect(isRefusal(transition(rec('shadow'), E.promote(), ctxFor(rec('shadow'))))).toBe(false);
  });

  it('非法组合不会被引擎「修好」:canary 的非法 deploy 只得到 candidate_invalid', () => {
    const r = rec('canary', { deploy: { claude: 'static', pi: 'none', codex: 'none' } });
    const res = transition(r, E.veto(), ctxFor(r));
    expect(isRefusal(res) && res.refused).toBe('candidate_invalid');
  });
});

describe('R21-4.5 纯度与记账', () => {
  it('入参深冻结也能运行;入参不变;相同输入输出完全相同(确定性);next 不是入参的同一个对象', () => {
    const r = deepFreeze(injected());
    const e = deepFreeze(E.veto('v'));
    const c = deepFreeze(ctxFor(r));
    const snap = JSON.stringify(r);
    const a = ok(transition(r, e, c));
    const b = ok(transition(r, e, c));
    expect(a).toEqual(b);
    expect(a.next).not.toBe(r);
    expect(JSON.stringify(r)).toBe(snap);
  });

  it('时钟只来自 ctx.now:条目的 at = ctx.now;换时钟只改 at,idem_key 不变', () => {
    const r = injected();
    const a = step(r, E.veto('v'), { now: '2026-11-10T01:00:00Z' });
    const b = step(r, E.veto('v'), { now: '2026-11-11T23:00:00Z' });
    expect(a.entries.map((e) => e.at)).toEqual(['2026-11-10T01:00:00Z', '2026-11-10T01:00:00Z']);
    expect(b.entries.map((e) => e.at)).toEqual(['2026-11-11T23:00:00Z', '2026-11-11T23:00:00Z']);
    expect(a.entries.map((e) => e.idem_key)).toEqual(b.entries.map((e) => e.idem_key));
  });

  it('每次转移都有 commit_lifecycle effect 与每条条目一行审计(R21-3.8 / R21-12.10);effects 只是描述', () => {
    const res = step(injected(), E.veto('v'));
    expect(res.effects.filter((e) => e.type === 'commit_lifecycle')).toHaveLength(1);
    const audits = res.effects.filter((e) => e.type === 'append_audit');
    expect(audits).toHaveLength(res.entries.length);
    expect(audits[0]).toMatchObject({
      line: {
        kind: 'transition',
        id: ID,
        dim: 'lifecycle',
        from: 'canary',
        to: 'rolling_back',
        reason: 'vetoed',
      },
    });
  });

  it('transitions 满 256 条再追加:保持 256 条,transitions_dropped 恰好 +1,最早的被丢,本次 entries 完整', () => {
    const many = Array.from({ length: 256 }, (_, i) => entry(i + 1));
    const r = rec('proposed', { transitions: many, transitions_dropped: 5 });
    const res = step(r, E.gatesPassed('full'));
    expect(res.next.transitions).toHaveLength(256);
    expect(res.next.transitions_dropped).toBe(6);
    expect(res.next.transitions[0]).toEqual(many[1]);
    expect(res.next.transitions.at(-1)).toEqual(res.entries[0]);
    expect(res.entries).toHaveLength(1);
    // 对照:255 条时不丢
    const r2 = rec('proposed', { transitions: many.slice(0, 255), transitions_dropped: 5 });
    const res2 = step(r2, E.gatesPassed('full'));
    expect(res2.next.transitions).toHaveLength(256);
    expect(res2.next.transitions_dropped).toBe(5);
  });

  it('transitions 满 256 且一次追加两条(canary → rolling_back 含 deploy):dropped 恰好 +2', () => {
    const many = Array.from({ length: 256 }, (_, i) => entry(i + 1));
    const r = rec('canary', {
      transitions: many,
      deploy: { claude: 'injected', pi: 'none', codex: 'none' },
    });
    const res = step(r, E.veto('big'));
    expect(res.entries).toHaveLength(2);
    expect(res.next.transitions).toHaveLength(256);
    expect(res.next.transitions_dropped).toBe(2);
    // 进入 canary 的记录被丢掉时,canary 限期按「已到」处理(走向更少生效)
    const rb = res.next;
    const lim = transition(rb, E.limit('late', 0), ctxFor(rb));
    expect(isRefusal(lim)).toBe(false);
  });
});
