/**
 * §21 V1 装配块 C1b——worker 个人步(`PersonalStage`)的**生产装配**:真实 I/O 适配器 + 能力表 + 相位注入缝。
 * 照 `assemble-write.ts`:本文件是**唯一**拿真实写出口的装配层;`stage/*` 的纯逻辑经端口工厂注入它。
 *
 * 惰性保证:
 *  - **工厂求值零 IO**(`assembleWorkerStage` 只闭包捕获参数,不读盘、不建目录、不取锁);
 *  - **相位 0 一律不进**:`eligible()` = 相位 ≥ V1a ∧ `RSI_PHASE_REQUIRES` 在**契约导出的** `RSI_PRODUCTION_WIRED_CAPS` 下无缺项(能力缺 = 不进,fail-closed)。
 *    生产调用不传 `phase` / `wired`(缺省取 `RSI_AUTO_PHASE` 与契约集合,**没有环境变量旁路**);两个参数只是测试缝,不得被当作生产能力的交付证据;
 *  - 闭包全静态 import,**无动态 `import()` / `require`**;不 import 任何增影响模块(`grantCanary` 所在的 `canary-writer.ts`、`runPersonalStep`、`openPersonalRepo` / `bootstrapRepo`、`stage/growth.ts`、判决槽)。
 * C1b 不装配 `GrowthStage`(缺省 `growth_unwired`);S1 / S2 / 压缩 / 污染扫描(C2)与 D 的端口不存在,故不可能被误调。
 *
 * 状态写:S0 只持 rsi 锁,B2 的 `makePauseStatePort` 要两把锁 + 命令锁上下文,不能用;这里的 `PauseStatePort` 只需 rsi 锁,
 * 走与 worker 自己相同的 `readStateForWrite` + `writeStateFile` + `commitUnderLockWith`(整份合法才写,其它键保留,提交快照清单)。
 */
import * as path from 'node:path';
import { RSI_AUTO_PHASE, RsiStateSchema, phaseAtLeast, type RsiState } from '../contracts/rsi.js';
import {
  RSI_ASSEMBLY_CAPS,
  RSI_PRODUCTION_WIRED_CAPS,
  missingPhaseCaps,
  type RsiAssemblyCap,
} from '../contracts/rsi-phase-caps.js';
import type { IoContext } from '../io/paths.js';
import { lstat } from '../io/read-fs.js';
import { removeCanary, muteCanary } from './canary/canary-mute.js';
import { makeBreakerMarkerPort, makeUserMarkerPort } from './canary/pause-marker.js';
import { CANARY_FILES } from './canary/files.js';
import { RsiLockError } from './lock-error.js';
import type { RsiLockDeps, RsiLockHandle } from './lock.js';
import { rsiDirReadonly } from './lock-read.js';
import {
  NO_PAUSE,
  enforceMute,
  type AutoPauseState,
  type BreakerDeps,
  type PauseStatePort,
} from './personal/breaker.js';
import { acquirePersonalLock, type PersonalLockHandle } from './personal/personal-lock.js';
import { personalHome } from './personal/home-state.js';
import { isRsiLockLost } from './personal/stage/errors.js';
import {
  newFallbackTrack,
  planAfterFallback,
  runFallbackOnce,
  type FallbackTrack,
} from './personal/stage/fallback.js';
import { runEnforceLadder, type S0Ports, type S0StateKind } from './personal/stage/ladder.js';
import { createPersonalStage } from './personal/stage/personal-stage.js';
import {
  makeBothPorts,
  makeSafetyPort,
  type PersonalToolkit,
  type StepsAssemblyDeps,
} from './assemble-personal.js';
import type { FallbackPorts, StateRead } from './personal/stage/ports.js';
import type {
  FallbackCtx,
  FallbackReport,
  PersonalCtx,
  PersonalRound,
  PersonalStage,
} from './personal/stage/types.js';
import { readRsiFixed } from './services/attribution.js';
import { commitUnderLockWith } from './services/commit.js';
import { readStateForWrite, writeStateFile } from './services/fixed-write.js';
import { l0Due } from './services/breaker.js';
import { parseRsiStateDoc } from './state.js';
import { RsiFailClosedError, type RsiServiceCtx } from './types.js';
import type {
  PortFallbackCtx,
  PortFallbackReport,
  PortFallbackTrack,
  PortPersonalCtx,
  PortRoundView,
  WorkerPersonalPort,
} from './worker-personal-port.js';

// ---------- 能力表 ----------
/** 契约能力表(键 = `RSI_ASSEMBLY_CAPS` 全集)。C1b **没有交付任何契约能力**(审计补扫 / 恢复扫描 / 增长存储守卫 / 全产生者盖戳都在 C2 / D),全部为假;只有 `RSI_PRODUCTION_WIRED_CAPS` 才是门禁依据 */
export const PRODUCTION_CAPABILITY_TABLE: Readonly<Record<RsiAssemblyCap, boolean>> = Object.freeze(
  {
    effects_ledger_write: false,
    audit_appender: false,
    audit_compaction: false,
    audit_sweep: false,
    recovery_scan: false,
    growth_storage_guard: false,
    seal_stamp_all_producers: false,
    ledger_consume_ingest: false,
    ledger_consume_g4: false,
    near_fp_producer: false,
  },
);

/** 本块交付记录(**不是契约能力键**,不进 wired 集合、不影响相位门禁):C1b 交付 = P 点 + S0 + 兜底协议 + 试锁状态机 */
export const DELIVERED_MILESTONES: Readonly<Record<string, boolean>> = Object.freeze({
  worker_safety_skeleton: true,
});

/** 由契约能力表读出「已注入」的键集合(测试把它与契约导出的 `RSI_PRODUCTION_WIRED_CAPS` 逐项核对) */
export function wiredFromTable(
  table: Readonly<Record<RsiAssemblyCap, boolean>> = PRODUCTION_CAPABILITY_TABLE,
): ReadonlySet<RsiAssemblyCap> {
  return new Set(RSI_ASSEMBLY_CAPS.filter((k) => table[k] === true));
}

// ---------- 适配器 ----------
export interface AssembleWorkerDeps {
  /** **测试缝**:相位(缺省 `RSI_AUTO_PHASE`;生产不传) */
  readonly phase?: number;
  /** **测试缝**:已注入的能力集合(缺省契约导出的 `RSI_PRODUCTION_WIRED_CAPS`;生产不传) */
  readonly wired?: ReadonlySet<string>;
  /** 个人锁取锁依赖(测试缝:存活判据 / 时钟) */
  readonly lock?: RsiLockDeps;
}

async function rsiDirOf(io: IoContext): Promise<string | null> {
  const r = await rsiDirReadonly(io);
  if (r.kind === 'ok') return r.dir;
  if (r.kind === 'missing') return null;
  throw new RsiLockError('state_dir_unsafe');
}

/** 取 worker 传入的真实 rsi 锁句柄(`HeldRsi` 只声明了 nonce / assertHeld;写 state / 清单要完整句柄):不是完整句柄 = fail-closed */
function fullRsiHandle(lock: PersonalCtx['lock']): RsiLockHandle {
  const h = lock as Partial<RsiLockHandle>;
  if (typeof h.path !== 'string' || typeof h.release !== 'function') {
    throw new RsiFailClosedError('internal');
  }
  return lock as RsiLockHandle;
}

const isPaused = (s: RsiState): boolean => {
  const ap = s.auto_pause;
  return ap !== undefined && (ap.reasons.length > 0 || ap.diverged || ap.owner_changed);
};

async function readStateKind(io: IoContext): Promise<S0StateKind> {
  let r;
  try {
    r = await readRsiFixed(io, 'state.json');
  } catch {
    return 'unreadable';
  }
  if (r.kind === 'missing') return 'missing';
  const doc = parseRsiStateDoc(r.bytes);
  return doc.kind === 'ok' ? 'valid' : 'schema';
}

/** 只需 rsi 锁的 `PauseStatePort`(S0 用) */
function rsiOnlyPauseState(sctx: RsiServiceCtx, lock: PersonalCtx['lock']): PauseStatePort {
  return {
    async read(): Promise<AutoPauseState> {
      const r = await readRsiFixed(sctx.io, 'state.json');
      if (r.kind === 'missing') return NO_PAUSE;
      const doc = parseRsiStateDoc(r.bytes);
      if (doc.kind !== 'ok') throw new RsiFailClosedError('state_invalid');
      const ap = doc.state.auto_pause;
      if (ap === undefined) return NO_PAUSE;
      return {
        reasons: [...ap.reasons],
        diverged: ap.diverged,
        owner_changed: ap.owner_changed,
        ...(ap.released_marker_id !== undefined
          ? { released_marker_id: ap.released_marker_id }
          : {}),
      };
    },
    async write(s: AutoPauseState): Promise<void> {
      const handle = fullRsiHandle(lock);
      const prev = await readStateForWrite(sctx.io); // 整份不合规 → 抛 state_invalid;不写、不覆盖
      if (prev.prev === null) throw new RsiFailClosedError('state_invalid'); // 绝不凭空创建
      const next = RsiStateSchema.parse({
        ...prev.prev,
        auto_pause: {
          reasons: [...s.reasons],
          diverged: s.diverged,
          owner_changed: s.owner_changed,
          ...(s.released_marker_id !== undefined
            ? { released_marker_id: s.released_marker_id }
            : {}),
        },
      });
      await writeStateFile(sctx, handle, next, prev.rawConfirm);
      await commitUnderLockWith(sctx, handle, { trigger: 'poke' });
    },
  };
}

interface Rsi {
  readonly sctx: RsiServiceCtx;
  readonly lock: PersonalCtx['lock'];
  readonly now: () => Date;
}

async function withDir<T>(io: IoContext, f: (dir: string) => Promise<T>): Promise<T> {
  const dir = await rsiDirOf(io);
  if (dir === null) throw new RsiLockError('state_dir_unsafe');
  return f(dir);
}

/**
 * S0 与阶梯共用的 B 标记端口:目录先解析 / 校验,rsi 锁复核由写点守卫在**实际创建 / unlink 之前**做(删除在回读之后);失锁 = 零写入。
 * `assertHeld` 不是 fencing,这里只保证最后一次复核与写之间没有额外的异步文件操作
 */
function guardedBreakerMarker(c: Rsi): BreakerDeps['marker']['breaker'] {
  const io = c.sctx.io;
  const port = (d: string) =>
    makeBreakerMarkerPort(io, d, c.now, undefined, () => c.lock.assertHeld());
  return {
    ensure: (reason) => withDir(io, (d) => port(d).ensure(reason)),
    read: () => withDir(io, (d) => port(d).read()),
    remove: () => withDir(io, (d) => port(d).remove()),
  };
}

function breakerDeps(c: Rsi, phase: number): BreakerDeps {
  const io = c.sctx.io;
  return {
    state: rsiOnlyPauseState(c.sctx, c.lock),
    canary: {
      mute: () => withDir(io, (rsiDir) => muteCanary({ io, rsiDir, locks: { rsi: c.lock } })),
    },
    marker: {
      breaker: guardedBreakerMarker(c),
      user: { exists: () => withDir(io, (d) => makeUserMarkerPort(io, d, c.now).exists()) },
    },
    phase,
  };
}

/** S0 / 兜底共用的阶梯写端口(显式字段构造) */
function ladderPorts(
  c: Rsi,
): Pick<FallbackPorts, 'muteCanary' | 'removeCanary' | 'ensureBreakerMarker' | 'assertHeld'> {
  const io = c.sctx.io;
  return {
    muteCanary: () => withDir(io, (rsiDir) => muteCanary({ io, rsiDir, locks: { rsi: c.lock } })),
    removeCanary: async () => {
      await withDir(io, (rsiDir) => removeCanary({ io, rsiDir, locks: { rsi: c.lock } }));
      return true;
    },
    ensureBreakerMarker: (cause) => {
      void cause;
      return guardedBreakerMarker(c).ensure('gate_internal');
    },
    assertHeld: () => c.lock.assertHeld(),
  };
}

async function lstatExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function fallbackPortsFor(ctx: FallbackCtx): FallbackPorts {
  const c: Rsi = { sctx: ctx.sctx, lock: ctx.lock, now: ctx.now };
  const io = ctx.sctx.io;
  return {
    async readStateRaw(): Promise<StateRead> {
      let r;
      try {
        r = await readRsiFixed(io, 'state.json');
      } catch {
        return { kind: 'unreadable' };
      }
      if (r.kind === 'missing') return { kind: 'ok', paused: false };
      const doc = parseRsiStateDoc(r.bytes);
      return doc.kind === 'ok' ? { kind: 'ok', paused: isPaused(doc.state) } : { kind: 'invalid' };
    },
    markers: () =>
      withDir(io, async (d) => ({
        B: await lstatExists(path.join(d, CANARY_FILES.pauseBreaker)),
        U: await lstatExists(path.join(d, CANARY_FILES.pause)),
      })),
    ...ladderPorts(c),
  };
}

/** 读盘上的两个标志(`PersonalRound.flags`);读不出 = `null`(按未知处理,不臆测) */
async function readFlags(
  io: IoContext,
): Promise<{ diverged: boolean; owner_changed: boolean } | null> {
  try {
    const r = await readRsiFixed(io, 'state.json');
    if (r.kind === 'missing') return { diverged: false, owner_changed: false };
    const doc = parseRsiStateDoc(r.bytes);
    if (doc.kind !== 'ok') return null;
    const ap = doc.state.auto_pause;
    return { diverged: ap?.diverged ?? false, owner_changed: ap?.owner_changed ?? false };
  } catch {
    return null;
  }
}

export function assembleWorkerStage(d: AssembleWorkerDeps = {}): PersonalStage {
  const phase = d.phase ?? RSI_AUTO_PHASE;
  const wired = d.wired ?? RSI_PRODUCTION_WIRED_CAPS;
  /** 本轮取到的原始个人锁句柄(个人步端口要真实 `LockCap`;`HeldPersonal` 包装不外泄) */
  const rawPersonal: { current: PersonalLockHandle | null } = { current: null };
  const toolkit: PersonalToolkit = {
    breakerDeps: (c, ph) => breakerDeps(c, ph),
    ladderPorts: (c) => ladderPorts(c),
    enforce: (c, ph) =>
      runEnforceLadder({
        ...ladderPorts(c),
        enforceFull: () => enforceMute(breakerDeps(c, ph)),
        stateKind: () => readStateKind(c.sctx.io),
      }),
  };
  const sd: StepsAssemblyDeps = { phase, toolkit, rawPersonal: () => rawPersonal.current };
  return createPersonalStage({
    steps: {
      both: (ctx, round, budget) => makeBothPorts(ctx, round, budget, sd),
      rsiOnly: (ctx, round) =>
        makeSafetyPort({ sctx: ctx.sctx, lock: ctx.lock, now: ctx.now }, sd, round),
      flags: (ctx) => readFlags(ctx.sctx.io),
    },
    eligible: () => phaseAtLeast('V1a', phase) && missingPhaseCaps(phase, wired).length === 0,
    s0Ports(ctx: PersonalCtx): S0Ports {
      const c: Rsi = { sctx: ctx.sctx, lock: ctx.lock, now: ctx.now };
      const bd = breakerDeps(c, phase);
      return {
        ...ladderPorts(c),
        enforceFull: () => enforceMute(bd),
        stateKind: () => readStateKind(ctx.sctx.io),
      };
    },
    fallbackPorts: fallbackPortsFor,
    acquirePersonal(ctx: PersonalCtx) {
      return async () => {
        rawPersonal.current = null;
        const home = ctx.sctx.io.hostEnv['HOME'];
        if (home === undefined || !path.isAbsolute(home)) throw new RsiLockError('internal');
        const h = await acquirePersonalLock(personalHome(ctx.sctx.io, home), d.lock ?? {});
        rawPersonal.current = h;
        return h;
      };
    },
    async l0DueNow(ctx: PersonalCtx): Promise<boolean> {
      const r = await readStateForWrite(ctx.sctx.io);
      return l0Due(r.prev, ctx.nowMs());
    },
  });
}

// ---------- 依赖倒置的装配点:真实个人步 + 真实兜底协调器 → worker 的叶子端口 ----------
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type MustBeTrue<T extends true> = T;
/**
 * 编译期断言:叶子端口里的结构化视图与 C1a 冻结类型不得漂移(任一边改了,这里就编译失败)。
 * 口径:FallbackTrack / FallbackReport 是**双向等价**;ctx 与 round 是**方向性兼容**(worker 交出的 ctx 能当真实 ctx 用、真实回合能被 worker 的只读视图读),
 * 不是整类型镜像——端口只描述 worker 读写的最小字段(ISP);round 视图里的 `growth.code` 是宽的 string,worker 只比较 `personal_busy` / `personal_fault` 两个字面量。
 */
export type PortDriftChecks = [
  MustBeTrue<Same<FallbackTrack, PortFallbackTrack>>,
  MustBeTrue<Same<FallbackReport, PortFallbackReport>>,
  /** worker 交给个人步的 ctx 必须能当真实 ctx 用 */
  MustBeTrue<[PortPersonalCtx] extends [PersonalCtx] ? true : false>,
  MustBeTrue<[PortFallbackCtx] extends [FallbackCtx] ? true : false>,
  /** 真实回合必须能被 worker 的只读视图读 */
  MustBeTrue<[PersonalRound] extends [PortRoundView] ? true : false>,
];

/** 把个人步与真实协调器装成 worker 的 `personal` 注入物(`worker-entry.ts` 与测试共用;类型兼容由赋值检查保证) */
export function bindWorkerPersonal(stage: PersonalStage): WorkerPersonalPort {
  return {
    stage,
    runtime: {
      newTrack: newFallbackTrack,
      runFallbackOnce,
      planAfterFallback,
      isLockLost: isRsiLockLost,
    },
  };
}
