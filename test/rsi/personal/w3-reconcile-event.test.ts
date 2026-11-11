/**
 * W1 转移表追加的对账事件 `revocation_reconcile`(R21-9.5:原因 revocation_reconciled;终态理由按凭据依据显式映射)。
 * 只追加行与测试;W1 已合并的测试不改。
 */
import { describe, expect, it } from 'vitest';
import { isRefusal, transition } from '../../../src/rsi/personal/transition.js';
import type { TransitionEvent } from '../../../src/rsi/personal/transition-table.js';
import { ctxFor, rec } from './transition-fixture.js';

const ev = (
  basis: 'veto' | 'taint' | 'clear' | 'judge_reject',
  evidence = 'r1',
): TransitionEvent => ({
  kind: 'revocation_reconcile',
  evidence,
  basis,
});

describe('R21-9.5 对账事件 revocation_reconcile', () => {
  it.each([
    ['veto', 'vetoed'],
    ['taint', 'tainted'],
    ['clear', 'cleared'],
    ['judge_reject', 'judge_rejected'],
  ] as const)(
    'proposed / shadow 依据 %s → rejected,原因 revocation_reconciled,终态理由 %s',
    (basis, terminal) => {
      for (const from of ['proposed', 'shadow'] as const) {
        const r = rec(from);
        const res = transition(r, ev(basis), ctxFor(r));
        expect(isRefusal(res)).toBe(false);
        if (isRefusal(res)) continue;
        expect(res.next.lifecycle).toBe('rejected');
        expect(res.next.terminal_reason).toBe(terminal);
        expect(res.entries.map((e) => e.reason)).toEqual(['revocation_reconciled']);
      }
    },
  );
  it('veto 依据仍写指纹黑名单效果;其它依据不写', () => {
    const r = rec('shadow');
    const v = transition(r, ev('veto'), ctxFor(r));
    const c = transition(r, ev('clear'), ctxFor(r));
    if (isRefusal(v) || isRefusal(c)) throw new Error('应成功');
    expect(v.effects.some((e) => e.type === 'blacklist_veto')).toBe(true);
    expect(c.effects.some((e) => e.type === 'blacklist_veto')).toBe(false);
  });
  it('未知依据在入口被拒(bad_input),不兜底成 clear', () => {
    const r = rec('shadow');
    const res = transition(
      r,
      { kind: 'revocation_reconcile', evidence: 'x', basis: 'whatever' },
      ctxFor(r),
    );
    expect(res).toMatchObject({ refused: 'bad_input' });
  });
  it('同一 idem_key 重复 → 空操作;终态上的对账是空操作(只写审计)', () => {
    const r = rec('shadow');
    const a = transition(r, ev('clear'), ctxFor(r));
    if (isRefusal(a)) throw new Error('应成功');
    expect(transition(a.next, ev('clear'), ctxFor(a.next))).toMatchObject({ outcome: 'noop' });
    const t = rec('rejected');
    expect(transition(t, ev('taint', 'other'), ctxFor(t))).toMatchObject({
      outcome: 'noop',
      noop_reason: 'terminal_state',
    });
  });
  it('canary 收到对账事件 → illegal_transition(canary 的撤销归 V1b / W7);相位 V0 → phase_not_available', () => {
    const c = rec('canary');
    expect(transition(c, ev('clear'), ctxFor(c))).toMatchObject({ refused: 'illegal_transition' });
    const p = rec('proposed');
    expect(transition(p, ev('clear'), ctxFor(p, { phase: 0 }))).toMatchObject({
      refused: 'phase_not_available',
    });
  });
});
