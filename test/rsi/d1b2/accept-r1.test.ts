/**
 * D1b-2 主代理验收第 1 轮的四条返工(第 1 条 commit.ts 清理结果见 `commit-hook.test.ts`;第 2 条架构门见 `growth-sinks-arch.test.ts`):
 *  - 第 3 条 `creation_audit_confirmed_before_truncation`:创建审计未耐久确认前不截断创建条目(`applyEvent` 的截断边界);三个故障点(提交后 working.put 前、working.put 后审计前、审计行已落但确认未返回)
 *    之后跨过 256 条窗口:最终恰好一行、原 `at`、原键;确认失败 → 转移不提交(零写入);
 *  - 第 4 条 `creation_requires_seal`:放行的 claim + 不装 seal → 创建提交与创建审计都不被调用(不能用恒拒 claim 代替);减影响入口无封存照常;
 *  - 第 5 条 `denied_is_apply_result_branch`:被拒是 `ApplyResult` 自己的分支,不进冻结的 `StepHalt`;增效事件被拒只记 `growthDenied`、后续减影响照跑;减影响提交返回 denied → `commit_failed`(fail-closed)。
 */
import { describe, expect, it } from 'vitest';
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
  RsiAuditLine,
} from '../../../src/contracts/rsi-personal.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { applyEvent } from '../../../src/rsi/personal/candidate-apply.js';
import { startRollback } from '../../../src/rsi/personal/rollback.js';
import { CREATION_FROM } from '../../../src/rsi/personal/candidate-record.js';
import { runPersonalStep } from '../../../src/rsi/personal/candidate-step.js';
import { recoverCreationAudits } from '../../../src/rsi/personal/creation-audit.js';
import { auditKeyOf, keyedAuditSink } from '../../../src/rsi/personal/effects-recover.js';
import {
  deferredKeyedEffects,
  type KeyedEffectResult,
  type KeyedEffectSink,
} from '../../../src/rsi/personal/rollback-ports.js';
import { makeFx, runWrite } from '../auto/write-fixture.js';
import { world7, harmReq, recordOf, ID as ID7 } from '../rollback/w7-fixture.js';
import { E, entry, rec, SIG } from '../personal/transition-fixture.js';
import { gateFactsNoBusy, staged, world3, type World3 } from '../personal/w3-fixture.js';

const V1B = 2;
const A = 'ra_aaaaaaaaaaaa';
const B = 'ra_bbbbbbbbbbbb';
const CREATED_AT = '2026-10-01T00:00:00.000Z';

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

/** 带键审计假件(按生产语义:同键只生效一次);`fault` 一次性 */
class KeyedAudit {
  rows = new Map<string, RsiAuditLine>();
  calls: string[][] = [];
  log: string[];
  fault: 'none' | 'throw_before' | 'throw_after' | 'sealed' | 'lock_lost' = 'none';
  constructor(log: string[] = []) {
    this.log = log;
  }
  appendKeyed = async (items: readonly { line: RsiAuditLine; idem_key?: string }[]) => {
    const f = this.fault;
    this.calls.push(items.map((i) => i.idem_key ?? ''));
    this.log.push('audit');
    if (f === 'throw_before') {
      this.fault = 'none';
      throw new Error('audit_down');
    }
    if (f === 'sealed') {
      this.fault = 'none';
      throw Object.assign(new Error('sealed'), {
        name: 'AuditSealedError',
        code: 'sealed_interval',
      });
    }
    if (f === 'lock_lost') {
      this.fault = 'none';
      throw new RsiLockError('lock_lost');
    }
    for (const it of items) {
      const key = auditKeyOf(it.line.id, it.idem_key ?? '');
      if (!this.rows.has(key)) this.rows.set(key, it.line);
    }
    if (f === 'throw_after') {
      this.fault = 'none';
      throw new Error('ack_lost');
    }
  };
  /** 对账 / 补做出口:同一份 `rows`、同一键空间,行取效果里带的那一行 */
  asSink(): KeyedEffectSink {
    return {
      applyOnce: async (key, effects): Promise<KeyedEffectResult> => {
        if (this.rows.has(key)) return 'already';
        const e = effects[0];
        if (e?.type !== 'append_audit') throw new Error('unexpected effect');
        this.rows.set(key, e.line);
        return 'applied';
      },
    };
  }
}

const creationEntry = (): PersonalLifecycleRecord['transitions'][number] => ({
  dim: 'lifecycle',
  from: CREATION_FROM,
  to: 'proposed',
  at: CREATED_AT,
  reason: 'ingested',
  idem_key: 'c'.repeat(16),
});

/** 窗口里恰好 `n` 条:第 0 条是创建条目,其余是占位条目(不是创建行) */
const windowed = (r: PersonalLifecycleRecord, n: number): PersonalLifecycleRecord => ({
  ...r,
  transitions: [creationEntry(), ...Array.from({ length: n - 1 }, (_, i) => entry(i + 100))],
});

const creationKey = (id: string): string => auditKeyOf(id, 'c'.repeat(16));

describe('creation_audit_confirmed_before_truncation(第 3 条)', () => {
  it('截断创建条目的转移:先经带键端口落创建审计(原 at、原键),再提交;提交后窗口里不再有创建条目;恰好一行', async () => {
    const w = world3({ phase: V1B });
    const log: string[] = [];
    const k = new KeyedAudit(log);
    w.d.audit.appendKeyed = k.appendKeyed;
    const orig = w.store.commit.bind(w.store);
    w.store.commit = async (s) => {
      log.push('commit');
      return orig(s);
    };
    const r0 = windowed(rec('proposed'), 256);
    w.store.put(r0);
    const r = await applyEvent(w.d, r0, E.gatesPassed());
    expect(r.kind).toBe('transitioned');
    expect(log.indexOf('audit')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('audit')).toBeLessThan(log.indexOf('commit'));
    const row = k.rows.get(creationKey(r0.id));
    expect(row?.at).toBe(CREATED_AT);
    expect(row?.from).toBe(CREATION_FROM);
    const after = w.store.records.get(r0.id);
    expect(after?.transitions).toHaveLength(256);
    expect(after?.transitions_dropped).toBe(1);
    expect(after?.transitions.some((e) => e.idem_key === 'c'.repeat(16))).toBe(false);
    // 重放:记录里已没有创建条目,补做不会再产出(也不会重复)
    const rec2 = await recoverCreationAudits({
      store: { readAll: () => w.store.readAll() },
      sink: k.asSink(),
    });
    expect([rec2.applied, rec2.already]).toEqual([[], []]);
    expect([...k.rows.keys()].filter((x) => x === creationKey(r0.id))).toHaveLength(1);
  });

  it('truncation_refused_when_creation_audit_unconfirmed:确认失败(抛错)→ halt{commit_failed},转移不提交(零写入);故障恢复后重试成功,仍恰好一行', async () => {
    const w = world3({ phase: V1B });
    const k = new KeyedAudit();
    w.d.audit.appendKeyed = k.appendKeyed;
    const r0 = windowed(rec('proposed'), 256);
    w.store.put(r0);
    k.fault = 'throw_before';
    const r = await applyEvent(w.d, r0, E.gatesPassed());
    expect(r).toEqual({
      kind: 'halt',
      halt: 'commit_failed',
      why: 'creation_audit_unconfirmed:audit_down',
    });
    expect(w.store.commits).toEqual([]);
    expect(w.store.records.get(r0.id)?.transitions[0]?.idem_key).toBe('c'.repeat(16));
    expect(k.rows.size).toBe(0);
    const again = await applyEvent(w.d, r0, E.gatesPassed());
    expect(again.kind).toBe('transitioned');
    expect([...k.rows.keys()].filter((x) => x === creationKey(r0.id))).toHaveLength(1);
  });

  it('审计行已落但确认没返回(throw_after):不提交;重试时同键幂等 → 最终恰好一行、原 at', async () => {
    const w = world3({ phase: V1B });
    const k = new KeyedAudit();
    w.d.audit.appendKeyed = k.appendKeyed;
    const r0 = windowed(rec('proposed'), 256);
    w.store.put(r0);
    k.fault = 'throw_after';
    const r = await applyEvent(w.d, r0, E.gatesPassed());
    expect(r.kind).toBe('halt');
    expect(w.store.commits).toEqual([]);
    expect(k.rows.get(creationKey(r0.id))?.at).toBe(CREATED_AT);
    expect((await applyEvent(w.d, r0, E.gatesPassed())).kind).toBe('transitioned');
    expect([...k.rows.keys()].filter((x) => x === creationKey(r0.id))).toHaveLength(1);
    expect(k.rows.get(creationKey(r0.id))?.at).toBe(CREATED_AT);
  });

  it('appendKeyed 返回 deferred(缩减入口:行没落地、续做依赖记录里的创建条目)不是确认 → 拒绝截断;零写入;真实适配器 keyedAuditSink(deferredKeyedEffects) 同样如此', async () => {
    // 假件返回 'deferred'
    const w = world3({ phase: V1B });
    w.d.audit.appendKeyed = async () => 'deferred';
    const r0 = windowed(rec('proposed'), 256);
    w.store.put(r0);
    expect(await applyEvent(w.d, r0, E.gatesPassed())).toEqual({
      kind: 'halt',
      halt: 'commit_failed',
      why: 'creation_audit_unconfirmed:deferred',
    });
    expect(w.store.commits).toEqual([]);
    // 生产的带键出口:底层 sink 是 deferred → appendKeyed 返回 'deferred'(不能把 applyOnce 的 deferred 丢掉)
    const w2 = world3({ phase: V1B });
    const real = keyedAuditSink(deferredKeyedEffects);
    expect(await real.appendKeyed?.([{ line: {} as RsiAuditLine, idem_key: 'c'.repeat(16) }])).toBe(
      'deferred',
    );
    w2.d.audit = real;
    w2.store.put(r0);
    expect((await applyEvent(w2.d, r0, E.gatesPassed())).kind).toBe('halt');
    expect(w2.store.commits).toEqual([]);
    // 对照:底层 sink 落地(applied)→ 返回 undefined,转移照常
    const w3 = world3({ phase: V1B });
    w3.d.audit = keyedAuditSink({ applyOnce: async () => 'applied' });
    w3.store.put(r0);
    expect((await applyEvent(w3.d, r0, E.gatesPassed())).kind).toBe('transitioned');
  });

  it('已知代价(owner 待定):减影响事件(veto)在缩减入口(deferredKeyedEffects)上也被截断确认挡住 → halt{commit_failed},记录不动;非截断的减影响不受影响', async () => {
    const w = world3({ phase: V1B });
    w.d.audit = keyedAuditSink(deferredKeyedEffects);
    const r0 = windowed(rec('canary'), 256);
    w.store.put(r0);
    expect(await applyEvent(w.d, r0, E.veto())).toEqual({
      kind: 'halt',
      halt: 'commit_failed',
      why: 'creation_audit_unconfirmed:deferred',
    });
    expect(w.store.commits).toEqual([]);
    expect(w.store.records.get(r0.id)?.lifecycle).toBe('canary');
    // 对照:窗口未满(创建条目不会被截)→ veto 照常
    const w2 = world3({ phase: V1B });
    w2.d.audit = keyedAuditSink(deferredKeyedEffects);
    const r1 = windowed(rec('canary'), 255);
    w2.store.put(r1);
    expect((await applyEvent(w2.d, r1, E.veto())).kind).toBe('transitioned');
  });

  it('缺 appendKeyed 端口 → 拒绝截断(halt{commit_failed, port_missing});不回落无键 append;零写入', async () => {
    const w = world3({ phase: V1B });
    delete w.d.audit.appendKeyed;
    let appended = 0;
    w.d.audit.append = async () => void appended++;
    const r0 = windowed(rec('proposed'), 256);
    w.store.put(r0);
    expect(await applyEvent(w.d, r0, E.gatesPassed())).toEqual({
      kind: 'halt',
      halt: 'commit_failed',
      why: 'creation_audit_unconfirmed:port_missing',
    });
    expect(appended).toBe(0);
    expect(w.store.commits).toEqual([]);
  });

  it('丢锁原样传播(不吞成 halt);零写入', async () => {
    const w = world3({ phase: V1B });
    const k = new KeyedAudit();
    w.d.audit.appendKeyed = k.appendKeyed;
    const r0 = windowed(rec('proposed'), 256);
    w.store.put(r0);
    k.fault = 'lock_lost';
    await expect(applyEvent(w.d, r0, E.gatesPassed())).rejects.toBeInstanceOf(RsiLockError);
    expect(w.store.commits).toEqual([]);
  });

  it('创建日已封存(AuditSealedError sealed_interval)= 已对账封存,视为已确认:转移照常提交', async () => {
    const w = world3({ phase: V1B });
    const k = new KeyedAudit();
    w.d.audit.appendKeyed = k.appendKeyed;
    const r0 = windowed(rec('proposed'), 256);
    w.store.put(r0);
    k.fault = 'sealed';
    expect((await applyEvent(w.d, r0, E.gatesPassed())).kind).toBe('transitioned');
  });

  it('对照:创建条目仍在窗口内(255 条 + 1)→ 不额外落创建审计(即时路径与恢复负责)', async () => {
    const w = world3({ phase: V1B });
    const k = new KeyedAudit();
    w.d.audit.appendKeyed = k.appendKeyed;
    const r0 = windowed(rec('proposed'), 255);
    w.store.put(r0);
    expect((await applyEvent(w.d, r0, E.gatesPassed())).kind).toBe('transitioned');
    expect(k.rows.has(creationKey(r0.id))).toBe(false);
    expect(w.store.records.get(r0.id)?.transitions_dropped).toBe(0);
  });

  describe('三个故障点之后跨过截断边界:最终恰好一行、原 at、原键', () => {
    const POINTS = [
      'after_ref_update_before_working_put',
      'after_working_put',
      'ack_lost',
    ] as const;
    for (const point of POINTS) {
      it(point, async () => {
        const w = world3({ phase: V1B });
        const k = new KeyedAudit();
        w.d.audit.appendKeyed = k.appendKeyed;
        propose(w);
        if (point === 'after_ref_update_before_working_put') w.putFail.error = new Error('crash');
        if (point === 'after_working_put') k.fault = 'throw_before';
        if (point === 'ack_lost') k.fault = 'throw_after';
        const s = await runPersonalStep(w.d);
        expect(s.created).toHaveLength(1);
        expect(s.effectsFailed.length).toBeGreaterThan(0);
        w.putFail.error = null;
        const id = s.created[0] as string;
        const created = w.store.records.get(id) as PersonalLifecycleRecord;
        const at = created.transitions[0]?.at;
        const key = created.transitions[0]?.idem_key as string;
        // 重启后的对账(截断之前):同键幂等
        const sink = k.asSink();
        await recoverCreationAudits({ store: { readAll: () => w.store.readAll() }, sink });
        // 模拟之后记录增长到 256 条窗口,下一次转移会截掉创建条目
        const grown: PersonalLifecycleRecord = {
          ...created,
          lifecycle: 'proposed', // 同一步的闸可能已把它推进到 shadow;这里要对 proposed 再施加 gates_passed
          transitions: [
            created.transitions[0] as PersonalLifecycleRecord['transitions'][number],
            ...Array.from({ length: 255 }, (_, i) => entry(i + 100)),
          ],
        };
        w.store.put(grown);
        const r = await applyEvent(w.d, grown, E.gatesPassed());
        expect(r.kind).toBe('transitioned');
        const mine = [...k.rows.entries()].filter(([kk]) => kk === auditKeyOf(id, key));
        expect(mine).toHaveLength(1);
        // 不论是即时路径、对账补做还是截断边界的确认写入的,那一行都带条目里的原 at
        expect(mine[0]?.[1].at).toBe(at);
        expect(w.store.records.get(id)?.transitions.some((e) => e.idem_key === key)).toBe(false);
      });
    }
  });
});

describe('creation_requires_seal(第 4 条)', () => {
  it('放行的 claim + 不装 seal → 创建提交与创建审计都不被调用;claim 也不调;记 growthDenied{seal_missing}(回合级,不 halt)', async () => {
    const w = world3({ phase: V1B });
    delete w.d.seal;
    const k = new KeyedAudit();
    w.d.audit.appendKeyed = k.appendKeyed;
    propose(w);
    const r = await runPersonalStep(w.d);
    expect(r.growthDenied).toEqual([{ op: 'candidate_create', code: 'seal_missing' }]);
    expect(r.created).toEqual([]);
    expect(r.halted).toBeNull();
    expect(w.store.commits).toEqual([]);
    expect(w.store.records.size).toBe(0);
    expect(w.working.size).toBe(0);
    expect(k.calls).toEqual([]);
    expect(w.audits).toEqual([]);
    expect(w.growth.claims).toEqual([]);
    expect(w.growth.hookCalls).toBe(0);
  });

  it('对照:同一世界装上 seal → 创建成功(上一条的拒绝正是因为缺 seal,不是别的原因)', async () => {
    const w = world3({ phase: V1B });
    propose(w);
    const r = await runPersonalStep(w.d);
    expect(r.created).toHaveLength(1);
    expect(r.growthDenied).toEqual([]);
  });

  it('减影响入口保留无封存兼容:缺 seal 时 shadow 排队到期(减影响)照常推进', async () => {
    const w = world3({ phase: V1B });
    delete w.d.seal;
    const s = rec('shadow', { id: B, cluster_id: 'cl-b' });
    w.store.put(s);
    w.working.set(B, wcFor(s, '2026-10-11'));
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBeNull();
    expect(w.store.records.get(B)?.lifecycle).toBe('expired');
  });
});

describe('denied_is_apply_result_branch(第 5 条)', () => {
  it('增效事件(gates_passed)提交前复核拒:只记 growthDenied,不 halt;被拒事件无转移 / 审计 / effect / 工作副本变化;后续减影响(排队到期)照跑', async () => {
    const w = world3({ phase: V1B });
    w.growth.hookDeny = 'taint_pending';
    const p = rec('proposed', { id: A, cluster_id: 'cl-a' });
    const wcA = wcFor(p);
    w.store.put(p);
    w.working.set(A, wcA);
    w.gateFacts.fn = async () => gateFactsNoBusy();
    const s = rec('shadow', { id: B, cluster_id: 'cl-b' });
    w.store.put(s);
    w.working.set(B, wcFor(s, '2026-10-11'));
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBeNull();
    expect(r.growthDenied).toEqual([{ op: 'candidate_create', code: 'taint_pending' }]);
    expect(w.store.records.get(A)?.lifecycle).toBe('proposed');
    expect(w.working.get(A)).toEqual(wcA);
    expect(w.store.records.get(B)?.lifecycle).toBe('expired');
    // 被拒事件没有审计 / effect(B 的到期是另一件事,只核对 A)
    expect(w.audits.filter((a) => a.id === A)).toEqual([]);
    expect(w.effects.filter((e) => JSON.stringify(e).includes(A))).toEqual([]);
  });

  it('减影响事件的提交返回 denied(底座违约)→ halted=commit_failed(既有的完整性失败类),不记 growthDenied;事件零落地', async () => {
    const w = world3({ phase: V1B });
    const s = rec('shadow', { id: B, cluster_id: 'cl-b' });
    w.store.put(s);
    w.working.set(B, wcFor(s, '2026-10-11'));
    w.store.failCommit = { status: 'denied', code: 'rogue' };
    const r = await runPersonalStep(w.d);
    expect(r.halted).toBe('commit_failed');
    expect(r.growthDenied).toEqual([]);
    expect(w.store.records.get(B)?.lifecycle).toBe('shadow');
    expect(w.audits).toEqual([]);
    expect(w.effects).toEqual([]);
    expect(w.working.get(B)?.shadow.queued_since).toBe('2026-10-11');
  });

  it('ApplyResult 里 denied 与 halt 是两个分支:applyEvent 的拒绝不是 halt(StepHalt 不含 growth_denied)', async () => {
    const w = world3({ phase: V1B });
    delete w.d.growth;
    const p = rec('proposed');
    w.store.put(p);
    const r = await applyEvent(w.d, p, E.gatesPassed());
    expect(r).toEqual({ kind: 'denied', why: 'unwired' });
    expect(r.kind).not.toBe('halt');
  });

  it('回滚路径:记录推进被 denied(底座违约)→ incomplete{retryable, record_denied:*};记录不动,不落入「推进成功」的正常路径', async () => {
    const w = world7();
    w.store.failCommit = { status: 'denied', code: 'rogue' };
    const r = await startRollback(w.d, harmReq());
    expect(r).toMatchObject({ status: 'incomplete', cause: 'retryable' });
    expect(JSON.stringify(r)).toContain('record_denied:rogue');
    expect(recordOf(w).lifecycle).toBe('canary');
    // 修复要保护的副作用:记录没推进 → 不得删仓库文件(`repo.remove` 未被调用,目标文件仍在)
    expect(w.calls).not.toContain('repo.remove');
    expect(w.repoFiles.size).toBe(1);
  });

  it('veto(减影响)遇到 denied → 退 3 internal(fail-closed),不当成成功;记录不动', async () => {
    const w7 = world7({ record: rec('shadow') });
    const fx = makeFx(w7);
    w7.store.failCommit = { status: 'denied', code: 'rogue' };
    const r = await runWrite('veto', [ID7], fx);
    expect(r.code).toBe(3);
    expect(r.err).toContain('RSI_FAIL_CLOSED reason=internal');
    expect(w7.store.records.get(ID7)?.lifecycle).toBe('shadow');
  });
});
