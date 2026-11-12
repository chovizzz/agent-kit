/**
 * 转移效果的续做(docs/contracts.md §21.24 W0-16「未完成的 effects 由调用方的持久化事务 / outbox 续做,不能靠事件重放补齐;实现与崩溃测试归 W7」)。
 *
 * 方案:**不新增 outbox 文件**。终态转移的效果(墓碑、聚类冷却、否决黑名单)全部可以由**已提交的终态记录**确定性地重新推出
 * ({@link effectsForTerminal}),所以「权威副本已提交、效果没落地」的窗口由 {@link recoverTerminalEffects} 补齐:扫全部终态记录,
 * 对每条记录按稳定键 {@link terminalEffectKey} 调 `KeyedEffectSink.applyOnce`(同键只生效一次,至少一次调用 + 按键幂等 = 恰好一次的效果)。
 * 回滚执行器在删 journal 之前同样调它,journal 在效果落地之前一直保留。
 * **不覆盖审计行**(`append_audit`):`AuditSink` 没有按键幂等,重放会重复行;审计缺失不影响任何安全判定,登记在汇报「遗留」。
 */
import { RSI_COOLDOWN_DAYS } from '../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';
import { RsiLockError } from '../lock-error.js';
import type { AuthoritativeStore } from './candidate-ports.js';
import type { KeyedEffectSink, KeyedEffectResult } from './rollback-ports.js';
import type { TransitionEffect } from './transition.js';
import { isTerminalLifecycle } from './transition-table.js';

/** 同一候选的同一份内容只有一次终态效果 */
export const terminalEffectKey = (
  rec: Pick<PersonalLifecycleRecord, 'id' | 'content_sha256'>,
): string => `terminal:${rec.id}:${rec.content_sha256}`;

/** 与转移引擎在「非终态 → 终态」时产出的效果逐项一致(`transition.ts` 的 `apply` 尾部);非终态记录返回空 */
export function effectsForTerminal(rec: PersonalLifecycleRecord): TransitionEffect[] {
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
  if (tr === 'auto_rollback') {
    out.push({
      type: 'start_cooldown',
      cluster_id: rec.cluster_id,
      kind: 'auto_rollback',
      days: RSI_COOLDOWN_DAYS.auto_rollback,
    });
  } else if (rec.lifecycle === 'expired') {
    out.push({
      type: 'start_cooldown',
      cluster_id: rec.cluster_id,
      kind: 'expired',
      days: RSI_COOLDOWN_DAYS.expired,
    });
  }
  return out;
}

export async function landTerminalEffects(
  sink: KeyedEffectSink,
  rec: PersonalLifecycleRecord,
): Promise<KeyedEffectResult | 'none'> {
  const effects = effectsForTerminal(rec);
  if (effects.length === 0) return 'none';
  return sink.applyOnce(terminalEffectKey(rec), effects);
}

export interface RecoverEffectsResult {
  /** 本次 `applied`(之前没落地)的候选 */
  applied: string[];
  already: string[];
  deferred: string[];
  /** 落地失败(下次再来) */
  failed: { id: string; why: string }[];
  /** 读权威副本不是 ok(没有任何动作) */
  skipped: string | null;
}

export async function recoverTerminalEffects(d: {
  store: Pick<AuthoritativeStore, 'readAll'>;
  effects: KeyedEffectSink;
}): Promise<RecoverEffectsResult> {
  const out: RecoverEffectsResult = {
    applied: [],
    already: [],
    deferred: [],
    failed: [],
    skipped: null,
  };
  const all = await d.store.readAll();
  if (all.kind !== 'ok') {
    out.skipped = all.kind;
    return out;
  }
  for (const rec of all.value) {
    try {
      const r = await landTerminalEffects(d.effects, rec);
      if (r === 'applied') out.applied.push(rec.id);
      else if (r === 'already') out.already.push(rec.id);
      else if (r === 'deferred') out.deferred.push(rec.id);
    } catch (e) {
      if (e instanceof RsiLockError && e.kind === 'lock_lost') throw e;
      out.failed.push({ id: rec.id, why: e instanceof Error ? e.message : 'error' });
    }
  }
  return out;
}
