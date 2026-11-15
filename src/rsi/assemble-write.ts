/**
 * 装配块 B2 的**写侧组合根**(设计稿 v3 §F B2;SOLID 的 D:命令依赖 `write/ports.ts` 的窄端口,具体实现在这里注入)。读侧组合根是 `assemble-read.ts`,两者互不穿越。
 * 把写命令的端口接到 B1a 的存储核(事务协调器 / 账 / 审计 / `SealGuard`)与 A 段的只读适配器上:
 *  - `locks`:`makeCommandLocks`(rsi → personal → sync,试锁、逆序释放);**持有 rsi + personal 之后、`fn` 之前**用**真实句柄**装配存储核(`assembleRsiStore`,fs 带 root),
 *    所以真实句柄的 `release()` 经生命周期控制块(H1);存储核按「本次 `HeldLocks`」登记,`rollbackDeps` / `vetoLift` 从**本次持有**取,不从装配时的全局取;
 *  - 锁绑定端口(`pauseState` / `marks` / `vetoLift` / `rebase.rewriteHead` / `cache`):经 `CommandLockContext.current()` 断言正处于持锁期,锁外调用 = 抛,零写入;
 *  - 旧 `KeyedEffectSink` → 新端口:`legacyKeyedEffects`(映射规则见 `effects-adapter.ts`),完整三层信息记进 `layers`;封存拒绝经 `seal` 包装记进 `layers.sealed`;
 *  - `peekRecord(s)` / `recordedSha` 的**锁外读**用 A 段的只读适配器;**git 路径在生产里不装配**(`gitPath` 缺省 = 未装配 → 读恒 `invalid`,契约 W0-22 第 6 条:`.git` 收紧 0700 之前保持未装配,归 D),
 *    所以相位提升后 `veto` / `rollback --to` 在锁外预读处仍 fail-closed(退 3),直到 D 合并;
 *  - **不提供 `consumers`**(账的消费方归 D):`rsi veto` 因此不报完整成功。
 * **工厂创建不读盘、不建目录、不取锁**;所有 I/O 在端口方法被调用时才发生。
 */
import { ownerRepoFingerprint, personalHome } from './personal/home-state.js';
import type { IoContext } from '../io/paths.js';
import { acquireLock as acquireSyncLock, ApplyError, type ApplyEnv } from '../sync/apply.js';
import {
  assertInsideLocks,
  makeCommandLocks,
  type AcquiredLock,
  type CommandLockContext,
  type LockAcquirers,
} from './auto/write/command-locks.js';
import { makePeekRecord, makePeekRecords } from './auto/read/peek.js';
import type { HeldLocks, WritePorts } from './auto/write/ports.js';
import { makeEntryMarks, makePauseStatePort, type RsiDirResolver } from './canary/state-port.js';
import { makeBreakerMarkerReader } from './canary/pause-marker-read.js';
import { RSI_AUTO_PHASE } from '../contracts/rsi.js';
import { RsiLockError, type RsiLockErrorKind } from './lock-error.js';
import { acquireRsiLock } from './lock.js';
import { rsiDirReadonly, type RsiLockDeps } from './lock-read.js';
import { makeCacheCleanup } from './personal/cache-cleanup.js';
import type { PersonalRepoDeps, StepHook } from './personal/commit.js';
import { personalRepoStore } from './personal/candidate-repo.js';
import type { PersonalLocks } from './personal/commit.js';
import { isSealedInterval, type EntrySeal } from './personal/entry-stamp.js';
import { legacyKeyedEffects } from './personal/effects-adapter.js';
import { newLayerRecorder, type LayerRecorder } from './personal/effects-layers.js';
import { makeHoldFacts } from './personal/hold-facts.js';
import { acquirePersonalLock } from './personal/personal-lock.js';
import { makeRebasePort } from './personal/rebase-port.js';
import { makeHomeReadPort } from './personal/read/home-reads.js';
import { makeGitReadonly, type GitSpawn } from './personal/read/git-readonly.js';
import { unwiredRecordedRead, type RecordedReadPort } from './personal/read/recorded-port.js';
import {
  homeRevocationReader,
  homeRevocationWriter,
  homeTxnStore,
  v1PayloadSync,
} from './personal/rollback-ports.js';
import type { RollbackDeps } from './personal/rollback.js';
import {
  personalRepoRemoval,
  recordedRecordsReader,
  recordedShaReader,
} from './personal/rollback-repo.js';
import { keyedAuditSink } from './personal/effects-recover.js';
import type { ClearDeps } from './personal/clear.js';
import { PortNotWired } from './personal/rollback-ports.js';
import { assembleRsiStore, type RsiStore } from './store/store.js';
import { safeStoreFs } from './store/fs-port.js';
import type { LockCap } from './store/ports.js';

export interface AssembleWriteDeps {
  /** 已就绪的 rsi io(`repoRoot` / `stateDir`) */
  io: IoContext;
  /** 已 realpath 且通过 `resolveAllowedHome` 的 HOME */
  home: string;
  /** `[rsi] repo`(`owner_repo_fp` 的来源) */
  repoPath: string;
  env: Readonly<Record<string, string | undefined>> | undefined;
  now: () => Date;
  /** 存储核的时钟(UTC 日:冷却裁剪 / 水位线 I1);缺省 = `now`。测试用它与 `now`(条目取时)分开,演练「锁外预取的旧时刻 / 时钟回拨」 */
  storeClock?: () => Date;
  /** 相位(缺省 `RSI_AUTO_PHASE`;测试注入,生产不传) */
  phase?: number;
  /** git 绝对路径解析(调用时才执行;缺省 / `null` = 未装配,锁外预读恒 `invalid`) */
  gitPath?: () => Promise<string | null>;
  /** 受限只读 git 的 spawn 出口(`gitPath` 给了才需要;生产不给) */
  gitSpawn?: GitSpawn;
  /** 测试缝:锁实现的时钟 / pid / 存活判据;崩溃注入 */
  lock?: RsiLockDeps;
  onRollbackStep?: (step: string) => void | Promise<void>;
  onRepoStep?: StepHook;
}

export interface WriteAdapters {
  locks: CommandLockContext;
  layers: LayerRecorder;
  ports: Pick<
    WritePorts,
    | 'locks'
    | 'pauseState'
    | 'holds'
    | 'marks'
    | 'breaker'
    | 'rollbackDeps'
    | 'clearDeps'
    | 'peekRecord'
    | 'peekRecords'
    | 'vetoLift'
    | 'rebase'
    | 'layers'
  >;
  /** 本次持有对应的存储核(测试断言路由用;生产代码只经 `rollbackDeps` / `vetoLift` 使用) */
  storeOf(held: HeldLocks): RsiStore | undefined;
}

const isLockCap = (x: unknown): x is LockCap =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as { path?: unknown }).path === 'string' &&
  typeof (x as { attachReleaseGate?: unknown }).attachReleaseGate === 'function';

function syncLockAcquirer(env: ApplyEnv): () => Promise<AcquiredLock> {
  return async () => {
    try {
      return await acquireSyncLock(env);
    } catch (e) {
      if (e instanceof ApplyError && e.code === 'SYNC_LOCKED') {
        const kind: RsiLockErrorKind = e.detail === 'held_over_ttl' ? 'locked_over_ttl' : 'locked';
        throw new RsiLockError(kind);
      }
      throw e;
    }
  };
}

export async function assembleWriteAdapters(d: AssembleWriteDeps): Promise<WriteAdapters> {
  const phase = d.phase ?? RSI_AUTO_PHASE;
  const h = personalHome(d.io, d.home);
  const ownerFp = await ownerRepoFingerprint(d.repoPath);
  const repoDeps: PersonalRepoDeps = {
    h,
    ownerRepoFp: ownerFp,
    now: d.now,
    ...(d.onRepoStep !== undefined ? { onStep: d.onRepoStep } : {}),
  };
  const layers = newLayerRecorder();
  const storeByHeld = new WeakMap<HeldLocks, RsiStore>();

  const rsiDir: RsiDirResolver = async () => {
    const r = await rsiDirReadonly(d.io);
    if (r.kind === 'ok') return r.dir;
    if (r.kind === 'missing') return null;
    throw new RsiLockError('state_dir_unsafe');
  };

  const syncEnv: ApplyEnv = {
    home: d.home,
    homeReal: d.home,
    tmpDir: d.io.tmpDir,
    env: d.env,
    deps: {},
  };
  const acquirers: LockAcquirers = {
    rsi: () => acquireRsiLock(d.io, d.lock ?? {}),
    personal: () => acquirePersonalLock(h, d.lock ?? {}),
    sync: syncLockAcquirer(syncEnv),
  };
  const locks = makeCommandLocks(acquirers, {
    async around(set, held, run) {
      if (set.rsi !== null) {
        const dir = await rsiDir();
        if (dir === null || !isLockCap(set.rsi) || !isLockCap(set.personal)) {
          throw new RsiLockError('internal');
        }
        // 真实句柄 + 带 root 的 fs(H1:真实句柄没有 root 的 fs 会被存储核拒绝)
        const store = assembleRsiStore({
          fs: safeStoreFs(d.io, dir),
          rsi: set.rsi,
          personal: set.personal,
          clock: d.storeClock ?? d.now,
        });
        storeByHeld.set(held, store);
      }
      return run();
    },
  });

  const personalLocksOf = (held: HeldLocks): PersonalLocks => ({
    personal: held.personal,
    ...(held.rsi !== null ? { rsi: held.rsi } : {}),
  });

  const sealOf = (store: RsiStore, held: HeldLocks): EntrySeal => ({
    open: async () => {
      const region = await store.seal.open(held.personal);
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
  });

  const constEnv = {
    read: async () => ({
      phase,
      autoLoopEffective: false,
      autoPaused: false,
      marks: { enabled: false, paused: false, policyFp: '', resetGen: 0 },
    }),
  };

  const rollbackDeps = (held: HeldLocks): RollbackDeps => {
    const store = storeByHeld.get(held);
    if (store === undefined) throw new RsiLockError('internal'); // 没有存储核 = 不是 rsi_personal_sync 的持有
    const pl = personalLocksOf(held);
    const auth = personalRepoStore(repoDeps, pl);
    const keyedEffects = legacyKeyedEffects({
      sink: store.sink,
      userVeto: store.userVeto,
      store: auth,
      recorder: layers,
    });
    const revocations = homeRevocationReader(h);
    return {
      store: auth,
      working: {
        list: async () => [],
        put: async () => {
          throw new PortNotWired('working_store');
        },
      },
      revocations,
      audit: keyedAuditSink(keyedEffects),
      effects: { apply: async () => undefined },
      env: constEnv,
      now: d.now,
      locks: { personal: held.personal },
      txns: homeTxnStore(h),
      revoker: homeRevocationWriter(h, () => held.personal.assertHeld()),
      cache: makeCacheCleanup({ io: d.io, rsiDir, locks, revocations, now: d.now }),
      repo: personalRepoRemoval(repoDeps, pl),
      payload: v1PayloadSync(phase),
      keyedEffects,
      recordedSha: recordedShaReader(repoDeps, pl),
      seal: sealOf(store, held),
      ...(d.onRollbackStep !== undefined ? { onStep: d.onRollbackStep } : {}),
    };
  };

  const clearDeps = (held: HeldLocks): ClearDeps => {
    const pl: PersonalLocks = { personal: held.personal };
    return {
      store: personalRepoStore(repoDeps, pl),
      revocations: homeRevocationReader(h),
      locks: { personal: held.personal },
      txns: homeTxnStore(h),
      revoker: homeRevocationWriter(h, () => held.personal.assertHeld()),
      repo: personalRepoRemoval(repoDeps, pl),
      payload: v1PayloadSync(phase),
      now: d.now,
      recordedSha: recordedShaReader(repoDeps, pl),
      phase,
      syncLock: held.syncLock,
      recordedRecords: recordedRecordsReader(repoDeps, pl),
      ...(d.onRollbackStep !== undefined ? { onStep: d.onRollbackStep } : {}),
    };
  };

  // 锁外预读(A 段只读适配器);git 路径未装配 = 恒 invalid
  let recorded: Promise<RecordedReadPort> | undefined;
  const lazyRecorded: RecordedReadPort = (() => {
    const get = (): Promise<RecordedReadPort> =>
      (recorded ??= (async () => {
        const g = d.gitPath === undefined ? null : await d.gitPath();
        return g === null || d.gitSpawn === undefined
          ? unwiredRecordedRead
          : makeGitReadonly({ gitPath: g, gitDir: `${h.repoDir}/.git`, spawn: d.gitSpawn });
      })());
    return {
      readCommit: async (o) => (await get()).readCommit(o),
      listTree: async (o) => (await get()).listTree(o),
      readBlob: async (o) => (await get()).readBlob(o),
    };
  })();
  const src = { home: makeHomeReadPort(d.home), recorded: lazyRecorded };

  const rebase = makeRebasePort({ repo: repoDeps, locks });

  return {
    locks,
    layers,
    storeOf: (held) => storeByHeld.get(held),
    ports: {
      locks,
      layers,
      pauseState: makePauseStatePort({ io: d.io, rsiDir, locks }),
      marks: makeEntryMarks({ io: d.io, rsiDir, locks }),
      holds: makeHoldFacts({
        repoInvalid: async () => (await rebase.classify()).kind === 'invalid',
      }),
      breaker: {
        read: async () => {
          const dir = await rsiDir();
          return dir === null ? null : makeBreakerMarkerReader(dir).read();
        },
      },
      rollbackDeps,
      clearDeps,
      peekRecord: makePeekRecord(src),
      peekRecords: makePeekRecords(src),
      rebase,
      vetoLift: {
        async lift(id, sha) {
          const held = await assertInsideLocks(locks, true);
          const store = storeByHeld.get(held);
          if (store === undefined) throw new RsiLockError('internal');
          return store.userVeto.lift(id, sha, d.now().toISOString());
        },
      },
    },
  };
}
