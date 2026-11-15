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
import {
  markRoundUnsettled,
  roundInternals,
  type AnyRound,
  type BothRound,
  type RsiOnlyRound,
} from './round.js';

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

/** 持两锁的回合**必须**给 `startRollbackLimit`(类型即必填;运行期再校验);rsi-only 回合不需要 */
export function createRoundBudget(
  round: BothRound,
  opts: { readonly startRollbackLimit: number },
): RoundBudget;
export function createRoundBudget(round: RsiOnlyRound): RoundBudget;
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

type SweepOutcome =
  | { readonly kind: 'result'; readonly result: SettleResult }
  /** rsi 失锁等上抛:终态就是这次 rejection,之后每次调用都得到同一个 rejection(不降级成普通 unsettled) */
  | { readonly kind: 'rejected'; readonly error: unknown };
interface SweepRecord {
  readonly running: Promise<SettleResult>;
  outcome: SweepOutcome | null;
}
const sweeps = new WeakMap<object, SweepRecord>();

/**
 * 每轮至多**真正扫尾一次**(状态在回合上:未开始 / 进行中 / 已完成):
 *  - 进行中再调用(含扫尾端口的同步前缀重入)→ 返回**同一个** Promise(先建好共享 Promise 再启动扫尾,不暴露占位值);
 *  - 已扫过再调用 → 不再扫:先前的结果(含 rejection)原样返回——失败后不能靠再调一次重来,脏标记保持置位;先前 `settled` 而其后又出现新的脏写 → `unsettled`(不重扫);
 *  - 第一次调用时脏标记为空 → `settled`(零调用,且**不算**已扫过:其后真有脏写时仍可扫这一次)。
 */
export function settleSafety(
  round: AnyRound,
  ports: SweepPorts,
  budget: RoundBudget,
): Promise<SettleResult> {
  const st = roundInternals(round);
  const prev = sweeps.get(round);
  if (prev !== undefined) {
    const o = prev.outcome;
    if (o === null) return prev.running;
    if (o.kind === 'rejected') return Promise.reject(o.error);
    if (o.result.kind === 'unsettled') return Promise.resolve(o.result);
    if (st.dirty.size === 0) return Promise.resolve(o.result);
    markRoundUnsettled(round, 'safety_not_settled');
    return Promise.resolve({ kind: 'unsettled', reason: 'safety_not_settled', faults: [] });
  }
  if (st.dirty.size === 0) return Promise.resolve({ kind: 'settled', swept: false }); // 零调用
  let resolve!: (r: SettleResult) => void;
  let reject!: (e: unknown) => void;
  const running = new Promise<SettleResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const rec: SweepRecord = { running, outcome: null };
  sweeps.set(round, rec);
  void sweepOnce(round, ports, budget).then(
    (result) => {
      rec.outcome = { kind: 'result', result };
      resolve(result);
    },
    (error: unknown) => {
      rec.outcome = { kind: 'rejected', error };
      reject(error);
    },
  );
  return running;
}

async function sweepOnce(
  round: AnyRound,
  ports: SweepPorts,
  budget: RoundBudget,
): Promise<SettleResult> {
  const st = roundInternals(round);
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
