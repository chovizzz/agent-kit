/**
 * §21 V1 装配块 C2——个人步 S1 / S2 / 压缩 / 污染扫描的**生产适配器**(照 `assemble-write.ts`:本文件是拿真实写出口的装配层;`personal/steps/*` 的纯编排经端口注入它)。
 * 只被 `assemble-worker.ts` import;S0 的工具箱由 assemble-worker 注入(`PersonalToolkit`,避免与它循环 import)。
 *
 * 惰性 / 边界:
 *  - 工厂求值零 IO;端口方法被调用时才有 I/O(`kit` 惰性构造:存储核、仓库依赖、回滚依赖);
 *  - **写端口只在最外层包装**(`round.writeAdapter`):每个对外端口方法各一个包装;包装内部调用的叶子端口(工作副本、审计、凭据写、journal)**不再包装**(写适配器单飞:嵌套 = `internal`);
 *  - 个人锁:端口收**被包装的句柄**(`wrapPersonalLock`:丢失转型为 `PersonalLockLost`,不会被 worker 映射成 UNRECORDABLE);存储核要的 `LockCap` 是对原始句柄的委托壳(`assertHeld` 同样转型);
 *  - 不装配任何增影响能力(没有 `grantCanary`、`runPersonalStep`、建仓、创建提交):`openPersonalRepo` **只**经 `steps/repo-recover.ts` 的 bootstrap 守卫调用,`bootstrap` 选项恒不传;
 *  - 不装配的事实源(不臆测,只少一道熔断 / 只少一项展示):`budget_high_legacy` / `cost_high_legacy` / `redaction_changed` / 上线代理事件日;`rollback_stalled` / `protection_marks`(D 的 auto-view 写者消费)。
 */
import * as path from 'node:path';
import { KIT_VERSION } from '../contracts/meta.js';
import {
  CandidateWorkingCopySchema,
  type CandidateWorkingCopy,
  type PersonalLifecycleRecord,
} from '../contracts/rsi-personal.js';
import { RSI_DIR_MODE, RSI_MAX_SESSIONS_PER_ARM, RsiCountsSchema } from '../contracts/rsi.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readDir, readFileSafe, statDirSafe } from '../io/read-fs.js';
import { mkdirp } from '../io/safe-fs.js';
import { makeAnalysisSource } from './analysis/read.js';
import { runAnalysis, type AnalysisOutcome } from './analysis/run.js';
import { makeAnalysisReadPorts } from './analysis/source-ports.js';
import { isAutoLoopEffective, resolveAutoConfig } from './auto-config.js';
import { writeRsiFileAtomic } from './canary/atomic-write.js';
import { reconcileCaches } from './canary/canary-reconcile.js';
import { CANARY_FILES } from './canary/files.js';
import { readCanaryDoc } from './canary/permit-read.js';
import { RsiLockError } from './lock-error.js';
import type { RsiLockHandle } from './lock.js';
import { RSI_DIR_OWNER, RSI_FILE_OWNER, rsiDirReadonly } from './lock-read.js';
import {
  autoRelease,
  applyAutoRelease,
  evaluateTriggers,
  noObservation,
  type AutoPauseState,
  type BreakerDeps,
  type TriggerFacts,
} from './personal/breaker.js';
import type { EnvReader, StepEnv, WorkingStore } from './personal/candidate-ports.js';
import { personalRepoStore } from './personal/candidate-repo.js';
import { openPersonalRepo, type PersonalLocks, type PersonalRepoDeps } from './personal/commit.js';
import { newLayerRecorder } from './personal/effects-layers.js';
import { legacyKeyedEffects } from './personal/effects-adapter.js';
import { keyedAuditSink, recoverTerminalEffects } from './personal/effects-recover.js';
import { isSealedInterval, type EntrySeal } from './personal/entry-stamp.js';
import { onAnalysisOutcome } from './personal/harm-chain.js';
import { ownerRepoFingerprint, personalHome, readJournal } from './personal/home-state.js';
import type { JudgeReduceSlot } from './personal/judge-slot.js';
import type { PersonalLockHandle } from './personal/personal-lock.js';
import {
  expireShadowQueues,
  makeStepRunner,
  reconcileRevocationLines,
  type ReconcileOut,
  type RunnerOut,
} from './personal/reduce-step.js';
import { writeRevocationDetailed } from './personal/revoke-write.js';
import {
  homeRevocationReader,
  homeRevocationWriter,
  homeTxnStore,
  v1PayloadSync,
  type CacheCleanup,
} from './personal/rollback-ports.js';
import { personalRepoRemoval, recordedShaReader } from './personal/rollback-repo.js';
import {
  resumeAll,
  startRollback,
  type RollbackDeps,
  type RollbackOutcome,
  type RollbackRequest,
} from './personal/rollback.js';
import { PersonalLockLost, isRsiLockLost } from './personal/stage/errors.js';
import { muteDown, tripAndMuteGuarded, type MuteLadderPorts } from './personal/stage/ladder.js';
import { wrapPersonalLock } from './personal/stage/lock-identity.js';
import type {
  EnforceResult,
  MutedVerdict,
  RecoveryPort,
  ReducePort,
  SafetyPort,
  StepOutcome,
  Compactor,
} from './personal/stage/ports.js';
import type { BothRound, RsiOnlyRound } from './personal/stage/round.js';
import type { RoundBudget } from './personal/stage/settle.js';
import type { TaintCandidate } from './personal/stage/taint-types.js';
import type { PersonalCtx, RsiOnlyTripReason, TripReason } from './personal/stage/types.js';
import { utcDay, canaryDays } from './personal/transition-table.js';
import {
  createRepoRecovery,
  type JournalKind,
  type OpenOutcome,
} from './personal/steps/repo-recover.js';
import type { BothPorts } from './personal/steps/run-steps.js';
import { HALT_PREFIX } from './personal/steps/s1-recover.js';
import {
  type CandidateListing,
  type CandidateSource,
  type ExcludeRescan,
  type PurgeJournalFacts,
  type RunTaintState,
  type StagingBound,
  type TaintFactsPort,
} from './personal/steps/steps-types.js';
import { createTaintScanner } from './personal/steps/taint-scan.js';
import { classifierFor, readRsiFixed } from './services/attribution.js';
import { readPurgeJournal } from './services/purge-journal.js';
import { isStagingId, listStaging, probeStagingDir, readMark } from './services/staging.js';
import { taintNewlyExcludedWith } from './services/taint.js';
import { parseRsiStateDoc } from './state.js';
import { compactorOf } from './store/compactor.js';
import { safeStoreFs } from './store/fs-port.js';
import type { LockCap } from './store/ports.js';
import { assembleRsiStore, type RsiStore } from './store/store.js';
import { RsiFailClosedError, type RsiServiceCtx } from './types.js';

// ---------------------------------------------------------------------------
// 注入的 S0 工具箱 / 配置
// ---------------------------------------------------------------------------
export interface RsiRef {
  readonly sctx: RsiServiceCtx;
  readonly lock: PersonalCtx['lock'];
  readonly now: () => Date;
}
/** assemble-worker 的 S0 实现(阶梯端口 / 熔断依赖 / 完整阶梯),本文件复用同一份,不复制算法 */
export interface PersonalToolkit {
  breakerDeps(c: RsiRef, phase: number): BreakerDeps;
  ladderPorts(c: RsiRef): MuteLadderPorts;
  enforce(c: RsiRef, phase: number): Promise<EnforceResult>;
}
export interface StepsAssemblyDeps {
  readonly phase: number;
  readonly toolkit: PersonalToolkit;
  /** 本轮取到的**原始**个人锁句柄(取锁闭包捕获;`HeldPersonal` 包装不外泄) */
  rawPersonal(): PersonalLockHandle | null;
  /** W9b 注入点(缺省:空操作并报告 unavailable,与 `UNAVAILABLE_JUDGE.reduce` 同语义) */
  readonly judge?: JudgeReduceSlot;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
class TaintApplyFailed extends Error {
  override readonly name = 'TaintApplyFailed';
}
const isLockish = (e: unknown): boolean =>
  isRsiLockLost(e) || e instanceof PersonalLockLost || e instanceof RsiLockError;

async function rsiDirOf(io: IoContext): Promise<string | null> {
  const r = await rsiDirReadonly(io);
  if (r.kind === 'ok') return r.dir;
  if (r.kind === 'missing') return null;
  throw new RsiLockError('state_dir_unsafe');
}
async function needRsiDir(io: IoContext): Promise<string> {
  const d = await rsiDirOf(io);
  if (d === null) throw new RsiLockError('state_dir_unsafe');
  return d;
}
async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
const homeOf = (io: IoContext): string => {
  const home = io.hostEnv['HOME'];
  if (home === undefined || !path.isAbsolute(home)) throw new RsiLockError('internal');
  return home;
};
const haltOutcome = (h: string): StepOutcome => ({ kind: 'incomplete', why: `${HALT_PREFIX}${h}` });
const isoZ = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;

function outcomeOfRollback(o: RollbackOutcome): StepOutcome {
  if (o.status === 'complete' || o.status === 'revocation_complete') return { kind: 'done' };
  const cause = 'cause' in o ? o.cause : 'unknown';
  return { kind: 'incomplete', why: `rollback_${o.status}:${cause}` };
}

/** worker 传入的真实 rsi 锁句柄(`HeldRsi` 只声明了 nonce / assertHeld;taint 续做要完整句柄):不是完整句柄 = fail-closed */
function fullRsiHandle(lock: PersonalCtx['lock']): RsiLockHandle {
  const h = lock as Partial<RsiLockHandle>;
  if (typeof h.path !== 'string' || typeof h.release !== 'function') {
    throw new RsiFailClosedError('internal');
  }
  return lock as RsiLockHandle;
}

const COPY_NAME = /^(ra_[0-9a-f]{12})\.json$/;

// ---------------------------------------------------------------------------
// 工作副本 / 环境(生产适配器;D1b 要求 C2 先合)
// ---------------------------------------------------------------------------
/** `.state/rsi/candidates/<id>.json` 的读写(持 rsi 锁;strict schema,不合规整体抛错 = fail-closed,不跳过坏副本) */
export function makeWorkingStore(
  io: IoContext,
  held: { assertHeld(): Promise<void> },
  rsiDir: string,
): WorkingStore {
  const dir = path.join(rsiDir, 'candidates');
  return {
    async list(): Promise<CandidateWorkingCopy[]> {
      const st = await statDirSafe(dir, { owner: RSI_DIR_OWNER });
      if (st.kind === 'missing') return [];
      if (st.kind === 'unsafe') throw new RsiLockError('state_dir_unsafe');
      const out: CandidateWorkingCopy[] = [];
      for (const e of await readDir(dir)) {
        if (!COPY_NAME.test(e.name) || !e.isFile || e.isSymbolicLink) continue;
        const r = await readFileSafe(path.join(dir, e.name), {
          maxBytes: 64 * 1024,
          owner: RSI_FILE_OWNER,
        });
        if (r.kind !== 'ok') throw new RsiFailClosedError('state_dir_unsafe');
        const p = CandidateWorkingCopySchema.parse(JSON.parse(r.bytes.toString('utf8')));
        if (`${p.id}.json` !== e.name) throw new RsiFailClosedError('internal');
        out.push(p);
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async put(copy: CandidateWorkingCopy): Promise<void> {
      const p = CandidateWorkingCopySchema.parse(copy); // 整份合法才写
      await held.assertHeld();
      await mkdirp(io, dir, RSI_DIR_MODE);
      await writeRsiFileAtomic(io, dir, `${p.id}.json`, `${JSON.stringify(p)}\n`, [held]);
    },
  };
}

type PauseFacts =
  { readonly kind: 'ok'; readonly paused: boolean } | { readonly kind: 'unreadable' };
async function readPauseFacts(io: IoContext): Promise<PauseFacts> {
  let paused = false;
  try {
    const r = await readRsiFixed(io, 'state.json');
    if (r.kind === 'ok') {
      const doc = parseRsiStateDoc(r.bytes);
      if (doc.kind !== 'ok') return { kind: 'unreadable' };
      const ap = doc.state.auto_pause;
      paused = ap !== undefined && (ap.reasons.length > 0 || ap.diverged || ap.owner_changed);
    }
    const d = await rsiDirOf(io);
    if (d !== null) {
      paused =
        paused ||
        (await present(path.join(d, CANARY_FILES.pause))) ||
        (await present(path.join(d, CANARY_FILES.pauseBreaker)));
    }
  } catch {
    return { kind: 'unreadable' };
  }
  return { kind: 'ok', paused };
}

/** 步骤的环境事实:相位、自动环是否生效、是否暂停(读不出 = 按暂停);`marks` 只服务 D 的 `runPersonalStep`,C2 给常量 */
export function makeEnvReader(c: RsiRef, phase: number): EnvReader {
  return {
    async read(): Promise<StepEnv> {
      const effective = isAutoLoopEffective(true, resolveAutoConfig(c.sctx.config), phase);
      const p = await readPauseFacts(c.sctx.io);
      const paused = p.kind === 'ok' ? p.paused : true;
      return {
        phase,
        autoLoopEffective: effective,
        autoPaused: paused,
        marks: { enabled: effective, paused, policyFp: '', resetGen: 0 },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 污染事实端口(只读;purge journal 只经 `readPurgeJournal`——D3 扩 schema 后不会读崩)
// ---------------------------------------------------------------------------
export function makeTaintFacts(io: IoContext): TaintFactsPort {
  return {
    async journal(): Promise<PurgeJournalFacts> {
      const j = await readPurgeJournal(io);
      if (j.state === 'present') return { kind: 'ok', runs: j.journal.taint_targets.runs };
      return { kind: j.state };
    },
    async runState(runId: string): Promise<RunTaintState> {
      try {
        if (!isStagingId(runId, 'run')) return 'unreadable';
        if ((await probeStagingDir(io, 'run', runId)) === 'missing') return 'missing';
        return (await readMark(io, 'run', runId)).present ? 'tainted' : 'clean';
      } catch {
        return 'unreadable';
      }
    },
    async stagingBound(): Promise<StagingBound> {
      try {
        await listStaging(io, 'promote');
        await listStaging(io, 'run');
        return 'ok';
      } catch (e) {
        if (e instanceof RsiFailClosedError && e.reason === 'staging_too_large') return 'too_large';
        return 'untrusted';
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SafetyPort(S2R / T_rsi / 扫尾;只需 rsi 锁;持两锁与忙 / 故障回合共用)
// ---------------------------------------------------------------------------
export function makeSafetyPort(
  c: RsiRef,
  deps: Pick<StepsAssemblyDeps, 'phase' | 'toolkit'>,
  round: BothRound | RsiOnlyRound,
): SafetyPort {
  const io = c.sctx.io;
  const bd = (): BreakerDeps => deps.toolkit.breakerDeps(c, deps.phase);
  const ladder = (): MuteLadderPorts => deps.toolkit.ladderPorts(c);
  const revs = () => homeRevocationReader(personalHome(io, homeOf(io)));

  const enforceMute = round.writeAdapter('safety_mute', (): Promise<EnforceResult> =>
    deps.toolkit.enforce(c, deps.phase),
  );
  const reconcile = round.writeAdapter('safety_mute', async (): Promise<StepOutcome> => {
    const rv = await revs().read();
    if (rv.kind !== 'ok') return haltOutcome('revocations_invalid');
    if (rv.lines.length === 0) return { kind: 'done' };
    await reconcileCaches(
      { io, rsiDir: await needRsiDir(io), locks: { rsi: c.lock } },
      rv.lines,
      c.now(),
    );
    return { kind: 'done' };
  });
  const trip = round.writeAdapter('trip', (reasons: readonly RsiOnlyTripReason[]) =>
    tripAndMuteGuarded(bd(), ladder(), reasons),
  );
  const stop = round.writeAdapter('safety_mute', () => muteDown(ladder()));

  return {
    enforceMute: () => enforceMute(),
    reconcileCaches: () => reconcile(),
    async verifyMuted(): Promise<MutedVerdict> {
      try {
        const p = await readPauseFacts(io);
        if (p.kind !== 'ok') return { ok: false, why: 'unreadable' };
        const dir = await rsiDirOf(io);
        if (dir === null) return { ok: true };
        const cd = await readCanaryDoc(dir);
        if (cd.kind === 'unreadable') return { ok: false, why: 'unreadable' };
        if (cd.kind !== 'ok') return { ok: true };
        if (p.paused && cd.value.agents_inject.length > 0) {
          return { ok: false, why: 'inject_present_while_paused' };
        }
        const rv = await revs().read();
        if (rv.kind !== 'ok') return { ok: false, why: 'unreadable' };
        const listed = rv.lines.some(
          (l) =>
            l.candidate_id === cd.value.candidate_id &&
            l.content_sha256 === cd.value.content_sha256,
        );
        return listed ? { ok: false, why: 'credential_entry_present' } : { ok: true };
      } catch (e) {
        if (isLockish(e)) throw e;
        return { ok: false, why: 'unreadable' };
      }
    },
    async evaluateRsiTriggers(): Promise<readonly RsiOnlyTripReason[]> {
      const out: RsiOnlyTripReason[] = [];
      const r = await readRsiFixed(io, 'state.json');
      if (r.kind !== 'ok') return out;
      const doc = parseRsiStateDoc(r.bytes);
      if (doc.kind !== 'ok') return out;
      // kit_major_changed:确认记录的 kit 主版本与当前不同(确认记录缺失 = 没有「已确认」可比)
      const major = Number.parseInt(KIT_VERSION.split('.')[0] ?? '', 10);
      const conf = doc.state.confirm;
      if (conf !== null && Number.isInteger(major) && conf.kit_major !== major) {
        out.push('kit_major_changed');
      }
      const facts = await observationFacts(io, doc.state, c.now());
      if (facts !== null && noObservation(facts)) out.push('no_observation');
      return out;
    },
    tripAndMute: (reasons) => trip(reasons),
    stopExistingInjection: () => stop(),
  };
}

/** `no_observation` 的事实:最近一个有信号的 UTC 日(counts.json 的 `signals_by_day`);counts 读不出 = `null`(不评估,不臆测) */
async function observationFacts(
  io: IoContext,
  state: { last_tick: unknown },
  now: Date,
): Promise<Pick<TriggerFacts, 'today' | 'lastObservedDay' | 'l0HasRuns'> | null> {
  try {
    const r = await readRsiFixed(io, 'counts.json');
    if (r.kind !== 'ok') return null;
    const p = RsiCountsSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
    if (!p.success) return null;
    let last: string | null = null;
    for (const k of Object.values(p.data.per_key)) {
      for (const day of Object.keys(k.signals_by_day)) if (last === null || day > last) last = day;
    }
    return {
      today: utcDay(now.toISOString()),
      lastObservedDay: last,
      l0HasRuns: state.last_tick !== null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 持两锁的端口束
// ---------------------------------------------------------------------------
interface Kit {
  readonly rd: RollbackDeps;
  readonly auth: ReturnType<typeof personalRepoStore>;
  readonly repoDeps: PersonalRepoDeps;
  readonly locks: PersonalLocks;
  readonly store: RsiStore;
  readonly working: WorkingStore;
  readonly h: ReturnType<typeof personalHome>;
  readonly rsiDir: string;
  readonly revoke: (
    line: Parameters<ReturnType<typeof homeRevocationWriter>['write']>[0],
  ) => ReturnType<typeof writeRevocationDetailed>;
}

const memo = <T>(f: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
};

export function makeBothPorts(
  ctx: PersonalCtx,
  round: BothRound,
  budget: RoundBudget,
  deps: StepsAssemblyDeps,
): BothPorts {
  const c: RsiRef = { sctx: ctx.sctx, lock: ctx.lock, now: ctx.now };
  const io = ctx.sctx.io;
  const phase = deps.phase;

  const kit = memo(async (): Promise<Kit> => {
    const raw = deps.rawPersonal();
    if (raw === null) throw new RsiLockError('internal');
    const held = wrapPersonalLock(raw);
    const rsiDir = await needRsiDir(io);
    const h = personalHome(io, homeOf(io));
    const repoDeps: PersonalRepoDeps = {
      h,
      ownerRepoFp: await ownerRepoFingerprint(ctx.sctx.config.repo),
      now: ctx.now,
    };
    const locks: PersonalLocks = { personal: held, rsi: ctx.lock };
    // 存储核要真实 LockCap:个人锁用委托壳(assertHeld 转型成 PersonalLockLost;其余成员委托原始句柄)
    const personalCap: LockCap = {
      assertHeld: () => held.assertHeld(),
      release: () => raw.release(),
      ...(raw.path !== undefined ? { path: raw.path } : {}),
      ...(raw.kind !== undefined ? { kind: raw.kind } : {}),
      ...(raw.attachReleaseGate !== undefined
        ? { attachReleaseGate: raw.attachReleaseGate.bind(raw) }
        : {}),
      ...(raw.canAttachReleaseGate !== undefined
        ? { canAttachReleaseGate: raw.canAttachReleaseGate.bind(raw) }
        : {}),
    };
    const store = assembleRsiStore({
      fs: safeStoreFs(io, rsiDir),
      rsi: ctx.lock as unknown as LockCap,
      personal: personalCap,
      clock: ctx.now,
    });
    const auth = personalRepoStore(repoDeps, locks);
    const layers = newLayerRecorder();
    const keyedEffects = legacyKeyedEffects({
      sink: store.sink,
      userVeto: store.userVeto,
      store: auth,
      recorder: layers,
    });
    const revocations = homeRevocationReader(h);
    const working = makeWorkingStore(io, ctx.lock, rsiDir);
    const cache: CacheCleanup = {
      async clean(x) {
        const rv = await revocations.read();
        if (rv.kind !== 'ok') throw new Error('cache_cleanup: revocations_unreadable');
        const line = rv.lines.find(
          (l) => l.candidate_id === x.candidate_id && l.content_sha256 === x.content_sha256,
        );
        if (line === undefined) throw new Error('cache_cleanup: revocation_missing');
        await reconcileCaches({ io, rsiDir, locks: { rsi: ctx.lock } }, [line], ctx.now());
        return 'cleaned';
      },
    };
    const seal: EntrySeal = {
      open: async () => {
        const region = await store.seal.open(personalCap);
        return {
          stampFirst: (now) => {
            try {
              return region.stampFirst(now);
            } catch (e) {
              if (isSealedInterval(e)) layers.sealed({ cause: 'sealed_interval' });
              throw e;
            }
          },
          markSourceCommitted: () => region.markSourceCommitted(),
          close: () => region.close(),
        };
      },
    };
    const rd: RollbackDeps = {
      store: auth,
      working,
      revocations,
      audit: keyedAuditSink(keyedEffects),
      effects: { apply: async () => undefined },
      env: makeEnvReader(c, phase),
      now: ctx.now,
      locks: { personal: held },
      txns: homeTxnStore(h),
      revoker: homeRevocationWriter(h, () => held.assertHeld()),
      cache,
      repo: personalRepoRemoval(repoDeps, locks),
      payload: v1PayloadSync(phase),
      keyedEffects,
      recordedSha: recordedShaReader(repoDeps, locks),
      seal,
    };
    return {
      rd,
      auth,
      repoDeps,
      locks,
      store,
      working,
      h,
      rsiDir,
      revoke: (line) => writeRevocationDetailed(h, () => held.assertHeld(), line),
    };
  });

  const rollback = async (k: Kit, req: RollbackRequest): Promise<RollbackOutcome> => {
    budget.charge('startRollback');
    return startRollback(k.rd, req);
  };
  const safety = makeSafetyPort(c, deps, round);

  // ---------- S1 ----------
  const recoverRepo = round.writeAdapter(
    'candidate_record',
    createRepoRecovery({
      async journalKind(): Promise<JournalKind> {
        const k = await kit();
        const j = await readJournal(k.h);
        if (j.kind === 'invalid') return 'invalid';
        if (j.kind === 'absent') return 'none';
        return j.value.kind === 'bootstrap' ? 'bootstrap' : 'other';
      },
      async open(): Promise<OpenOutcome> {
        const k = await kit();
        // 只在 bootstrap 守卫放行后才会走到这里;`bootstrap` 选项恒不传(私有仓库一律 absent)
        const r = await openPersonalRepo(k.repoDeps, k.locks, {});
        switch (r.kind) {
          case 'ready':
            return { kind: 'ready' };
          case 'absent':
            return { kind: 'absent' };
          case 'deferred':
            return { kind: 'deferred', reason: r.reason };
          case 'invalid':
            return { kind: 'invalid', why: r.why };
        }
      },
    }),
  );
  const setFlags = round.writeAdapter(
    'state_pause_flag',
    async (f: { diverged?: boolean; owner_changed?: boolean }): Promise<StepOutcome> => {
      const d = deps.toolkit.breakerDeps(c, phase);
      let failure: unknown = null;
      try {
        const cur = await d.state.read();
        const next: AutoPauseState = {
          ...cur,
          diverged: f.diverged ?? cur.diverged,
          owner_changed: f.owner_changed ?? cur.owner_changed,
        };
        if (next.diverged !== cur.diverged || next.owner_changed !== cur.owner_changed) {
          await d.state.write(next);
        }
      } catch (e) {
        if (isRsiLockLost(e)) throw e;
        failure = e;
      }
      // 写标志之后立即静音(state 写失败也静音;宁可多停);静音失败不挡后续
      const mute = await muteDown(deps.toolkit.ladderPorts(c));
      if (failure !== null) return { kind: 'failed', why: 'state_write' };
      return mute === 'unreliable' ? { kind: 'failed', why: 'mute_unreliable' } : { kind: 'done' };
    },
  );
  const resume = round.writeAdapter('rollback_transition', async (): Promise<StepOutcome> => {
    const k = await kit();
    const outs = await resumeAll(k.rd);
    for (const o of outs) {
      const s = outcomeOfRollback(o);
      if (s.kind !== 'done') return s;
    }
    return { kind: 'done' };
  });
  const effects = round.writeAdapter('effects', async (): Promise<StepOutcome> => {
    const k = await kit();
    const r = await recoverTerminalEffects({ store: k.auth, effects: k.rd.keyedEffects });
    // 私有仓库还没建(首次,生产常态)= 没有终态可补;读不出 / 被延期 = 未完成
    if (r.skipped === 'absent') return { kind: 'done' };
    if (r.skipped !== null) return { kind: 'incomplete', why: `effects_skipped:${r.skipped}` };
    if (r.failed.length > 0) return { kind: 'incomplete', why: 'effects_failed' };
    if (r.deferred.length > 0) return { kind: 'incomplete', why: 'effects_deferred' };
    return { kind: 'done' };
  });
  /** canary 级凭据对账:凭据命中 canary 记录且无 journal → 启动 reconcile 回滚;终止事件不可由原因重建的(harm / judge / 到期类)→ 人工 */
  const reconcileCanary = round.writeAdapter(
    'rollback_transition',
    async (): Promise<StepOutcome> => {
      const k = await kit();
      const rv = await k.rd.revocations.read();
      if (rv.kind !== 'ok') return haltOutcome('revocations_invalid');
      const all = await k.auth.readAll();
      if (all.kind === 'absent') return { kind: 'skipped', why: 'repo_absent' };
      if (all.kind === 'deferred') return { kind: 'skipped', why: 'repo_deferred' };
      if (all.kind === 'invalid') return haltOutcome('repo_invalid');
      let unmappable = false;
      for (const line of rv.lines) {
        const rec = all.value.find(
          (r) => r.id === line.candidate_id && r.content_sha256 === line.content_sha256,
        );
        if (rec === undefined || rec.lifecycle !== 'canary') continue;
        if (line.reason !== 'vetoed' && line.reason !== 'tainted' && line.reason !== 'cleared') {
          unmappable = true;
          continue;
        }
        const o = outcomeOfRollback(
          await rollback(k, {
            candidate_id: rec.id,
            content_sha256: rec.content_sha256,
            kind: 'reconcile',
            reason: line.reason,
            by: line.by,
            target_terminal: 'rolled_back',
          }),
        );
        if (o.kind !== 'done') return o;
      }
      return unmappable ? { kind: 'incomplete', why: 'credential_unmappable' } : { kind: 'done' };
    },
  );

  const recovery: RecoveryPort = {
    recoverRepo: () => recoverRepo(),
    setFlagAndMute: (f) => setFlags(f),
    resumeRollbacks: () => resume(),
    recoverTerminalEffects: () => effects(),
    reconcileRevocations: () => reconcileCanary(),
  };

  // ---------- S2P ----------
  const applyTaint = round.writeAdapter(
    'revocation',
    async (tainted: readonly TaintCandidate[]): Promise<StepOutcome> => {
      const k = await kit();
      let conflict = false;
      const failed: string[] = [];
      for (const t of tainted) {
        try {
          if (t.lifecycle === 'canary') {
            // canary 不另写凭据:`startRollback` 自己按 journal → 凭据 → 记录的顺序写(无「凭据已落、journal 未建」窗口)
            const o = outcomeOfRollback(
              await rollback(k, {
                candidate_id: t.id,
                content_sha256: t.content_sha256,
                kind: 'rollback',
                reason: 'tainted',
                by: 'worker',
                target_terminal: 'rolled_back',
                event: { kind: 'taint', evidence: `taint:${t.id}` },
              }),
            );
            if (o.kind !== 'done') failed.push(t.id);
          } else if (t.lifecycle === 'proposed' || t.lifecycle === 'shadow') {
            // 凭据先于转移;已有凭据必须回读:同来源(worker / tainted)才是幂等,其余 = 冲突(不覆盖、不追加)
            const w = await k.revoke({
              at: isoZ(ctx.now()),
              candidate_id: t.id,
              content_sha256: t.content_sha256,
              identity12: null,
              reason: 'tainted',
              by: 'worker',
            });
            if (
              w.kind === 'already' &&
              !(w.existing.by === 'worker' && w.existing.reason === 'tainted')
            ) {
              conflict = true;
            }
          }
        } catch (e) {
          if (isLockish(e)) throw e;
          failed.push(t.id);
        }
      }
      // 凭据 / 回滚写失败 = 写结果不可判定:抛出(写适配器据此使本轮 unsettled;下轮幂等重试)
      if (failed.length > 0) throw new TaintApplyFailed(failed.join(','));
      return conflict ? { kind: 'incomplete', why: 'taint_credential_conflict' } : { kind: 'done' };
    },
  );

  const classifierOf = memo(() => classifierFor(io, ctx.sctx.config));

  const runAnalysisStep = round.writeAdapter(
    'rollback_transition',
    async (): Promise<StepOutcome> => {
      const k = await kit();
      const all = await k.auth.readAll();
      if (all.kind !== 'ok') return { kind: 'skipped', why: `repo_${all.kind}` };
      const canary = all.value.filter((r) => r.lifecycle === 'canary');
      if (canary.length === 0) return { kind: 'done' };
      const wcs = new Map((await k.working.list()).map((w) => [w.id, w]));
      const source = makeAnalysisSource({
        io,
        rsiDir: k.rsiDir,
        ...makeAnalysisReadPorts({
          home: homeOf(io),
          rsiDir: k.rsiDir,
          classify: async (key) => (await classifierOf())(key),
          readState: async () => {
            const r = await readRsiFixed(io, 'state.json');
            return r.kind === 'ok' ? r.bytes : null;
          },
        }),
      });
      let out: StepOutcome = { kind: 'done' };
      for (const rec of canary) {
        const sig = rec.cluster_signature ?? wcs.get(rec.id)?.cluster_signature;
        const start = canaryStartOf(rec);
        if (sig === undefined || start === null) {
          out = { kind: 'incomplete', why: 'analysis_input_missing' };
          continue;
        }
        const o: AnalysisOutcome = await runAnalysis(source, {
          candidateId: rec.id,
          signature: sig,
          windowStartIso: start,
        });
        if (o.kind === 'unavailable' || o.kind === 'paused') continue; // 不判、不转移
        if (o.kind === 'harm') {
          budget.charge('startRollback');
          const r = await onAnalysisOutcome(k.rd, o, rec);
          if (r.kind === 'rolled') {
            const s = outcomeOfRollback(r.outcome);
            if (s.kind !== 'done') out = s;
          }
        } else if (o.analysis.max_arm_sessions >= RSI_MAX_SESSIONS_PER_ARM) {
          const s = outcomeOfRollback(await limitRollback(k, rec, o.analysis.max_arm_sessions));
          if (s.kind !== 'done') out = s;
        }
      }
      return out;
    },
  );

  const limitRollback = async (
    k: Kit,
    rec: PersonalLifecycleRecord,
    maxArm: number,
  ): Promise<RollbackOutcome> =>
    rollback(k, {
      candidate_id: rec.id,
      content_sha256: rec.content_sha256,
      kind: 'rollback',
      reason: 'limit_reached',
      by: 'worker',
      target_terminal: 'expired',
      event: { kind: 'canary_limit', evidence: `limit:${rec.id}`, max_arm_sessions: maxArm },
    });

  const expire = round.writeAdapter('rollback_transition', async (): Promise<StepOutcome> => {
    const k = await kit();
    const all = await k.auth.readAll();
    if (all.kind !== 'ok') return { kind: 'skipped', why: `repo_${all.kind}` };
    const today = utcDay(ctx.now().toISOString());
    let out: StepOutcome = { kind: 'done' };
    for (const rec of all.value) {
      if (rec.lifecycle === 'canary' && canaryDays(rec, today) >= 90) {
        const s = outcomeOfRollback(await limitRollback(k, rec, 0));
        if (s.kind !== 'done') out = s;
      }
    }
    const working = new Map((await k.working.list()).map((w) => [w.id, w]));
    const ro: RunnerOut = { halted: null, breaker: null, effectsFailed: [], transitions: [] };
    const run = makeStepRunner(k.rd, working, ro);
    const r = await expireShadowQueues(run, all.value, working, ctx.now().toISOString());
    if (r === 'halt') return haltOutcome(ro.halted ?? 'candidate_invalid');
    return out;
  });

  const reconcileReduce = round.writeAdapter(
    'rollback_transition',
    async (): Promise<StepOutcome> => {
      const k = await kit();
      const rv = await k.rd.revocations.read();
      if (rv.kind !== 'ok') return haltOutcome('revocations_invalid');
      const all = await k.auth.readAll();
      if (all.kind !== 'ok')
        return all.kind === 'invalid'
          ? haltOutcome('repo_invalid')
          : { kind: 'skipped', why: `repo_${all.kind}` };
      const working = new Map((await k.working.list()).map((w) => [w.id, w]));
      const ro: RunnerOut = { halted: null, breaker: null, effectsFailed: [], transitions: [] };
      const rec: ReconcileOut = {
        unmappedRevocations: [],
        reconcileIncomplete: false,
        reconciled: [],
      };
      const run = makeStepRunner(k.rd, working, ro);
      if ((await reconcileRevocationLines(run, all.value, rv.lines, rec)) === 'halt') {
        return haltOutcome(ro.halted ?? 'candidate_invalid');
      }
      return rec.reconcileIncomplete
        ? { kind: 'incomplete', why: 'unmapped_revocation' }
        : { kind: 'done' };
    },
  );

  const trip = round.writeAdapter('trip', (reasons: readonly TripReason[]) =>
    tripAndMuteGuarded(deps.toolkit.breakerDeps(c, phase), deps.toolkit.ladderPorts(c), reasons),
  );
  const release = round.writeAdapter('state_pause_flag', async (): Promise<StepOutcome> => {
    const d = deps.toolkit.breakerDeps(c, phase);
    const cur = await d.state.read();
    const facts = await observationFacts(io, await stateOf(io), ctx.now());
    // 只重查有事实源的条件(`no_observation`);其余自动解除码的条件无从判定 → 视为仍成立(fail-closed:不清)
    const r = autoRelease(cur, (code) =>
      code === 'no_observation' && facts !== null ? noObservation(facts) : true,
    );
    await applyAutoRelease(d, r);
    return { kind: 'done' };
  });

  const reduce: ReducePort = {
    applyTaint: (t) => applyTaint(t),
    runAnalysis: () => runAnalysisStep(),
    expireCandidates: () => expire(),
    reconcileRevocations: () => reconcileReduce(),
    async evaluateTriggers(): Promise<readonly TripReason[]> {
      const k = await kit();
      const rv = await k.rd.revocations.read();
      const all = await k.auth.readAll();
      if (rv.kind !== 'ok' || all.kind !== 'ok') return []; // 读不出 = 不评估(只少一道熔断,不放行增影响)
      const today = utcDay(ctx.now().toISOString());
      const obs = await observationFacts(io, await stateOf(io), ctx.now());
      const f: TriggerFacts = {
        today,
        autoRollbackDays: all.value
          .filter((r) => r.terminal_reason === 'auto_rollback')
          .map((r) =>
            utcDay(r.transitions[r.transitions.length - 1]?.at ?? ctx.now().toISOString()),
          ),
        proxyEventDays: [],
        vetoDays: rv.lines.filter((l) => l.by === 'veto').map((l) => utcDay(l.at)),
        lastObservedDay: obs?.lastObservedDay ?? today,
        l0HasRuns: obs?.l0HasRuns ?? false,
        budgetUsedPct: 0,
        budgetCausedByThisLoop: false,
        costOverLegacy: false,
      };
      return evaluateTriggers(f);
    },
    tripAndMute: (reasons) => trip(reasons),
    applyAutoRelease: () => release(),
    async startRollback(req): Promise<StepOutcome> {
      const k = await kit();
      const all = await k.auth.readAll();
      if (all.kind !== 'ok') return { kind: 'failed', why: `repo_${all.kind}` };
      const rec = all.value.find((r) => r.id === req.id);
      if (rec === undefined) return { kind: 'failed', why: 'candidate_missing' };
      if (req.kind === 'limit_reached') return outcomeOfRollback(await limitRollback(k, rec, 0));
      return outcomeOfRollback(
        await rollback(k, {
          candidate_id: rec.id,
          content_sha256: rec.content_sha256,
          kind: req.kind,
          reason: req.reason,
          by: 'worker',
          target_terminal: 'rolled_back',
        }),
      );
    },
  };

  // ---------- 候选列表 / 重扫 / 压缩 ----------
  const candidates: CandidateSource = {
    async list(): Promise<CandidateListing> {
      const k = await kit();
      const all = await k.auth.readAll();
      if (all.kind === 'absent') return { kind: 'absent' };
      if (all.kind !== 'ok') return { kind: 'unavailable', why: `repo_${all.kind}` };
      const live = all.value.filter(
        (r) => r.lifecycle === 'proposed' || r.lifecycle === 'shadow' || r.lifecycle === 'canary',
      );
      return {
        kind: 'ok',
        cands: live.map((r) => ({
          id: r.id,
          content_sha256: r.content_sha256,
          lifecycle: r.lifecycle,
          source: r.source_proposal ?? null,
        })),
        canaryIds: live.filter((r) => r.lifecycle === 'canary').map((r) => r.id),
      };
    },
  };
  const rescan: ExcludeRescan = {
    rescan: round.writeAdapter('effects', async (): Promise<StepOutcome> => {
      await taintNewlyExcludedWith(ctx.sctx, fullRsiHandle(ctx.lock), { source: 'exclude' });
      return { kind: 'done' };
    }),
  };
  const compactor: Compactor = {
    compact: round.writeAdapter('compaction', async () => {
      const k = await kit();
      const r = await compactorOf(k.store, { clock: ctx.now }).compact();
      if (r.kind === 'compact_blocked') {
        const cause = r.cause as string;
        return {
          kind: 'compact_blocked' as const,
          cause: (cause === 'audit_full' || cause === 'effects_full' || cause === 'region_open'
            ? cause
            : 'store_io') as 'audit_full' | 'effects_full' | 'region_open' | 'store_io',
        };
      }
      return { kind: r.kind === 'noop' ? ('noop' as const) : ('compacted' as const) };
    }),
  };

  const s2: BothPorts['s2'] = {
    reduce,
    safety,
    scanner: createTaintScanner(makeTaintFacts(io)),
    candidates,
    rescan,
    judge: deps.judge ?? NO_JUDGE,
  };
  return { recovery, s2, compactor };
}

/** W9b 未装配:减影响侧空操作并报告 unavailable(与 `UNAVAILABLE_JUDGE.reduce` 同语义;不 import 判决槽运行时) */
const NO_JUDGE: JudgeReduceSlot = Object.freeze({
  run: () =>
    Promise.resolve({
      evaluated: 0,
      transitioned: [] as readonly string[],
      blocked: [] as readonly { id: string; code: 'judge_unavailable' }[],
      deferred: [] as readonly { id: string; why: string }[],
      halted: null,
      unavailable: true,
    }),
});

function canaryStartOf(rec: PersonalLifecycleRecord): string | null {
  for (let i = rec.transitions.length - 1; i >= 0; i--) {
    const t = rec.transitions[i];
    if (t !== undefined && t.dim === 'lifecycle' && t.to === 'canary') return t.at;
  }
  return null;
}

async function stateOf(io: IoContext): Promise<{ last_tick: unknown }> {
  const r = await readRsiFixed(io, 'state.json');
  if (r.kind !== 'ok') return { last_tick: null };
  const doc = parseRsiStateDoc(r.bytes);
  return doc.kind === 'ok' ? { last_tick: doc.state.last_tick } : { last_tick: null };
}
