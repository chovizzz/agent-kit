/**
 * §21 V1 装配块 C1a——**回合对象**:`BothRound`(两把锁都在手)、`RsiOnlyRound`(personal 锁忙 / 故障)、写适配器(单飞 + `finally` 推进 `gen`)、
 * `safetyDirty`(与 `gen` 分开)、判决 latch。冻结(C 稿 v2 §4 / §8.1 / §11.2)。
 *
 * **类型证明:rsi-only 的轮次造不出 `GrowthPass`**
 *  1. 唯一的回合工厂 `openRound(rsi, attempt)` 收 `PersonalAttempt`(判别联合):`busy` / `fault` 分支**不带个人锁句柄**,只能得到 `RsiOnlyRound`;
 *     只有 `held` 分支才得到 `BothRound`。`attempt` 只能由 `attemptPersonal` 产生(运行期 WeakSet 校验,伪造 = `RoundInternalError`)。
 *  2. `BothRound` 带 `personalNonce` 与私有 `unique symbol` 品牌;`RsiOnlyRound` 两者都没有且品牌不同 → 二者互不可赋值(`c1-types.test.ts` 的 `@ts-expect-error`)。
 *  3. `evaluateGrowth(round: BothRound, …)` 是 `GrowthPass` 的**唯一**铸造点(`growth.ts` 模块私有),而 `PersonalRound.growth` 在无 `BothRound` 时是 `denied` 变体(无 round 字段)。
 * 运行期的第二道:`growth.ts` 的铸造登记表只认本模块铸造且未消费的 pass。威胁模型:防工程误用,不防同进程恶意代码(强转可绕过类型,绕不过登记表与盘上 nonce)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { DefinitelyNotWritten, RoundInternalError, type PersonalFault } from './errors.js';
import type { JudgeGrowthDeny } from '../judge-slot.js';
import {
  isProducedAttempt,
  newRoundId,
  type HeldPersonal,
  type HeldRsi,
  type PersonalAttempt,
} from './lock-identity.js';
import {
  DIRTY_KINDS,
  WRITE_KINDS,
  type DirtyKind,
  type UnsettledReason,
  type GrowthAccess,
  type WriteKind,
} from './types.js';

declare const roundBrand: unique symbol;

/** 写适配器只包装异步函数(返回 Promise):包装后一定是异步的,同步实现会让调用方漏 `await`、误判写入与 `gen` 推进已完成 */
export type AsyncFn = (...args: never[]) => Promise<unknown>;

/** `safetyDirty` 的只读视图(置位 / 清零只在本模块与 `settle.ts` 内部) */
export interface SafetyDirtyView {
  isDirty(): boolean;
  kinds(): readonly DirtyKind[];
}

export interface BothRound {
  readonly id: string;
  readonly rsiNonce: string;
  readonly personalNonce: string;
  /** 写代数:任何持久写之后递增(`finally`,含抛错 / 部分成功) */
  gen(): number;
  unsettled(): readonly UnsettledReason[];
  readonly safetyDirty: SafetyDirtyView;
  /** 包装一个写端口方法:单飞(嵌套 / 并发 = `RoundInternalError`)、`finally` 无条件推进 `gen` */
  writeAdapter<K extends WriteKind, F extends AsyncFn>(kind: K, impl: F): F;
  readonly [roundBrand]: 'both';
}

/** personal 锁忙 / 故障的回合:没有 `personalNonce`、没有个人锁句柄;`evaluateGrowth` 不接受它 */
export interface RsiOnlyRound {
  readonly id: string;
  readonly rsiNonce: string;
  gen(): number;
  unsettled(): readonly UnsettledReason[];
  readonly safetyDirty: SafetyDirtyView;
  writeAdapter<K extends WriteKind, F extends AsyncFn>(kind: K, impl: F): F;
  readonly [roundBrand]: 'rsi_only';
}

export type AnyRound = BothRound | RsiOnlyRound;

export type RoundOpen =
  | { readonly kind: 'both'; readonly round: BothRound; readonly personal: HeldPersonal }
  | {
      readonly kind: 'rsi_only';
      readonly round: RsiOnlyRound;
      readonly deny: 'personal_busy' | 'personal_fault';
      readonly fault: PersonalFault | null;
    };

/** 判决 latch 的取值(W9:本 tick 内**只加严**,传给 `check`;码表归 `judge-slot.ts`) */
export type JudgeBlockCode = JudgeGrowthDeny;

/** 回合内部状态:只给 `growth.ts` / `settle.ts` 用(架构测试:stage 目录之外不得 import `roundInternals`) */
export interface RoundInternals {
  readonly form: 'both' | 'rsi_only';
  gen: number;
  inFlight: 0 | 1;
  /** 一个**会置脏**的写(脏种类、且不是扫尾自己的写)正在进行:此时脏标记还没置位,收敛判定不能当它不存在 */
  dirtyInFlight: boolean;
  /**
   * 在「扫尾上下文」里运行 `f`:`f` 的异步链上、**`f` 返回之前**发起的写(经写适配器)是扫尾自己的写,不置脏;别处并发发起的写不在此上下文内,照常置脏。
   * 上下文令牌在 `f` 兑现 / 拒绝后失效:端口遗留的定时器 / 后台任务在失效之后发起的写不再被豁免(尽力防御;违约端口——返回前未完成写——在兑现同刻排下的微任务不在保证内)。
   */
  runAsSweep<T>(f: () => Promise<T>): Promise<T>;
  /** 当前同步 / 异步上下文是否在本回合的扫尾上下文内(写适配器入口同步读取) */
  inSweep(): boolean;
  readonly unsettled: UnsettledReason[];
  readonly dirty: Set<DirtyKind>;
  readonly latch: Map<string, JudgeBlockCode>;
  markUnsettled(reason: UnsettledReason): void;
  /** 取走全部脏标记并**立即清零**(`settleSafety` 步骤 2) */
  takeDirty(): readonly DirtyKind[];
  restoreDirty(kinds: readonly DirtyKind[]): void;
}

const internalsOf = new WeakMap<object, RoundInternals>();
const adapted = new WeakSet<object>();

export function roundInternals(round: AnyRound): RoundInternals {
  const st = internalsOf.get(round);
  if (st === undefined) throw new RoundInternalError('round_not_opened_here');
  return st;
}

/** 该函数是否由 `round.writeAdapter` 包装出的(架构测试 `all_write_ports_wrapped` 用) */
export const isWriteAdapted = (fn: unknown): boolean => typeof fn === 'function' && adapted.has(fn);

const WRITE_KIND_SET: ReadonlySet<string> = new Set(WRITE_KINDS);
const DIRTY_KIND_SET: ReadonlySet<string> = new Set(DIRTY_KINDS);

function makeInternals(form: 'both' | 'rsi_only'): RoundInternals {
  const unsettled: UnsettledReason[] = [];
  const dirty = new Set<DirtyKind>();
  // 每回合一个上下文存储(函数体内创建:模块顶层不得有构造调用,见 c1-inert)
  const sweepScope = new AsyncLocalStorage<{ active: boolean }>();
  return {
    form,
    gen: 0,
    inFlight: 0,
    dirtyInFlight: false,
    runAsSweep: async <T>(f: () => Promise<T>): Promise<T> => {
      const token = { active: true };
      try {
        return await sweepScope.run(token, f);
      } finally {
        token.active = false;
      }
    },
    inSweep: (): boolean => sweepScope.getStore()?.active === true,
    unsettled,
    dirty,
    latch: new Map(),
    markUnsettled(reason: UnsettledReason): void {
      if (!unsettled.includes(reason)) unsettled.push(reason);
    },
    takeDirty(): readonly DirtyKind[] {
      const all = [...dirty];
      dirty.clear();
      return all;
    },
    restoreDirty(kinds: readonly DirtyKind[]): void {
      for (const k of kinds) dirty.add(k);
    },
  };
}

function writeAdapterOf(
  st: RoundInternals,
): <K extends WriteKind, F extends AsyncFn>(kind: K, impl: F) => F {
  return function writeAdapter<K extends WriteKind, F extends AsyncFn>(kind: K, impl: F): F {
    if (!WRITE_KIND_SET.has(kind))
      throw new RoundInternalError(`unknown_write_kind:${String(kind)}`);
    if (typeof impl !== 'function') throw new RoundInternalError('write_impl_not_function');
    const fn = impl as unknown as (this: unknown, ...a: unknown[]) => Promise<unknown>;
    const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      // 写的来源在入口同步判定(异步上下文归属):扫尾自己发起的写才免置脏;并发的其它写按普通写处理
      const ownSweepWrite = st.inSweep();
      // 单飞:嵌套 / 并发使用 = 编程错误。抛在 try 之前,所以**不会**碰外层写的 inFlight / gen(外层 finally 照常收尾)
      if (st.inFlight !== 0) throw new RoundInternalError(`write_in_flight:${kind}`);
      st.inFlight = 1;
      const setsDirty = DIRTY_KIND_SET.has(kind) && !ownSweepWrite;
      if (setsDirty) st.dirtyInFlight = true;
      try {
        return await fn.apply(this, args);
      } catch (e) {
        // 默认「不确定」:只有适配器在任何 IO 之前主动声明 `DefinitelyNotWritten` 才不使本轮未决
        if (!(e instanceof DefinitelyNotWritten)) st.markUnsettled(`write_outcome_unknown:${kind}`);
        throw e;
      } finally {
        // 无条件推进(覆盖写成功后抛错 / 部分成功;`DefinitelyNotWritten` 也保守推进);授权写内 `requireGrowth` 看到的仍是本写之前的 gen
        st.gen += 1;
        if (setsDirty) st.dirty.add(kind as DirtyKind);
        st.dirtyInFlight = false;
        st.inFlight = 0;
      }
    };
    adapted.add(wrapped);
    return wrapped as unknown as F;
  };
}

function view(st: RoundInternals): SafetyDirtyView {
  return {
    isDirty: (): boolean => st.dirty.size > 0,
    kinds: (): readonly DirtyKind[] => [...st.dirty],
  };
}

export interface OpenRoundOptions {
  readonly newId?: () => string;
}

/**
 * **唯一**的回合工厂。`BothRound` 只能由「个人锁试锁成功」(`attempt.kind === 'held'`)构造。
 * 两把锁的 nonce 相同 = 同一句柄被当成两把锁 → `RoundInternalError`;`attempt` 非 `attemptPersonal` 所产 → `RoundInternalError`。
 */
export function openRound(
  rsi: HeldRsi,
  attempt: PersonalAttempt,
  opts: OpenRoundOptions = {},
): RoundOpen {
  if (!isProducedAttempt(attempt)) throw new RoundInternalError('attempt_not_produced');
  if (typeof rsi.nonce !== 'string' || rsi.nonce === '')
    throw new RoundInternalError('rsi_nonce_invalid');
  const id = (opts.newId ?? newRoundId)();
  if (attempt.kind === 'held') {
    const pn = attempt.personal.nonce;
    if (typeof pn !== 'string' || pn === '') throw new RoundInternalError('personal_nonce_invalid');
    if (pn === rsi.nonce) throw new RoundInternalError('same_nonce');
    const st = makeInternals('both');
    const round: BothRound = {
      id,
      rsiNonce: rsi.nonce,
      personalNonce: pn,
      gen: (): number => st.gen,
      unsettled: (): readonly UnsettledReason[] => [...st.unsettled],
      safetyDirty: view(st),
      writeAdapter: writeAdapterOf(st),
    } as unknown as BothRound;
    internalsOf.set(round, st);
    return { kind: 'both', round: Object.freeze(round), personal: attempt.personal };
  }
  const st = makeInternals('rsi_only');
  const round: RsiOnlyRound = {
    id,
    rsiNonce: rsi.nonce,
    gen: (): number => st.gen,
    unsettled: (): readonly UnsettledReason[] => [...st.unsettled],
    safetyDirty: view(st),
    writeAdapter: writeAdapterOf(st),
  } as unknown as RsiOnlyRound;
  internalsOf.set(round, st);
  return {
    kind: 'rsi_only',
    round: Object.freeze(round),
    deny: attempt.kind === 'busy' ? 'personal_busy' : 'personal_fault',
    fault: attempt.kind === 'fault' ? attempt.fault : null,
  };
}

/** 压缩 / 步骤等「写之外」的未决标记入口(如压缩抛错)。仅 stage 目录内使用 */
export function markRoundUnsettled(round: AnyRound, reason: UnsettledReason): void {
  roundInternals(round).markUnsettled(reason);
}

/**
 * 判决 latch 的写入口(S2P 4b 之后调):**单调**,只加严不放宽——同一 id 已有 latch 码时保持原码,不被后来的码覆盖、更不会被清除。
 * 读侧由 `evaluateGrowth` 的 G8 并入。
 */
export function recordJudgeBlocked(
  round: BothRound,
  blocked: readonly { readonly id: string; readonly code: JudgeBlockCode }[],
): void {
  const st = roundInternals(round);
  for (const b of blocked) if (!st.latch.has(b.id)) st.latch.set(b.id, b.code);
}
export function judgeBlockedOf(round: BothRound, id: string): JudgeBlockCode | null {
  return roundInternals(round).latch.get(id) ?? null;
}

/**
 * S3(增影响)的入口许可(纯函数;优先级 `lock_lost` > rsi-only 的 `personal_busy` / `personal_fault` > `update_busy` > `open`):
 * **只有 `open` 变体带 `BothRound`**——`update_busy` 时 S0–S2 照跑(它们用的是 `RoundOpen.round`),但 S3 拿不到 round,`evaluateGrowth` 在类型上不可调用。
 */
export function growthAccessOf(
  open: RoundOpen,
  flags: { readonly updateBusy: boolean; readonly lockLost: boolean },
): GrowthAccess {
  if (flags.lockLost) return { kind: 'denied', code: 'lock_lost' };
  if (open.kind === 'rsi_only') return { kind: 'denied', code: open.deny };
  if (flags.updateBusy) return { kind: 'denied', code: 'update_busy' };
  return { kind: 'open', round: open.round };
}
