/**
 * 压缩调度(C v1 §7;**调度,不实现**:`Compactor` 是 B1b 的真实现,装配处注入)。S1 之后、S2P 之前(此时没有 `SealRegion`,避开 `region_open`),每轮至多调一次。
 *  - `noop` / `compacted` 无事;
 *  - `compact_blocked{audit_full | effects_full}` → 日志码 `compact_<cause>`、`storeFull`(容量压力,verdict `store_full` 由 D 现读);**不停 S2**(减影响必须跑);
 *  - `compact_blocked{region_open | store_io}` / 抛错 / 非法返回 → 日志码 + 本轮 `compaction_failed`(unsettled);同样不停 S2;失锁分类走 `classify`(rsi 失锁上抛);
 *  - `compactor` 缺省(B1b 未装配)= `compact_unwired` 记一次,**不是故障**,verdict 不因它拒绝。
 */
import type { Compactor } from '../stage/ports.js';
import type { BothRound } from '../stage/round.js';
import { classify } from '../stage/errors.js';
import type { PersonalFault } from '../stage/errors.js';
import type { UnsettledReason } from '../stage/types.js';

export interface CompactionReport {
  /** 日志摘要码候选(`compact_<cause>`);`null` = 常态零行 */
  readonly logCode: string | null;
  readonly storeFull: boolean;
  readonly fault: PersonalFault | null;
  readonly unsettled: readonly UnsettledReason[];
  /** 个人锁丢失:结束个人轮 */
  readonly ended: boolean;
}

const CAUSES: ReadonlySet<string> = new Set([
  'audit_full',
  'effects_full',
  'region_open',
  'store_io',
]);
const CLEAN: CompactionReport = Object.freeze({
  logCode: null,
  storeFull: false,
  fault: null,
  unsettled: Object.freeze([]) as readonly UnsettledReason[],
  ended: false,
});

export async function runCompaction(
  compactor: Compactor | undefined,
  round: BothRound,
): Promise<CompactionReport> {
  if (compactor === undefined) return { ...CLEAN, logCode: 'compact_unwired' };
  try {
    const r: unknown = await compactor.compact(round);
    const k = (r as { kind?: unknown } | null)?.kind;
    if (k === 'noop' || k === 'compacted') return CLEAN;
    if (k === 'compact_blocked') {
      const cause = (r as { cause?: unknown }).cause;
      if (typeof cause === 'string' && CAUSES.has(cause)) {
        const full = cause === 'audit_full' || cause === 'effects_full';
        return {
          ...CLEAN,
          logCode: `compact_${cause}`,
          storeFull: full,
          unsettled: full ? [] : ['compaction_failed'],
        };
      }
    }
    return { ...CLEAN, logCode: 'compact_invalid', unsettled: ['compaction_failed'] };
  } catch (e) {
    const c = classify(e);
    if (c.kind === 'rethrow') throw e;
    if (c.kind === 'end_personal_round') {
      return { ...CLEAN, ended: true, unsettled: ['compaction_failed'] };
    }
    return { ...CLEAN, logCode: 'compact_threw', fault: c.fault, unsettled: ['compaction_failed'] };
  }
}
