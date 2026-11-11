/**
 * W5 自动探针准入的 worker 侧判定(W0-3、R21-6.5 / 6.6)与标记取回视图。纯函数:读(账、会话计数库)与写(`canary-admission.json`)另测。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CanaryAdmission, RsiCanaryLedgerLine } from '../../../src/contracts/rsi-personal.js';
import type { SessionStat } from '../../../src/contracts/session-stat.js';
import {
  planAdmission,
  type AdmissionPlanInput,
  type AgentFacts,
  type MarkerSighting,
} from '../../../src/rsi/canary/admission-plan.js';
import { stepAdmission } from '../../../src/rsi/canary/admission-write.js';
import {
  buildMarkerView,
  postAdmissionMultiMarker,
  type StatItem,
} from '../../../src/rsi/canary/marker-view.js';
import { exists, lstat, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import { CID, POLICY, T0, adm, admitted, makeCanaryWorld, probing } from './w5-fixture.js';

const NOW = new Date(T0);
const ARMED = '2026-11-10T00:00:00Z';
const FACTS: AgentFacts = {
  hookCanaryInstalled: true,
  shapeVersion: 'claude-1',
  agentVersion: '2.1.0',
  maxUsedGeneration: 0,
  usedTickets: 3,
};
const M = ['rsm_0000000000000001', 'rsm_0000000000000002', 'rsm_0000000000000003'] as const;

const probeLine = (
  marker: string,
  at: string,
  agent: 'claude' | 'pi' = 'claude',
): RsiCanaryLedgerLine => ({
  kind: 'assign',
  at,
  agent,
  marker,
  candidate_id: null,
  arm: 'excluded',
  reason: 'admission_probe',
  p: 0,
  background_fp: '0'.repeat(16),
  background_fp_ex: '0'.repeat(16),
  policy_fp: POLICY,
  case_set_sha256: null,
  overlaps_preset: false,
  hint_version: 1,
});
const LINES = M.map((m, i) => probeLine(m, `2026-11-10T0${i + 1}:00:00Z`));
const seen =
  (s: Record<string, MarkerSighting[]>) =>
  (m: string): readonly MarkerSighting[] =>
    s[m] ?? [];
const sessionOf = (i: number, q: number | null = 120, d = 1): MarkerSighting => ({
  session_ref: `s_${i.toString(16).padStart(16, '0')}`,
  distinct_markers: d,
  quiet_minutes: q,
});
const ALL_SEEN = { [M[0]]: [sessionOf(1)], [M[1]]: [sessionOf(2)], [M[2]]: [sessionOf(3)] };

function plan(over: Partial<AdmissionPlanInput> = {}) {
  return planAdmission({
    now: NOW,
    autoLoopEffective: true,
    phase: 2,
    autoPaused: false,
    current: null,
    agents: { claude: FACTS, pi: undefined },
    ledger: [],
    markers: seen({}),
    postAdmissionMultiMarker: { claude: false, pi: false },
    ...over,
  });
}
const withEntry = (e: ReturnType<typeof probing>): CanaryAdmission => adm(e);

describe('arm:何时开始探针', () => {
  it('条件齐 → claude 置 probing:generation 1、tickets 3、armed_at 取当前秒、过期 = armed + 7 日', () => {
    const p = plan();
    expect(p.changed).toBe(true);
    expect(p.next.agents.claude).toEqual({
      state: 'probing',
      shape_version: 'claude-1',
      agent_version: '2.1.0',
      generation: 1,
      armed_at: '2026-11-10T12:00:00.000Z',
      probe_expires_at: '2026-11-17T12:00:00.000Z',
      tickets: 3,
      decided_at: null,
      reason: null,
    });
    expect(p.next.agents.pi).toBeUndefined();
  });
  const off: [string, Partial<AdmissionPlanInput>][] = [
    ['自动循环无效', { autoLoopEffective: false }],
    ['相位 1(< V1b)', { phase: 1 }],
    ['AUTO_PAUSE 在场', { autoPaused: true }],
    [
      '钩子没装 canary 变体',
      { agents: { claude: { ...FACTS, hookCanaryInstalled: false }, pi: undefined } },
    ],
    [
      'agent_version 不可知(hint 不会消费票)',
      { agents: { claude: { ...FACTS, agentVersion: null }, pi: undefined } },
    ],
    [
      'agent 没有形状事实(pi 的 canary 变体尚为 null)',
      { agents: { claude: undefined, pi: undefined } },
    ],
  ];
  it.each(off)('不 arm:%s', (_n, over) => {
    const p = plan(over);
    expect(p.changed).toBe(false);
    expect(p.next.agents).toEqual({});
  });
  it('新代 generation = max(旧条目代数, 磁盘上已出现的最大探针代数) + 1(不与遗留占用文件撞名)', () => {
    const failed = probing({
      state: 'failed',
      decided_at: ARMED,
      reason: 'probe_expired',
      generation: 2,
      shape_version: 'claude-0',
    });
    const p = plan({
      current: withEntry(failed),
      agents: { claude: { ...FACTS, maxUsedGeneration: 5 }, pi: undefined },
    });
    expect(p.next.agents.claude?.generation).toBe(6);
    expect(p.next.agents.claude?.state).toBe('probing');
  });
});

describe('判定 probing:admitted / failed / pending', () => {
  const entry = probing({ armed_at: ARMED, probe_expires_at: '2026-11-17T00:00:00Z' });
  const run = (over: Partial<AdmissionPlanInput>) =>
    plan({ current: withEntry(entry), ledger: LINES, markers: seen(ALL_SEEN), ...over });
  const stateOf = (p: ReturnType<typeof plan>): string | undefined => p.next.agents.claude?.state;

  it('3 张票的 3 个标记各被恰好一个会话取回、各会话只取回 1 个标记、静止 ≥ 60 分钟 → admitted(decided_at = 当前)', () => {
    const p = run({});
    expect(stateOf(p)).toBe('admitted');
    expect(p.next.agents.claude).toMatchObject({
      decided_at: '2026-11-10T12:00:00.000Z',
      reason: null,
    });
  });
  it('静止恰好 60 分钟 → admitted;59 分钟 → 仍 probing', () => {
    expect(stateOf(run({ markers: seen({ ...ALL_SEEN, [M[2]]: [sessionOf(3, 60)] }) }))).toBe(
      'admitted',
    );
    const p = run({ markers: seen({ ...ALL_SEEN, [M[2]]: [sessionOf(3, 59)] }) });
    expect(p.changed).toBe(false);
  });
  it('静止时长不可知(null)→ 不 admitted(fail-closed)', () => {
    expect(run({ markers: seen({ ...ALL_SEEN, [M[0]]: [sessionOf(1, null)] }) }).changed).toBe(
      false,
    );
  });
  it('只有 2 行探针账 → 不 admitted', () => {
    expect(run({ ledger: LINES.slice(0, 2) }).changed).toBe(false);
  });
  it('一个标记被两个会话取回(resume / fork 复制)→ 不 admitted', () => {
    const p = run({ markers: seen({ ...ALL_SEEN, [M[1]]: [sessionOf(2), sessionOf(9)] }) });
    expect(p.changed).toBe(false);
  });
  it('某会话取回 ≥ 2 个不同标记 → 立即 failed(multi_marker),不等静止', () => {
    const p = run({ markers: seen({ ...ALL_SEEN, [M[0]]: [sessionOf(1, 0, 2)] }) });
    expect(p.next.agents.claude).toMatchObject({ state: 'failed', reason: 'multi_marker' });
  });
  it('某标记在其账行之后 48 小时仍无人取回 → failed(marker_not_retrieved);不足 48 小时 → 仍 probing', () => {
    const lines = [
      probeLine(M[0], '2026-11-08T11:00:00Z'),
      LINES[1] as RsiCanaryLedgerLine,
      LINES[2] as RsiCanaryLedgerLine,
    ];
    const late = run({
      ledger: lines,
      markers: seen({ [M[1]]: [sessionOf(2)], [M[2]]: [sessionOf(3)] }),
      current: withEntry(
        probing({ armed_at: '2026-11-08T00:00:00Z', probe_expires_at: '2026-11-17T00:00:00Z' }),
      ),
    });
    expect(late.next.agents.claude).toMatchObject({
      state: 'failed',
      reason: 'marker_not_retrieved',
    });
    const early = run({ markers: seen({ [M[1]]: [sessionOf(2)], [M[2]]: [sessionOf(3)] }) });
    expect(early.changed).toBe(false);
  });
  it('probe_expires_at 到期仍未凑齐 → failed(probe_expired);到期当刻也算', () => {
    const p = run({ ledger: LINES.slice(0, 2), now: new Date('2026-11-17T00:00:00Z') });
    expect(p.next.agents.claude).toMatchObject({ state: 'failed', reason: 'probe_expired' });
  });
  it('旧代的探针行(at 早于本代 armed_at)不计入:新 arm 之后没有新行 → 不 admitted', () => {
    const p = run({
      current: withEntry(probing({ armed_at: '2026-11-10T10:00:00Z', generation: 2 })),
      ledger: LINES.map((_l, i) => probeLine(M[i] as string, `2026-11-09T0${i + 1}:00:00Z`)),
    });
    expect(p.changed).toBe(false);
  });
  it('其它 agent 的探针行不计入 claude', () => {
    expect(
      run({
        ledger: LINES.map((_l, i) =>
          probeLine(M[i] as string, `2026-11-10T0${i + 1}:00:00Z`, 'pi'),
        ),
      }).changed,
    ).toBe(false);
  });
  it('本代票没有占满(usedTickets < tickets)→ 不 admitted:账里的行可能是旧代 hint 迟到落的', () => {
    const p = run({ agents: { claude: { ...FACTS, usedTickets: 2 }, pi: undefined } });
    expect(p.changed).toBe(false);
  });
  it('旧代迟到的探针行让行数多于本代票数 → 不 admitted(只会阻止准入)', () => {
    const extra = probeLine('rsm_0000000000000009', '2026-11-10T04:00:00Z');
    expect(run({ ledger: [...LINES, extra] }).changed).toBe(false);
  });
  it('已到期时即使证据齐全也判 probe_expired(到期先于成功)', () => {
    const p = run({ now: new Date('2026-11-17T00:00:00Z') });
    expect(p.next.agents.claude).toMatchObject({ state: 'failed', reason: 'probe_expired' });
  });
  it('probing 期间版本变了:旧版本的齐全证据不判 admitted,允许时重新 arm(generation + 1);暂停时原地等待', () => {
    const f = { ...FACTS, agentVersion: '2.2.0' };
    const p = run({ agents: { claude: f, pi: undefined } });
    expect(p.next.agents.claude).toMatchObject({
      state: 'probing',
      generation: 2,
      agent_version: '2.2.0',
    });
    expect(run({ agents: { claude: f, pi: undefined }, autoPaused: true }).changed).toBe(false);
  });
  it('暂停 / 循环失效时不给 admitted(它是授予影响的前置),但失败照常判(只收紧)', () => {
    expect(run({ autoPaused: true }).changed).toBe(false);
    expect(run({ autoLoopEffective: false }).changed).toBe(false);
    const p = run({
      autoPaused: true,
      markers: seen({ ...ALL_SEEN, [M[0]]: [sessionOf(1, 0, 2)] }),
    });
    expect(p.next.agents.claude).toMatchObject({ state: 'failed', reason: 'multi_marker' });
  });
});

describe('admitted / failed 之后', () => {
  it('准入之后经准入的会话被判多标记 → 回到 failed(multi_marker)(撤销准入)', () => {
    const p = plan({
      current: withEntry(admitted()),
      postAdmissionMultiMarker: { claude: true, pi: false },
    });
    expect(p.next.agents.claude).toMatchObject({ state: 'failed', reason: 'multi_marker' });
  });
  it('admitted 且版本未变 → 不动', () => {
    expect(plan({ current: withEntry(admitted()) }).changed).toBe(false);
  });
  it('admitted 但 shape_version / agent_version 变了 → 重新 arm(generation + 1,旧准入由 hint 现算判 not_admitted)', () => {
    for (const f of [
      { ...FACTS, shapeVersion: 'claude-2' },
      { ...FACTS, agentVersion: '2.2.0' },
    ]) {
      const p = plan({
        current: withEntry(admitted({ generation: 4 })),
        agents: { claude: f, pi: undefined },
      });
      expect(p.next.agents.claude).toMatchObject({ state: 'probing', generation: 5 });
    }
  });
  it('failed 在版本变化之前不自动重探;版本变了才重探', () => {
    const failed = probing({ state: 'failed', decided_at: ARMED, reason: 'marker_not_retrieved' });
    expect(plan({ current: withEntry(failed) }).changed).toBe(false);
    const p = plan({
      current: withEntry(failed),
      agents: { claude: { ...FACTS, agentVersion: '2.2.0' }, pi: undefined },
    });
    expect(p.next.agents.claude?.state).toBe('probing');
  });
  it('前台显式 rearm 才让版本未变的 failed 重探', () => {
    const failed = probing({ state: 'failed', decided_at: ARMED, reason: 'probe_expired' });
    expect(plan({ current: withEntry(failed), rearm: ['claude'] }).next.agents.claude?.state).toBe(
      'probing',
    );
    expect(plan({ current: withEntry(failed), rearm: ['claude'], autoPaused: true }).changed).toBe(
      false,
    );
  });
});

function stat(ref: number, markers: string[] | undefined): SessionStat {
  return {
    session_ref: `s_${ref.toString(16).padStart(16, '0')}`,
    project_key: 'p',
    ts: '2026-11-10T01:00:00Z',
    external_content: false,
    counts: {},
    ...(markers === undefined ? {} : { rsi_markers: markers, injection_excluded: 0 }),
  } as unknown as SessionStat;
}

describe('标记取回视图(R21-6.6)', () => {
  it('每个标记 → 取回它的会话,带各会话的不同标记数;缺键(未采集)的会话不在任何标记下', () => {
    const items: StatItem[] = [
      { agent: 'claude', stat: stat(1, [M[0]]) },
      { agent: 'claude', stat: stat(2, [M[0], M[1]]) },
      { agent: 'codex', stat: stat(3, undefined) },
    ];
    const v = buildMarkerView(items, (r) => (r.endsWith('1') ? 30 : null));
    expect(
      v(M[0]).map((s) => [s.session_ref.slice(-1), s.distinct_markers, s.quiet_minutes]),
    ).toEqual([
      ['1', 1, 30],
      ['2', 2, null],
    ]);
    expect(v(M[1]).map((s) => s.distinct_markers)).toEqual([2]);
    expect(v(M[2])).toEqual([]);
  });
  it('同一 session_ref 的重复行只取第一行(防御)', () => {
    const v = buildMarkerView(
      [
        { agent: 'claude', stat: stat(1, [M[0]]) },
        { agent: 'claude', stat: stat(1, [M[0], M[1]]) },
      ],
      () => 0,
    );
    expect(v(M[0])).toHaveLength(1);
    expect(v(M[1])).toEqual([]);
  });
  const assign = (marker: string, at: string, arm: 'treat' | 'control'): RsiCanaryLedgerLine =>
    ({
      ...probeLine(marker, at),
      arm,
      reason: null,
      candidate_id: CID,
      p: 0.5,
    }) as RsiCanaryLedgerLine;
  it('准入之后:取回 ≥ 2 个标记且其中有准入之后发出的 treat / control 标记 → true;只涉及探针标记或准入之前的标记 → false', () => {
    const ledger = [
      assign(M[0], '2026-11-10T06:00:00Z', 'treat'),
      probeLine(M[1], '2026-11-10T07:00:00Z'),
    ];
    const decided = Date.parse('2026-11-10T05:00:00Z');
    const multi = (markers: string[]): StatItem[] => [{ agent: 'claude', stat: stat(1, markers) }];
    expect(postAdmissionMultiMarker('claude', decided, ledger, multi([M[0], M[2]]))).toBe(true);
    expect(postAdmissionMultiMarker('claude', decided, ledger, multi([M[1], M[2]]))).toBe(false);
    expect(postAdmissionMultiMarker('claude', decided, ledger, multi([M[0]]))).toBe(false);
    expect(
      postAdmissionMultiMarker(
        'claude',
        Date.parse('2026-11-10T08:00:00Z'),
        ledger,
        multi([M[0], M[2]]),
      ),
    ).toBe(false);
    expect(postAdmissionMultiMarker('pi', decided, ledger, multi([M[0], M[2]]))).toBe(false);
  });
});

describe('canary-admission.json 的唯一写入方', () => {
  const held = { assertHeld: async (): Promise<void> => undefined };
  const inputs = (): Omit<AdmissionPlanInput, 'current'> => ({
    now: NOW,
    autoLoopEffective: true,
    phase: 2,
    autoPaused: false,
    agents: { claude: FACTS, pi: undefined },
    ledger: [],
    markers: seen({}),
    postAdmissionMultiMarker: { claude: false, pi: false },
  });
  it('有变化才写:0600、schema 合法;第二次(无变化)返回 unchanged 且文件逐字节不变', async () => {
    const w = await makeCanaryWorld('w5-adm-write-');
    const d = { io: w.io, rsiDir: w.rsi, locks: { rsi: held, personal: held } };
    const r = await stepAdmission(d, inputs());
    expect(r.kind).toBe('written');
    const f = path.join(w.rsi, 'canary-admission.json');
    expect((await lstat(f)).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(await readText(f)) as CanaryAdmission;
    expect(doc.agents.claude?.state).toBe('probing');
    const before = await readText(f);
    expect((await stepAdmission(d, inputs())).kind).toBe('unchanged');
    expect(await readText(f)).toBe(before);
  });
  it('现有准入文件不合规 → blocked,不覆盖(损坏的文件不被静默替换成重新开始)', async () => {
    const w = await makeCanaryWorld('w5-adm-bad-');
    const f = path.join(w.rsi, 'canary-admission.json');
    await safe.writeFile(w.io, f, '{bad', { mode: 0o600 });
    const d = { io: w.io, rsiDir: w.rsi, locks: { rsi: held, personal: held } };
    expect(await stepAdmission(d, inputs())).toEqual({
      kind: 'blocked',
      why: 'admission_file_unreadable',
    });
    expect(await readText(f)).toBe('{bad');
  });
  it('丢锁 → 抛错、不写', async () => {
    const w = await makeCanaryWorld('w5-adm-lock-');
    const lost = {
      assertHeld: async (): Promise<void> => {
        throw new Error('lock_lost');
      },
    };
    const d = { io: w.io, rsiDir: w.rsi, locks: { rsi: held, personal: lost } };
    await expect(stepAdmission(d, inputs())).rejects.toThrow('lock_lost');
    expect(await exists(path.join(w.rsi, 'canary-admission.json'))).toBe(false);
  });
});
