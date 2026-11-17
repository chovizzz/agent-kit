/**
 * S1 恢复步(C v1 §5 / v2 §8.4;持两把锁)。五项各自独立 try,任一失败不挡下一项;`classify`:rsi 失锁原样上抛,个人失锁结束个人轮(`ended`)。
 * 只编排,不含 I/O:全部副作用在 `RecoveryPort`(装配处实现并经 `round.writeAdapter` 包装)。
 *
 *  1. 仓库 + journal 续做(`recoverRepo`;bootstrap 守卫在端口内,见 `repo-recover.ts`);
 *  2. 标志重算(W0-25):judged ① → 清 `diverged` / `owner_changed`;② → `diverged`;④ → `owner_changed`;③ / absent / incomplete / 抛错 → **不动**。有更新才调 `setFlagAndMute`(一次 state 写 + 紧随静音,预算 ≤1);写失败 → 故障,**不清标志**(宁可多停);
 *  3. `resumeRollbacks`;4. `recoverTerminalEffects`;5. `reconcileRevocations`(含 canary 级:凭据命中 canary 且无 journal → 启动 reconcile 回滚)。
 * 仓库不可用(invalid)**不在 S1 里 trip**:熔断预算每轮 ≤1,由 S2P 第 5 步把 `personal_repo_invalid` 与其它触发码**合并成一次** `tripAndMute`(返回 `tripReasons`)。
 * 任何一项 `incomplete` 只进 `faults` / `incomplete`;是否拒绝增影响由 `evaluateGrowth` 现读(不读本报告)。
 */
import type { TripReason } from '../stage/types.js';
import { classify, classifyHalt } from '../stage/errors.js';
import type { PersonalFault } from '../stage/errors.js';
import type { RecoveryPort, StepOutcome } from '../stage/ports.js';
import type { RoundBudget } from '../stage/settle.js';
import { faultOfOutcome, tagOf } from './steps-types.js';
import type { UnsettledReason } from '../stage/types.js';

export interface S1Flags {
  readonly diverged: boolean;
  readonly owner_changed: boolean;
}
export interface S1Result {
  readonly faults: readonly PersonalFault[];
  readonly unsettled: readonly UnsettledReason[];
  /** 本轮对标志的结论:`null` = 未得出结论(保持盘上原值) */
  readonly flagsTarget: Partial<S1Flags> | null;
  /** 需要并入 S2P 触发的熔断码(仓库不可用) */
  readonly tripReasons: readonly TripReason[];
  readonly incomplete: readonly string[];
  /** 个人锁丢失:余下步骤跳过 */
  readonly ended: boolean;
}

/** 适配器把 `StepHalt` 编码进 `incomplete.why` 的前缀(`halt:<StepHalt>`),编排层统一分类 */
export const HALT_PREFIX = 'halt:';

export async function runS1(p: {
  readonly recovery: RecoveryPort;
  readonly budget: RoundBudget;
}): Promise<S1Result> {
  const faults: PersonalFault[] = [];
  const unsettled: UnsettledReason[] = [];
  const incomplete: string[] = [];
  const tripReasons: TripReason[] = [];
  let flagsTarget: Partial<S1Flags> | null = null;
  let ended = false;

  /** 返回 `false` = 个人锁丢失,停止余下步骤 */
  const guarded = async (name: string, fn: () => Promise<StepOutcome>): Promise<boolean> => {
    try {
      const o = await fn();
      noteOutcome(name, o);
      return true;
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'rethrow') throw e;
      if (c.kind === 'end_personal_round') {
        ended = true;
        return false;
      }
      faults.push(c.fault);
      return true;
    }
  };
  const noteOutcome = (name: string, o: StepOutcome): void => {
    if (o.kind === 'incomplete' && o.why.startsWith(HALT_PREFIX)) {
      const h = classifyHalt(o.why.slice(HALT_PREFIX.length) as never);
      if (h.kind === 'stop_step_unsettled') unsettled.push(`step_integrity:${h.cause}`);
      else if (h.kind === 'lock_lost_unresolved') unsettled.push('lock_loss_unresolved');
    }
    const f = faultOfOutcome(name, o);
    if (f !== null) faults.push(f);
    if (o.kind === 'incomplete') incomplete.push(tagOf(name));
  };

  // 1. 仓库 + journal
  try {
    const r = await p.recovery.recoverRepo();
    switch (r.kind) {
      case 'invalid':
        tripReasons.push('personal_repo_invalid');
        break;
      case 'incomplete':
        incomplete.push(tagOf(`repo:${r.why}`));
        faults.push({ code: 'step_halted', detail: tagOf(`recovery_incomplete:${r.why}`) });
        break;
      case 'judged':
        if (r.judgement === 'at_record') flagsTarget = { diverged: false, owner_changed: false };
        else if (r.judgement === 'diverged') flagsTarget = { diverged: true };
        else if (r.judgement === 'owner_changed') flagsTarget = { owner_changed: true };
        break;
      case 'absent':
      case 'deferred':
        break;
    }
  } catch (e) {
    const c = classify(e);
    if (c.kind === 'rethrow') throw e;
    if (c.kind === 'end_personal_round') return done();
    faults.push(c.fault);
  }

  // 2. 标志(有结论才写;写失败不清标志)
  if (flagsTarget !== null && !ended) {
    const target = flagsTarget;
    const ok = await guarded('set_flags', async () => {
      p.budget.charge('setFlagAndMute');
      return p.recovery.setFlagAndMute(target);
    });
    if (!ok) return done();
  }
  // 3–5
  if (!ended && !(await guarded('resume_rollbacks', () => p.recovery.resumeRollbacks())))
    return done();
  if (!ended && !(await guarded('terminal_effects', () => p.recovery.recoverTerminalEffects()))) {
    return done();
  }
  if (!ended) await guarded('reconcile_revocations', () => p.recovery.reconcileRevocations());
  return done();

  function done(): S1Result {
    return { faults, unsettled, flagsTarget, tripReasons, incomplete, ended };
  }
}
