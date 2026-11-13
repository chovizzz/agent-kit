/**
 * 转移效果的续做(docs/contracts.md §21.24 W0-16「未完成的 effects 由调用方的持久化事务 / outbox 续做,不能靠事件重放补齐;实现与崩溃测试归 W7」)。
 *
 * 方案:**不新增 outbox 文件**。终态转移的效果(墓碑、聚类冷却、否决黑名单、保护审计标记)全部可以由**已提交的终态记录**确定性地重新推出
 * ({@link terminalEffectsOf},单一事实源,见 `terminal-effects.ts`;{@link effectsForTerminal} 是它的别名),所以「权威副本已提交、效果没落地」的窗口由 {@link recoverTerminalEffects} 补齐:扫全部终态记录,
 * 对每条记录按稳定键 {@link terminalEffectKey} 调 `KeyedEffectSink.applyOnce`(同键只生效一次,至少一次调用 + 按键幂等 = 恰好一次的效果)。
 * **E1 / E2 分层**:veto 事件的即时黑名单(E1,键 {@link vetoEffectKey})与终态批次(E2,键 `terminal:`)分开;E1 在回滚记录已提交、尚未到终态时崩溃的窗口由 `recoverTerminalEffects` 的第二遍补做
 * (扫 `lifecycle=rolling_back ∧ rollback.reason=vetoed`)。E1 与 E2 可含同一 `blacklist_veto(id, sha)`,正确性依赖该 effect 的**集合插入语义**(按 `(id, sha)` 插入,重复为空操作,附带计数不重复)。
 * 保护审计标记(`protection_mark`,W0-23)是 E2 批次的一员,与冷却、墓碑同一个 `terminal:` 键、同一次 `applyOnce`,见 {@link landTerminalEffects};它**不**走 `audit:` 键。
 * 回滚执行器在删 journal 之前同样调它,journal 在效果落地之前一直保留。
 * **审计行同样按键续做**(M6):转移条目(`record.transitions[]`)已是已提交的权威事实,审计行由条目确定性推出({@link auditItemsOf}),
 * 稳定键 = `audit:<候选>:<条目 idem_key>`({@link auditKeyOf};事件身份,不是行内容哈希),经同一个 `KeyedEffectSink` 落地(`append_audit` 效果;生产实现须与记键同一持久化步骤)。
 * 只覆盖**回滚路径产生的**条目(从进入 `rolling_back` / 终态的那一条起):更早的条目是各自转移当时直接追加的,不重放,免得重复。
 * **版本前提(W0-20 验收第 2 轮裁定,不做迁移)**:W7 从未发版,生产上不存在「旧版本已用无键 `d.audit` 直接追加了回滚审计」的记录;
 * 首个带回滚的发行版起,回滚审计一律经本带键出口。因此「补做」不会与更早版本的直接追加重复。若将来在此之前发布了无键回滚,须先补迁移 / 去重策略,不能沿用本前提。
 */
import type { PersonalLifecycleRecord, RsiAuditLine } from '../../contracts/rsi-personal.js';
import { RsiLockError } from '../lock-error.js';
import type { AuditSink, AuthoritativeStore } from './candidate-ports.js';
import type { KeyedEffectSink, KeyedEffectResult } from './rollback-ports.js';
import { auditOf } from './transition.js';
import {
  PROTECTION_UNCLASSIFIED_REASON,
  PROTECTION_UNKNOWN_REASON,
  terminalEffectKey,
  terminalEffectsOf,
  vetoEffectKey,
} from './terminal-effects.js';
import { originProtection } from './transition-table.js';

export {
  PROTECTION_UNCLASSIFIED_REASON,
  PROTECTION_UNKNOWN_REASON,
  terminalEffectKey,
  terminalEffectsOf,
  vetoEffectKey,
};

/** 与转移引擎在「非终态 → 终态」时产出的终态效果逐项一致(同调 {@link terminalEffectsOf});非终态记录返回空 */
export const effectsForTerminal = terminalEffectsOf;

/** 审计行的稳定事件键 = 候选 id + 产生这一行的转移条目的 `idem_key`(事件身份;**不是**行内容哈希:两个 evidence 不同的合法转移可以产生内容完全相同的行) */
export const auditKeyOf = (candidateId: string, idemKey: string): string =>
  `audit:${candidateId}:${idemKey}`;

export interface KeyedAuditItem {
  key: string;
  line: RsiAuditLine;
  idem_key: string;
}

/** 经回滚执行器到终态的终止理由(审计补做的范围) */
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

/** 回滚路径产生的审计行及其事件键:从第一条进入 `rolling_back` / 终态的 lifecycle 条目起(该条目之后的 deploy / rollback 条目同属一次回滚);即时落地与恢复共用同一个键 */
export function auditItemsOf(rec: PersonalLifecycleRecord): KeyedAuditItem[] {
  const i = rec.transitions.findIndex((e) => e.dim === 'lifecycle' && TERMINAL_OR_ROLLING(e.to));
  return i < 0
    ? []
    : rec.transitions.slice(i).map((e) => ({
        key: auditKeyOf(rec.id, e.idem_key),
        line: auditOf(e, rec.id),
        idem_key: e.idem_key,
      }));
}

/** 执行器的审计出口:每行经带键端口落地。缺事件身份(没有转移条目的审计,如终态空操作)→ 抛错(fail-closed,不回落到行内容哈希) */
export function keyedAuditSink(sink: KeyedEffectSink): AuditSink {
  const land = async (items: readonly { line: RsiAuditLine; idem_key?: string }[]) => {
    for (const it of items) {
      if (it.idem_key === undefined) throw new Error('audit_key_missing');
      await sink.applyOnce(auditKeyOf(it.line.id, it.idem_key), [
        { type: 'append_audit', line: it.line, idem_key: it.idem_key },
      ]);
    }
  };
  return { append: (lines) => land(lines.map((line) => ({ line }))), appendKeyed: land };
}

/** 补做回滚路径的审计行(按键幂等);任一行 `deferred` → `deferred`(其余行仍尽力落,不因一行推迟而漏做);否则有行落地 → `applied`;全是 `already` → `already`;没有行 → `none` */
export async function landAuditEffects(
  sink: KeyedEffectSink,
  rec: PersonalLifecycleRecord,
): Promise<KeyedEffectResult | 'none'> {
  let out: KeyedEffectResult | 'none' = 'none';
  for (const { key, line, idem_key } of auditItemsOf(rec)) {
    // 与即时路径同形(effect 带 idem_key),下游按 effect 字段校验时两条路径一致
    const r = await sink.applyOnce(key, [{ type: 'append_audit', line, idem_key }]);
    if (r === 'deferred') out = 'deferred';
    else if (out !== 'deferred' && (r === 'applied' || out === 'none')) out = r;
  }
  return out;
}

/**
 * 终态批次 E2 的落地:**整批一次** `applyOnce(terminal:<id>:<sha>)`——黑名单 / 墓碑 / 冷却与保护审计标记(`protection_mark`,W0-22 第 14 条)同键同批,
 * 即时路径(回滚执行器收尾)与恢复路径(`recoverTerminalEffects`)共用本函数。批次的结果就是整体结果:`deferred` 时标记也没有落,不存在「标记已落而冷却 deferred」或反过来。
 */
export async function landTerminalEffects(
  sink: KeyedEffectSink,
  rec: PersonalLifecycleRecord,
): Promise<KeyedEffectResult | 'none'> {
  const effects = terminalEffectsOf(rec);
  if (effects.length === 0) return 'none';
  return sink.applyOnce(terminalEffectKey(rec), effects);
}

/** 终态批次与回滚审计行两路落地结果的聚合:任一 `deferred` → 整体 `deferred`;否则取批次结果(审计行的 `applied` / `already` 不改变批次口径) */
export function aggregateLanding(
  batch: KeyedEffectResult | 'none',
  audit: KeyedEffectResult | 'none',
): KeyedEffectResult | 'none' {
  return audit === 'deferred' ? 'deferred' : batch;
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
  /** 第二遍(E1 补做):`rolling_back` 且 `rollback.reason=vetoed` 的候选,按 {@link vetoEffectKey} 补的黑名单 */
  veto: { applied: string[]; already: string[]; deferred: string[] };
  /** 终态记录里「自相矛盾、无法分类起因」的候选 id(`originProtection` = `unclassified`;已按保守方向发了冷却与 `protection_unclassified` 标记,这里只为可见) */
  unclassified: string[];
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
    veto: { applied: [], already: [], deferred: [] },
    unclassified: [],
  };
  const all = await d.store.readAll();
  if (all.kind !== 'ok') {
    out.skipped = all.kind;
    return out;
  }
  for (const rec of all.value) {
    try {
      const batch = await landTerminalEffects(d.effects, rec);
      if (batch !== 'none' && originProtection(rec).kind === 'unclassified')
        out.unclassified.push(rec.id);
      // 只补回滚执行器产生的终态(其余终态的审计行是转移当时直接追加的);审计行的 `deferred` 并入整体结果
      const audit =
        rec.terminal_reason !== null && EXECUTOR_TERMINAL_REASONS.has(rec.terminal_reason)
          ? await landAuditEffects(d.effects, rec)
          : 'none';
      const r = aggregateLanding(batch, audit);
      if (r === 'applied') out.applied.push(rec.id);
      else if (r === 'already') out.already.push(rec.id);
      else if (r === 'deferred') out.deferred.push(rec.id);
    } catch (e) {
      if (e instanceof RsiLockError && e.kind === 'lock_lost') throw e;
      out.failed.push({ id: rec.id, why: e instanceof Error ? e.message : 'error' });
    }
  }
  // 第二遍(E1):回滚已提交、仍在 rolling_back 且原因是 vetoed → 补即时黑名单(此前该窗口在终态之前没有黑名单)
  for (const rec of all.value) {
    if (rec.lifecycle !== 'rolling_back' || rec.rollback?.reason !== 'vetoed') continue;
    try {
      const r = await d.effects.applyOnce(vetoEffectKey(rec), [
        { type: 'blacklist_veto', id: rec.id, content_sha256: rec.content_sha256 },
      ]);
      out.veto[r].push(rec.id);
    } catch (e) {
      if (e instanceof RsiLockError && e.kind === 'lock_lost') throw e;
      out.failed.push({ id: rec.id, why: e instanceof Error ? e.message : 'error' });
    }
  }
  return out;
}
