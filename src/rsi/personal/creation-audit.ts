/**
 * 候选**创建行**的审计行:单一派生函数 + 崩溃后补做(§21 V1 D1b-2;W0-30;设计稿 D1b b6d / I13)。
 *
 * 创建行 `(无) → proposed`(reason `ingested`)是权威记录 `transitions[]` 里的一个条目,审计行由条目确定性推出({@link creationAuditItems}):
 * 事件时间取**条目里的 `at`**(不是补做时的 now),稳定键 = `audit:<候选>:<条目 idem_key>`(`auditKeyOf`,与回滚路径的带键出口同一个键空间)。
 * **唯一的派生点就是本文件**:`runPersonalStep` 的即时落地、{@link recoverCreationAudits}(提交后崩溃的补做)与 B1b 对账源 `store/reconcile-source.ts` 的 `derivedOf` 都调它,
 * 所以三者对同一条创建行的 `at` / `idem_key` / 行内容不会漂移。
 * **依赖方向(定死)**:`store/reconcile-source.ts` → 本文件;本文件(与整个 `personal/`)**不得** import `store/`——否则存储核进入 `candidate-step.ts` 的运行时闭包(`inert.test.ts` 红)。
 */
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';
import { RsiLockError } from '../lock-error.js';
import { CREATION_FROM } from './candidate-record.js';
import type { AuthoritativeStore } from './candidate-ports.js';
import { auditKeyOf, type KeyedAuditItem } from './effects-recover.js';
import type { KeyedEffectResult, KeyedEffectSink } from './rollback-ports.js';
import { auditOf, type TransitionEntry } from './transition.js';

/** 创建行:`transitions[0]`(256 条窗口截断后它可能已不是创建行,所以按内容核对,不按下标假定) */
const isCreationEntry = (e: TransitionEntry): boolean =>
  e.dim === 'lifecycle' &&
  e.from === CREATION_FROM &&
  e.to === 'proposed' &&
  e.reason === 'ingested';

/** 记录里的创建行对应的审计行(0 或 1 条;事件时间 = 条目的 `at`) */
export function creationAuditItems(rec: PersonalLifecycleRecord): KeyedAuditItem[] {
  const e = rec.transitions[0];
  if (e === undefined || !isCreationEntry(e)) return [];
  return [{ key: auditKeyOf(rec.id, e.idem_key), line: auditOf(e, rec.id), idem_key: e.idem_key }];
}

export interface RecoverCreationAuditsResult {
  /** 本次 `applied`(之前没落地)的候选 */
  applied: string[];
  already: string[];
  deferred: string[];
  /** 落地失败(下次再来) */
  failed: { id: string; why: string }[];
  /** 读权威副本不是 ok(没有任何动作) */
  skipped: string | null;
}

/**
 * 补做创建行审计:扫全部权威记录,对每条创建行按稳定键 `applyOnce`(同键只生效一次;重复调用得 `already`,不重复落行)。
 * 提交后、审计落地前崩溃的窗口由它补;补的行用**记录里的 `at`**,不用补做时刻。读不到权威副本 → `skipped`(不当成「没有缺行」)。
 * 单个候选的落地失败不挡其余候选;丢锁(`RsiLockError lock_lost`)立即上抛。
 */
export async function recoverCreationAudits(d: {
  store: Pick<AuthoritativeStore, 'readAll'>;
  sink: KeyedEffectSink;
}): Promise<RecoverCreationAuditsResult> {
  const out: RecoverCreationAuditsResult = {
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
    for (const { key, line, idem_key } of creationAuditItems(rec)) {
      let r: KeyedEffectResult;
      try {
        r = await d.sink.applyOnce(key, [{ type: 'append_audit', line, idem_key }]);
      } catch (e) {
        if (e instanceof RsiLockError && e.kind === 'lock_lost') throw e;
        out.failed.push({ id: rec.id, why: e instanceof Error ? e.message : 'error' });
        continue;
      }
      (r === 'applied' ? out.applied : r === 'already' ? out.already : out.deferred).push(rec.id);
    }
  }
  return out;
}
