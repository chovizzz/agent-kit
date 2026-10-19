import * as path from 'node:path';
import type { AgentId } from '../../src/contracts/common.js';
import type { IoContext } from '../../src/io/paths.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ProposalSchema } from '../../src/contracts/proposal.js';
import { readText } from '../../src/io/read-fs.js';
import { buildMatcher, countWindow, loadWindowData } from '../../src/lifecycle/attest-count.js';
import { loadSignals } from '../../src/reflect/load.js';
import { mergeProposals } from '../../src/reflect/merge.js';
import { runReflect } from '../../src/reflect/run.js';
import { stageDir } from '../../src/reflect/stage.js';
import { aliasFor, mergeInput, parsedDraft, worldPlan } from '../fixtures/reflect/plan.js';
import {
  L1,
  L2,
  lintDraft,
  okText,
  out,
  putRawSignalLines,
  putSignals,
  setupEnv,
  sig,
  testRedactor,
  worldSignals,
  newWork,
  sessionRef,
} from '../fixtures/reflect/world.js';

const UNTIL = '2026-10-12T08:00:00.000Z';
const UNTIL_MS = Date.parse(UNTIL);

describe('K2 W1:loadSignals 引导窗口上界(不含)', () => {
  it('ts == until 被丢并计 filtered_future;until−1ms 保留(正向对照);无 until 时全留', async () => {
    const w = await newWork('rl-until-');
    const at = (ms: number, i: number) =>
      sig({
        project: 'A',
        session: 'A1',
        index: i,
        text: `以后先 lint ${i}`,
        ts: new Date(ms).toISOString(),
      });
    const before = at(UNTIL_MS - 1, 0);
    const equal = at(UNTIL_MS, 1);
    const after = at(UNTIL_MS + 1, 2);
    await putSignals(w.io, [before, equal, after]);
    const r = await loadSignals(w.io, testRedactor(), { until: UNTIL });
    expect(r.signals.map((s) => s.sig_id)).toEqual([before.sig_id]);
    expect(r.stats.filtered_future).toBe(2);
    expect(r.stats.loaded).toBe(1);
    // 回归:不传 until 行为不变,计数为 0
    const all = await loadSignals(w.io, testRedactor());
    expect(all.signals).toHaveLength(3);
    expect(all.stats.filtered_future).toBe(0);
    expect(all.stats.filtered_out).toBe(0);
  });

  it('since 与 until 的过滤计数互不重叠', async () => {
    const w = await newWork('rl-until2-');
    await putSignals(w.io, [
      sig({ project: 'A', session: 'A1', index: 0, text: '以后先 a', ts: '2026-10-01T00:00:00Z' }),
      sig({ project: 'A', session: 'A1', index: 1, text: '以后先 b', ts: '2026-10-06T00:00:00Z' }),
      sig({ project: 'A', session: 'A1', index: 2, text: '以后先 c', ts: '2026-10-20T00:00:00Z' }),
    ]);
    const r = await loadSignals(w.io, testRedactor(), { since: '2026-10-05', until: UNTIL });
    expect(r.stats).toMatchObject({ loaded: 1, filtered_out: 1, filtered_future: 1 });
  });
});

/** 一批能区分「复用 countWindow」与「自写匹配」的信号:多次命中、event_key 重复、外部会话、窗口两侧边界。 */
function baselineWorld() {
  const base = worldSignals();
  const hit = (session: string, i: number, over: Record<string, unknown> = {}) => ({
    ...sig({
      project: 'B',
      session,
      index: i,
      text: `请帮我 git commit 一下 ${session}-${i}`,
      ts: '2026-10-02T10:00:00Z',
    }),
    ...over,
  });
  return [
    ...base,
    hit('M1', 0),
    hit('M1', 1), // 同会话第二次命中:fired 多于 exposure
    hit('M1', 2, { event_key: 'ek_dup_1' }),
    hit('M2', 0, { event_key: 'ek_dup_1' }), // 跨会话重复事件:D4 只算一次
    sig({
      project: 'B',
      session: 'M3',
      index: 0,
      text: '外部会话里的 git commit',
      external: true,
      ts: '2026-10-02T10:00:00Z',
    }),
    hit('M4', 0, { ts: new Date(UNTIL_MS - 1).toISOString() }), // 上界内
    hit('M5', 0, { ts: new Date(UNTIL_MS).toISOString() }), // == until:不在窗口
    hit('M6', 0, { ts: '2026-12-01T00:00:00Z' }), // 未来
  ];
}

async function stagedGuidance(
  env: Awaited<ReturnType<typeof setupEnv>>,
  runId: string,
): Promise<{ guidance: unknown; raw: string }> {
  const raw = await readText(path.join(stageDir(env.w.io, runId), 'proposals/2026-10-12-001.yaml'));
  const p = ProposalSchema.parse(parse(raw));
  return { guidance: p.reflector.guidance, raw };
}

async function putStats(
  io: IoContext,
  agent: AgentId,
  month: string,
  rows: { session: string; ts: string; project?: string }[],
): Promise<void> {
  const dir = path.join(io.stateDir, 'sessions', agent);
  await mkdirp(io, dir, 0o700);
  const lines = rows.map((r) =>
    JSON.stringify({
      session_ref: sessionRef(r.session),
      project_key: r.project ?? 'p_stat',
      ts: r.ts,
      external_content: false,
      counts: { user_messages: 1, tool_calls: 0, tool_failures: 0, unknown_event_types: {} },
    }),
  );
  await writeFile(io, path.join(dir, `${month}.jsonl`), `${lines.join('\n')}\n`, { mode: 0o600 });
}

async function expectedBaseline(
  io: IoContext,
  from: number,
  agents: readonly AgentId[],
  dropStats = false,
) {
  const data = await loadWindowData(io, from, UNTIL_MS, agents);
  const m = buildMatcher({ type: 'phrase', pattern: 'git commit' });
  if (m.kind !== 'match') throw new Error('matcher');
  const c = countWindow({
    signals: data.signals,
    sessionStats: dropStats ? [] : data.sessionStats,
    matcher: m,
    from,
    to: UNTIL_MS,
    agents,
  });
  return {
    sessions_total: c.sessions_total,
    exposure_sessions: c.exposure_sessions,
    fired: c.fired,
  };
}

describe('K2 W2:基线与 attest 同口径', () => {
  it('phrase 型:guidance.baseline == 直接调 countWindow;since/until 写入;提案过 schema', async () => {
    const env = await setupEnv(undefined, baselineWorld());
    const r = await runReflect(env.deps, { ...env.opts, since: '2026-09-15' });
    expect(r.report.outcome).toBe('staged');
    const { guidance } = await stagedGuidance(env, 'run-test-1');
    const data = await loadWindowData(env.w.io, Date.parse('2026-09-15T00:00:00Z'), UNTIL_MS, []);
    const m = buildMatcher({ type: 'phrase', pattern: 'git commit' });
    if (m.kind !== 'match') throw new Error('matcher');
    const c = countWindow({
      signals: data.signals,
      sessionStats: data.sessionStats,
      matcher: m,
      from: Date.parse('2026-09-15T00:00:00Z'),
      to: UNTIL_MS,
      agents: [],
    });
    expect(guidance).toEqual({
      since: '2026-09-15',
      until: UNTIL,
      baseline: {
        sessions_total: c.sessions_total,
        exposure_sessions: c.exposure_sessions,
        fired: c.fired,
      },
    });
    // 夹具确实能区分口径:同会话多次命中 + D4 去重 + 外部会话 + 边界,fired≠exposure,且有曝光
    expect(c.exposure_sessions).toBeGreaterThan(0);
    expect(c.fired).toBeGreaterThan(c.exposure_sessions);
    expect(c.deduplicated).toBe(1);
    // 未来信号(== until / 之后)既不在提案输入也不在基线:丢弃数记入 rejected
    expect(r.load.filtered_future).toBe(2);
    expect(r.report.rejected['load_filtered_future']).toBe(2);
  });

  it('不设 --since:guidance.since = null,窗口从头开始', async () => {
    const env = await setupEnv(undefined, baselineWorld());
    await runReflect(env.deps, env.opts);
    const { guidance } = await stagedGuidance(env, 'run-test-1');
    expect(guidance).toMatchObject({ since: null, until: UNTIL });
  });

  it('tool 型同样与 countWindow 一致;path 型:只写分母,曝光/命中为 0(reflect 不产出 always 型)', async () => {
    for (const [sigType, runId] of [
      [{ type: 'tool', pattern: 'Bash' }, 'run-tool'],
      [{ type: 'path', pattern: 'src/' }, 'run-path'],
    ] as const) {
      const env = await setupEnv(
        (req) => okText(out(lintDraft(req.user, { signature: sigType }))),
        baselineWorld(),
      );
      const r = await runReflect(env.deps, { ...env.opts, runId });
      expect(r.report.outcome, runId).toBe('staged');
      const { guidance } = await stagedGuidance(env, runId);
      const b = (guidance as { baseline: Record<string, number> }).baseline;
      const data = await loadWindowData(env.w.io, 0, UNTIL_MS, []);
      const count = (matcher: Parameters<typeof countWindow>[0]['matcher']) =>
        countWindow({
          signals: data.signals,
          sessionStats: data.sessionStats,
          matcher,
          from: 0,
          to: UNTIL_MS,
          agents: [],
        });
      const total = count({ kind: 'always' }).sessions_total;
      expect(total).toBeGreaterThan(0);
      if (sigType.type === 'tool') {
        const m = buildMatcher(sigType);
        if (m.kind !== 'match') throw new Error('matcher');
        const c = count(m);
        expect(c.exposure_sessions).toBeGreaterThan(0); // 正向对照:夹具里 Bash 工具确有命中
        expect(b).toEqual({
          sessions_total: c.sessions_total,
          exposure_sessions: c.exposure_sessions,
          fired: c.fired,
        });
      } else {
        expect(b).toEqual({ sessions_total: total, exposure_sessions: 0, fired: 0 });
      }
    }
  });

  it('会话计数库进分母:只有 stat 的会话 +1;同会话 stat 不重复计;边界与 agent 过滤同 attest', async () => {
    const env = await setupEnv(undefined, baselineWorld());
    await putStats(env.w.io, 'claude', '202610', [
      { session: 'STAT_ONLY', ts: '2026-10-05T00:00:00Z' }, // 只有 stat:进分母,不进曝光
      { session: 'M1', ts: '2026-10-02T10:00:00Z' }, // 与信号同会话:不重复计
      { session: 'STAT_AT_UNTIL', ts: UNTIL }, // == until:不在窗口
      { session: 'STAT_BEFORE_UNTIL', ts: new Date(UNTIL_MS - 1).toISOString() },
    ]);
    await putStats(env.w.io, 'codex', '202610', [
      { session: 'OTHER_AGENT', ts: '2026-10-05T00:00:00Z' },
    ]);
    const r = await runReflect(env.deps, { ...env.opts, agents: ['claude'] });
    expect(r.report.outcome).toBe('staged');
    const { guidance } = await stagedGuidance(env, 'run-test-1');
    const got = (guidance as { baseline: Record<string, number> }).baseline;
    expect(got).toEqual(await expectedBaseline(env.w.io, 0, ['claude']));
    const noStats = await expectedBaseline(env.w.io, 0, ['claude'], true);
    // 只有 stat 的两个窗口内会话(STAT_ONLY、STAT_BEFORE_UNTIL)进分母,曝光/命中不变
    expect(got['sessions_total']).toBe(noStats.sessions_total + 2);
    expect(got['exposure_sessions']).toBe(noStats.exposure_sessions);
    expect(got['fired']).toBe(noStats.fired);
  });

  it('--since 是基线下界:since 前同月的命中被排除,恰在 since 的保留;不设 since 则全计', async () => {
    const mk = () => [
      ...baselineWorld().map((x) =>
        x.ts < '2026-10-05' ? { ...x, ts: '2026-10-06T10:00:00Z' } : x,
      ),
      sig({
        project: 'B',
        session: 'S_BEFORE',
        index: 0,
        text: 'git commit 前',
        ts: '2026-10-04T23:59:59.999Z',
      }),
      sig({
        project: 'B',
        session: 'S_AT',
        index: 0,
        text: 'git commit 当天',
        ts: '2026-10-05T00:00:00Z',
      }),
    ];
    const withSince = await setupEnv(undefined, mk());
    await runReflect(withSince.deps, { ...withSince.opts, since: '2026-10-05' });
    const a = (await stagedGuidance(withSince, 'run-test-1')).guidance as {
      baseline: Record<string, number>;
    };
    const from = Date.parse('2026-10-05T00:00:00Z');
    expect(a.baseline).toEqual(await expectedBaseline(withSince.w.io, from, []));
    const noSince = await setupEnv(undefined, mk());
    await runReflect(noSince.deps, noSince.opts);
    const b = (await stagedGuidance(noSince, 'run-test-1')).guidance as {
      baseline: Record<string, number>;
    };
    expect(b.baseline).toEqual(await expectedBaseline(noSince.w.io, 0, []));
    // 两者必须不同,且差恰为 S_BEFORE 这一个会话(下界真的生效,不是巧合)
    expect(b.baseline['exposure_sessions']).toBe((a.baseline['exposure_sessions'] as number) + 1);
  });

  it('未来信号不进提示与证据:窗口内(until−1ms)canary 在,未来 canary 不在', async () => {
    const IN = 'CANARY_IN_WINDOW_55';
    const FUT = 'CANARY_FUTURE_66';
    const env = await setupEnv(undefined, [
      ...worldSignals(),
      sig({
        project: 'A',
        session: 'F1',
        index: 0,
        text: `以后提交前必须先跑 lint ${IN}`,
        ts: new Date(UNTIL_MS - 1).toISOString(),
      }),
      sig({
        project: 'B',
        session: 'F2',
        index: 0,
        text: `以后提交前必须先跑 lint ${FUT}`,
        ts: new Date(UNTIL_MS).toISOString(),
      }),
    ]);
    const r = await runReflect(env.deps, { ...env.opts, includePrompt: true });
    expect(r.report.outcome).toBe('staged');
    const allPrompts = env.backend.prompts.map((p) => p.user).join('\n');
    expect(allPrompts).toContain(IN);
    expect(allPrompts).not.toContain(FUT);
    expect(r.load.filtered_future).toBe(1);
  });

  it('引导窗口内有坏记录(信号库 schema 不合)→ 不写残缺基线,整批作废,rejected=baseline_unavailable', async () => {
    const env = await setupEnv(undefined, baselineWorld());
    // 另一个 agent 的月份文件里放一条 ts 在窗口内、但不合 schema 的行
    await putRawSignalLines(env.w.io, 'codex', '202610', [
      '{"not":"a signal","ts":"2026-10-03T00:00:00Z"}',
    ]);
    const r = await runReflect(env.deps, env.opts);
    expect(r.report.outcome).toBe('output_rejected');
    expect(r.report.rejected['baseline_unavailable']).toBe(1);
    expect(r.exitCode).toBe(1);
    // 对照:窗口外(ts 在 until 之后)的坏行被忽略,不阻断
    const env2 = await setupEnv(undefined, baselineWorld());
    await putRawSignalLines(env2.w.io, 'codex', '202610', [
      '{"not":"a signal","ts":"2026-10-30T00:00:00Z"}',
    ]);
    expect((await runReflect(env2.deps, env2.opts)).report.outcome).toBe('staged');
  });

  it('固定时刻:until 在运行开始时取一次;之后的 clock 调用只影响 created 日期', async () => {
    const env = await setupEnv(undefined, baselineWorld());
    const times = ['2026-10-12T08:00:00Z', '2026-10-13T09:00:00Z'];
    let n = 0;
    const deps = { ...env.deps, clock: () => new Date(times[Math.min(n++, 1)] as string) };
    const r = await runReflect(deps, env.opts);
    expect(r.report.outcome).toBe('staged');
    const raw = await readText(
      path.join(stageDir(env.w.io, 'run-test-1'), `proposals/${r.report.staged[0]}.yaml`),
    );
    const p = ProposalSchema.parse(parse(raw));
    expect(p.reflector.guidance?.until).toBe('2026-10-12T08:00:00.000Z');
    expect(r.report.staged[0]).toBe('2026-10-13-001'); // merge 仍用后取的时钟
  });
});

describe('K2 回归:没有新字段时输出与改动前一致', () => {
  it('mergeProposals 不传 guidance → 提案没有 reflector.guidance 键', async () => {
    const plan = await worldPlan();
    const e = [aliasFor(plan.pack, L1), aliasFor(plan.pack, L2)];
    const [m] = mergeProposals(mergeInput(plan, [parsedDraft({ evidence: e })]));
    expect('guidance' in m!.proposal.reflector).toBe(false);
    expect(m!.proposalYaml).not.toContain('guidance');
  });

  it('没有未来信号时报告 rejected 不出现 load_filtered_future', async () => {
    const env = await setupEnv();
    const r = await runReflect(env.deps, env.opts);
    expect(r.report.outcome).toBe('staged');
    expect(Object.keys(r.report.rejected)).not.toContain('load_filtered_future');
    expect(r.load.filtered_future).toBe(0);
  });
});
