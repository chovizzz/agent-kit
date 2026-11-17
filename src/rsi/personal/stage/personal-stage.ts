/**
 * §21 V1 装配块 C1b——`PersonalStage` 的实现(纯编排;所有 I/O 经注入的端口工厂,本文件无 fs / 锁实现依赖)。
 *
 * `run(ctx)` 顺序(C v2 §3 状态机;C1b 只含 S0 与试锁):
 *  1. **S0**(只需 rsi 锁):`runEnforceLadder`。故障 → `faults[]` + 本轮 `safety_not_settled`(使 `evaluateGrowth` 拒绝);rsi 失锁原样上抛。
 *     S0 的真实写点(B 独占创建、`state.json` + 快照清单、`canary.json` 静音 / 删除)都发生在回合对象**建立之前**:它们就是安全动作本身,不置脏、不推进 `gen`(`gen` 只管已铸造的授权)。
 *  2. 试个人锁(`attemptPersonal`,永不抛;取锁本身会建目录 / 回收旧锁,所以「C1b 无个人侧持久写」不成立,只有「无业务写」成立)→ `openRound`。
 *     忙 → `personal_busy`;故障 → `personal_fault`;`update_busy` → S3 不可达(`growthAccessOf`)。
 *  3. 显式复核点:个人锁 `assertHeld`(丢失 → 结束个人轮,`growth = lock_lost`,本轮未决)、rsi 锁 `assertHeld`(丢失 → 原样上抛)。**不靠 `release()` 暴露失锁**。
 *  4. 个人锁取得后的**整个 run 体都在 try / finally 内**:任何非端口抛点(`openRound`、`l0DueNow` 等)也释放个人锁。
 *  S1 / S2 / 压缩 / S3 在 C1b **没有端口、不被调用**(C2 / D 才有);`flags` / `rollback_stalled` / `protection_marks` 因此是「未计算」的空值,**不是**「已确认无」——
 *  未接线期间的拒绝由 `GrowthStage` 缺省(`growth_unwired`)承担,装配无 `GrowthStage`。
 * **`PersonalRound.growth.open` 带的 `BothRound` 不是返回后仍有效的持锁授权**:个人锁在 `run` 返回之前已释放。S3(D)必须在 `run` 内、释放个人锁之前运行;C1b 的 worker 不消费它。
 *
 * `safetyFallback(ctx)`:`runFallbackLadder`,永不抛(含 rsi 失锁 → `aborted`)。`eligible()`:纯判定,抛错 = 不进(fail-closed)。
 */
import { classify, isRsiLockLost } from './errors.js';
import type { PersonalFault } from './errors.js';
import { runEnforceLadder, runFallbackLadder, type S0Ports } from './ladder.js';
import { attemptPersonal } from './lock-identity.js';
import type { FallbackPorts, SafetyPort } from './ports.js';
import {
  growthAccessOf,
  markRoundUnsettled,
  openRound,
  type BothRound,
  type RsiOnlyRound,
} from './round.js';
import {
  runBothSteps,
  runRsiOnlySteps,
  type BothPorts,
  type StepsResult,
} from '../steps/run-steps.js';
import type { S1Flags } from '../steps/s1-recover.js';
import type {
  FallbackCtx,
  FallbackReport,
  PersonalCtx,
  PersonalRound,
  PersonalStage,
} from './types.js';

export interface PersonalStageDeps {
  /** 相位 + 能力资格(无 IO);抛错 = 不 eligible */
  eligible(): boolean;
  /** 每次 `run` 现建的 S0 端口(装配处用真实 I/O 适配器构造) */
  s0Ports(ctx: PersonalCtx): S0Ports;
  /** 每次兜底现建的端口(**必须是显式字段构造的窄对象**,不得把含 state 写能力的宽对象直接传入) */
  fallbackPorts(ctx: FallbackCtx): FallbackPorts;
  /** 个人锁取锁器(装配处注入真实 `acquirePersonalLock`) */
  acquirePersonal(ctx: PersonalCtx): Parameters<typeof attemptPersonal>[0];
  /** 本轮 L0 是否到期(S3 节流依据,用当前 state 现算);抛错按 false(不到期 = 不增影响) */
  l0DueNow(ctx: PersonalCtx): Promise<boolean>;
  /**
   * **C2**(可选;缺省 = C1b 行为:只有 S0 与试锁):S1 / 压缩 / S2 / `T_rsi` / 单次扫尾的端口工厂。装配层每次 `run` 现建
   * (持两锁:`both` 收本轮 `BothRound`,写端口经 `round.writeAdapter` 包装;忙 / 故障:`rsiOnly` 只给 rsi 侧 `SafetyPort`)。
   */
  steps?: {
    both(ctx: PersonalCtx, round: BothRound): BothPorts;
    rsiOnly(ctx: PersonalCtx, round: RsiOnlyRound): SafetyPort;
    /** 读盘上最终的两个标志(给 `PersonalRound.flags`);读不出 = `null`(按未知处理,不臆测) */
    flags?(ctx: PersonalCtx): Promise<S1Flags | null>;
  };
}

const safetyFaultOf = (kind: string): PersonalFault => ({
  code: 'step_halted',
  detail: `safety_fault:${kind}`,
});

export function createPersonalStage(deps: PersonalStageDeps): PersonalStage {
  return {
    eligible(): boolean {
      try {
        return deps.eligible() === true;
      } catch {
        return false;
      }
    },

    async safetyFallback(ctx: FallbackCtx): Promise<FallbackReport> {
      try {
        return await runFallbackLadder(deps.fallbackPorts(ctx));
      } catch (e) {
        if (isRsiLockLost(e)) return { kind: 'aborted', why: 'rsi_lock_lost' };
        return { kind: 'threw', name: e instanceof Error ? e.name : typeof e };
      }
    },

    async run(ctx: PersonalCtx): Promise<PersonalRound> {
      const faults: PersonalFault[] = [];
      let s0Clean = true;

      // ---- S0 ----
      try {
        const r = await runEnforceLadder(deps.s0Ports(ctx));
        if (r.fault !== null) {
          faults.push(safetyFaultOf(r.fault));
          s0Clean = false;
        }
      } catch (e) {
        const c = classify(e);
        if (c.kind === 'rethrow') throw e;
        s0Clean = false;
        faults.push(
          c.kind === 'fault'
            ? c.fault
            : { code: 'internal', detail: 'personal_lock_lost_in_safety_step' },
        );
      }

      // ---- 试个人锁 ----
      const attempt = await attemptPersonal(async () => deps.acquirePersonal(ctx)());
      const held = attempt.kind === 'held' ? attempt.personal : null;
      try {
        const open = openRound(ctx.lock, attempt);
        if (!s0Clean) markRoundUnsettled(open.round, 'safety_not_settled');
        if (open.kind === 'rsi_only' && open.fault !== null) faults.push(open.fault);

        let lockLost = false;
        if (held !== null) {
          try {
            await held.assertHeld();
          } catch (e) {
            const c = classify(e);
            if (c.kind === 'rethrow') throw e;
            if (c.kind === 'fault') {
              faults.push(c.fault);
            }
            lockLost = c.kind === 'end_personal_round';
            markRoundUnsettled(open.round, 'safety_not_settled');
          }
        }
        let l0DueNow = false;
        try {
          l0DueNow = (await deps.l0DueNow(ctx)) === true;
        } catch (e) {
          if (isRsiLockLost(e)) throw e;
          l0DueNow = false;
        }

        // ---- C2:S2R → S1 → 压缩 → S2P → 扫尾(忙 / 故障:S2R → T_rsi → 扫尾) ----
        let flags: S1Flags = { diverged: false, owner_changed: false };
        if (deps.steps !== undefined && !lockLost) {
          let sr: StepsResult | null = null;
          try {
            sr =
              open.kind === 'both'
                ? await runBothSteps({
                    ports: deps.steps.both(ctx, open.round),
                    round: open.round,
                    l0DueNow,
                  })
                : await runRsiOnlySteps({
                    safety: deps.steps.rsiOnly(ctx, open.round),
                    round: open.round,
                  });
          } catch (e) {
            const c = classify(e);
            if (c.kind === 'rethrow') throw e;
            markRoundUnsettled(open.round, 'safety_not_settled');
            if (c.kind === 'end_personal_round') lockLost = true;
            else faults.push(c.fault);
          }
          if (sr !== null) {
            faults.push(...sr.faults);
            for (const r of sr.unsettled) markRoundUnsettled(open.round, r);
            if (sr.ended) {
              lockLost = true; // 个人锁丢失:结束个人轮,余下写不依赖失效句柄
              markRoundUnsettled(open.round, 'safety_not_settled');
            }
            if (sr.flagsTarget !== null) flags = { ...flags, ...sr.flagsTarget };
          }
          try {
            const f = (await deps.steps.flags?.(ctx)) ?? null;
            if (f !== null) flags = f;
          } catch (e) {
            if (isRsiLockLost(e)) throw e;
          }
        }

        // 返回前最后一次 rsi 锁复核:丢失 = 原样上抛(finally 释放个人锁)
        await ctx.lock.assertHeld();

        return {
          growth: growthAccessOf(open, { updateBusy: ctx.updateBusy, lockLost }),
          faults,
          unsettled: open.round.unsettled(),
          l0DueNow,
          flags,
          rollback_stalled: [],
          protection_marks: [],
        };
      } finally {
        if (held !== null) await held.release().catch(() => undefined);
      }
    },
  };
}
