/**
 * C1a:W9 判决槽——`UNAVAILABLE_JUDGE` 缺省实现、`checkJudgeGrowth` 的运行期包装(抛错 / 超时 / 非法值 = judge_indeterminate)、`normalizeJudgeReport`。
 * 判决逻辑本身(`evaluateJudgeSignal`)归 W9a,这里不测、也不复制。
 */
import { describe, expect, it } from 'vitest';
import {
  JUDGE_CHECK_TIMEOUT_MS,
  JUDGE_GROWTH_DENY_CODES,
  UNAVAILABLE_JUDGE,
  checkJudgeGrowth,
  normalizeJudgeReport,
  normalizeJudgeVerdict,
  type JudgeGrowthSlot,
  type JudgeSlots,
} from '../../../src/rsi/personal/judge-slot.js';
import { classifyHalt } from '../../../src/rsi/personal/stage/errors.js';
import { rec } from './c1-fixture.js';
import { judgeSlotUnavailableContract } from './judge-slot-contract.js';

const SRC = { run_id: 'run-1', proposal_id: 'p-1' };

// 符合性替身:另一种「不可用」实现(判决源读失败),遵守同一份契约(里氏替换)
const unreadableDouble = (): JudgeSlots => ({
  reduce: {
    run: () =>
      Promise.resolve({
        evaluated: 0,
        transitioned: [],
        blocked: [],
        deferred: [],
        halted: null,
        unavailable: true,
      }),
  },
  growth: {
    check: (r) =>
      Promise.resolve(
        r.source_proposal === null || r.source_proposal === undefined
          ? { ok: true as const }
          : { ok: false as const, code: 'judge_indeterminate' as const },
      ),
  },
});
judgeSlotUnavailableContract('UNAVAILABLE_JUDGE', () => UNAVAILABLE_JUDGE);
judgeSlotUnavailableContract('读失败替身', unreadableDouble);

describe('UNAVAILABLE_JUDGE 的精确取值', () => {
  it('check:带来源 → {ok:false, judge_unavailable};null / 缺失 → {ok:true}', async () => {
    expect(await UNAVAILABLE_JUDGE.growth.check(rec(SRC))).toEqual({
      ok: false,
      code: 'judge_unavailable',
    });
    expect(await UNAVAILABLE_JUDGE.growth.check(rec(null))).toEqual({ ok: true });
    expect(await UNAVAILABLE_JUDGE.growth.check(rec(undefined))).toEqual({ ok: true });
  });
  it('run:空报告 + unavailable=true;传不传 ids 都一样;槽对象冻结(装配处不能就地改写缺省实现)', async () => {
    const empty = {
      evaluated: 0,
      transitioned: [],
      blocked: [],
      deferred: [],
      halted: null,
      unavailable: true,
    };
    expect(await UNAVAILABLE_JUDGE.reduce.run({})).toEqual(empty);
    expect(await UNAVAILABLE_JUDGE.reduce.run({ ids: ['x'] })).toEqual(empty);
    expect(Object.isFrozen(UNAVAILABLE_JUDGE)).toBe(true);
    expect(Object.isFrozen(UNAVAILABLE_JUDGE.reduce)).toBe(true);
    expect(Object.isFrozen(UNAVAILABLE_JUDGE.growth)).toBe(true);
    expect(Object.isFrozen((await UNAVAILABLE_JUDGE.reduce.run({})).transitioned)).toBe(true);
  });
  it('三个拒绝码的集合与顺序', () => {
    expect([...JUDGE_GROWTH_DENY_CODES]).toEqual([
      'judge_unavailable',
      'judge_indeterminate',
      'judge_signal_pending',
    ]);
    expect(JUDGE_CHECK_TIMEOUT_MS).toBe(2000);
  });
});

describe('checkJudgeGrowth:跨信任边界的运行期包装(永不抛)', () => {
  const slot = (check: JudgeGrowthSlot['check']): JudgeGrowthSlot => ({ check });
  const IND = { ok: false, code: 'judge_indeterminate' };

  it('正常值原样通过:ok / 三个拒绝码', async () => {
    expect(
      await checkJudgeGrowth(
        slot(() => Promise.resolve({ ok: true })),
        rec(SRC),
      ),
    ).toEqual({ ok: true });
    for (const code of JUDGE_GROWTH_DENY_CODES) {
      expect(
        await checkJudgeGrowth(
          slot(() => Promise.resolve({ ok: false, code })),
          rec(SRC),
        ),
      ).toEqual({ ok: false, code });
    }
  });

  it('check 抛错(异步 / 同步 / 非 Error)→ judge_indeterminate', async () => {
    expect(
      await checkJudgeGrowth(
        slot(() => Promise.reject(new Error('io'))),
        rec(SRC),
      ),
    ).toEqual(IND);
    expect(
      await checkJudgeGrowth(
        slot(() => {
          throw new Error('sync');
        }),
        rec(SRC),
      ),
    ).toEqual(IND);
    expect(
      await checkJudgeGrowth(
        slot(() => Promise.reject('str')),
        rec(SRC),
      ),
    ).toEqual(IND);
  });

  it('超时 → judge_indeterminate(悬挂的 check 不阻塞)', async () => {
    const hang = slot(() => new Promise(() => undefined));
    expect(await checkJudgeGrowth(hang, rec(SRC), { timeoutMs: 20 })).toEqual(IND);
  });

  it('返回非法值(枚举外的码 / 缺 code / 非对象 / ok 不是布尔)→ judge_indeterminate', async () => {
    for (const bad of [
      undefined,
      null,
      'ok',
      1,
      {},
      { ok: 'true' },
      { ok: false },
      { ok: false, code: 'whatever' },
      { ok: false, code: 7 },
    ]) {
      expect(
        await checkJudgeGrowth(
          slot(() => Promise.resolve(bad as never)),
          rec(SRC),
        ),
        JSON.stringify(bad),
      ).toEqual(IND);
    }
  });

  it('槽缺失 / 无 check 方法(未装配)→ judge_unavailable', async () => {
    const UN = { ok: false, code: 'judge_unavailable' };
    expect(await checkJudgeGrowth(undefined, rec(SRC))).toEqual(UN);
    expect(await checkJudgeGrowth(null, rec(SRC))).toEqual(UN);
    expect(await checkJudgeGrowth({} as JudgeGrowthSlot, rec(SRC))).toEqual(UN);
  });

  it('normalizeJudgeVerdict:ok:true 带多余字段也只取 {ok:true};拒绝码严格枚举', () => {
    expect(normalizeJudgeVerdict({ ok: true, code: 'judge_unavailable', extra: 1 })).toEqual({
      ok: true,
    });
    expect(normalizeJudgeVerdict({ ok: false, code: 'judge_signal_pending' })).toEqual({
      ok: false,
      code: 'judge_signal_pending',
    });
    expect(normalizeJudgeVerdict({ ok: false, code: 'unavailable' })).toBeNull();
  });
});

describe('normalizeJudgeReport(run 返回值的运行期校验)', () => {
  const good = {
    evaluated: 2,
    transitioned: ['a'],
    blocked: [{ id: 'b', code: 'judge_signal_pending' }],
    deferred: [{ id: 'c', why: 'unreadable' }],
    halted: null,
    unavailable: false,
  };
  it('合法报告原样规范化(拷贝,不共享引用)', () => {
    const r = normalizeJudgeReport(good);
    expect(r).toEqual(good);
    expect(r?.transitioned).not.toBe(good.transitioned);
  });
  it('每个字段非法 → null', () => {
    const bads: unknown[] = [
      null,
      'x',
      [],
      { ...good, evaluated: -1 },
      { ...good, evaluated: 1.5 },
      { ...good, evaluated: '2' },
      { ...good, transitioned: [1] },
      { ...good, transitioned: 'a' },
      { ...good, blocked: [{ id: 'b', code: 'nope' }] },
      { ...good, blocked: [{ id: 3, code: 'judge_unavailable' }] },
      { ...good, blocked: null },
      { ...good, deferred: [{ id: 'c' }] },
      { ...good, deferred: 'x' },
      { ...good, halted: 7 },
      { ...good, unavailable: 'no' },
    ];
    for (const b of bads) expect(normalizeJudgeReport(b), JSON.stringify(b)).toBeNull();
    const missing: Record<string, unknown> = { ...good };
    delete missing['unavailable'];
    expect(normalizeJudgeReport(missing)).toBeNull();
  });
  it('halted 合法字符串原样透传给 classifyHalt;未知 halted 值被 classifyHalt 按完整性不明处理', () => {
    const r = normalizeJudgeReport({ ...good, halted: 'repo_invalid' });
    expect(r?.halted).toBe('repo_invalid');
    expect(classifyHalt(r?.halted as never).kind).toBe('stop_step_unsettled');
    const lost = normalizeJudgeReport({ ...good, halted: 'lock_lost' });
    expect(classifyHalt(lost?.halted as never).kind).toBe('lock_lost_unresolved'); // judge_returns_*_lock_lost 的分流入口,归属需 resolveLockLoss
    const weird = normalizeJudgeReport({ ...good, halted: 'brand_new' });
    expect(classifyHalt(weird?.halted as never).kind).toBe('stop_step_unsettled');
    // 原型链键经 normalize → classify 同样按「完整性不明」处理(不是 Object.prototype 上的函数)
    for (const k of ['toString', 'constructor', '__proto__']) {
      const r = normalizeJudgeReport({ ...good, halted: k });
      expect(r, k).not.toBeNull();
      expect(classifyHalt(r?.halted as never), k).toEqual({
        kind: 'stop_step_unsettled',
        cause: 'candidate_invalid',
      });
    }
  });
});
