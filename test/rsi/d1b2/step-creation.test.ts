/**
 * D1b-2:`runPersonalStep` 的创建提交与增影响端口、创建取时、创建审计、观察行端口、两把锁(I9 / I11 / I12)。
 * 「创建恒拒」是防误接线,不是功能:缺端口 / claim 拒 / 提交前复核拒 → `growthDenied` 记录、**不 halt**(减影响子步骤照常),零写入;
 * 放行(测试夹具的放行假件)→ 创建走 `claim` 钩子 + `stampFirst` 取时 + 带键审计。这些用例**不证明生产装配允许创建**(生产没有调用方、`GrowthStage` 未装配)。
 */
import { describe, expect, it } from 'vitest';
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
  RsiAuditLine,
} from '../../../src/contracts/rsi-personal.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { runPersonalStep } from '../../../src/rsi/personal/candidate-step.js';
import { classifyHalt } from '../../../src/rsi/personal/stage/errors.js';
import { recoverCreationAudits } from '../../../src/rsi/personal/creation-audit.js';
import type { GrowthClaimPort } from '../../../src/rsi/personal/candidate-ports.js';
import type { KeyedEffectResult } from '../../../src/rsi/personal/rollback-ports.js';
import { SealRegistry, createSealGuard } from '../../../src/rsi/store/seal.js';
import type { EntrySeal } from '../../../src/rsi/personal/entry-stamp.js';
import { rec as mkRec, SIG } from '../personal/transition-fixture.js';
import { gateFactsNoBusy, staged, world3, type World3 } from '../personal/w3-fixture.js';

const V1B = 2;
const A = 'ra_aaaaaaaaaaaa';
const B = 'ra_bbbbbbbbbbbb';

function wcFor(r: PersonalLifecycleRecord, queued: string | null = null): CandidateWorkingCopy {
  return {
    schema_version: 1,
    id: r.id,
    cluster_signature: { ...SIG },
    source: { run_id: 'run-1', proposal_id: '2026-11-05-001' },
    shadow: { sessions: 25, hits: 3, canary_ready_since: null, queued_since: queued },
    evidence: { sessions: [], days: [] },
    stats: { sessions_observed: 0, sessions_treat: 0, sessions_control: 0, bytes_injected: 0 },
    repo_removal_deferred: false,
  };
}

function propose(w: World3): void {
  w.stagedList = [staged()];
  w.gateFacts.fn = async () => gateFactsNoBusy();
}

/** 创建路径上的全部持久副作用都为零 */
function expectNoCreation(w: World3): void {
  expect(w.store.commits).toEqual([]);
  expect(w.store.records.size).toBe(0);
  expect(w.working.size).toBe(0);
  expect(w.audits).toEqual([]);
  expect(w.effects).toEqual([]);
}

describe('创建提交先过 growth 端口(d1_sinks_refuse_without_pass / creation_commit_without_claim)', () => {
  it('d1_creation_always_refused_with_reason:缺 growth 端口 → growthDenied[{candidate_create, unwired}],零写入,不 halt;封存区域不开、不取时', async () => {
    const w = world3({ phase: V1B });
    delete w.d.growth;
    propose(w);
    let opens = 0;
    const seal: EntrySeal = {
      open: async () => {
        opens++;
        throw new Error('封存区域不应被打开');
      },
    };
    w.d.seal = seal;
    const r = await runPersonalStep(w.d);
    expect(r.growthDenied).toEqual([{ op: 'candidate_create', code: 'unwired' }]);
    expect(r.created).toEqual([]);
    expect(r.halted).toBeNull();
    expect(opens).toBe(0);
    expectNoCreation(w);
  });

  it('claim 拒 → growthDenied 带原因码;本轮不再逐个候选重试(只 claim 一次);后面的提案仍按原规则分类(skip 照记)', async () => {
    const w = world3({ phase: V1B });
    w.growth.denyClaim = 'paused';
    propose(w);
    w.stagedList = [
      staged(),
      staged({ atomId: 'other-rule', proposalId: '2026-11-05-002' }),
      staged({ layer: 'team', proposalId: '2026-11-05-003' }),
    ];
    const r = await runPersonalStep(w.d);
    expect(r.growthDenied).toEqual([{ op: 'candidate_create', code: 'paused' }]);
    expect(w.growth.claims).toEqual([{ op: 'candidate_create', cand: null }]);
    expect(r.halted).toBeNull();
    expectNoCreation(w);
  });

  it('claim 返回畸形 → claim_malformed;钩子不被调用', async () => {
    const w = world3({ phase: V1B });
    w.d.growth = { claim: async () => ({ ok: true }) as never };
    propose(w);
    const r = await runPersonalStep(w.d);
    expect(r.growthDenied).toEqual([{ op: 'candidate_create', code: 'claim_malformed' }]);
    expectNoCreation(w);
  });

  it('提交前复核拒(commit 返回 denied)→ growthDenied;记录 / 文件 / 工作副本 / 审计都没有;区域已关闭;不 halt', async () => {
    const w = world3({ phase: V1B });
    w.growth.hookDeny = 'creation_unready';
    propose(w);
    let closes = 0;
    w.d.seal = {
      open: async () => ({
        stampFirst: (now) => now().toISOString(),
        markSourceCommitted: () => undefined,
        close: () => {
          closes++;
        },
      }),
    };
    const r = await runPersonalStep(w.d);
    expect(r.growthDenied).toEqual([{ op: 'candidate_create', code: 'creation_unready' }]);
    expect(r.created).toEqual([]);
    expect(r.halted).toBeNull();
    expect(closes).toBe(1);
    expectNoCreation(w);
  });

  it('放行:钩子经 commit 传给提交底座且被调用;创建成功(对照:上面各用例去掉的正是这一条)', async () => {
    const w = world3({ phase: V1B });
    propose(w);
    const r = await runPersonalStep(w.d);
    expect(r.created).toHaveLength(1);
    expect(r.growthDenied).toEqual([]);
    expect(w.growth.claims[0]).toEqual({ op: 'candidate_create', cand: null });
    expect(typeof w.store.commits[0]?.beforeRefUpdate).toBe('function');
    expect(w.growth.hookCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('被拒的增影响动作不阻止减影响子步骤(不 halt)', () => {
  it('gates_passed 缺端口被拒:候选留在 proposed,记 growthDenied,halted 为空;同一步里 shadow 排队到期(减影响)照常推进', async () => {
    const w = world3({ phase: V1B });
    delete w.d.growth;
    w.gateFacts.fn = async () => gateFactsNoBusy();
    const p = mkRec('proposed', { id: A, cluster_id: 'cl-a' });
    w.store.put(p);
    w.working.set(A, wcFor(p));
    const s = mkRec('shadow', { id: B, cluster_id: 'cl-b' });
    w.store.put(s);
    w.working.set(B, wcFor(s, '2026-10-11')); // 2026-11-10 − 30 日:排队到期
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBeNull();
    expect(r.growthDenied).toEqual([{ op: 'candidate_create', code: 'unwired' }]);
    expect(w.store.records.get(A)?.lifecycle).toBe('proposed');
    expect(w.store.records.get(B)?.lifecycle).toBe('expired');
  });

  it('gates_passed 的 claim 拒 → 同样不 halt、不转移;gate_red(减影响)不看端口:红闸照常 rejected', async () => {
    const w = world3({ phase: V1B });
    w.growth.denyClaim = 'paused';
    const green = mkRec('proposed', { id: A, cluster_id: 'cl-a' });
    const red = mkRec('proposed', { id: B, cluster_id: 'cl-b' });
    for (const x of [green, red]) {
      w.store.put(x);
      w.working.set(x.id, wcFor(x));
    }
    w.gateFacts.fn = async (r) =>
      r.id === A ? gateFactsNoBusy() : gateFactsNoBusy(undefined, { tombstoned: true });
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBeNull();
    expect(w.store.records.get(A)?.lifecycle).toBe('proposed');
    expect(w.store.records.get(B)?.lifecycle).toBe('rejected');
    expect(w.growth.claims.every((c) => c.op === 'candidate_create')).toBe(true);
  });
});

describe('创建取时经封存区域(I11)', () => {
  const clockNow = new Date('2026-11-10T12:00:00.000Z');
  function sealedWorld(through: string): { w: World3; registry: SealRegistry } {
    const w = world3({ phase: V1B });
    w.now.value = clockNow;
    const registry = new SealRegistry();
    const guard = createSealGuard({ registry, readWatermark: async () => ({ through, gen: 1 }) });
    w.d.seal = { open: async () => guard.open({ assertHeld: async () => undefined }) };
    propose(w);
    return { w, registry };
  }

  it('creation_stamp_sealed_interval_refused_before_commit:取时落在已封存区间 → halted=sealed_interval,零写入(无提交、无记录、无工作副本、无审计)', async () => {
    const { w } = sealedWorld('2026-11-10');
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBe('sealed_interval');
    expect(r.created).toEqual([]);
    expectNoCreation(w);
  });

  it('正向对照:水位线在取时之前 → 创建成功,条目 at 就是区域取到的时刻', async () => {
    const { w } = sealedWorld('2026-11-09');
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBeNull();
    expect(r.created).toHaveLength(1);
    const first = [...w.store.records.values()][0]?.transitions[0];
    expect(first?.at).toBe(clockNow.toISOString());
  });
});

describe('创建审计经唯一派生点、带键落地(I13 的即时一半)', () => {
  it('装配了 appendKeyed 时,创建行审计经它落地:键 = 条目 idem_key,at = 条目 at(创建行不走无键 append)', async () => {
    const w = world3({ phase: V1B });
    const keyed: { line: RsiAuditLine; idem_key?: string }[] = [];
    w.d.audit.appendKeyed = async (items) => {
      keyed.push(...items);
    };
    propose(w);
    await runPersonalStep(w.d);
    const created = [...w.store.records.values()][0];
    const first = created?.transitions[0];
    const row = keyed.find((k) => k.line.from === 'none');
    expect(row?.idem_key).toBe(first?.idem_key);
    expect(row?.line.at).toBe(first?.at);
    expect(w.audits.some((a) => a.from === 'none')).toBe(false);
  });
});

describe('创建审计缺带键出口:不回落无键 append(与恢复的键去重对齐)', () => {
  it('creation_audit_without_keyed_port_not_appended_via_keyless_append:缺 appendKeyed → 创建成功但创建行审计不落、记 effectsFailed;随后恢复按键补一次(applied),再来一次 already(不重复)', async () => {
    const w = world3({ phase: V1B });
    delete w.d.audit.appendKeyed;
    const appended: RsiAuditLine[] = [];
    w.d.audit.append = async (l) => void appended.push(...l);
    propose(w);
    const r = await runPersonalStep(w.d);
    expect(r.created).toHaveLength(1);
    const id = r.created[0] as string;
    expect(r.effectsFailed).toContain(`${id}:creation_audit_port_missing`);
    expect(appended.some((a) => a.from === 'none')).toBe(false);
    expect(w.audits.some((a) => a.from === 'none')).toBe(false);
    // 恢复:同一个键空间,第一次补上,第二次 already(无键行不参与去重,所以绝不能先写一条无键的)
    const landed = new Set<string>();
    const sink = {
      applyOnce: async (key: string): Promise<KeyedEffectResult> => {
        if (landed.has(key)) return 'already';
        landed.add(key);
        return 'applied';
      },
    };
    const store = { readAll: () => w.store.readAll() };
    expect((await recoverCreationAudits({ store, sink })).applied).toEqual([id]);
    expect((await recoverCreationAudits({ store, sink })).already).toEqual([id]);
  });
});

describe('ApplyResult.denied 的降级只对已分类的增影响事件(减影响事件出现 denied = 底座违约 → halt commit_failed)', () => {
  it('runner_downgrades_reducing_denied:减影响事件(shadow 排队到期)的提交返回 denied → halted=commit_failed(既有的完整性失败类,fail-closed),不记 growthDenied', async () => {
    const w = world3({ phase: V1B });
    const s = mkRec('shadow', { id: B, cluster_id: 'cl-b' });
    w.store.put(s);
    w.working.set(B, wcFor(s, '2026-10-11')); // 30 日 → 排队到期(减影响)
    w.store.failCommit = { status: 'denied', code: 'rogue' };
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBe('commit_failed');
    expect(r.growthDenied).toEqual([]);
    expect(w.store.records.get(B)?.lifecycle).toBe('shadow');
  });
});

describe('claim 返回值只读一次(校验过的值就是转交的值)', () => {
  it('创建路径:带 getter 的 claim 返回值 —— hook 只被读一次,commit 收到的就是那一次读到的函数', async () => {
    const w = world3({ phase: V1B });
    let reads = 0;
    const fn = async (): Promise<void> => undefined;
    const port: GrowthClaimPort = {
      claim: async () =>
        ({
          ok: true,
          get hook() {
            reads++;
            return reads === 1 ? fn : undefined;
          },
        }) as never,
    };
    w.d.growth = port;
    propose(w);
    const r = await runPersonalStep(w.d);
    expect(r.created).toHaveLength(1);
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(w.store.commits[0]?.beforeRefUpdate).toBe(fn);
  });
});

describe('观察行只经 appendObservation(I12)', () => {
  function rebuildWorld(): World3 {
    const w = world3({ phase: V1B });
    w.store.put(
      mkRec('shadow', {
        id: A,
        source_proposal: { run_id: 'run-1', proposal_id: '2026-11-05-001' },
      }),
    );
    return w;
  }
  it('有端口:重建工作副本的观察行(ready_since_rebuilt)经 appendObservation 落地', async () => {
    const w = rebuildWorld();
    await runPersonalStep(w.d);
    expect(w.audits.some((a) => a.reason === 'ready_since_rebuilt')).toBe(true);
  });

  it('observation_row_without_port_not_appended_via_keyless_append:缺端口 → 观察行不落、不回落 append,记 effectsFailed', async () => {
    const w = rebuildWorld();
    delete w.d.audit.appendObservation;
    const appended: RsiAuditLine[] = [];
    w.d.audit.append = async (l) => void appended.push(...l);
    const r = await runPersonalStep(w.d);
    expect(appended).toEqual([]);
    expect(w.audits.some((a) => a.kind === 'evaluation')).toBe(false);
    expect(r.effectsFailed).toContain(`${A}:observation_port_missing`);
    expect(r.halted).toBeNull();
  });

  it('排队清零的观察行(promote_facts_unavailable)同样只走端口', async () => {
    const w = world3({ phase: V1B });
    const s = mkRec('shadow', { id: A, cluster_id: 'cl-a' });
    w.store.put(s);
    w.working.set(A, wcFor(s, '2026-11-09'));
    w.promoteFacts.fn = async () => null;
    delete w.d.audit.appendObservation;
    const r = await runPersonalStep(w.d);
    expect(w.audits).toEqual([]);
    expect(r.effectsFailed).toContain(`${A}:observation_port_missing`);
  });
});

describe('StepDeps.locks 两把锁都要持(I9 的锁半)', () => {
  it('rsi 锁丢失:入口 assertHeld 抛 → 整步抛出,零写入(没有 marks 写、没有提交)', async () => {
    const w = world3({ phase: V1B });
    propose(w);
    const marks0 = structuredClone(w.marks.value);
    w.d.locks.rsi.assertHeld = async () => {
      throw new RsiLockError('lock_lost');
    };
    await expect(runPersonalStep(w.d)).rejects.toBeInstanceOf(RsiLockError);
    expect(w.marks.value).toEqual(marks0);
    expectNoCreation(w);
  });

  it('personal 锁丢失同样抛出(对照:两把锁各自独立生效)', async () => {
    const w = world3({ phase: V1B });
    propose(w);
    w.d.locks.personal.assertHeld = async () => {
      throw new RsiLockError('lock_lost');
    };
    await expect(runPersonalStep(w.d)).rejects.toBeInstanceOf(RsiLockError);
    expectNoCreation(w);
  });
});

describe('创建提交遇到拒绝后引用异动:映射 commit_failed(fail-closed),不是只停本步的 repo_deferred', () => {
  it('creation_ref_moved_after_denied_maps_commit_failed:创建提交返回 deferred{ref_moved_after_denied} → halted=commit_failed,分类 stop_step_unsettled;无创建落地', async () => {
    const w = world3({ phase: V1B });
    propose(w);
    w.store.failCommit = {
      status: 'deferred',
      reason: 'personal_repo_diverged',
      why: 'ref_moved_after_denied',
    };
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBe('commit_failed');
    expect(r.created).toEqual([]);
    expect(r.growthDenied).toEqual([]); // 完整性失败,不是被拒
    expect(classifyHalt(r.halted as 'commit_failed')).toEqual({
      kind: 'stop_step_unsettled',
      cause: 'commit_failed',
    });
    expectNoCreation(w);
  });

  it('对照:创建提交的其它 deferred 仍是 repo_deferred(只停本步)', async () => {
    const w = world3({ phase: V1B });
    propose(w);
    w.store.failCommit = {
      status: 'deferred',
      reason: 'personal_repo_diverged',
      why: 'some_other_why',
    };
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBe('repo_deferred');
    expectNoCreation(w);
  });
});
