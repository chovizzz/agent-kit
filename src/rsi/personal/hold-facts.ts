/**
 * `HoldFacts` 的真实现(装配块 B2;`write/ports.ts`):`rsi auto resume` 解除前**重查仍成立的码**(R21-10.2 重查列:`gate_internal`、`apply_failed`、`personal_repo_invalid`、`budget_high_legacy`)。
 *
 * **数据源核查结论(2026-11-15,B2 开工时逐项查代码与契约)**——快照 = 「条件仍成立」的码集合;**查不到数据源的一律按仍成立处理(不可用 → 拒绝解除,fail-closed)**:
 *  - `personal_repo_invalid`:**有真实数据源**——私有仓库的只读检视(`inspectPersonalRepo`:结构校验 + HEAD 判定,不写盘);结果 `invalid` 或检视本身抛错 → 仍成立;`absent` / `ok` / 情形②④(分叉 / 换主是独立标志)→ 不成立;
 *  - `budget_high_legacy`:**未查到数据源**——`TriggerFacts.budgetUsedPct` 在 `breaker.ts` 只有判定函数,全仓没有任何读取「自动配额占用百分比」的实现(`ingest-quota.ts` 是 ingest 每日名额,不是配额占用);→ 恒视为仍成立;
 *  - `gate_internal`:**未查到数据源**——该码由 G0–G7 的内部错误在发现点直接 `tripBreaker`,没有持久的「闸内部错误」事实可重查;→ 恒视为仍成立;
 *  - `apply_failed`:V2 的码(`RSI_AUTO_PAUSE_REASON_PHASE`),本期不发,也没有数据源;→ 恒视为仍成立。
 * 后果(写进交付汇报「问题」):`gate_internal` / `rollback_storm`(重查同一组四项)在 `budget_high_legacy` 等源接上之前**无法人工 `resume` 清除**——命令退 1 `RSI_AUTO_RESUME_BLOCKED`,由 worker(C)的触发 / 解除逻辑或后续数据源接线解决。
 */
import type { RsiAutoPauseReason } from '../../contracts/rsi.js';
import type { HoldFacts } from '../auto/write/ports.js';

export interface HoldFactsDeps {
  /** 私有仓库当前是否 `invalid`(只读检视);抛错由本函数按「仍成立」处理 */
  repoInvalid(): Promise<boolean>;
}

/** 没有数据源、按「仍成立」处理的码(拒绝解除) */
export const HOLDS_WITHOUT_SOURCE: readonly RsiAutoPauseReason[] = Object.freeze([
  'gate_internal',
  'apply_failed',
  'budget_high_legacy',
]);

export function makeHoldFacts(d: HoldFactsDeps): HoldFacts {
  return {
    async snapshot(): Promise<ReadonlySet<RsiAutoPauseReason>> {
      const out = new Set<RsiAutoPauseReason>(HOLDS_WITHOUT_SOURCE);
      let invalid = true; // 读不出 = 仍成立
      try {
        invalid = await d.repoInvalid();
      } catch {
        invalid = true;
      }
      if (invalid) out.add('personal_repo_invalid');
      return out;
    },
  };
}
