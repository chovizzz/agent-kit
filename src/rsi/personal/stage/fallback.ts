/**
 * §21 V1 装配块 C1a——**`safetyFallback` 与原始异常的合并协议**(C v2 §2;冻结):`runFallbackOnce` 协调器、`track.fb`、`planAfterFallback`。纯逻辑,无 I/O。
 *
 * 协议(worker.ts catch 的新写法在 C1b 接线;本块只落可单测的协调器):
 *  - `original` 与 `outcome`(只由原异常算出)在调用兜底之前就固定,**此后任何分支都不改写它们**;兜底的结果只进(a)`FallbackReport`(b)日志一行 `safety_fallback_<kind>`;
 *    **不改** outcome / 结果 / 退出码;
 *  - 跳过:原异常是 rsi `lock_lost` ∨ outcome ∈ `FALLBACK_SKIP_OUTCOMES`(= worker 既有的零写入契约 `UNRECORDABLE`)∨ `pCompleted` ∨ `fallbackTried`
 *    ∨ 没有 stage ∨ `!eligible()`;
 *  - **单飞**:同一个 `track` 上兜底至多调用一次(两条入口——catch 与 P 违约包装层——共用本协调器与同一个 `track.fb`),二次错误不递归;
 *  - `aborted(rsi_lock_lost)`:worker **不再调 `finish`**,零后续写入(outcome 仍是原异常的);
 *  - 兜底自身抛错(含 rsi 失锁)一律被吞并转成报告,**永不抛**。
 */
import type { RsiOutcome } from '../../../contracts/rsi.js';
import { isRsiLockLost } from './errors.js';
import {
  FALLBACK_SKIP_OUTCOMES,
  type FallbackCtx,
  type FallbackReport,
  type PersonalStage,
} from './types.js';

export interface FallbackTrack {
  /** `run()` 一旦返回(含带 `faults[]` 的退化回合)即置真;其后的抛点不再调兜底(S0 已先执行) */
  pCompleted: boolean;
  /** 兜底已被调用过(单飞) */
  fallbackTried: boolean;
  /** 兜底结果;null = 未调用(跳过)或仍在进行 */
  fb: FallbackReport | null;
  /** 进行中的兜底(单飞的共享 Promise):第二个入口**等同一个结果**,不能在兜底未完成时拿到 null 就去 `finish` */
  pending: Promise<FallbackReport | null> | null;
}
export const newFallbackTrack = (): FallbackTrack => ({
  pCompleted: false,
  fallbackTried: false,
  fb: null,
  pending: null,
});

export type FallbackSkipReason =
  | 'rsi_lock_lost'
  | 'unrecordable_outcome'
  | 'p_completed'
  | 'already_tried'
  | 'no_stage'
  | 'ineligible';

const SKIP_SET: ReadonlySet<string> = new Set(FALLBACK_SKIP_OUTCOMES);

/** 纯判定:是否跳过兜底(返回第一个命中的原因;null = 应当调用) */
export function fallbackSkipReason(input: {
  readonly original: unknown;
  readonly outcome: RsiOutcome;
  readonly track: FallbackTrack;
  readonly stage: Pick<PersonalStage, 'eligible'> | undefined;
}): FallbackSkipReason | null {
  if (isRsiLockLost(input.original)) return 'rsi_lock_lost';
  if (SKIP_SET.has(input.outcome)) return 'unrecordable_outcome';
  if (input.track.pCompleted) return 'p_completed';
  if (input.track.fallbackTried) return 'already_tried';
  if (input.stage === undefined) return 'no_stage';
  let eligible = false;
  try {
    eligible = input.stage.eligible() === true;
  } catch {
    eligible = false; // 相位资格读不出 = 不进(fail-closed:不在不确定时写)
  }
  return eligible ? null : 'ineligible';
}

/**
 * 唯一调用点。返回本次(或此前已存的)兜底结果;跳过时返回 `track.fb`(可能为 null)。永不抛。
 * **单飞 + 共享结果**:已调用过(`fallbackTried`)时**等同一个进行中的 Promise**(不再调用)——所以 `aborted(rsi_lock_lost)` 在两条入口(catch 与 P 违约包装层)下
 * 即使并发进入,也都拿到最终的 `aborted` 而导致「不调 finish」,第二个入口不会在兜底未完成时拿到 null 就先去 `finish`。
 */
export async function runFallbackOnce(input: {
  readonly track: FallbackTrack;
  readonly stage: Pick<PersonalStage, 'eligible' | 'safetyFallback'> | undefined;
  readonly ctx: FallbackCtx;
  readonly original: unknown;
  readonly outcome: RsiOutcome;
}): Promise<FallbackReport | null> {
  const { track, stage, ctx } = input;
  if (track.fallbackTried) return track.pending ?? track.fb;
  if (fallbackSkipReason(input) !== null || stage === undefined) return track.fb;
  track.fallbackTried = true; // 先置位再调用:兜底内的任何重入都看到「已调用」
  const run = async (): Promise<FallbackReport | null> => {
    try {
      return await stage.safetyFallback(ctx);
    } catch (e) {
      return isRsiLockLost(e)
        ? { kind: 'aborted', why: 'rsi_lock_lost' }
        : { kind: 'threw', name: e instanceof Error ? e.name : typeof e };
    }
  };
  track.pending = run();
  track.fb = await track.pending;
  return track.fb;
}

export interface FollowUpPlan {
  /** 原异常算出的 outcome,**原样**带回(兜底结果不得替换它) */
  readonly outcome: RsiOutcome;
  /** 是否调 `finish`(`aborted(rsi_lock_lost)` = false:零后续写入) */
  readonly callFinish: boolean;
  /** 尽力追加的日志码 `safety_fallback_<kind>`;null = 不写(兜底被跳过 / 已失锁) */
  readonly logCode: string | null;
}

export function fallbackLogCode(r: FallbackReport): string {
  return `safety_fallback_${r.kind}`;
}

/** 兜底之后的收尾计划(纯函数) */
export function planAfterFallback(outcome: RsiOutcome, fb: FallbackReport | null): FollowUpPlan {
  if (fb !== null && fb.kind === 'aborted' && fb.why === 'rsi_lock_lost') {
    return { outcome, callFinish: false, logCode: null };
  }
  return { outcome, callFinish: true, logCode: fb === null ? null : fallbackLogCode(fb) };
}
