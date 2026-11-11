/**
 * W3 worker 推进入口 `runPersonalStep`:候选创建、闸、shadow 步、撤销对账、入口清零。
 * 标题含 `M13-n` 的用例是契约变异锚点表(§21.24 W0-13)的负向用例,变异表按 ID 对账。
 */
import { describe, expect, it } from 'vitest';
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
} from '../../../src/contracts/rsi-personal.js';
import { runPersonalStep, entryReset } from '../../../src/rsi/personal/candidate-step.js';
import { candidateId } from '../../../src/rsi/personal/ids.js';
import { rec as mkRec, SIG } from './transition-fixture.js';
import {
  draftOf,
  goodFacts,
  promoteBaseFor,
  REV,
  staged,
  TODAY,
  world3,
  type World3,
} from './w3-fixture.js';

const V1A = 1;
const V1B = 2;

function wcFor(
  r: PersonalLifecycleRecord,
  shadow: Partial<CandidateWorkingCopy['shadow']> = {},
): CandidateWorkingCopy {
  return {
    schema_version: 1,
    id: r.id,
    cluster_signature: { ...SIG },
    source: { run_id: 'run-1', proposal_id: '2026-11-05-001' },
    shadow: { sessions: 25, hits: 3, canary_ready_since: null, queued_since: null, ...shadow },
    evidence: { sessions: [], days: [] },
    stats: { sessions_observed: 0, sessions_treat: 0, sessions_control: 0, bytes_injected: 0 },
    repo_removal_deferred: false,
  };
}

function addShadow(
  w: World3,
  id: string,
  o: {
    cluster?: string;
    shadow?: Partial<CandidateWorkingCopy['shadow']>;
    lifecycle?: 'shadow' | 'canary';
  } = {},
): PersonalLifecycleRecord {
  const r = mkRec(o.lifecycle ?? 'shadow', {
    id,
    cluster_id: o.cluster ?? `cl-${id}`,
    ...(o.lifecycle === 'canary'
      ? { deploy: { claude: 'injected', pi: 'none', codex: 'none' } }
      : {}),
  });
  w.store.put(r);
  w.working.set(id, wcFor(r, o.shadow));
  return r;
}

const A = 'ra_aaaaaaaaaaaa';
const B = 'ra_bbbbbbbbbbbb';
const C = 'ra_cccccccccccc';

/** 推进事实(全部成立)的提供器 */
function eligible(w: World3, over: Partial<ReturnType<typeof promoteBaseFor>> = {}): void {
  w.promoteFacts.fn = async (r) => promoteBaseFor(r, over);
}
const life = (w: World3, id: string): string | undefined => w.store.records.get(id)?.lifecycle;

function withNewProposal(w: World3): string {
  w.stagedList = [staged()];
  w.gateFacts.fn = async () => {
    const { clusterBusy: _c, ...rest } = goodFacts(draftOf());
    return rest;
  };
  const d = draftOf();
  return d.id;
}

describe('候选创建 (无) → proposed(W0-6 / W0-16)', () => {
  it('创建一条 proposed 记录(reason ingested)、原子文件、工作副本与审计;随后闸全过 → shadow', async () => {
    const w = world3();
    const id = withNewProposal(w);
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBeNull();
    expect(r.created).toEqual([id]);
    expect(id).toBe(
      candidateId('run-20261105T000000Z-abc', '2026-11-05-001', draftOf().contentSha256),
    );
    const rec = w.store.records.get(id);
    expect(rec?.lifecycle).toBe('shadow');
    expect(rec?.transitions.map((t) => `${t.from}>${t.to}:${t.reason}`)).toEqual([
      'none>proposed:ingested',
      'proposed>shadow:gates_passed',
    ]);
    expect(rec?.source_proposal).toEqual({
      run_id: 'run-20261105T000000Z-abc',
      proposal_id: '2026-11-05-001',
    });
    expect(rec?.cluster_signature).toEqual({
      kind: 'tool',
      tool_name: 'Bash',
      tool_error_class: 'not_found',
    });
    expect(w.store.files.get(`rules/${id}.md`)).toContain('origin: auto_rsi');
    expect(w.working.get(id)?.shadow).toEqual({
      sessions: 0,
      hits: 0,
      canary_ready_since: null,
      queued_since: null,
    });
    expect(w.audits.map((a) => `${a.from}>${a.to}`)).toEqual(['none>proposed', 'proposed>shadow']);
  });
  it('重复调用不重复创建(候选 id 由内容派生;同一提案只一个候选)', async () => {
    const w = world3();
    const id = withNewProposal(w);
    await runPersonalStep(w.d);
    const commits = w.store.commits.length;
    const r2 = await runPersonalStep(w.d);
    expect(r2.created).toEqual([]);
    expect(w.store.commits.length).toBe(commits);
    expect(w.store.records.size).toBe(1);
    expect(w.store.records.has(id)).toBe(true);
  });
  it('不是候选来源的提案(team 层 / op≠add)既不创建也不报错', async () => {
    const w = world3();
    w.stagedList = [
      staged({ layer: 'team' }),
      staged({ op: 'edit', proposalId: '2026-11-05-002' }),
    ];
    const r = await runPersonalStep(w.d);
    expect(r.created).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(w.store.records.size).toBe(0);
  });
  it('无法派生签名(证据信号不在库)→ 跳过并记录原因,不创建', async () => {
    const w = world3();
    w.stagedList = [staged()];
    w.signals = [];
    const r = await runPersonalStep(w.d);
    expect(r.created).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['signature_unavailable']);
  });
  it('崩溃于「提交后、写工作副本前」:下一次调用按权威记录重建工作副本', async () => {
    const w = world3();
    const r0 = mkRec('shadow', {
      id: A,
      source_proposal: { run_id: 'run-1', proposal_id: '2026-11-05-001' },
    });
    w.store.put(r0);
    expect(w.working.has(A)).toBe(false);
    await runPersonalStep(w.d);
    expect(w.working.get(A)?.shadow.sessions).toBe(0);
  });
});

describe('闸结果 → 转移(R21-5.2)', () => {
  it('闸红 → rejected(rejected_gate)并带墓碑 / 冷却效果', async () => {
    const w = world3();
    const id = withNewProposal(w);
    w.gateFacts.fn = async () => {
      const { clusterBusy: _c, ...rest } = goodFacts(draftOf());
      return { ...rest, tombstoned: true };
    };
    const r = await runPersonalStep(w.d);
    expect(r.gated).toEqual([{ id, outcome: 'red:g4_tombstone' }]);
    const rec = w.store.records.get(id);
    expect(rec?.lifecycle).toBe('rejected');
    expect(rec?.terminal_reason).toBe('rejected_gate');
    expect(rec?.transitions.at(-1)?.reason).toBe('g4_tombstone');
    expect(w.effects.some((e) => e.type === 'write_tombstone')).toBe(true);
  });
  it('闸内部错误 → gate_internal 熔断、候选停在 proposed、不记 rejected', async () => {
    const w = world3();
    const id = withNewProposal(w);
    w.gateFacts.fn = async () => {
      const { clusterBusy: _c, ...rest } = goodFacts(draftOf());
      return { ...rest, replay: null };
    };
    const r = await runPersonalStep(w.d);
    expect(r.breaker).toBe('gate_internal');
    expect(r.gated[0]?.outcome).toBe('internal:g6');
    expect(life(w, id)).toBe('proposed');
  });
  it('事实收集器读不到(null)或抛错 → 同样 gate_internal,不是通过', async () => {
    const w = world3();
    const id = withNewProposal(w);
    w.gateFacts.fn = async () => null;
    expect((await runPersonalStep(w.d)).breaker).toBe('gate_internal');
    w.gateFacts.fn = async () => {
      throw new Error('signal store down');
    };
    expect((await runPersonalStep(w.d)).breaker).toBe('gate_internal');
    expect(life(w, id)).toBe('proposed');
  });
  it('G7:同聚类已有非终态候选 → 留在 proposed(排队,不拒)', async () => {
    const w = world3();
    const id = withNewProposal(w);
    addShadow(w, A, { cluster: draftOf().clusterId });
    const r = await runPersonalStep(w.d);
    expect(r.gated).toEqual([{ id, outcome: 'queued' }]);
    expect(life(w, id)).toBe('proposed');
  });
});

describe('权威副本不可用时中止', () => {
  it.each(['absent', 'deferred', 'invalid'] as const)('仓库 %s:不创建、不推进', async (mode) => {
    const w = world3();
    withNewProposal(w);
    w.store.mode = mode;
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBe(
      mode === 'absent' ? 'repo_absent' : mode === 'deferred' ? 'repo_deferred' : 'repo_invalid',
    );
    expect(r.breaker).toBe(mode === 'invalid' ? 'personal_repo_invalid' : null);
    expect(w.store.commits.length).toBe(0);
    expect(w.marks.value?.repoReachable).toBe(false);
  });
  it('提交失败(cas_failed)→ 中止 commit_failed,不写工作副本', async () => {
    const w = world3();
    withNewProposal(w);
    w.store.failCommit = { status: 'cas_failed', expected: 'a', actual: 'b' };
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBe('commit_failed');
    expect(w.working.size).toBe(0);
  });
  it('效果落地失败:权威副本保留,记 effectsFailed', async () => {
    const w = world3();
    const id = withNewProposal(w);
    w.gateFacts.fn = async () => {
      const { clusterBusy: _c, ...rest } = goodFacts(draftOf());
      return { ...rest, cooldownActive: true };
    };
    w.effectsFail.value = true;
    const r = await runPersonalStep(w.d);
    expect(life(w, id)).toBe('rejected');
    expect(r.effectsFailed.length).toBe(1);
  });
});

describe('撤销凭据对账(R21-9.5 的 V1a 部分)', () => {
  it('凭据列出的 shadow 候选被推进到终态;原因取凭据的原因', async () => {
    const w = world3();
    addShadow(w, A);
    w.revs.value = { kind: 'ok', lines: [REV(A, 'vetoed')] };
    const r = await runPersonalStep(w.d);
    expect(r.reconciled).toEqual([A]);
    expect(w.store.records.get(A)?.terminal_reason).toBe('vetoed');
  });
  it('凭据的内容哈希不是该候选当前内容 → 不对账', async () => {
    const w = world3();
    addShadow(w, A);
    w.revs.value = { kind: 'ok', lines: [REV(A, 'cleared', 'b'.repeat(64))] };
    expect((await runPersonalStep(w.d)).reconciled).toEqual([]);
    expect(life(w, A)).toBe('shadow');
  });
  it('凭据读不到 → 中止且不授予任何影响(合格的 shadow 也不推进)', async () => {
    const w = world3({ phase: V1B });
    addShadow(w, A);
    eligible(w);
    w.revs.value = { kind: 'invalid', why: 'too_large' };
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBe('revocations_invalid');
    expect(life(w, A)).toBe('shadow');
  });
});

describe('shadow 步', () => {
  it('相位 V1b、资格齐全、名额空闲 → 推进 canary(原因 shadow_hits_met),并记 canary_ready_since', async () => {
    const w = world3({ phase: V1B });
    addShadow(w, A);
    eligible(w);
    const r = await runPersonalStep(w.d);
    expect(r.transitions).toEqual([`${A}: shadow -> canary`]);
    expect(w.store.records.get(A)?.transitions.at(-1)?.reason).toBe('shadow_hits_met');
    expect(w.working.get(A)?.shadow.canary_ready_since).toBe(TODAY);
  });
  it('M13-1 相位 V1a:资格齐全也不推进,且 queued_since 保持为空(相位未到不排队)', async () => {
    const w = world3({ phase: V1A });
    addShadow(w, A);
    eligible(w);
    await runPersonalStep(w.d);
    expect(life(w, A)).toBe('shadow');
    expect(w.working.get(A)?.shadow.queued_since).toBeNull();
  });
  it.each([
    ['配置无效', { config_valid: false }],
    ['enabled 为假', { enabled: false }],
    ['授权缺', { authorized: false }],
    ['taint', { tainted: true }],
    ['冷却', { cooldown_active: true }],
    ['墓碑', { tombstoned: true }],
    ['黑名单', { blacklisted: true }],
    ['内容变', { current_content_sha256: 'c'.repeat(64) }],
    ['签名变', { current_cluster_signature: { kind: 'tool', tool_name: 'Edit' } as const }],
    ['证据失效', { evidence_valid: false }],
    ['会话不足', { sessions: 19 }],
    ['命中不足但会话不足以到期', { sessions: 10, hits: 1 }],
  ] as const)('M13-1 前置不成立不推进:%s', async (_n, over) => {
    const w = world3({ phase: V1B });
    addShadow(w, A);
    eligible(w, over as never);
    await runPersonalStep(w.d);
    expect(life(w, A)).toBe('shadow');
  });
  it('M13-1 自动循环无效 / 暂停:不推进', async () => {
    for (const patch of [{ autoLoopEffective: false }, { autoPaused: true }]) {
      const w = world3({ phase: V1B });
      Object.assign(w.env, patch);
      addShadow(w, A);
      eligible(w);
      await runPersonalStep(w.d);
      expect(life(w, A)).toBe('shadow');
    }
  });
  it('M13-1 撤销凭据已列出该候选:不推进(先对账到终态)', async () => {
    const w = world3({ phase: V1B });
    addShadow(w, A);
    eligible(w);
    w.revs.value = { kind: 'ok', lines: [REV(A)] };
    await runPersonalStep(w.d);
    expect(life(w, A)).toBe('rejected');
  });
  it('命中不足的到期:≥ 20 会话且命中 < 2 → expired(no_hit)', async () => {
    const w = world3({ phase: V1B });
    addShadow(w, A);
    eligible(w, { sessions: 20, hits: 1 });
    await runPersonalStep(w.d);
    expect(w.store.records.get(A)?.terminal_reason).toBe('no_hit');
    expect(life(w, A)).toBe('expired');
  });
  it('M13-2 权威记录在列出之后已是终态(无撤销凭据):不推进', async () => {
    const w = world3({ phase: V1B });
    const r = addShadow(w, A);
    eligible(w);
    w.store.readOverride.set(A, mkRec('rejected', { id: r.id }));
    await runPersonalStep(w.d);
    expect(life(w, A)).toBe('shadow'); // 列表里的副本没有被改写
    expect(w.store.commits.length).toBe(0);
  });
  it('M13-4 全局名额:已有 canary 占用时 shadow 不推进,从今天起排队', async () => {
    const w = world3({ phase: V1B });
    addShadow(w, C, { lifecycle: 'canary' });
    addShadow(w, A);
    eligible(w);
    await runPersonalStep(w.d);
    expect(life(w, A)).toBe('shadow');
    expect(w.working.get(A)?.shadow.queued_since).toBe(TODAY);
  });
  it('M13-4 两个候选同时具备资格:同一步只推进一个(队首),另一个排队', async () => {
    const w = world3({ phase: V1B });
    addShadow(w, B);
    addShadow(w, A);
    eligible(w);
    await runPersonalStep(w.d);
    expect([life(w, A), life(w, B)].sort()).toEqual(['canary', 'shadow']);
    const queued = life(w, A) === 'shadow' ? A : B;
    expect(w.working.get(queued)?.shadow.queued_since).toBe(TODAY);
  });
  it('M13-7 队首按 (canary_ready_since, id) 升序;ready 日期晚的让位', async () => {
    const w = world3({ phase: V1B });
    addShadow(w, A, { shadow: { canary_ready_since: '2026-11-05' } });
    addShadow(w, B, { shadow: { canary_ready_since: '2026-11-01' } });
    eligible(w);
    await runPersonalStep(w.d);
    expect(life(w, B)).toBe('canary');
    expect(life(w, A)).toBe('shadow');
  });
  it('M13-7 canary_ready_since 很久以前但没有在排队:不到期、照常推进', async () => {
    const w = world3({ phase: V1B });
    addShadow(w, A, { shadow: { canary_ready_since: '2026-01-01', queued_since: null } });
    eligible(w);
    await runPersonalStep(w.d);
    expect(life(w, A)).toBe('canary');
  });
  it('M13-6 排队第 30 日名额恰好空闲:先到期(expired / limit_reached),不进 canary', async () => {
    const w = world3({ phase: V1B });
    addShadow(w, A, { shadow: { queued_since: '2026-10-11' } }); // 2026-11-10 − 30 日
    eligible(w);
    await runPersonalStep(w.d);
    expect(life(w, A)).toBe('expired');
    expect(w.store.records.get(A)?.transitions.at(-1)?.reason).toBe('limit_reached');
  });
  it('M13-6 排队第 29 日:不到期', async () => {
    const w = world3({ phase: V1A });
    addShadow(w, A, { shadow: { queued_since: '2026-10-12' } });
    w.marks.value = {
      enabled: true,
      paused: false,
      policyFp: 'p1',
      repoReachable: true,
      revocationCount: 0,
    };
    eligible(w);
    await runPersonalStep(w.d);
    expect(life(w, A)).toBe('shadow');
  });
});

describe('入口清零 queued_since(W0-13)', () => {
  const marks = {
    enabled: true,
    paused: false,
    policyFp: 'p1',
    repoReachable: true,
    revocationCount: 0,
  };
  it('entryReset:各入口事件各自成立;无变化不清零', () => {
    expect(entryReset(null, marks)).toBe(true);
    expect(entryReset(marks, marks)).toBe(false);
    expect(entryReset(marks, { ...marks, enabled: false })).toBe(true);
    expect(entryReset(marks, { ...marks, paused: true })).toBe(true);
    expect(entryReset(marks, { ...marks, policyFp: 'p2' })).toBe(true);
    expect(entryReset({ ...marks, repoReachable: false }, marks)).toBe(true);
    expect(entryReset(marks, { ...marks, revocationCount: 1 })).toBe(true);
    expect(entryReset(marks, { ...marks, repoReachable: false })).toBe(false);
  });
  it('M13-5 pause 之后第一个持锁步清空 queued_since:已过 30 日的排队不会到期,条件恢复后重新起算', async () => {
    const w = world3({ phase: V1A });
    addShadow(w, A, { shadow: { queued_since: '2026-09-01' } });
    w.marks.value = marks;
    w.env.marks.paused = true;
    eligible(w);
    const r = await runPersonalStep(w.d);
    expect(r.queueReset).toBe(true);
    expect(life(w, A)).toBe('shadow');
    expect(w.working.get(A)?.shadow.queued_since).toBeNull();
  });
  it('M13-5 无入口事件:同样的旧 queued_since 会到期(对照)', async () => {
    const w = world3({ phase: V1A });
    addShadow(w, A, { shadow: { queued_since: '2026-09-01' } });
    w.marks.value = marks;
    eligible(w);
    const r = await runPersonalStep(w.d);
    expect(r.queueReset).toBe(false);
    expect(life(w, A)).toBe('expired');
  });
  it('M13-5 升相位后不立即 limit_reached:V1a 期间资格不成立 → queued_since 为空,升到 V1b 后从当日起算', async () => {
    const w = world3({ phase: V1A });
    addShadow(w, A, { shadow: { canary_ready_since: '2026-08-01' } });
    w.marks.value = marks;
    eligible(w);
    w.now.value = new Date('2026-11-10T12:00:00Z');
    await runPersonalStep(w.d);
    expect(w.working.get(A)?.shadow.queued_since).toBeNull();
    w.env.phase = V1B;
    addShadow(w, C, { lifecycle: 'canary' }); // 名额被占 → 排队
    await runPersonalStep(w.d);
    expect(life(w, A)).toBe('shadow');
    expect(w.working.get(A)?.shadow.queued_since).toBe(TODAY);
  });
  it('撤销凭据数量增加也是入口事件', async () => {
    const w = world3({ phase: V1A });
    addShadow(w, A, { shadow: { queued_since: '2026-09-01' } });
    addShadow(w, B);
    w.marks.value = marks;
    w.revs.value = { kind: 'ok', lines: [REV(B)] };
    eligible(w);
    const r = await runPersonalStep(w.d);
    expect(r.queueReset).toBe(true);
    expect(life(w, A)).toBe('shadow');
  });
});
