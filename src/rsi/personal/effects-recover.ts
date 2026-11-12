/**
 * 转移效果的续做(docs/contracts.md §21.24 W0-16「未完成的 effects 由调用方的持久化事务 / outbox 续做,不能靠事件重放补齐;实现与崩溃测试归 W7」)。
 *
 * 方案:**不新增 outbox 文件**。终态转移的效果(墓碑、聚类冷却、否决黑名单)全部可以由**已提交的终态记录**确定性地重新推出
 * ({@link effectsForTerminal}),所以「权威副本已提交、效果没落地」的窗口由 {@link recoverTerminalEffects} 补齐:扫全部终态记录,
 * 对每条记录按稳定键 {@link terminalEffectKey} 调 `KeyedEffectSink.applyOnce`(同键只生效一次,至少一次调用 + 按键幂等 = 恰好一次的效果)。
 * 回滚执行器在删 journal 之前同样调它,journal 在效果落地之前一直保留。
 * **审计行同样按键续做**(M6):转移条目(`record.transitions[]`)已是已提交的权威事实,审计行由条目确定性推出({@link auditLinesOf}),
 * 稳定键 = `audit:<候选>:<行 canonical 哈希前 16 位>`({@link auditKeyOf}),经同一个 `KeyedEffectSink` 落地(`append_audit` 效果;生产实现须与记键同一持久化步骤)。
 * 只覆盖**回滚路径产生的**条目(从进入 `rolling_back` / 终态的那一条起):更早的条目是各自转移当时直接追加的,不重放,免得重复。
 */
import { createHash } from 'node:crypto';
import { RSI_COOLDOWN_DAYS } from '../../contracts/rsi.js';
import type { PersonalLifecycleRecord, RsiAuditLine } from '../../contracts/rsi-personal.js';
import { canonicalJson } from '../../io/canonical-json.js';
import { RsiLockError } from '../lock-error.js';
import type { AuthoritativeStore } from './candidate-ports.js';
import type { KeyedEffectSink, KeyedEffectResult } from './rollback-ports.js';
import type { TransitionEffect } from './transition.js';
import { auditOf } from './transition.js';
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

/** 审计行的稳定事件键:同一行(同一条转移条目)只落一次 */
export const auditKeyOf = (line: RsiAuditLine): string =>
  `audit:${line.id}:${createHash('sha256').update(canonicalJson(line), 'utf8').digest('hex').slice(0, 16)}`;

/** 经回滚执行器到终态的终态理由(审计补做的范围) */
const EXECUTOR_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'auto_rollback',
  'vetoed',
  'tainted',
  'cleared',
  'judge_rejected',
  'auto_expired',
]);

const TERMINAL_OR_ROLLING = (to: string): boolean =>
  to === 'rolling_back' ||
  to === 'rejected' ||
  to === 'expired' ||
  to === 'rolled_back' ||
  to === 'retired';

/** 回滚路径产生的审计行:从第一条进入 `rolling_back` / 终态的 lifecycle 条目起(该条目之后的 deploy / rollback 条目同属一次回滚) */
export function auditLinesOf(rec: PersonalLifecycleRecord): RsiAuditLine[] {
  const i = rec.transitions.findIndex((e) => e.dim === 'lifecycle' && TERMINAL_OR_ROLLING(e.to));
  return i < 0 ? [] : rec.transitions.slice(i).map((e) => auditOf(e, rec.id));
}

/** 补做回滚路径的审计行(按键幂等);返回本次落地(`applied`)的行数 */
export async function landAuditEffects(
  sink: KeyedEffectSink,
  rec: PersonalLifecycleRecord,
): Promise<number> {
  let applied = 0;
  for (const line of auditLinesOf(rec)) {
    const r = await sink.applyOnce(auditKeyOf(line), [{ type: 'append_audit', line }]);
    if (r === 'applied') applied += 1;
  }
  return applied;
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
      // 只补回滚执行器产生的终态(其余终态的审计行是转移当时直接追加的)
      if (rec.terminal_reason !== null && EXECUTOR_TERMINAL_REASONS.has(rec.terminal_reason)) {
        await landAuditEffects(d.effects, rec);
      }
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
