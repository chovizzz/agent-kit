/**
 * §21 V1 装配块 C1a——**单次扫尾协议 `settleSafety`** 与每轮端口调用预算 `RoundBudget`(C v2 §4.3;冻结)。纯内存逻辑 + 注入端口,无 I/O。
 *
 * 脏则重入 = **固定的一次**扫尾(不是循环、不是「重跑整轮」):
 *  1. `safetyDirty` 为空 → `settled`(**零调用**);
 *  2. `takeDirty()`:**此刻清零**(先于任何扫尾调用);
 *  3. 固定顺序、各一次:`enforceMute()`(读**新**状态)→ `reconcileCaches()`(对**新**凭据)→ 只读核验 `verifyMuted()`;任一步抛错 / 故障 → 记故障并继续其余步骤(尽力);
 *  4. **不重跑** S1、压缩、触发评估、自动解除、污染扫描(`tripAndMute` 内含自己的静音,不依赖扫尾);
 *  5. 全部通过 → `settled`;核验失败或任一步故障 → `unsettled('safety_not_settled')`,**`safetyDirty` 保持置位**(把第 2 步取走的标记放回),不再循环。
 *     扫尾自己的写**不再置脏**(`sweeping` 期间写适配器不置脏标记;`gen` 照常推进)。
 * `gen` 与 `safetyDirty` 互不相干:审计补行、压缩、effects 写使 `gen` 变化(只作废已铸造的 pass),但不置脏、不触发扫尾,更不导致永久 `unsettled`。
 */
import { RoundInternalError, classify, type PersonalFault } from './errors.js';
import type { MutedVerdict, EnforceResult, StepOutcome } from './ports.js';
import { markRoundUnsettled, roundInternals, type AnyRound } from './round.js';

// ---------- RoundBudget ----------
export const BUDGET_PORTS = Object.freeze([
  'enforceMute',
  'setFlagAndMute',
  'tripAndMute',
  'reconcileCaches',
  'applyAutoRelease',
  'evaluateTriggers',
  'startRollback',
] as const);
export type BudgetPort = (typeof BUDGET_PORTS)[number];

/**
 * 每轮端口最大调用次数(C v2 §4.3 表)。`startRollback`:持两锁 ≤ canary 记录数(全局名额的常量上限,**由 C2 经 `startRollbackLimit` 传入**,
 * 合约里没有该常量,故工厂不给缺省值,缺失 = 拒绝构造);忙 / 故障轮 0。
 */
export const ROUND_BUDGET_LIMITS = Object.freeze({
  both: Object.freeze({
    enforceMute: 2,
    setFlagAndMute: 1,
    tripAndMute: 1,
    reconcileCaches: 2,
    applyAutoRelease: 1,
    evaluateTriggers: 1,
  }),
  rsi_only: Object.freeze({
    enforceMute: 2,
    setFlagAndMute: 0,
    tripAndMute: 1,
    reconcileCaches: 2,
    applyAutoRelease: 0,
    evaluateTriggers: 1,
    startRollback: 0,
  }),
} as const);

export interface RoundBudget {
  readonly form: 'both' | 'rsi_only';
  /** 记一次调用;超限 → 本轮 `unsettled('budget_exceeded:<port>')` 并抛 `RoundInternalError`(防循环) */
  charge(port: BudgetPort): void;
  used(port: BudgetPort): number;
  limit(port: BudgetPort): number;
}

export function createRoundBudget(
  round: AnyRound,
  opts: { readonly startRollbackLimit?: number } = {},
): RoundBudget {
  const st = roundInternals(round);
  const limits: Record<BudgetPort, number> = { ...ROUND_BUDGET_LIMITS.rsi_only };
  if (st.form === 'both') {
    const n = opts.startRollbackLimit;
    // fail-closed:持两锁的回合必须给出 startRollback 上限(正整数),不给缺省值
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new RoundInternalError('start_rollback_limit_required');
    }
    Object.assign(limits, ROUND_BUDGET_LIMITS.both, { startRollback: n });
  }
  const counts: Record<BudgetPort, number> = {
    enforceMute: 0,
    setFlagAndMute: 0,
    tripAndMute: 0,
    reconcileCaches: 0,
    applyAutoRelease: 0,
    evaluateTriggers: 0,
    startRollback: 0,
  };
  return {
    form: st.form,
    charge(port: BudgetPort): void {
      if (!(BUDGET_PORTS as readonly string[]).includes(port)) {
        throw new RoundInternalError(`unknown_budget_port:${String(port)}`);
      }
      if (counts[port] >= limits[port]) {
        markRoundUnsettled(round, `budget_exceeded:${port}`);
        throw new RoundInternalError(`budget_exceeded:${port}`);
      }
      counts[port] += 1;
    },
    used: (port: BudgetPort): number => counts[port],
    limit: (port: BudgetPort): number => limits[port],
  };
}

// ---------- settleSafety ----------
export interface SweepPorts {
  enforceMute(): Promise<EnforceResult>;
  reconcileCaches(): Promise<StepOutcome>;
  verifyMuted(): Promise<MutedVerdict>;
}
export type SettleResult =
  | { readonly kind: 'settled'; readonly swept: boolean }
  | {
      readonly kind: 'unsettled';
      readonly reason: 'safety_not_settled';
      readonly faults: readonly PersonalFault[];
    };

type StepRun = 'ok' | 'not_ok' | { readonly rethrow: unknown };

export async function settleSafety(
  round: AnyRound,
  ports: SweepPorts,
  budget: RoundBudget,
): Promise<SettleResult> {
  const st = roundInternals(round);
  if (st.dirty.size === 0) return { kind: 'settled', swept: false }; // 零调用
  const snapshot = st.takeDirty(); // 此刻清零(先于任何扫尾调用)
  const faults: PersonalFault[] = [];
  const attempt = async (port: BudgetPort | null, f: () => Promise<boolean>): Promise<StepRun> => {
    try {
      if (port !== null) budget.charge(port);
      return (await f()) ? 'ok' : 'not_ok';
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'rethrow') return { rethrow: e };
      if (c.kind === 'fault') faults.push(c.fault);
      return 'not_ok';
    }
  };
  const results: StepRun[] = [];
  st.sweeping = true;
  try {
    // 固定顺序、各一次;任一步失败不挡后面的(尽力),核验放最后(只读,不占预算)
    results.push(
      await attempt('enforceMute', async () => (await ports.enforceMute()).fault === null),
    );
    if (!results.some((r) => typeof r === 'object')) {
      results.push(
        await attempt('reconcileCaches', async () => {
          const o = await ports.reconcileCaches();
          return o.kind === 'done' || o.kind === 'skipped';
        }),
      );
    }
    if (!results.some((r) => typeof r === 'object')) {
      results.push(await attempt(null, async () => (await ports.verifyMuted()).ok === true));
    }
  } finally {
    st.sweeping = false;
  }
  const thrown = results.find((r): r is { readonly rethrow: unknown } => typeof r === 'object');
  if (thrown !== undefined) {
    st.restoreDirty(snapshot);
    throw thrown.rethrow;
  }
  if (results.length === 3 && results.every((r) => r === 'ok') && faults.length === 0) {
    return { kind: 'settled', swept: true };
  }
  st.restoreDirty(snapshot); // safetyDirty 保持置位
  markRoundUnsettled(round, 'safety_not_settled');
  return { kind: 'unsettled', reason: 'safety_not_settled', faults };
}
