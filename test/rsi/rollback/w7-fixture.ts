/**
 * W7 测试夹具:回滚执行器的内存端口(与生产端口同一份契约:读失败 = 抛错 / invalid,写失败 = 抛错;journal 与凭据写入经真 schema 校验)。
 * **不调用被测执行器**;期望值由测试自己手写。崩溃注入:一次性,命中后清除,所以同一个 world 可以「进程死亡 → 重启续做」。
 */
import {
  PersonalTxnSchema,
  RsiRevocationLineSchema,
  type PersonalLifecycleRecord,
  type PersonalTxn,
  type RsiAuditLine,
  type RsiRevocationLine,
} from '../../../src/contracts/rsi-personal.js';
import type { StepEnv } from '../../../src/rsi/personal/candidate-ports.js';
import type { RollbackDeps, RollbackRequest } from '../../../src/rsi/personal/rollback.js';
import type {
  KeyedEffectResult,
  PayloadSyncResult,
  RepoRemovalResult,
  TxnStore,
} from '../../../src/rsi/personal/rollback-ports.js';
import type { TransitionEffect } from '../../../src/rsi/personal/transition.js';
import type { TransitionEvent } from '../../../src/rsi/personal/transition-table.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { MemStore } from '../personal/w3-fixture.js';
import { ID, SHA, rec } from '../personal/transition-fixture.js';

export { ID, SHA };
export const NOW = new Date('2026-11-10T12:00:00.000Z');
/** V1b 的相位序号(`RSI_AUTO_PHASE_ORDER`:V0=0, V1a=1, V1b=2) */
export const V1B = 2;
export const V1A = 1;

export class Crash extends Error {
  constructor(readonly step: string) {
    super(`injected crash at ${step}`);
  }
}

export const HARM: TransitionEvent = {
  kind: 'harm',
  evidence: 'analysis-v1:c1:look=1:t=0.500:p=0.0100:bound=0.0200',
  metric: 'c1',
  worse: true,
};

export const harmReq = (over: Partial<RollbackRequest> = {}): RollbackRequest => ({
  candidate_id: ID,
  content_sha256: SHA,
  kind: 'rollback',
  reason: 'harm_c1',
  by: 'worker',
  target_terminal: 'rolled_back',
  event: HARM,
  ...over,
});

/** canary 且 claude 已注入的候选 */
export const canaryRec = (over: Partial<PersonalLifecycleRecord> = {}): PersonalLifecycleRecord =>
  rec('canary', { deploy: { claude: 'injected', pi: 'none', codex: 'none' }, ...over });

export interface World7 {
  d: RollbackDeps;
  store: MemStore;
  txns: Map<string, PersonalTxn>;
  revs: RsiRevocationLine[];
  /** 全部端口调用与步骤点(按发生顺序) */
  calls: string[];
  audits: RsiAuditLine[];
  /** 每个键真正生效的次数(`applyOnce` 返回 `applied` 的次数) */
  effectApplied: Map<string, number>;
  effectLog: Map<string, TransitionEffect[]>;
  /** 审计行(键 `audit:*`)单独记账,不混进 `effectLog` / `effectApplied`(那两个只含终态业务效果的键) */
  auditApplied: Map<string, number>;
  auditLog: Map<string, RsiAuditLine[]>;
  /** 审计落地的模式(与 `keyedMode` 分开,`keyedMode` 只管终态效果):`lock_lost` = 抛丢锁错误 */
  auditMode: { value: 'applied' | 'throw' | 'lock_lost' };
  /** `deferralMark` 端口的调用记录(测试按需把 `d.deferralMark` 指向 `markDeferral`) */
  deferralMarks: string[];
  markDeferral: { mark(candidateId: string): Promise<void> };
  repoFiles: Set<string>;
  repoMode: { value: 'ok' | 'deferred' | 'invalid' | 'absent' };
  payload: {
    has: Set<string>;
    /** 撤销路径也清不掉的残留(模拟 syncRevoke 没能删净) */
    stuck: Set<string>;
    mode: 'done' | 'drift' | 'unavailable';
    revoked: string[][];
  };
  cache: { mode: 'cleaned' | 'pending'; failOnce: boolean };
  keyedMode: { value: KeyedEffectResult | 'throw' };
  env: StepEnv;
  crash: { step: string | null };
  /** 一次性崩溃:下一次命中该步骤点时抛 {@link Crash} */
  crashAt(step: string | null): void;
}

export function world7(
  over: { record?: PersonalLifecycleRecord | null; phase?: number } = {},
): World7 {
  const store = new MemStore();
  if (over.record !== null) store.put(over.record ?? canaryRec());
  const txns = new Map<string, PersonalTxn>();
  const revs: RsiRevocationLine[] = [];
  const calls: string[] = [];
  const audits: RsiAuditLine[] = [];
  const effectApplied = new Map<string, number>();
  const effectLog = new Map<string, TransitionEffect[]>();
  const auditApplied = new Map<string, number>();
  const auditLog = new Map<string, RsiAuditLine[]>();
  const auditMode: World7['auditMode'] = { value: 'applied' };
  const deferralMarks: string[] = [];
  const repoFiles = new Set<string>(['rules/ra_0123456789ab.md']);
  const repoMode: World7['repoMode'] = { value: 'ok' };
  const payload: World7['payload'] = {
    has: new Set(),
    stuck: new Set(),
    mode: 'done',
    revoked: [],
  };
  const cache: World7['cache'] = { mode: 'cleaned', failOnce: false };
  const keyedMode: World7['keyedMode'] = { value: 'applied' };
  const crash: World7['crash'] = { step: null };
  const env: StepEnv = {
    phase: over.phase ?? V1B,
    autoLoopEffective: true,
    autoPaused: false,
    marks: { enabled: true, paused: false, policyFp: 'p', resetGen: 0 },
  };

  const txnStore: TxnStore = {
    async read(id) {
      const t = txns.get(id);
      return t === undefined ? { kind: 'absent' } : { kind: 'ok', value: structuredClone(t) };
    },
    async write(t) {
      calls.push(`txn.write:${t.phase}`);
      txns.set(t.txn_id, PersonalTxnSchema.parse(t));
    },
    async remove(id) {
      calls.push('txn.remove');
      txns.delete(id);
    },
    async list() {
      return [...txns.keys()].sort();
    },
  };

  const w: World7 = {
    store,
    txns,
    revs,
    calls,
    audits,
    effectApplied,
    effectLog,
    auditApplied,
    auditLog,
    auditMode,
    deferralMarks,
    markDeferral: { mark: async (id) => void deferralMarks.push(id) },
    repoFiles,
    repoMode,
    payload,
    cache,
    keyedMode,
    env,
    crash,
    crashAt: (s) => void (crash.step = s),
    d: undefined as unknown as RollbackDeps,
  };
  w.d = {
    store,
    working: { list: async () => [], put: async () => undefined },
    revocations: { read: async () => ({ kind: 'ok', lines: [...revs] }) },
    audit: { append: async (l) => void audits.push(...l) },
    effects: { apply: async () => undefined },
    env: { read: async () => env },
    now: () => NOW,
    locks: { personal: { assertHeld: async () => undefined } },
    txns: txnStore,
    revoker: {
      async write(line) {
        calls.push('revoke.write');
        const p = RsiRevocationLineSchema.parse(line);
        if (
          revs.some(
            (l) => l.candidate_id === p.candidate_id && l.content_sha256 === p.content_sha256,
          )
        ) {
          return 'already_present';
        }
        revs.push(p);
        return 'written';
      },
    },
    cache: {
      async clean() {
        calls.push('cache.clean');
        if (cache.failOnce) {
          cache.failOnce = false;
          throw new Error('cache down');
        }
        return cache.mode;
      },
    },
    repo: {
      async remove(c): Promise<RepoRemovalResult> {
        calls.push('repo.remove');
        if (repoMode.value === 'deferred') return { status: 'deferred', why: 'worktree_dirty' };
        if (repoMode.value === 'invalid') return { status: 'invalid', why: 'git_read_failed' };
        if (repoMode.value === 'absent') return { status: 'absent' };
        const present = c.target_paths.filter((p) => repoFiles.has(p));
        for (const p of present) repoFiles.delete(p);
        return { status: present.length === 0 ? 'already' : 'committed' };
      },
    },
    payload: {
      async revoke(ids): Promise<PayloadSyncResult> {
        calls.push('payload.revoke');
        payload.revoked.push([...ids]);
        if (payload.mode === 'drift') return { status: 'drift', why: 'user_edited' };
        if (payload.mode === 'unavailable') return { status: 'unavailable', why: 'x' };
        for (const i of ids) if (!payload.stuck.has(i)) payload.has.delete(i);
        return { status: 'done' };
      },
      async absent(id) {
        return !payload.has.has(id);
      },
    },
    keyedEffects: {
      async applyOnce(key, effects): Promise<KeyedEffectResult> {
        if (key.startsWith('audit:')) {
          calls.push('audit.applyOnce');
          if (auditMode.value === 'throw') throw new Error('audit down');
          if (auditMode.value === 'lock_lost') throw new RsiLockError('lock_lost');
          if (auditLog.has(key)) return 'already';
          const lines = effects.flatMap((e) => (e.type === 'append_audit' ? [e.line] : []));
          auditLog.set(key, lines);
          audits.push(...lines);
          auditApplied.set(key, (auditApplied.get(key) ?? 0) + 1);
          return 'applied';
        }
        calls.push('effects.applyOnce');
        if (keyedMode.value === 'throw') throw new Error('effects down');
        if (keyedMode.value === 'deferred') return 'deferred';
        if (effectLog.has(key)) return 'already';
        effectLog.set(key, [...effects]);
        effectApplied.set(key, (effectApplied.get(key) ?? 0) + 1);
        return 'applied';
      },
    },
    onStep: async (s) => {
      calls.push(`step:${s}`);
      if (crash.step === s) {
        crash.step = null;
        throw new Crash(s);
      }
    },
  };
  return w;
}

/** 权威记录(必在) */
export function recordOf(w: World7, id = ID): PersonalLifecycleRecord {
  const r = w.store.records.get(id);
  if (r === undefined) throw new Error('record missing');
  return r;
}
