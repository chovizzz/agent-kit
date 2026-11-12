/**
 * W6 判变差(R21-7.4 / 7.4a / 7.6 / 7.7 / 7.8 / 7.13):α 分配、OBF 累计边界、查看节奏、稀疏层、C2 缺键、C4、背景分段、资格、正向恒不可判。
 * 每条不变量一个正例 + 负例;数据都是手写的合成序列。
 */
import { describe, expect, it } from 'vitest';
import { RSI_DECIDE_BETTER_ENABLED } from '../../../src/contracts/rsi.js';
import {
  analyzeSegment,
  c4Check,
  DEFAULT_ANALYSIS_CONFIG,
  type AnalysisConfig,
  type SegmentAnalysis,
} from '../../../src/rsi/analysis/analyze.js';
import { obfCumulativeAlpha } from '../../../src/rsi/analysis/math.js';
import { AnalysisRngError, seededRandom } from '../../../src/rsi/analysis/rng.js';
import {
  ALPHA_PER_METRIC,
  HARM_P_METRICS,
  type ObservedSession,
  type RandomizedLine,
} from '../../../src/rsi/analysis/types.js';
import { FP1, FP2, MIN, T_BASE, alternating, assembled, lineOf, obsSession } from './w6-fixture.js';

function run(
  sessions: readonly ObservedSession[],
  o: {
    extra?: readonly RandomizedLine[];
    c4?: number | null;
    cfg?: Partial<AnalysisConfig>;
    seed?: string;
  } = {},
): SegmentAnalysis {
  return analyzeSegment({
    assembled: assembled(sessions, o.extra ?? []),
    random: seededRandom(o.seed ?? 'w6'),
    c4Bytes: o.c4 === undefined ? 100 : o.c4,
    config: { ...DEFAULT_ANALYSIS_CONFIG, ...o.cfg },
  });
}
const FAST: Partial<AnalysisConfig> = { permutations: 200 };

/** 120 个会话:偶数序号 control、奇数序号 treat */
const harmC1 = (n = 120): ObservedSession[] =>
  alternating(n, (i, arm) => ({ c1: arm === 'treat' ? 3 : i % 4 === 0 ? 1 : 0 }));

describe('R21-7.4 常量与 α 分配', () => {
  it('四项各 0.025(= 总 α 0.10 ÷ 4;C4 不在其中);不是 ÷5', () => {
    expect([...HARM_P_METRICS]).toEqual(['c1', 'c2', 'c3', 'c6']);
    expect(ALPHA_PER_METRIC).toBeCloseTo(0.025, 12);
    expect(DEFAULT_ANALYSIS_CONFIG.alphaPerMetric).toBeCloseTo(0.025, 12);
  });
  it('第 k 次查看的边界 = 累计 α*(t_k),t = 对照组有观测会话数 / 上限(不是增量、不含 treat)', () => {
    // 上限改成 10:前缀 10 会话含 5 个 control → t = 0.5;前缀 20 含 10 个 → t = 1
    const a = run(alternating(20), { cfg: { ...FAST, maxPerArm: 10 } });
    expect(a.looks.map((l) => [l.k, l.observed, l.control_observed, l.t])).toEqual([
      [1, 10, 5, 0.5],
      [2, 20, 10, 1],
    ]);
    const b1 = a.looks[0]?.metrics[0]?.boundary as number;
    const b2 = a.looks[1]?.metrics[0]?.boundary as number;
    expect(b1).toBeGreaterThan(0.0015);
    expect(b1).toBeLessThan(0.00155);
    expect(b2).toBeCloseTo(0.025, 6);
    expect(b1).toBeCloseTo(obfCumulativeAlpha(0.025, 0.5), 12);
    // 四项共用同一边界
    for (const m of a.looks[1]?.metrics ?? []) expect(m.boundary).toBe(b2);
  });
});

describe('R21-7.4 判变差:越过 OBF 边界 → harm_<指标>', () => {
  it('R21-7.4 C1:treat 每会话 3 次失败、control 多为 0:信息时间够了才越界(k 在 10–12,t ≥ 0.4),之前的查看都没越', () => {
    const a = run(harmC1());
    expect(a.kind).toBe('harm');
    expect(a.harm?.metric).toBe('c1');
    expect(a.harm?.k).toBeGreaterThanOrEqual(10);
    expect(a.harm?.k).toBeLessThanOrEqual(12);
    expect(a.harm?.t).toBeGreaterThanOrEqual(0.4);
    expect(a.harm?.p as number).toBeLessThanOrEqual(a.harm?.boundary as number);
    const crossed = a.looks.filter((l) => l.metrics.some((m) => m.crossed));
    expect(crossed.length).toBe(1);
    expect(a.looks[a.looks.length - 1]?.k).toBe(a.harm?.k);
    const c1 = a.looks[a.looks.length - 1]?.metrics.find((m) => m.metric === 'c1');
    expect((c1?.estimate as number) > 1).toBe(true);
    expect(a.positive).toBe('not_decidable');
  });
  it('同样的效应出现得太早(40 会话,t ≈ 0.17):OBF 边界极小,不越界', () => {
    const a = run(harmC1(40));
    expect(a.kind).toBe('no_harm');
    expect(a.harm).toBeNull();
    for (const l of a.looks) {
      expect(l.metrics.some((m) => m.crossed)).toBe(false);
      expect(l.metrics[0]?.boundary as number).toBeLessThan(1e-3);
    }
    // 效应本身已经很显著(p 极小),只是没到边界
    expect(a.looks[a.looks.length - 1]?.metrics[0]?.p as number).toBeLessThan(0.01);
  });
  it('没有效应(两组同分布)→ 不判变差', () => {
    const a = run(
      alternating(120, (i) => ({ c1: Math.floor(i / 2) % 3, c3: Math.floor(i / 2) % 2 })),
      {
        cfg: FAST,
      },
    );
    expect(a.kind).toBe('no_harm');
    expect(a.looks.every((l) => l.metrics.every((m) => !m.crossed))).toBe(true);
  });
  it('R21-7.13 方向相反(treat 更好)→ 不判变差,也不产生任何「变好」结论(R21-7.13:positive 恒 not_decidable)', () => {
    const a = run(alternating(120, (_i, arm) => ({ c1: arm === 'treat' ? 0 : 2 })));
    expect(a.kind).toBe('no_harm');
    expect(a.harm).toBeNull();
    expect(a.positive).toBe('not_decidable');
    expect(a.looks[a.looks.length - 1]?.metrics[0]?.estimate as number).toBe(0);
    expect(RSI_DECIDE_BETTER_ENABLED).toBe(false);
  });
  it('C2:retry_chain_max 越大越差(log(1+x) 的分层均值差);缺键的会话不进 C2、更不当 0', () => {
    const a = run(alternating(120, (_i, arm) => ({ retry_chain_max: arm === 'treat' ? 3 : 0 })));
    expect(a.harm?.metric).toBe('c2');
    const est = a.looks[a.looks.length - 1]?.metrics.find((m) => m.metric === 'c2')?.estimate;
    expect(est).toBeCloseTo(4, 6); // 几何均值比 = 1 + 3
    // 缺键:treat 全是 null → C2 没有可用层(若被当成 0 会得到「两组都 0」而不是「没有层」)
    const missing = run(
      alternating(120, (i, arm) => ({ retry_chain_max: arm === 'control' ? i % 3 : null })),
      { cfg: FAST },
    );
    for (const l of missing.looks) {
      expect(l.metrics.find((m) => m.metric === 'c2')?.status).toBe('no_usable_strata');
    }
    expect(missing.harm).toBeNull();
  });
  it('C2 不跨 agent 能力比较:没有工具名的 agent(codex / kimi)不进 C2,即使带了 retry_chain_max', () => {
    const a = run(
      alternating(40, (_i, arm) => ({
        agent: 'codex' as unknown as 'claude',
        retry_chain_max: arm === 'treat' ? 3 : 0,
      })),
      { cfg: FAST },
    );
    for (const l of a.looks) {
      expect(l.metrics.find((m) => m.metric === 'c2')?.status).toBe('no_usable_strata');
    }
  });
  it('C3:显式教训 / 纠正多的一组更差', () => {
    const a = run(alternating(120, (_i, arm) => ({ c3: arm === 'treat' ? 2 : 0 })));
    expect(a.harm?.metric).toBe('c3');
  });
  it('C6:treat 的完整率明显更低(关联失败的账行没有项目,按 agent 分层)', () => {
    const sessions = alternating(120, () => ({}));
    // 额外 60 个 treat 账行没取回标记(不完整),均匀散落在时间线上
    const extra = Array.from({ length: 60 }, (_v, i) =>
      lineOf(obsSession(1000 + i, 'treat'), {
        marker: `rsm_${(5000 + i).toString(16).padStart(16, '0')}`,
        complete: false,
        session_ts_ms: null,
        at_ms: T_BASE + i * 2 * MIN + 30_000,
      }),
    );
    const a = run(sessions, { extra });
    expect(a.harm?.metric).toBe('c6');
    expect(a.incomplete).toEqual({ treat: 60, control: 0 });
    expect(a.randomized).toEqual({ treat: 120, control: 60 });
    const last = a.looks[a.looks.length - 1]?.metrics.find((m) => m.metric === 'c6');
    expect(last?.estimate as number).toBeGreaterThan(5); // 百分点
  });
  it('C6 负例:采集尚未覆盖的账行(judgeable=false)不当作关联失败', () => {
    const extra = Array.from({ length: 60 }, (_v, i) =>
      lineOf(obsSession(1000 + i, 'treat'), {
        marker: `rsm_${(5000 + i).toString(16).padStart(16, '0')}`,
        complete: false,
        judgeable: false,
        session_ts_ms: null,
        at_ms: T_BASE + i * 2 * MIN + 30_000,
      }),
    );
    const a = run(alternating(120), { extra, cfg: FAST });
    expect(a.harm).toBeNull();
    expect(a.incomplete).toEqual({ treat: 0, control: 0 });
  });
  it('L2 C6 分母按 ITT:已关联且资格不成立的账行不进分母(按组计入 c6_ineligible_excluded);未关联的保留', () => {
    // treat 会话资格全不成立 → 它们的账行出分母;60 个 treat 账行没取回标记(资格不可知,保留);control 60 个完整
    const sessions = alternating(120, (_i, arm) => ({ eligible: arm !== 'treat' }));
    const extra = Array.from({ length: 60 }, (_v, i) =>
      lineOf(obsSession(1000 + i, 'treat'), {
        marker: `rsm_${(5000 + i).toString(16).padStart(16, '0')}`,
        complete: false,
        eligible: null,
        session_ts_ms: null,
        at_ms: T_BASE + i * MIN + 30_000,
      }),
    );
    const a = run(sessions, { extra, cfg: FAST });
    expect(a.c6_ineligible_excluded).toEqual({ treat: 60, control: 0 });
    expect(a.randomized).toEqual({ treat: 60, control: 60 });
    // treat 完整率 0、control 1 → 100 个百分点(若把资格不成立的 60 个 treat 完整行放进分母,只有 50)
    const c6 = a.looks[a.looks.length - 1]?.metrics.find((m) => m.metric === 'c6');
    expect(c6?.estimate).toBeCloseTo(100, 6);
  });
  it('M1 R21-6.7 关联失败按最坏情况做敏感性:treat 记不完整、control 记完整;只出报告,不改主判定', () => {
    const unlinked = (arm: 'treat' | 'control', i: number): RandomizedLine =>
      lineOf(obsSession(1000 + i, arm), {
        marker: `rsm_${(arm === 'treat' ? 5000 + i : 7000 + i).toString(16).padStart(16, '0')}`,
        complete: false,
        eligible: null,
        session_ts_ms: null,
        at_ms: T_BASE + i * MIN + 30_000,
      });
    const extra = [
      ...Array.from({ length: 60 }, (_v, i) => unlinked('treat', i)),
      ...Array.from({ length: 60 }, (_v, i) => unlinked('control', i)),
    ];
    const a = run(alternating(120), { extra });
    // 主分析:两组各 60 完整 + 60 不完整 → 完整率差 0 → 不是变差
    const last = a.looks[a.looks.length - 1];
    expect(last?.metrics.find((m) => m.metric === 'c6')?.estimate).toBeCloseTo(0, 6);
    expect(a.harm).toBeNull();
    expect(a.kind).not.toBe('harm');
    // 最坏情况:control 的 60 个关联失败记完整 → control 120/120、treat 60/120 → 50 个百分点
    const w = a.c6_worst_case;
    expect(w?.k).toBe(last?.k);
    expect(w?.unlinked).toEqual({ treat: 60, control: 60 });
    expect(w?.look.status).toBe('tested');
    expect(w?.look.estimate).toBeCloseTo(50, 6);
    expect(w?.look.p as number).toBeLessThan(0.05);
  });
  it('M1 负例:没有任何查看 → 没有最坏情况结果(null)', () => {
    expect(run(alternating(5), { cfg: FAST }).c6_worst_case).toBeNull();
  });
  it('两组均零事件 → 该项证据不足(不检验、不消耗 α)', () => {
    const a = run(alternating(40), { cfg: FAST });
    for (const l of a.looks) {
      for (const m of l.metrics.filter((x) => x.metric === 'c1' || x.metric === 'c3')) {
        expect([m.status, m.p, m.crossed]).toEqual(['insufficient', null, false]);
      }
    }
  });
  it('资格不成立的会话不进统计量,但仍计入信息时间与查看节奏', () => {
    const a = run(
      alternating(120, (_i, arm) => ({ c1: arm === 'treat' ? 3 : 0, eligible: arm !== 'treat' })),
      {
        cfg: FAST,
      },
    );
    expect(a.harm).toBeNull();
    expect(a.looks[a.looks.length - 1]?.t).toBe(0.5);
    expect(a.looks[0]?.observed).toBe(10);
    expect(a.looks[0]?.metrics.find((m) => m.metric === 'c1')?.status).toBe('no_usable_strata');
  });
});

describe('R21-7.4 C4 绝对上限:越限即回滚(不看 p 值、不等查看)', () => {
  it('R21-7.1 c4Check:≤ 1536 通过,1537 越限;没有 treat / 字节不可得分别标出', () => {
    expect(c4Check(1536, true).status).toBe('ok');
    expect(c4Check(1537, true).status).toBe('exceeded');
    expect(c4Check(null, true).status).toBe('unavailable');
    expect(c4Check(5000, false).status).toBe('no_treat');
    expect(c4Check(1536, true).limit).toBe(1536);
  });
  it('越限 → harm_c4;1536 字节不越限;字节不可得 → 不判 c4(也不当作通过)', () => {
    const s = alternating(20);
    const over = run(s, { c4: 1537, cfg: FAST });
    expect(over.kind).toBe('harm');
    expect(over.harm).toEqual({ metric: 'c4', k: 0, t: 0, p: null, boundary: null });
    expect(run(s, { c4: 1536, cfg: FAST }).harm).toBeNull();
    const unk = run(s, { c4: null, cfg: FAST });
    expect(unk.harm).toBeNull();
    expect(unk.c4.status).toBe('unavailable');
  });
});

describe('R21-7.4 查看节奏:每 RSI_LOOK_EVERY 个新有观测会话查看一次', () => {
  it('9 个会话没有查看;19 个 1 次;20 个 2 次(两组合计)', () => {
    expect(run(alternating(9), { cfg: FAST }).looks.length).toBe(0);
    expect(run(alternating(19), { cfg: FAST }).looks.length).toBe(1);
    expect(run(alternating(20), { cfg: FAST }).looks.length).toBe(2);
    expect(run(alternating(20), { cfg: FAST }).looks.map((l) => l.observed)).toEqual([10, 20]);
  });
  it('查看点按 (ts, session_ref) 排序取前缀,与输入顺序无关;重算得同一结果(种子可复算)', () => {
    const s = harmC1(60);
    const shuffled = [...s].reverse();
    const a = run(s, { cfg: FAST });
    const b = run(shuffled, { cfg: FAST });
    expect(b.looks).toEqual(a.looks);
    expect(run(s, { cfg: FAST, seed: 'w6' }).looks).toEqual(a.looks);
    expect(a.seed).toBe('w6');
  });
  it('注入的随机源越界 → 抛 AnalysisRngError(不静默)', () => {
    expect(() =>
      analyzeSegment({
        assembled: assembled(harmC1(20)),
        random: { seed: 'bad', stream: () => ({ unit: () => 1 }) },
        c4Bytes: 100,
        config: { ...DEFAULT_ANALYSIS_CONFIG, ...FAST },
      }),
    ).toThrow(AnalysisRngError);
  });
});

describe('R21-7.4a 稀疏分层:剔除、无层可用 → 不判定、不消耗 α、信息时间照常推进', () => {
  it('R21-7.4a 19 个 treat + 1 个 control:并层后仍稀疏 → 全部剔除;look 无效、kind=no_decision、从未有效查看', () => {
    const s = [
      ...alternating(1, () => ({})), // 1 个 control(序号 0)
      ...Array.from({ length: 19 }, (_v, i) => obsSession(i + 1, 'treat', { c1: 5 })),
    ];
    const a = run(s, { cfg: FAST });
    expect(a.looks.length).toBe(2);
    expect(a.looks.every((l) => !l.valid)).toBe(true);
    expect(a.never_valid_look).toBe(true);
    expect(a.kind).toBe('no_decision');
    expect(a.harm).toBeNull();
    const m = a.looks[1]?.metrics.find((x) => x.metric === 'c1');
    expect(m?.status).toBe('no_usable_strata');
    expect(m?.dropped_sessions).toBe(20);
    // 信息时间照常推进(control 只有 1 个)
    expect(a.looks.map((l) => l.t)).toEqual([1 / 120, 1 / 120]);
  });
  it('部分层稀疏:稀疏层被剔除、剩余层照常检验,剔除的会话数写进审计', () => {
    const s = [
      ...alternating(40, () => ({ project_key: 'big', c1: 1 })),
      // 另一个项目:treat 10 个、control 1 个 → 并入「其它」后仍稀疏
      ...Array.from({ length: 10 }, (_v, i) =>
        obsSession(101 + i, 'treat', { project_key: 'tiny', c1: 1 }),
      ),
      obsSession(100, 'control', { project_key: 'tiny' }),
    ];
    const a = run(s, { cfg: FAST });
    const m = a.looks[a.looks.length - 1]?.metrics.find((x) => x.metric === 'c1');
    expect(m?.status).toBe('tested');
    expect(m?.strata).toBe(1);
    // 最后一次查看的前缀 = 50 个会话:big 的 40 个 + tiny 的前 10 个(1 个 control + 9 个 treat)
    expect(m?.dropped_sessions).toBe(10);
    expect(a.never_valid_look).toBe(false);
  });
  it('并层:稀疏项目并入该 agent 的「其它」层后可用,会话数写进审计', () => {
    const s = [
      ...alternating(20, () => ({ project_key: 'big', c1: 1 })),
      ...Array.from({ length: 10 }, (_v, i) =>
        obsSession(100 + i, i % 2 === 0 ? 'control' : 'treat', {
          project_key: `small${i}`,
          c1: i % 2,
        }),
      ),
    ];
    const a = run(s, { cfg: FAST });
    const m = a.looks[a.looks.length - 1]?.metrics.find((x) => x.metric === 'c1');
    expect(m?.strata).toBe(2);
    expect(m?.pooled_sessions).toBe(10);
  });
});

describe('R21-7.7 背景分段:只分析当前段,跨段不合并,新段从 t = 0 重新计', () => {
  const old = alternating(60, (_i, arm) => ({ c1: arm === 'treat' ? 3 : 0, background_fp: FP1 }));
  const cur = alternating(
    40,
    (_i, arm) => ({ c1: arm === 'treat' ? 1 : 1, background_fp: FP2 }),
    100,
  );
  it('R21-7.7 当前段 = 账里最后一行的 background_fp;更早的段只出敏感性点估计,不判、不产事件', () => {
    const a = run([...old, ...cur], { cfg: FAST });
    expect(a.background_fp).toBe(FP2);
    expect(a.kind).toBe('no_harm');
    expect(a.harm).toBeNull();
    // 新段从 t = 0 重新计:第一次查看只含新段的前 10 个会话(5 个 control)
    expect(a.looks[0]).toMatchObject({ observed: 10, control_observed: 5 });
    expect(a.looks.length).toBe(4);
    expect(a.sensitivity.map((s) => [s.background_fp, s.observed])).toEqual([[FP1, 60]]);
    expect(a.sensitivity[0]?.c1_rr).toBe(Infinity);
    expect(a.treat_observed + a.control_observed).toBe(40);
  });
  it('回到旧指纹(A → B → A)也是新段:t 从 0 重新计,旧的 A 段不并入当前 A 段', () => {
    const a1 = alternating(20, (_i, arm) => ({ c1: arm === 'treat' ? 3 : 0, background_fp: FP1 }));
    const b = alternating(20, () => ({ background_fp: FP2 }), 100);
    const a2 = alternating(30, () => ({ c1: 1, background_fp: FP1 }), 200);
    const a = run([...a1, ...b, ...a2], { cfg: FAST });
    expect(a.background_fp).toBe(FP1);
    expect(a.treat_observed + a.control_observed).toBe(30);
    expect(a.looks[0]).toMatchObject({ observed: 10, control_observed: 5 });
    expect(a.sensitivity.map((s) => [s.run, s.background_fp, s.observed])).toEqual([
      [0, FP1, 20],
      [1, FP2, 20],
    ]);
    expect(a.harm).toBeNull();
  });
  it('负例:不分段(同一背景)时旧会话会被合并进同一次分析', () => {
    const same = [...old, ...cur.map((s) => ({ ...s, background_fp: FP1 }))];
    const a = run(same, { cfg: FAST });
    expect(a.background_fp).toBe(FP1);
    expect(a.treat_observed + a.control_observed).toBe(100);
    expect(a.sensitivity).toEqual([]);
  });
});

describe('R21-7.6 / 7.8 报告', () => {
  it('R21-7.8 overlaps_preset 取本段最后一行并标出不一致;完整与不完整的账行数按组统计', () => {
    const s = alternating(20);
    const extra = [
      lineOf(s[0] as ObservedSession, { overlaps_preset: true, at_ms: T_BASE + 99 * MIN }),
    ];
    const a = run(s, { extra, cfg: FAST });
    expect(a.overlaps_preset).toBe(true);
    expect(a.overlaps_preset_mixed).toBe(true);
    const b = run(s, { cfg: FAST });
    expect(b.overlaps_preset).toBe(false);
    expect(b.overlaps_preset_mixed).toBe(false);
    expect(run([], { cfg: FAST }).overlaps_preset).toBeNull();
  });
  it('R21-7.6 主判据:只出 MH 率比与事件数(资格成立的会话);两组零事件 → 证据不足、rr 为 null', () => {
    const a = run(
      alternating(40, (_i, arm) => ({ primary: arm === 'treat' ? 1 : 2 })),
      { cfg: FAST },
    );
    expect(a.primary.insufficient).toBe(false);
    expect(a.primary.rr).toBeCloseTo(0.5, 10);
    expect([a.primary.control_events, a.primary.treat_events]).toEqual([40, 20]);
    const z = run(alternating(40), { cfg: FAST });
    expect([z.primary.rr, z.primary.insufficient]).toEqual([null, true]);
  });
  it('max_arm_sessions = 两组有观测会话数的较大者(装配处据此走 canary_limit)', () => {
    const s = [...alternating(10), obsSession(50, 'treat'), obsSession(51, 'treat')];
    expect(run(s, { cfg: FAST }).max_arm_sessions).toBe(7);
  });
});
