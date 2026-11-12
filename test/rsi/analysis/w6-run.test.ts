/**
 * W6 编排与产出事件(R21-7.4 / R21-7.7 / R21-7.9 / R21-7.13):读失败不落成「无伤害」、漂移暂停、harm 事件过转移引擎的 schema、
 * 正向方向没有任何路径。端口用内存假件(同一契约:读不了就抛错)。
 */
import { describe, expect, it } from 'vitest';
import { RSI_DECIDE_BETTER_ENABLED } from '../../../src/contracts/rsi.js';
import type { RsiCanaryLedgerLine } from '../../../src/contracts/rsi-personal.js';
import type { Signal } from '../../../src/contracts/signal.js';
import { harmEvent } from '../../../src/rsi/analysis/events.js';
import { runAnalysis, type AnalysisSource } from '../../../src/rsi/analysis/run.js';
import { TransitionEventSchema } from '../../../src/rsi/personal/transition-table.js';
import { CID, MIN, T_BASE, assign, iso, marker, sessRef, stat } from './w6-fixture.js';
import type { StatItem } from '../../../src/rsi/canary/marker-view.js';

const DAY = 86_400_000;
let sn = 0;
function fail(session: number): Signal {
  sn++;
  return {
    sig_id: `sig_${sn.toString(16).padStart(16, '0')}`,
    agent: 'claude',
    agent_version: '2.1.0',
    agent_version_source: 'session_meta',
    session_ref: sessRef(session),
    project_key: 'p1',
    ts: iso(T_BASE),
    type: 'event',
    excerpt_redacted: '',
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
    event_kind: 'tool_result_failed',
    event_index: sn,
  } as unknown as Signal;
}
function call(session: number, idx: number): Signal {
  return {
    ...fail(session),
    event_kind: 'tool_call',
    tool_name: 'Bash',
    event_index: idx,
  } as Signal;
}

const SIGNATURE = { kind: 'tool', tool_name: 'Bash' } as const;
/** 120 个被随机的会话(偶数 control、奇数 treat);treat 每会话 3 次失败;另有一个窗口之前的命中会话,使全部会话资格成立 */
function world(): { ledger: RsiCanaryLedgerLine[]; stats: StatItem[]; signals: Signal[] } {
  const ledger: RsiCanaryLedgerLine[] = [];
  const stats: StatItem[] = [];
  const signals: Signal[] = [];
  for (let i = 1; i <= 120; i++) {
    const treat = i % 2 === 1;
    ledger.push(assign(i, treat ? 'treat' : 'control'));
    stats.push(stat(i));
    const nFail = treat ? 3 : i % 4 === 0 ? 1 : 0;
    for (let k = 0; k < nFail; k++) signals.push(fail(i));
  }
  stats.push(stat(900, { markers: [], tsMs: T_BASE - 5 * DAY }));
  signals.push(call(900, 0), { ...fail(900), event_index: 1 }, call(900, 2));
  return { ledger, stats, signals };
}

function source(over: Partial<AnalysisSource> = {}, w = world()): AnalysisSource {
  return {
    ledger: async () => w.ledger,
    stats: async () => w.stats,
    signals: async () => w.signals,
    classify: async () => 'P',
    payloadDrift: async () => 'clean',
    collectedThrough: async () => iso(T_BASE + 100_000 * MIN),
    c4Bytes: async () => 100,
    ...over,
  };
}
const REQ = { candidateId: CID, signature: SIGNATURE, windowStartIso: iso(T_BASE) } as const;

describe('R21-7.4 编排:harm 事件', () => {
  it('C1 变差 → harm;事件过 TransitionEventSchema:{kind:harm, metric:c1, worse:true},evidence ≤ 128 字且不含路径 / 项目 key', async () => {
    const o = await runAnalysis(source(), REQ);
    expect(o.kind).toBe('harm');
    if (o.kind !== 'harm') return;
    expect(o.analysis.harm?.metric).toBe('c1');
    expect(o.analysis.positive).toBe('not_decidable');
    const e = harmEvent(o);
    expect(e).not.toBeNull();
    expect(TransitionEventSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ kind: 'harm', metric: 'c1', worse: true });
    const ev = (e as { evidence: string }).evidence;
    expect(ev).toMatch(/^analysis-v1:c1:look=\d+:t=0\.\d{3}:p=0\.\d{4}:bound=0\.\d{4}$/);
    expect(ev.length).toBeLessThanOrEqual(128);
    expect(ev).not.toContain('p1');
  });
  it('C4 越限 → harm_c4(evidence 只含字节数与上限)', async () => {
    const o = await runAnalysis(source({ c4Bytes: async () => 1537 }), REQ);
    expect(o.kind).toBe('harm');
    expect(harmEvent(o)).toMatchObject({
      kind: 'harm',
      metric: 'c4',
      worse: true,
      evidence: 'analysis-v1:c4:bytes=1537:limit=1536',
    });
  });
  it('没有越界 → 不产出事件;正向方向没有任何路径(判定开关为假时变差判定照常触发)', async () => {
    const w = world();
    const calm = { ...w, signals: w.signals.filter((s) => s.session_ref === sessRef(900)) };
    const o = await runAnalysis(source({}, calm), REQ);
    expect(['no_harm', 'no_decision']).toContain(o.kind);
    expect(harmEvent(o)).toBeNull();
    expect(RSI_DECIDE_BETTER_ENABLED).toBe(false);
    const harm = await runAnalysis(source(), REQ);
    expect(harm.kind).toBe('harm');
  });
});

describe('R21-7.7 漂移暂停与 fail-closed(读失败从不落成「无伤害」)', () => {
  it('本机 payload 漂移 → paused,不读任何数据、不产出事件', async () => {
    let reads = 0;
    const o = await runAnalysis(
      source({
        payloadDrift: async () => 'drifted',
        ledger: async () => {
          reads++;
          return [];
        },
      }),
      REQ,
    );
    expect(o).toEqual({ kind: 'paused', reason: 'payload_drift' });
    expect(reads).toBe(0);
    expect(harmEvent(o)).toBeNull();
  });
  const boom = async (): Promise<never> => {
    throw new Error('boom');
  };
  it.each([
    ['payloadDrift', { payloadDrift: boom }],
    ['ledger', { ledger: boom }],
    ['stats', { stats: boom }],
    ['signals', { signals: boom }],
    ['classify', { classify: boom }],
    ['c4Bytes', { c4Bytes: boom }],
    ['collectedThrough', { collectedThrough: boom }],
  ] as const)('端口 %s 抛错 → unavailable(不是 no_harm)', async (_name, over) => {
    const o = await runAnalysis(source(over as Partial<AnalysisSource>), REQ);
    expect(o.kind).toBe('unavailable');
    expect(harmEvent(o)).toBeNull();
  });
  it('采集覆盖时刻不可得 → unavailable;账里标记重复 → unavailable(输入非法);窗口起点不可解析 → unavailable', async () => {
    expect(await runAnalysis(source({ collectedThrough: async () => null }), REQ)).toEqual({
      kind: 'unavailable',
      reason: 'collected_through_unknown',
    });
    const w = world();
    const dup = { ...w, ledger: [...w.ledger, assign(500, 'control', { marker: marker(1) })] };
    expect(await runAnalysis(source({}, dup), REQ)).toEqual({
      kind: 'unavailable',
      reason: 'input:duplicate_marker_in_ledger',
    });
    expect(await runAnalysis(source(), { ...REQ, windowStartIso: 'x' })).toEqual({
      kind: 'unavailable',
      reason: 'input:window_start_unparseable',
    });
  });
  it('注入的随机源越界 → unavailable(error:RSI_ANALYSIS_RNG)', async () => {
    const o = await runAnalysis(source(), {
      ...REQ,
      random: { seed: 'bad', stream: () => ({ unit: () => 2 }) },
    });
    expect(o).toEqual({ kind: 'unavailable', reason: 'error:RSI_ANALYSIS_RNG' });
  });
  it('项目都不属采集中 → 没有有观测会话:no_decision(不是 no_harm)', async () => {
    const o = await runAnalysis(source({ classify: async () => 'X' }), REQ);
    expect(o.kind).toBe('no_decision');
  });
  it('窗口之前的账行不属于本次(canary 与 adopted 信息不累计)', async () => {
    const o = await runAnalysis(source(), { ...REQ, windowStartIso: iso(T_BASE + 1000 * MIN) });
    expect(o.kind).toBe('no_decision');
  });
});
