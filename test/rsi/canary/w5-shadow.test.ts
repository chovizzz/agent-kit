/**
 * W5 shadow 计数:有观测会话数 / 签名命中数、首次达标日重算、`FactsProvider` / 重建工作副本的装配(R21-1.7、R21-3.8、W0-2、W0-13)。
 * 读取失败 = 事实不可得(null),从不当作 0 会话。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import type { LoadedSignal } from '../../../src/reflect/types.js';
import { tokenSet } from '../../../src/reflect/text.js';
import * as safe from '../../../src/io/safe-fs.js';
import { runPersonalStep } from '../../../src/rsi/personal/candidate-step.js';
import {
  countShadow,
  firstReadyDay,
  sessionHitsSignature,
  shadowEnteredAt,
  type ShadowObservation,
  type ShadowObserver,
} from '../../../src/rsi/personal/shadow-count.js';
import {
  makeReadySinceRecovery,
  makeShadowCountPort,
  syncShadowCounts,
  withShadowCounts,
} from '../../../src/rsi/personal/shadow-facts.js';
import { makeShadowObserver } from '../../../src/rsi/personal/shadow-observe.js';
import { entry, rec as mkRec, SIG } from '../personal/transition-fixture.js';
import { promoteBaseFor, sessRef, sigId, world3 } from '../personal/w3-fixture.js';
import { makeCanaryWorld } from './w5-fixture.js';

let n = 0;
function ls(
  session: number,
  kind: 'user_message' | 'tool_call' | 'tool_result_failed',
  index: number,
  o: { tool?: string; cls?: string; text?: string; external?: boolean } = {},
): LoadedSignal {
  n++;
  return {
    sig_id: sigId(n),
    agent: 'claude',
    agent_version: '2.1.0',
    agent_version_source: 'session_meta',
    session_ref: sessRef(session),
    project_key: 'p',
    ts: '2026-11-05T00:00:00Z',
    type: 'event',
    excerpt_redacted: o.text ?? '',
    external_content: o.external === true,
    confidence: 1,
    loaded_rule_ids: [],
    event_kind: kind,
    event_index: index,
    ...(o.tool !== undefined ? { tool_name: o.tool } : {}),
    ...(o.cls !== undefined ? { tool_error_class: o.cls } : {}),
  } as unknown as LoadedSignal;
}
/** 失败后重试:call → failed → call(同一工具) */
const retry = (s: number, tool = 'Bash', cls?: string): LoadedSignal[] => [
  ls(s, 'tool_call', 0, { tool }),
  ls(s, 'tool_result_failed', 1, cls === undefined ? {} : { cls }),
  ls(s, 'tool_call', 2, { tool }),
];
const TOOL = { kind: 'tool', tool_name: 'Bash' } as const;
const day = (i: number): string => `2026-10-${String(i).padStart(2, '0')}`;
const sess = (i: number, d: string = day(i)): { session_ref: string; ts: string } => ({
  session_ref: sessRef(i),
  ts: `${d}T10:00:00Z`,
});

describe('签名命中(W0-2)', () => {
  it('tool 签名:同一工具失败后重试 → 命中;别的工具 / 没有重试 / 外部内容会话 → 不命中', () => {
    expect(sessionHitsSignature(TOOL, retry(1))).toBe(true);
    expect(sessionHitsSignature({ kind: 'tool', tool_name: 'Edit' }, retry(1))).toBe(false);
    expect(
      sessionHitsSignature(TOOL, [
        ls(1, 'tool_call', 0, { tool: 'Bash' }),
        ls(1, 'tool_result_failed', 1),
      ]),
    ).toBe(false);
    expect(
      sessionHitsSignature(
        TOOL,
        retry(1).map((s) => ({ ...s, external_content: true })),
      ),
    ).toBe(false);
    expect(sessionHitsSignature(TOOL, [])).toBe(false);
  });
  it('tool 签名带 tool_error_class:只收窄不放宽;旧信号没有类时不命中', () => {
    const narrow = { kind: 'tool', tool_name: 'Bash', tool_error_class: 'not_found' } as const;
    expect(sessionHitsSignature(narrow, retry(1, 'Bash', 'not_found'))).toBe(true);
    expect(sessionHitsSignature(narrow, retry(1, 'Bash', 'timeout'))).toBe(false);
    expect(sessionHitsSignature(narrow, retry(1))).toBe(false);
    expect(sessionHitsSignature(TOOL, retry(1, 'Bash', 'timeout'))).toBe(true);
  });
  const text = '以后不要再提交大文件到仓库里';
  const lesson = { kind: 'lesson', rep_tokens: [...tokenSet(text)].sort() } as const;
  it('lesson 签名:显式教训的 token Jaccard ≥ 0.5 → 命中;无关教训 / 外部内容 → 不命中', () => {
    expect(sessionHitsSignature(lesson, [ls(1, 'user_message', 0, { text })])).toBe(true);
    expect(
      sessionHitsSignature(lesson, [
        ls(1, 'user_message', 0, { text: '以后记得每次先运行完整测试套件再提交' }),
      ]),
    ).toBe(false);
    expect(sessionHitsSignature(lesson, [ls(1, 'user_message', 0, { text, external: true })])).toBe(
      false,
    );
    expect(sessionHitsSignature(lesson, [ls(1, 'user_message', 0, { text: '今天天气不错' })])).toBe(
      false,
    );
  });
});

describe('计数与首次达标日', () => {
  const obs = (
    sessions: ShadowObservation['sessions'],
    signals: LoadedSignal[],
  ): ShadowObservation => ({ sessions, signals });
  it('hits 是命中会话数(一个会话里多次命中只记一次);sessions 按 session_ref 去重', () => {
    const o = obs(
      [sess(1), sess(1), sess(2), sess(3)],
      [...retry(1), ...retry(1).map((s, i) => ({ ...s, event_index: i + 10 })), ...retry(3)],
    );
    expect(countShadow(TOOL, o)).toEqual({ sessions: 3, hits: 2 });
  });
  it('只用本观测里的会话:不在会话列表的信号不计命中', () => {
    expect(countShadow(TOOL, obs([sess(1)], retry(9)))).toEqual({ sessions: 1, hits: 0 });
  });
  const world = (hitSessions: number[], total: number): ShadowObservation =>
    obs(
      Array.from({ length: total }, (_, i) => sess(i + 1)),
      hitSessions.flatMap((s) => retry(s)),
    );
  it('首次达标日 = 同时满足 ≥ 20 会话且命中 ≥ 2 的最早 UTC 日', () => {
    expect(firstReadyDay(TOOL, world([3, 5], 25))).toBe('2026-10-20');
    expect(firstReadyDay(TOOL, world([22, 23], 25))).toBe('2026-10-23');
  });
  it('未达标 → null:命中只有 1、会话只有 19、两者都不足', () => {
    expect(firstReadyDay(TOOL, world([3], 25))).toBeNull();
    expect(firstReadyDay(TOOL, world([3, 5], 19))).toBeNull();
    expect(firstReadyDay(TOOL, world([], 5))).toBeNull();
  });
  it('同一天的多个会话按当日全部会话之后的累计值判定', () => {
    const sessions = [
      ...Array.from({ length: 18 }, (_, i) => sess(i + 1)),
      sess(19, '2026-10-19'),
      sess(20, '2026-10-19'),
      sess(21, '2026-10-19'),
    ];
    expect(firstReadyDay(TOOL, obs(sessions, [...retry(1), ...retry(2)]))).toBe('2026-10-19');
  });
});

describe('shadowEnteredAt:窗口起点', () => {
  it('取最后一条 dim=lifecycle、to=shadow 的转移时间;找不到(被 256 条窗口挤掉)→ null(不退化成从纪元起算)', () => {
    const r = mkRec('shadow', {
      transitions: [
        entry(1),
        entry(2, 'shadow', '2026-10-20T00:00:00Z'),
        entry(3, 'shadow', '2026-10-25T00:00:00Z'),
      ],
    });
    expect(shadowEnteredAt(r)).toBe('2026-10-25T00:00:00Z');
    expect(shadowEnteredAt(mkRec('shadow', { transitions: [entry(1)] }))).toBeNull();
  });
});

function shadowRec(over: Partial<PersonalLifecycleRecord> = {}): PersonalLifecycleRecord {
  return mkRec('shadow', {
    transitions: [entry(1), entry(2, 'shadow', '2026-10-01T00:00:00Z')],
    cluster_signature: { ...SIG },
    ...over,
  });
}
const observerOf = (
  o: ShadowObservation,
  since: { v: string | null } = { v: null },
): ShadowObserver => ({
  observe: async (s) => {
    since.v = s;
    return o;
  },
});
const failing: ShadowObserver = {
  observe: async () => {
    throw new Error('store corrupt');
  },
};
const OBS25: ShadowObservation = {
  sessions: Array.from({ length: 25 }, (_, i) => sess(i + 1)),
  signals: [3, 5, 8].flatMap((s) => retry(s)),
};

describe('端口装配', () => {
  it('ShadowCountPort:以进入 shadow 的时间为窗口起点;读失败 / 无签名 / 无起点 → null(不是 0)', async () => {
    const since = { v: null as string | null };
    const port = makeShadowCountPort(observerOf(OBS25, since));
    expect(await port.count(shadowRec())).toEqual({ sessions: 25, hits: 3 });
    expect(since.v).toBe('2026-10-01T00:00:00Z');
    expect(await makeShadowCountPort(failing).count(shadowRec())).toBeNull();
    const noSig = shadowRec();
    delete (noSig as { cluster_signature?: unknown }).cluster_signature;
    expect(await port.count(noSig)).toBeNull();
    expect(await port.count(shadowRec({ transitions: [entry(1)] }))).toBeNull();
  });
  it('ReadySinceRecovery:历史里能证明达标的最早 UTC 日;未达标 / 读失败 / 无起点 → null', async () => {
    expect(await makeReadySinceRecovery(observerOf(OBS25)).recover(shadowRec())).toBe('2026-10-20');
    expect(
      await makeReadySinceRecovery(
        observerOf({ sessions: OBS25.sessions.slice(0, 10), signals: OBS25.signals }),
      ).recover(shadowRec()),
    ).toBeNull();
    expect(await makeReadySinceRecovery(failing).recover(shadowRec())).toBeNull();
    expect(
      await makeReadySinceRecovery(observerOf(OBS25)).recover(
        shadowRec({ transitions: [entry(1)] }),
      ),
    ).toBeNull();
  });
  it('withShadowCounts:promoteFacts 的 sessions / hits 取自真实计数,其余字段原样;任一事实不可得 → null(W3 据此不推进)', async () => {
    const r = shadowRec();
    const base = {
      gateFacts: async () => null,
      promoteFacts: async () => promoteBaseFor(r, { sessions: 0, hits: 0, tainted: true }),
    };
    const f = withShadowCounts(base, makeShadowCountPort(observerOf(OBS25)));
    const wc = undefined as never;
    expect(await f.promoteFacts(r, wc)).toMatchObject({ sessions: 25, hits: 3, tainted: true });
    expect(
      await withShadowCounts(base, makeShadowCountPort(failing)).promoteFacts(r, wc),
    ).toBeNull();
    expect(
      await withShadowCounts(
        { ...base, promoteFacts: async () => null },
        makeShadowCountPort(observerOf(OBS25)),
      ).promoteFacts(r, wc),
    ).toBeNull();
    expect(await f.gateFacts(r, wc)).toBeNull();
  });
  it('syncShadowCounts:只写 shadow 记录且计数有变化者;不可得的不动并列出', async () => {
    const w = world3();
    const r = shadowRec();
    const other = shadowRec({ id: 'ra_ba9876543210' });
    const proposed = mkRec('proposed', { id: 'ra_00000000000a' });
    const wcBase = {
      schema_version: 1 as const,
      cluster_signature: { ...SIG },
      source: { run_id: 'run-1', proposal_id: 'p1' },
      shadow: { sessions: 0, hits: 0, canary_ready_since: null, queued_since: null },
      evidence: { sessions: [], days: [] },
      stats: { sessions_observed: 0, sessions_treat: 0, sessions_control: 0, bytes_injected: 0 },
      repo_removal_deferred: false,
    };
    await w.d.working.put({ ...wcBase, id: r.id });
    await w.d.working.put({
      ...wcBase,
      id: other.id,
      shadow: { ...wcBase.shadow, sessions: 25, hits: 3 },
    });
    await w.d.working.put({ ...wcBase, id: proposed.id });
    const port = makeShadowCountPort(observerOf(OBS25));
    const res = await syncShadowCounts({
      working: w.d.working,
      records: [r, other, proposed],
      counts: port,
    });
    expect(res).toEqual({ updated: [r.id], unavailable: [] });
    expect(w.working.get(r.id)?.shadow).toMatchObject({ sessions: 25, hits: 3 });
    expect(w.working.get(proposed.id)?.shadow).toMatchObject({ sessions: 0, hits: 0 });
    const res2 = await syncShadowCounts({
      working: w.d.working,
      records: [r],
      counts: makeShadowCountPort(failing),
    });
    expect(res2).toEqual({ updated: [], unavailable: [r.id] });
  });
});

describe('W3 遗留:重建工作副本后 sessions / hits 由计数重算', () => {
  const src = { run_id: 'run-1', proposal_id: '2026-11-05-001' };
  it('缺工作副本的 shadow:重建后 sessions / hits 取自计数端口;读失败 / 事实不可得 → 保持 0;proposed 不调用计数', async () => {
    const w = world3();
    w.store.put(shadowRec({ source_proposal: src }));
    w.d.shadowCounts = { count: async () => ({ sessions: 21, hits: 4 }) };
    await runPersonalStep(w.d);
    expect(w.working.get(shadowRec().id)?.shadow).toMatchObject({ sessions: 21, hits: 4 });

    const w2 = world3();
    w2.store.put(shadowRec({ source_proposal: src }));
    w2.d.shadowCounts = {
      count: async () => {
        throw new Error('down');
      },
    };
    await runPersonalStep(w2.d);
    expect(w2.working.get(shadowRec().id)?.shadow).toMatchObject({ sessions: 0, hits: 0 });

    const w3 = world3();
    w3.store.put(shadowRec({ source_proposal: src }));
    w3.d.shadowCounts = { count: async () => null };
    await runPersonalStep(w3.d);
    expect(w3.working.get(shadowRec().id)?.shadow).toMatchObject({ sessions: 0, hits: 0 });

    const w4 = world3();
    w4.store.put(mkRec('proposed', { source_proposal: src }));
    let called = 0;
    w4.d.shadowCounts = {
      count: async () => {
        called++;
        return { sessions: 9, hits: 9 };
      },
    };
    await runPersonalStep(w4.d);
    expect(called).toBe(0);
  });
  it('计数端口里丢锁(RsiLockError lock_lost)→ 步骤以 lock_lost 中止', async () => {
    const w = world3();
    w.store.put(shadowRec({ source_proposal: src }));
    w.d.shadowCounts = {
      count: async () => {
        throw new RsiLockError('lock_lost');
      },
    };
    expect((await runPersonalStep(w.d)).halted).toBe('lock_lost');
  });
});

describe('真实来源适配器(会话计数库 + 信号库)', () => {
  const stat = (i: number, ts: string, o: { project?: string; markers?: string[] } = {}): string =>
    JSON.stringify({
      session_ref: sessRef(i),
      project_key: o.project ?? 'p',
      ts,
      external_content: false,
      counts: { user_messages: 1, tool_calls: 2, tool_failures: 1, unknown_event_types: {} },
      ...(o.markers === undefined ? {} : { rsi_markers: o.markers, injection_excluded: 0 }),
    });
  const sigLine = (s: LoadedSignal): string => JSON.stringify(s);
  const M1 = 'rsm_0000000000000001';
  const M2 = 'rsm_0000000000000002';
  const M3 = 'rsm_0000000000000003';

  async function setup(prefix: string, stats: string[], signals: LoadedSignal[]) {
    const w = await makeCanaryWorld(prefix);
    await safe.mkdirp(w.io, path.join(w.io.stateDir, 'sessions', 'claude'), 0o700);
    await safe.mkdirp(w.io, path.join(w.io.stateDir, 'signals', 'claude'), 0o700);
    await safe.writeFile(
      w.io,
      path.join(w.io.stateDir, 'sessions', 'claude', '202611.jsonl'),
      `${stats.join('\n')}\n`,
      { mode: 0o600 },
    );
    await safe.writeFile(
      w.io,
      path.join(w.io.stateDir, 'signals', 'claude', '202611.jsonl'),
      `${signals.map(sigLine).join('\n')}\n`,
      { mode: 0o600 },
    );
    return w;
  }
  const SINCE = '2026-11-02T00:00:00Z';

  it('「有观测会话」资格:窗口之后、采集中项目、非多标记、被随机的会话能在分组账里关联;缺键 / 0 个标记照计', async () => {
    const w = await setup(
      'w5-observe-',
      [
        stat(1, '2026-11-01T10:00:00Z'), // 窗口之前
        stat(2, '2026-11-03T10:00:00Z'), // 计
        stat(3, '2026-11-03T11:00:00Z', { project: 'p_excl' }), // X 项目
        stat(4, '2026-11-03T12:00:00Z', { markers: [M1, M2] }), // 多标记
        stat(5, '2026-11-03T13:00:00Z', { markers: [M3] }), // 标记不在账里
        stat(6, '2026-11-03T14:00:00Z', { markers: [M1] }), // 标记在账里:计
        stat(7, '2026-11-03T15:00:00Z', { markers: [] }), // 0 个标记:计
        stat(2, '2026-11-04T00:00:00Z'), // 同 session_ref 重复行:只取第一行
      ],
      [...retry(2), ...retry(3), ...retry(6), ...retry(1)],
    );
    const obs = makeShadowObserver({
      io: w.io,
      classify: async (k) => (k === 'p_excl' ? 'X' : 'P'),
      redactor: { pass2: () => ({ clean: true, hits: [] }) },
      ledgerMarkers: async () => new Set([M1]),
    });
    const o = await obs.observe(SINCE);
    expect(o.sessions.map((s) => s.session_ref)).toEqual([2, 6, 7].map(sessRef));
    // 信号只留下资格内会话的
    expect([...new Set(o.signals.map((s) => s.session_ref))].sort()).toEqual([2, 6].map(sessRef));
    expect(countShadow(TOOL, o)).toEqual({ sessions: 3, hits: 2 });
  });
  it('分组账读不了而又需要它(会话取回恰 1 个标记)→ 抛错,不退化成「都计」', async () => {
    const w = await setup(
      'w5-observe-ledger-',
      [stat(6, '2026-11-03T14:00:00Z', { markers: [M1] })],
      retry(6),
    );
    const obs = makeShadowObserver({
      io: w.io,
      classify: async () => 'P',
      redactor: { pass2: () => ({ clean: true, hits: [] }) },
      ledgerMarkers: async () => {
        throw new Error('ledger invalid');
      },
    });
    await expect(obs.observe(SINCE)).rejects.toThrow('ledger invalid');
  });
  it('会话计数行不合 schema → 抛错(月文件按损坏处理,不跳过坏行)', async () => {
    const w = await setup('w5-observe-bad-', ['{"session_ref":"x"}'], []);
    const obs = makeShadowObserver({
      io: w.io,
      classify: async () => 'P',
      redactor: { pass2: () => ({ clean: true, hits: [] }) },
      ledgerMarkers: async () => new Set(),
    });
    await expect(obs.observe(SINCE)).rejects.toThrow();
    expect(
      await makeShadowCountPort(obs).count(
        shadowRec({ transitions: [entry(1), entry(2, 'shadow', SINCE)] }),
      ),
    ).toBeNull();
  });
});
