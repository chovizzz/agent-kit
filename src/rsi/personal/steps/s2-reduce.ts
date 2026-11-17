/**
 * S2 只减影响(C v1 §6 / v2 §4.3;**没有任何增影响路径**:端口束里没有授予 / 创建 / 建仓能力)。纯编排;每步独立 try,`classify` 同 S1。
 *
 * S2R(只需 rsi 锁):`reconcileCaches`(凭据列出的 canary 条目移除 + stop 行,幂等)。
 * S2P(两把锁;顺序固定,「熔断触发放最后」):
 *   1. 污染:仅 `l0DueNow` 的轮先 `rescan`(幂等的减影响:新命中排除的暂存 run 先落 `TAINTED`),再 `scan`;命中 → `applyTaint`(凭据先于转移);
 *      `unknown` 且为 canary → `stopExistingInjection('source_unknown')`(只停注入,不转移、不写凭据);扫描 `unavailable` → 故障,**本步不判**;
 *   2. 分析链:仅存在 canary 记录 → `runAnalysis`;3. 到期:`expireCandidates`(canary 90 日 / `never_valid_look`;shadow 排队到期);
 *   4. proposed / shadow 凭据对账;4b. W9 槽 `judge.run({})`(排在对账之后;`halted` 进 `classifyHalt`;`blocked[]` 汇入单调 latch);
 *   5. 触发评估(**唯一一次**)与 S1 带来的 `personal_repo_invalid` 合并成**一次** `tripAndMute`;6. 自动解除(**唯一一次**)。
 * 忙 / 故障轮不进 S2P;`T_rsi`(仅 rsi 驻留事实)走 `runTRsi`。
 */
import { classify, classifyHalt } from '../stage/errors.js';
import type { PersonalFault } from '../stage/errors.js';
import { normalizeJudgeReport } from '../judge-slot.js';
import type { StepOutcome } from '../stage/ports.js';
import { recordJudgeBlocked, type BothRound } from '../stage/round.js';
import type { RoundBudget } from '../stage/settle.js';
import type { RsiOnlyTripReason, TripReason, UnsettledReason } from '../stage/types.js';
import { HALT_PREFIX } from './s1-recover.js';
import { TaintApplyFailed, faultOfOutcome, tagOf, type S2Ports } from './steps-types.js';
import type { SafetyPort } from '../stage/ports.js';

export interface S2Result {
  readonly faults: readonly PersonalFault[];
  readonly unsettled: readonly UnsettledReason[];
  /** 本轮做过的步骤(测试与日志用;顺序即执行顺序) */
  readonly ran: readonly string[];
  readonly ended: boolean;
}

class Collector {
  readonly faults: PersonalFault[] = [];
  readonly unsettled: UnsettledReason[] = [];
  readonly ran: string[] = [];
  ended = false;

  note(name: string, o: StepOutcome): void {
    if (o.kind === 'incomplete' && o.why.startsWith(HALT_PREFIX)) {
      const h = classifyHalt(o.why.slice(HALT_PREFIX.length) as never);
      if (h.kind === 'stop_step_unsettled') this.unsettled.push(`step_integrity:${h.cause}`);
      else if (h.kind === 'lock_lost_unresolved') this.unsettled.push('lock_loss_unresolved');
    }
    const f = faultOfOutcome(name, o);
    if (f !== null) this.faults.push(f);
  }
  /** 一步:成功返回结果;失锁(个人)→ `ended`;rsi 失锁上抛;其它 → 故障 */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.ended) return undefined;
    this.ran.push(name);
    try {
      return await fn();
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'rethrow') throw e;
      if (c.kind === 'end_personal_round') this.ended = true;
      else this.faults.push(c.fault);
      return undefined;
    }
  }
  result(): S2Result {
    return { faults: this.faults, unsettled: this.unsettled, ran: this.ran, ended: this.ended };
  }
}

/** S2R:只需 rsi 锁 */
export async function runS2R(p: {
  readonly safety: Pick<SafetyPort, 'reconcileCaches'>;
  readonly budget: RoundBudget;
}): Promise<S2Result> {
  const c = new Collector();
  const o = await c.step('reconcile_caches', async () => {
    p.budget.charge('reconcileCaches');
    return p.safety.reconcileCaches();
  });
  if (o !== undefined) c.note('reconcile_caches', o);
  return c.result();
}

/** `T_rsi`:personal 锁忙 / 故障的回合,只含 rsi 驻留事实的触发;命中调**同一个**仅需 rsi 锁的 `tripAndMute`(类型上个人侧码不可传入);不做自动解除 */
export async function runTRsi(p: {
  readonly safety: Pick<SafetyPort, 'evaluateRsiTriggers' | 'tripAndMute'>;
  readonly budget: RoundBudget;
}): Promise<S2Result> {
  const c = new Collector();
  const reasons = await c.step('evaluate_rsi_triggers', async () => {
    p.budget.charge('evaluateTriggers');
    return p.safety.evaluateRsiTriggers();
  });
  if (reasons !== undefined && reasons.length > 0) {
    await c.step('trip_and_mute', async () => {
      p.budget.charge('tripAndMute');
      return p.safety.tripAndMute(reasons as readonly RsiOnlyTripReason[]);
    });
  }
  return c.result();
}

export async function runS2P(p: {
  readonly ports: S2Ports;
  readonly round: BothRound;
  readonly budget: RoundBudget;
  readonly l0DueNow: boolean;
  /** S1 带来的熔断码(仓库不可用):与触发评估合并成一次 trip */
  readonly tripSeed: readonly TripReason[];
}): Promise<S2Result> {
  const { ports, round, budget } = p;
  const c = new Collector();

  // 1. 污染
  const listing = await c.step('list_candidates', () => ports.candidates.list());
  if (listing !== undefined && listing.kind === 'unavailable') {
    c.faults.push({ code: 'step_halted', detail: tagOf(`candidates_unavailable:${listing.why}`) });
  }
  if (listing !== undefined && listing.kind === 'ok') {
    if (p.l0DueNow) {
      const o = await c.step('rescan_excluded', () => ports.rescan.rescan());
      if (o !== undefined) c.note('rescan_excluded', o);
    }
    const scan = await c.step('taint_scan', () => ports.scanner.scan(round, listing.cands));
    if (scan !== undefined) {
      if (scan.kind === 'unavailable') {
        c.faults.push({ code: 'step_halted', detail: tagOf(`taint_unavailable:${scan.why}`) });
      } else {
        if (scan.tainted.length > 0) {
          const o = await c.step('apply_taint', async () => {
            try {
              return await ports.reduce.applyTaint(scan.tainted);
            } catch (e) {
              if (!(e instanceof TaintApplyFailed)) throw e;
              // 凭据 / 回滚写失败:稳定码 + 失败候选 id(写适配器已使本轮 unsettled;下轮幂等重试)
              c.faults.push({
                code: 'step_halted',
                detail: tagOf(`taint_apply_failed:${e.ids.join('+')}`),
              });
              return undefined;
            }
          });
          if (o !== undefined) c.note('apply_taint', o);
        }
        const canary = new Set(listing.canaryIds);
        if (scan.unknown.some((u) => canary.has(u.id))) {
          await c.step('stop_unknown_source', () =>
            ports.safety.stopExistingInjection('source_unknown'),
          );
        }
      }
    }
    // 2. 分析链(仅有 canary 记录)
    if (listing.canaryIds.length > 0) {
      const o = await c.step('run_analysis', () => ports.reduce.runAnalysis());
      if (o !== undefined) c.note('run_analysis', o);
    }
  }
  // 3. 到期
  const ex = await c.step('expire', () => ports.reduce.expireCandidates());
  if (ex !== undefined) c.note('expire', ex);
  // 4. 对账
  const rc = await c.step('reconcile_revocations', () => ports.reduce.reconcileRevocations());
  if (rc !== undefined) c.note('reconcile_revocations', rc);
  // 4b. W9 槽(缺省 `UNAVAILABLE_JUDGE.reduce`:空操作并报告 unavailable)
  const jr = await c.step('judge_reduce', () => ports.judge.run({}));
  if (jr !== undefined) {
    const rep = normalizeJudgeReport(jr);
    if (rep === null) c.faults.push({ code: 'judge_report_invalid' });
    else {
      recordJudgeBlocked(round, rep.blocked);
      if (rep.halted !== null) {
        const h = classifyHalt(rep.halted);
        if (h.kind === 'stop_step_unsettled') c.unsettled.push(`step_integrity:${h.cause}`);
        else if (h.kind === 'lock_lost_unresolved') {
          // 查不出是哪一把锁:不得默认当个人锁继续;这里只标未决并结束个人轮(停掉余下的写),
          // 归属由 `personal-stage` 在本步返回后 `resolveLockLoss`:rsi 锁已丢 = 原样上抛,个人锁 / 查不出 = 维持结束个人轮
          c.unsettled.push('lock_loss_unresolved');
          c.ended = true;
        }
      }
    }
  }
  // 5. 触发评估(唯一一次)+ S1 的熔断码合并成一次 trip
  const evald = await c.step('evaluate_triggers', async () => {
    budget.charge('evaluateTriggers');
    return ports.reduce.evaluateTriggers();
  });
  const merged = [...new Set<TripReason>([...p.tripSeed, ...(evald ?? [])])];
  if (merged.length > 0) {
    await c.step('trip_and_mute', async () => {
      budget.charge('tripAndMute');
      return ports.reduce.tripAndMute(merged);
    });
  }
  // 6. 自动解除(唯一一次)
  const rel = await c.step('auto_release', async () => {
    budget.charge('applyAutoRelease');
    return ports.reduce.applyAutoRelease();
  });
  if (rel !== undefined) c.note('auto_release', rel);
  return c.result();
}
