/**
 * W6 会话归并(R21-6.6 / R21-1.7 / §21.24 W0-14):0 标记 = 关联失败、≥ 2 个不同标记 = 多标记整会话排除、按标记去重(resume / fork)、
 * 缺键 = 未测、账行与计数行的 agent 须一致、账里标记重复 = 输入非法。每条不变量带负向用例。
 */
import { describe, expect, it } from 'vitest';
import { assemble, type AssembleInput } from '../../../src/rsi/analysis/assemble.js';
import { AnalysisInputError } from '../../../src/rsi/analysis/types.js';
import {
  CID,
  FP1,
  FP2,
  MIN,
  OTHER_CID,
  T_BASE,
  assign,
  iso,
  marker,
  sessRef,
  stat,
} from './w6-fixture.js';

function run(over: Partial<AssembleInput>): ReturnType<typeof assemble> {
  return assemble({
    candidateId: CID,
    windowStartIso: iso(T_BASE),
    collectedThroughIso: iso(T_BASE + 10_000 * MIN),
    ledger: [],
    stats: [],
    collecting: () => true,
    measures: () => ({ c1: 0, c3: 0, primary: 0 }),
    eligible: () => true,
    ...over,
  });
}

describe('R21-6.6 会话归并', () => {
  it('恰 1 个标记 → 关联到账行:有观测会话 + 完整账行', () => {
    const r = run({ ledger: [assign(1, 'treat')], stats: [stat(1)] });
    expect(r.observed.map((s) => [s.session_ref, s.arm, s.marker, s.background_fp])).toEqual([
      [sessRef(1), 'treat', marker(1), FP1],
    ]);
    expect(r.lines.map((l) => [l.marker, l.complete])).toEqual([[marker(1), true]]);
  });
  it('R21-6.6 0 个标记 → 关联失败:账行不完整、不进有观测会话', () => {
    const r = run({ ledger: [assign(1, 'control')], stats: [stat(1, { markers: [] })] });
    expect(r.observed).toEqual([]);
    expect(r.lines[0]?.complete).toBe(false);
    expect(r.lines[0]?.session_ts_ms).toBeNull();
  });
  it('≥ 2 个不同标记 → 多标记:整会话排除,它取回的标记对应的账行都不完整', () => {
    const r = run({
      ledger: [assign(1, 'treat'), assign(2, 'control')],
      stats: [stat(3, { markers: [marker(1), marker(2)] })],
    });
    expect(r.observed).toEqual([]);
    expect(r.lines.map((l) => l.complete)).toEqual([false, false]);
    expect(r.audit.multi_marker_sessions).toBe(1);
  });
  it('缺 rsi_markers(未采集)= 未测:不关联、不当作多标记也不当作有观测会话', () => {
    const r = run({ ledger: [assign(1, 'treat')], stats: [stat(1, { markers: undefined })] });
    expect(r.observed).toEqual([]);
    expect(r.lines[0]?.complete).toBe(false);
    expect(r.audit.multi_marker_sessions).toBe(0);
  });
});

describe('§21.24 W0-14 resume / fork 把同一标记复制进多个会话:按标记去重', () => {
  it('取 (ts, session_ref) 最早的会话,副本整个丢弃并计入审计;与输入顺序无关', () => {
    const early = stat(1, { tsMs: T_BASE + 5 * MIN, ref: sessRef(11) });
    const late = stat(2, { markers: [marker(1)], tsMs: T_BASE + 9 * MIN, ref: sessRef(12) });
    for (const stats of [
      [early, late],
      [late, early],
    ]) {
      const r = run({ ledger: [assign(1, 'treat')], stats });
      expect(r.observed.map((s) => s.session_ref)).toEqual([sessRef(11)]);
      expect(r.audit.duplicate_marker_sessions_dropped).toBe(1);
    }
  });
  it('开始时刻相同按 session_ref 升序取第一个', () => {
    const a = stat(1, { markers: [marker(1)], tsMs: T_BASE + MIN, ref: sessRef(21) });
    const b = stat(1, { markers: [marker(1)], tsMs: T_BASE + MIN, ref: sessRef(20) });
    const r = run({ ledger: [assign(1, 'treat')], stats: [a, b] });
    expect(r.observed.map((s) => s.session_ref)).toEqual([sessRef(20)]);
  });
  it('最早的携带者本身是多标记会话 → 标记对应账行不完整,较晚的单标记副本也不顶替它', () => {
    const multi = stat(1, {
      markers: [marker(1), marker(9)],
      tsMs: T_BASE + MIN,
      ref: sessRef(31),
    });
    const copy = stat(1, { markers: [marker(1)], tsMs: T_BASE + 5 * MIN, ref: sessRef(32) });
    const r = run({ ledger: [assign(1, 'treat')], stats: [multi, copy] });
    expect(r.observed).toEqual([]);
    expect(r.lines[0]?.complete).toBe(false);
  });
  it('同一 session_ref 的重复计数行只取第一行', () => {
    const first = stat(1, { markers: [marker(1)], ref: sessRef(40) });
    const dup = stat(2, { markers: [marker(2)], ref: sessRef(40) });
    const r = run({ ledger: [assign(1, 'treat'), assign(2, 'control')], stats: [first, dup] });
    expect(r.observed.map((s) => s.marker)).toEqual([marker(1)]);
  });
});

describe('R21-6.4 账行的取舍', () => {
  it('excluded 行(含探针行)、别的候选的行、窗口之前的行都不进分析', () => {
    const probe = assign(5, 'excluded', {
      marker: marker(5),
      candidate_id: null,
      reason: 'admission_probe',
      probe_generation: 1,
      probe_ticket: 1,
    });
    const r = run({
      ledger: [
        assign(1, 'excluded'),
        probe,
        assign(2, 'treat', { candidate_id: OTHER_CID }),
        assign(3, 'treat', { atMs: T_BASE - 60 * MIN }),
        assign(4, 'control'),
      ],
      stats: [stat(2), stat(3), stat(4), stat(5)],
    });
    expect(r.lines.map((l) => l.marker)).toEqual([marker(4)]);
    expect(r.observed.map((s) => s.marker)).toEqual([marker(4)]);
    // 别的候选 / 探针 / 窗口之前的账行所属会话:标记不在本候选账行里
    expect(r.audit.foreign_marker_sessions).toBe(3);
  });
  it('R21-6.4 arm=excluded 的账行不进分析,只按原因码计入审计(C6 分母说明);别的候选 / 窗口之前的不计', () => {
    const r = run({
      ledger: [
        assign(1, 'excluded'),
        assign(2, 'excluded', { reason: 'rng_error' }),
        assign(3, 'excluded'),
        assign(4, 'excluded', { candidate_id: OTHER_CID }),
        assign(5, 'excluded', { atMs: T_BASE - 60 * MIN }),
        assign(6, 'treat'),
      ],
      stats: [stat(6)],
    });
    expect(r.audit.excluded_by_reason).toEqual({ paused: 2, rng_error: 1 });
    expect(r.lines.length).toBe(1);
    expect(r.observed.length).toBe(1);
  });
  it('账里同一标记出现在两行 assign → 输入非法(抛错,不「尽量」)', () => {
    expect(() =>
      run({ ledger: [assign(1, 'treat'), assign(2, 'control', { marker: marker(1) })] }),
    ).toThrow(AnalysisInputError);
  });
  it('计数行 agent 与账行 agent 不一致 → 不关联(账行不完整)', () => {
    const r = run({
      ledger: [assign(1, 'treat', { agent: 'claude' })],
      stats: [stat(1, { agent: 'pi' })],
    });
    expect(r.observed).toEqual([]);
    expect(r.lines[0]?.complete).toBe(false);
    expect(r.audit.agent_mismatch).toBe(1);
  });
  it('标记不在账里 → 不是本次的会话(不计、不当作关联失败)', () => {
    const r = run({
      ledger: [assign(1, 'treat')],
      stats: [stat(1), stat(7, { markers: [marker(70)] })],
    });
    expect(r.observed.length).toBe(1);
    expect(r.audit.foreign_marker_sessions).toBe(1);
  });
});

describe('M2 有观测会话须在采集覆盖时刻之前开始(计数行首次采集即落盘,不等于信号读全)', () => {
  const through = T_BASE + 10 * MIN;
  it('M2 开始时刻晚于采集覆盖时刻 → 不是有观测会话(审计计数),但账行仍关联完整', () => {
    const r = run({
      ledger: [assign(1, 'treat'), assign(2, 'control')],
      stats: [stat(1, { tsMs: through - MIN }), stat(2, { tsMs: through + MIN })],
      collectedThroughIso: iso(through),
    });
    expect(r.observed.map((s) => s.marker)).toEqual([marker(1)]);
    expect(r.audit.beyond_collected_through).toBe(1);
    expect(r.lines.map((l) => [l.marker, l.complete])).toEqual([
      [marker(1), true],
      [marker(2), true],
    ]);
  });
  it('M2 边界:开始时刻恰等于采集覆盖时刻 → 仍算(≤)', () => {
    const r = run({
      ledger: [assign(1, 'treat')],
      stats: [stat(1, { tsMs: through })],
      collectedThroughIso: iso(through),
    });
    expect(r.observed.length).toBe(1);
    expect(r.audit.beyond_collected_through).toBe(0);
  });
});

describe('L2 C6 分母按 ITT:资格不成立的已关联账行不进分母', () => {
  it('已关联且资格不成立 → eligible=false;未关联 → null(资格不可知,保留);项目不在采集中 → null', () => {
    const r = run({
      ledger: [assign(1, 'treat'), assign(2, 'control'), assign(3, 'treat'), assign(4, 'control')],
      stats: [
        stat(1),
        stat(2, { markers: [] }),
        stat(3, { project: 'not_collected' }),
        stat(4, { project: 'elig_proj' }),
      ],
      collecting: (k) => k !== 'not_collected',
      eligible: (k) => k === 'elig_proj',
    });
    expect(r.lines.map((l) => [l.marker, l.complete, l.eligible])).toEqual([
      [marker(1), true, false],
      [marker(2), false, null],
      [marker(3), true, null],
      [marker(4), true, true],
    ]);
  });
});

describe('R21-1.7 有观测会话与 C6 的可判范围', () => {
  it('账行 at 晚于采集覆盖时刻 → 尚不可判(不当作关联失败),审计计数', () => {
    const r = run({
      ledger: [assign(1, 'treat'), assign(2, 'control', { atMs: T_BASE + 20 * MIN })],
      collectedThroughIso: iso(T_BASE + 10 * MIN),
    });
    expect(r.lines.map((l) => l.judgeable)).toEqual([true, false]);
    expect(r.audit.unjudgeable_lines).toBe(1);
  });
  it('不属采集中的项目:关联成功(账行完整)但不是有观测会话', () => {
    const r = run({
      ledger: [assign(1, 'treat')],
      stats: [stat(1, { project: 'excluded_proj' })],
      collecting: (k) => k !== 'excluded_proj',
    });
    expect(r.observed).toEqual([]);
    expect(r.lines[0]?.complete).toBe(true);
    expect(r.audit.not_collecting_project).toBe(1);
  });
  it('资格不成立的会话仍是有观测会话(只带 eligible=false),审计计数', () => {
    const r = run({ ledger: [assign(1, 'treat')], stats: [stat(1)], eligible: () => false });
    expect(r.observed.map((s) => s.eligible)).toEqual([false]);
    expect(r.audit.not_eligible).toBe(1);
  });
  it('信号度量与 retry_chain_max 原样带入;retry_chain_max 缺键 = null(不是 0)', () => {
    const r = run({
      ledger: [assign(1, 'treat'), assign(2, 'control')],
      stats: [stat(1, { retry: 0 }), stat(2)],
      measures: (ref) =>
        ref === sessRef(1) ? { c1: 2, c3: 3, primary: 4 } : { c1: 0, c3: 0, primary: 0 },
    });
    const [a, b] = r.observed;
    expect([a?.c1, a?.c3, a?.primary, a?.retry_chain_max]).toEqual([2, 3, 4, 0]);
    expect(b?.retry_chain_max).toBeNull();
  });
  it('账行保持账的先后顺序;background_fp 取自账行', () => {
    const r = run({
      ledger: [assign(1, 'treat'), assign(2, 'control', { background_fp: FP2 })],
      stats: [stat(1), stat(2)],
    });
    expect(r.lines.map((l) => l.background_fp)).toEqual([FP1, FP2]);
    expect(r.observed.map((s) => s.background_fp)).toEqual([FP1, FP2]);
  });
  it('窗口起点 / 采集时刻不可解析 → 抛输入错误', () => {
    expect(() => run({ windowStartIso: 'nope' })).toThrow(AnalysisInputError);
    expect(() => run({ collectedThroughIso: 'nope' })).toThrow(AnalysisInputError);
  });
});
