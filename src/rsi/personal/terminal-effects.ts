/**
 * 终态效果的**单一事实源**(owner 2026-11-12 决定 1「保留原保护」;docs/contracts.md R21-11.1 / R21-11.3 / R21-11.4):
 * `terminalEffectsOf(final)` 由已提交的终态记录确定性算出终态效果批次 E2,转移引擎的尾部(非终态 → 终态)与恢复(`effects-recover.ts` 的 `effectsForTerminal`)同调它,不再各写一份。
 * 批次顺序固定:`blacklist_veto`(`terminal_reason === 'vetoed'`)→ `write_tombstone` → 冷却 → 保护审计标记。落地键仍是 `terminalEffectKey`。
 *
 * 冷却口径(「原来发什么就发什么」,不加新规则):
 *  1. 改前规则(终态事实):`terminal_reason === 'auto_rollback'` → 90 天 `auto_rollback`;否则 `lifecycle === 'expired'` → 30 天 `expired`;
 *  2. 按进入回滚的起因补(并集)({@link originProtection}):`known`:起因的终态理由为 `auto_rollback`(harm_c1 / c2 / c3 / c4 / c6)→ 90 天;起因目标 `expired`(`limit_reached`)→ 30 天;
 *     判定类(`judge_*`)现行无冷却,不新增;`cleared / vetoed / tainted` 作起因照现行。**至多一条冷却**(改前规则 ∪ origin 规则同时有 90 天与 30 天时只发 90 天;例:`limit_reached` 进入回滚、补偿期间又收到 `harm_c1`);
 *  3. `unknown_rollback_origin`(回滚路径的起因条目因截断丢失)与 `unclassified`(自相矛盾的记录):改前规则没给冷却时按保守方向补 90 天 `auto_rollback`,并各发一条审计标记
 *     (`reason = protection_unknown` / `protection_unclassified`;既有 `kind = reconcile`,不新增 schema 键或枚举;`at` 取终态那条 lifecycle 条目的时间,所以即时与恢复得同一行)。
 *     撤销、墓碑、清理照常完成,不因分类失败而阻塞。
 * 本文件不 import `transition.ts` 的值(只取类型),避免引擎与恢复互相依赖。
 */
import { RSI_COOLDOWN_DAYS } from '../../contracts/rsi.js';
import type { PersonalLifecycleRecord, RsiAuditLine } from '../../contracts/rsi-personal.js';
import { idemKey } from './ids.js';
import type { TransitionEffect } from './transition.js';
import { isTerminalLifecycle, originProtection, terminalReasonOf } from './transition-table.js';

/** 同一候选的同一份内容只有一次终态效果 */
export const terminalEffectKey = (
  rec: Pick<PersonalLifecycleRecord, 'id' | 'content_sha256'>,
): string => `terminal:${rec.id}:${rec.content_sha256}`;

/** E1(veto 事件的即时黑名单)的落地键;与 {@link terminalEffectKey} 不同,所以 E1 与 E2 可含同一 `blacklist_veto(id, sha)`,正确性靠 effect 级「按 (id, sha) 集合插入、重复为空操作」 */
export const vetoEffectKey = (
  rec: Pick<PersonalLifecycleRecord, 'id' | 'content_sha256'>,
): string => `veto:${rec.id}:${rec.content_sha256}`;

export const PROTECTION_UNKNOWN_REASON = 'protection_unknown';
export const PROTECTION_UNCLASSIFIED_REASON = 'protection_unclassified';

type Cooldown = Extract<TransitionEffect, { type: 'start_cooldown' }>;

const cooldown = (rec: PersonalLifecycleRecord, kind: Cooldown['kind']): Cooldown => ({
  type: 'start_cooldown',
  cluster_id: rec.cluster_id,
  kind,
  days: RSI_COOLDOWN_DAYS[kind],
});

/** 改前规则:只看终态事实 */
function legacyCooldown(rec: PersonalLifecycleRecord): Cooldown | null {
  if (rec.terminal_reason === 'auto_rollback') return cooldown(rec, 'auto_rollback');
  if (rec.lifecycle === 'expired') return cooldown(rec, 'expired');
  return null;
}

/** 保护审计标记行(确定性:`at` = 终态那条 lifecycle 条目的时间,取不到最后一条条目的;都没有 → 不发标记) */
function protectionAudit(
  rec: PersonalLifecycleRecord,
  reason: string,
): Extract<TransitionEffect, { type: 'append_audit' }> | null {
  const terminalEntry = [...rec.transitions]
    .reverse()
    .find((e) => e.dim === 'lifecycle' && e.to === rec.lifecycle);
  const at = (terminalEntry ?? rec.transitions[rec.transitions.length - 1])?.at;
  if (at === undefined) return null;
  const line: RsiAuditLine = {
    at,
    kind: 'reconcile',
    id: rec.id,
    dim: 'lifecycle',
    from: 'rolling_back',
    to: rec.lifecycle,
    reason,
    counts: { cooldown_days: RSI_COOLDOWN_DAYS.auto_rollback },
  };
  return {
    type: 'append_audit',
    line,
    idem_key: idemKey({
      id: rec.id,
      dim: 'lifecycle',
      from: 'rolling_back',
      to: rec.lifecycle,
      evidence: `${reason}:${rec.content_sha256}`,
    }),
  };
}

/** E2:终态记录的效果批次;非终态返回空。纯函数,只读记录 */
export function terminalEffectsOf(rec: PersonalLifecycleRecord): TransitionEffect[] {
  if (!isTerminalLifecycle(rec.lifecycle)) return [];
  const tr = rec.terminal_reason;
  const out: TransitionEffect[] = [];
  if (tr === 'vetoed') {
    out.push({ type: 'blacklist_veto', id: rec.id, content_sha256: rec.content_sha256 });
  }
  out.push({
    type: 'write_tombstone',
    id: rec.id,
    terminal: rec.lifecycle,
    reason: tr ?? 'unknown',
  });
  const legacy = legacyCooldown(rec);
  const origin = originProtection(rec);
  let fromOrigin: Cooldown | null = null;
  let markReason: string | null = null;
  switch (origin.kind) {
    case 'not_applicable':
      break;
    case 'known':
      if (terminalReasonOf(origin.origin_reason) === 'auto_rollback') {
        fromOrigin = cooldown(rec, 'auto_rollback');
      } else if (origin.origin_target === 'expired') {
        fromOrigin = cooldown(rec, 'expired');
      }
      break;
    case 'unknown_rollback_origin':
    case 'unclassified':
      // 改前规则已给冷却则不变(也不发标记);否则保守方向 90 天 + 审计标记
      if (legacy === null) {
        fromOrigin = cooldown(rec, 'auto_rollback');
        markReason =
          origin.kind === 'unknown_rollback_origin'
            ? PROTECTION_UNKNOWN_REASON
            : PROTECTION_UNCLASSIFIED_REASON;
      }
      break;
  }
  // 冷却至多一条:改前规则 ∪ origin 规则,同时有 90 天与 30 天时只留 90 天(保护取强)
  const chosen = [legacy, fromOrigin].filter((c): c is Cooldown => c !== null);
  const strongest = chosen.find((c) => c.kind === 'auto_rollback') ?? chosen[0];
  if (strongest !== undefined) out.push(strongest);
  if (markReason !== null) {
    const mark = protectionAudit(rec, markReason);
    if (mark !== null) out.push(mark);
  }
  return out;
}
