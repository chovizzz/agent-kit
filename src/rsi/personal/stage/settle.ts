/**
 * §21 V1 装配块 C1a——**单次扫尾协议 `settleSafety`** 与每轮端口调用预算 `RoundBudget`(C v2 §4.3;冻结)。纯内存逻辑 + 注入端口,无 I/O。
 *
 * 脏则重入 = **固定的一次**扫尾(不是循环、不是「重跑整轮」):
 *  1. `safetyDirty` 为空 → `settled`(**零调用**);
 *  2. `takeDirty()`:**此刻清零**(先于任何扫尾调用);
 *  3. 固定顺序、各一次:`enforceMute()`(读**新**状态)→ `reconcileCaches()`(对**新**凭据)→ 只读核验 `verifyMuted()`;任一步抛错 / 故障 → 记故障并继续其余步骤(尽力);
 *  4. **不重跑** S1、压缩、触发评估、自动解除、污染扫描(`tripAndMute` 内含自己的静音,不依赖扫尾);
 *  5. 全部通过 → `settled`;核验失败或任一步故障 → `unsettled('safety_not_settled')`,**`safetyDirty` 保持置位**(把第 2 步取走的标记放回),不再循环。
 *     扫尾自己的写**不再置脏**:按**异步上下文归属**判定(扫尾每个端口调用都在 `runAsSweep` 内,该调用链上经写适配器发起的写免置脏;`gen` 照常推进);
 *     扫尾窗口内**别处并发发起**的脏写不在该上下文内,照常置脏;扫尾结束时脏标记非空 → `unsettled`(不报 `settled`、不重扫)。
 *  6. 失锁**不被扫尾吞掉**:rsi 锁 `lock_lost` 与个人锁 `PersonalLockLost` 都是终态——立即停止余下扫尾步骤,放回脏标记,以**同一个错误对象**拒绝(之后每次调用得到同一个 rejection);
 *     个人锁丢失另使本轮 `unsettled('safety_not_settled')`。调用方据此「只释放句柄、跳过余下个人步骤」。
 * `gen` 与 `safetyDirty` 互不相干:审计补行、压缩、effects 写使 `gen` 变化(只作废已铸造的 pass),但不置脏、不触发扫尾,更不导致永久 `unsettled`。
 */
import { PersonalLockLost, RoundInternalError, classify, type PersonalFault } from './errors.js';
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
/**
 * 扫尾端口。契约:端口**返回(兑现)之前**必须已完成它发起的全部写(未 await 的延迟 / 后台写不受保证:`runAsSweep` 的上下文令牌在端口兑现后失效,尽力防御定时器等遗留任务;违约端口在兑现同刻排下的微任务不在保证内,
 * 之后发起的写按普通写处理)。
 */
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
/** 脏标记已置位,或有一个会置脏的写还在途(完成后才置位) */
const dirtyNow = (st: {
  readonly dirty: ReadonlySet<unknown>;
  readonly dirtyInFlight: boolean;
}): boolean => st.dirty.size > 0 || st.dirtyInFlight;

/**
 * 每轮至多**真正扫尾一次**(状态在回合上:未开始 / 进行中 / 已完成):
 *  - 进行中再调用(含扫尾端口的同步前缀重入)→ 返回**同一个** Promise(先建好共享 Promise 再启动扫尾,不暴露占位值);
 *  - 已扫过再调用 → 不再扫:先前的结果(含 rejection)原样返回——失败后不能靠再调一次重来,脏标记保持置位;先前 `settled` 而其后又出现新的脏写 → `unsettled`(不重扫);
 *  - 第一次调用时脏标记为空 → `settled`(零调用,且**不算**已扫过:其后真有脏写时仍可扫这一次);但有会置脏的写**在途**(脏标记尚未置位)时 → `unsettled`(不启动扫尾、不算已扫过)。
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
    if (!dirtyNow(st)) return Promise.resolve(o.result);
    markRoundUnsettled(round, 'safety_not_settled');
    return Promise.resolve({ kind: 'unsettled', reason: 'safety_not_settled', faults: [] });
  }
  if (st.dirty.size === 0) {
    if (!st.dirtyInFlight) return Promise.resolve({ kind: 'settled', swept: false }); // 零调用
    // 会置脏的写在途(脏标记尚未置位):不能报 settled;不启动扫尾(与在途的写冲突),也不算已扫过——写完成后仍可扫这一次
    markRoundUnsettled(round, 'safety_not_settled');
    return Promise.resolve({ kind: 'unsettled', reason: 'safety_not_settled', faults: [] });
  }
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
      return (await st.runAsSweep(f)) ? 'ok' : 'not_ok';
    } catch (e) {
      const c = classify(e);
      // rsi 失锁 / 个人失锁:控制信号必须原样传出,不得降级成普通的「未收敛」
      if (c.kind === 'rethrow' || c.kind === 'end_personal_round') return { rethrow: e };
      if (c.kind === 'fault') faults.push(c.fault);
      return 'not_ok';
    }
  };
  const results: StepRun[] = [];
  // 固定顺序、各一次;任一步普通失败不挡后面的(尽力),失锁立即停止;核验放最后(只读,不占预算)
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
  const thrown = results.find((r): r is { readonly rethrow: unknown } => typeof r === 'object');
  if (thrown !== undefined) {
    st.restoreDirty(snapshot);
    if (thrown.rethrow instanceof PersonalLockLost) markRoundUnsettled(round, 'safety_not_settled');
    throw thrown.rethrow;
  }
  // 扫尾窗口内别处并发发起的脏写(不在扫尾上下文内)使脏标记非空、或仍在进行(尚未置脏):都不能报 settled
  if (
    results.length === 3 &&
    results.every((r) => r === 'ok') &&
    faults.length === 0 &&
    !dirtyNow(st)
  ) {
    return { kind: 'settled', swept: true };
  }
  st.restoreDirty(snapshot); // safetyDirty 保持置位
  markRoundUnsettled(round, 'safety_not_settled');
  return { kind: 'unsettled', reason: 'safety_not_settled', faults };
}
