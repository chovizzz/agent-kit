/**
 * worker 的个人步端口(C1b 依赖倒置):`worker.ts` 只认本文件。
 *
 * 为什么存在:`worker.ts` 只要静态 import 任何 `personal/stage/**` 模块(哪怕只是 `import type`),类型闭包就会经
 * `stage/types.ts → lock-identity.ts → personal-lock.ts → io/home-fs.ts`(或 `errors.ts → candidate-ports.ts → commit.ts → home-state.ts → home-fs.ts`)
 * 把个人层的写出口拖进钩子入口 `hook-entry.ts` 的闭包,违反 D-AU(钩子路径零写出口)。所以 worker 依赖本叶子端口,真实实现在部署组装处注入
 * (`assemble-worker.ts` 的 `bindWorkerPersonal`,由只被根入口动态加载的 `worker-entry.ts` 调用)。
 *
 * 纪律:
 *  - 本文件**只有类型**(`import type`),且只引用 worker.ts 本来就依赖的模块(contracts / services/observe / types / lock),**不 import 个人层任何文件**;
 *  - 本文件里的结构类型是 C1a 冻结类型(`FallbackReport` / `FallbackTrack` / `PersonalRound` 等)的**最小结构化视图**;两边漂移由 `assemble-worker.ts`
 *    里的编译期断言(互相可赋值)卡住,而不是靠注释。
 */
import type { RsiOutcome } from '../contracts/rsi.js';
import type { RsiLockHandle } from './lock.js';
import type { RsiObservation } from './services/observe.js';
import type { RsiServiceCtx } from './types.js';

export type PortFallbackReport =
  | { readonly kind: 'muted' | 'removed' | 'marker' | 'unreliable' | 'nothing' }
  | { readonly kind: 'threw'; readonly name: string }
  | { readonly kind: 'aborted'; readonly why: 'rsi_lock_lost' };

export interface PortFallbackCtx {
  readonly sctx: RsiServiceCtx;
  readonly lock: RsiLockHandle;
  readonly now: () => Date;
  readonly nowMs: () => number;
  readonly origin: 'recover_under_lock' | 'p_contract_violation' | 'other';
}

export interface PortPersonalCtx {
  readonly sctx: RsiServiceCtx;
  readonly lock: RsiLockHandle;
  readonly obs: RsiObservation;
  readonly now: () => Date;
  readonly nowMs: () => number;
  readonly updateBusy: boolean;
}

/** worker 读个人回合的全部字段(只读):日志摘要用 */
export interface PortRoundView {
  readonly growth: { readonly kind: 'open' } | { readonly kind: 'denied'; readonly code: string };
  readonly faults: readonly { readonly code: string; readonly detail?: string }[];
}

/** 兜底协调器的记账(与 C1a `FallbackTrack` 同形) */
export interface PortFallbackTrack {
  pCompleted: boolean;
  fallbackTried: boolean;
  fb: PortFallbackReport | null;
  pending: Promise<PortFallbackReport | null> | null;
}

/** 个人步(C1a `PersonalStage` 的结构化子集) */
export interface WorkerPersonalStage {
  run(ctx: PortPersonalCtx): Promise<PortRoundView>;
  safetyFallback(ctx: PortFallbackCtx): Promise<PortFallbackReport>;
  eligible(): boolean;
}

export interface PortFollowUpPlan {
  readonly outcome: RsiOutcome;
  readonly callFinish: boolean;
  readonly logCode: string | null;
}

/** worker 需要的运行时函数:真实实现 = C1a 的 `fallback.ts` / `errors.ts`,由装配处注入 */
export interface PersonalRuntime {
  newTrack(): PortFallbackTrack;
  runFallbackOnce(input: {
    readonly track: PortFallbackTrack;
    readonly stage: Pick<WorkerPersonalStage, 'eligible' | 'safetyFallback'> | undefined;
    readonly ctx: PortFallbackCtx;
    readonly original: unknown;
    readonly outcome: RsiOutcome;
  }): Promise<PortFallbackReport | null>;
  planAfterFallback(outcome: RsiOutcome, fb: PortFallbackReport | null): PortFollowUpPlan;
  /** rsi 锁失锁判定(`RsiLockError('lock_lost')`) */
  isLockLost(e: unknown): boolean;
}

/** `RsiWorkerRunDeps.personal` 的形状:个人步 + 它的运行时。两者必须一起注入(没有「只有 stage 没有运行时」的半配置) */
export interface WorkerPersonalPort {
  readonly stage: WorkerPersonalStage;
  readonly runtime: PersonalRuntime;
}
