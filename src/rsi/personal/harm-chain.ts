/**
 * W6 变差结论 → W1 转移引擎 → W7 回滚执行器的串接(docs/contracts.md R21-7.4 → R21-4.4 → R21-9.1)。**纯编排 + 端口**:
 *  1. `harmEvent(outcome)`(W6)只对 `harm` 结论产出 `TransitionEvent`(`harm` / `worse: true`),其余一律 `null` → 什么都不做;
 *  2. 能力闸:`rollback_four_phase`(V1b)不可用 → 拒绝(不写 journal、不写凭据);
 *  3. 交给执行器 `startRollback`:journal → 撤销凭据(`by = worker`,原因 `harm_<指标>`)→ 记录 `canary → rolling_back`(引擎)→ 私有仓库 → 清理 HOME。
 *     **凭据先于记录提交**:私有仓库 deferred / invalid 时凭据照样落盘,hint 照样停止注入(R21-9.3a)。
 * 缺端口(`cache` / `repo` / `payload` / `keyedEffects` 的 `unwired*`)时执行器返回 `incomplete`(journal 保留),不会假装完成。
 */
import { capabilityAvailable } from '../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';
import { harmEvent } from '../analysis/events.js';
import type { AnalysisOutcome } from '../analysis/run.js';
import { startRollback, type RollbackDeps, type RollbackOutcome } from './rollback.js';
import { terminationReason, terminationTarget } from './transition-table.js';

export type HarmChainResult =
  | { kind: 'no_event' }
  | { kind: 'refused'; why: 'not_canary' | 'phase_not_available' }
  | { kind: 'rolled'; outcome: RollbackOutcome };

export async function onAnalysisOutcome(
  d: RollbackDeps,
  outcome: AnalysisOutcome,
  rec: PersonalLifecycleRecord,
): Promise<HarmChainResult> {
  const event = harmEvent(outcome);
  if (event === null) return { kind: 'no_event' };
  if (rec.lifecycle !== 'canary' && rec.lifecycle !== 'rolling_back') {
    return { kind: 'refused', why: 'not_canary' };
  }
  const env = await d.env.read();
  if (!capabilityAvailable('rollback_four_phase', env.phase)) {
    return { kind: 'refused', why: 'phase_not_available' };
  }
  return {
    kind: 'rolled',
    outcome: await startRollback(d, {
      candidate_id: rec.id,
      content_sha256: rec.content_sha256,
      kind: 'rollback',
      reason: terminationReason(event),
      by: 'worker',
      target_terminal: terminationTarget(event),
      event,
    }),
  };
}
