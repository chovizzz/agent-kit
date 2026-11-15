/**
 * 真 `ReconcileSource` 适配器(B1b;设计稿 v3 §E 第 7 项、§B.3、§C.3;§21.24 W0-26 第 8、9 条):从**权威记录**(私有仓库 `lifecycle/<id>.json`)读出压缩要证明的集合。
 * 业务只依赖窄端口 {@link RecordsPort}(`readAll` 的结构类型,不 import 候选存储的类型;生产由 C 把 `AuthoritativeStore.readAll` 接进来),本文件无 I/O、无锁、无缓存:
 * **每次方法调用都重读一遍**(`resolve` 也一样,跨调用不缓存,所以压缩期间权威记录的变化不会被旧快照掩盖)。
 *
 * 数据来源(逐方法):
 *  - `entriesThrough(W)`:每条记录的 `transitions[]` 里日期 ≤ W 的条目 `{id, idem_key, at}`(记录因 >256 条窗口截断而丢失的条目不在其中,契约豁免);
 *  - `derivedThrough(W)`:R1–R4 = 每个条目 `auditOf(entry, id)` + `idem_key`(与即时落地的行同形,条目 `idem_key` 就是行的 `idem_key`);R7 = 终态记录的保护标记
 *    (`terminalEffectsOf` 里的 `protection_mark`:行 + 它自己的 `idem_key`);日期取行的 `at`;R5 / R6 / R8 无权威源,不在内;
 *  - `batchesThrough(W)`:E2 = 终态记录的账类效果(键 `terminal:<id>:<sha>`,`event_at` = 终态 lifecycle 条目的 `at`,与 `protectionAudit` 同一取法);
 *    E1 = `rolling_back ∧ rollback.reason = vetoed` 的黑名单(键 `veto:<id>:<sha>`,`event_at` = 进入 `rolling_back` 的条目 `at`;该条目因截断丢失时取最早留存条目的 `at`,它是上界)。只含事件日 ≤ W 的批次
 *    (`recoverThrough` 对越界批次整个拒绝);
 *  - `resolve(locator, idem_key)`:重读记录,在全部派生行里按 `idem_key` 找(键里含候选 id,全局唯一);找不到 → `null`。locator 只校验种类,不信任其 `ref`。
 * 读失败 / 记录不合规一律抛(`store_io` / `state_invalid`),**不得以空集通过**。
 */
import {
  PersonalLifecycleRecordSchema,
  type PersonalLifecycleRecord,
} from '../../contracts/rsi-personal.js';
import { utcDay, type UtcDay } from '../../contracts/rsi-store.js';
import {
  terminalEffectKey,
  terminalEffectsOf,
  vetoEffectKey,
} from '../personal/terminal-effects.js';
import { isTerminalLifecycle } from '../personal/transition-table.js';
import { auditOf } from '../personal/transition.js';
import { StoreError } from './errors.js';
import type {
  AuthoritativeEvent,
  DerivedRow,
  ReconcileEntry,
  ReconcileSource,
  RecoveryBatch,
  SourceLocator,
} from './ports.js';

/** 权威记录的窄读端口(与 `AuthoritativeStore.readAll` 结构兼容):`kind !== 'ok'` = 读不到 */
export interface RecordsPort {
  readAll(): Promise<{ kind: 'ok'; value: readonly unknown[] } | { kind: string }>;
}

const LOCATOR_KINDS: readonly string[] = ['entry', 'protection', 'effects'];

async function load(port: RecordsPort): Promise<PersonalLifecycleRecord[]> {
  let r: Awaited<ReturnType<RecordsPort['readAll']>>;
  try {
    r = await port.readAll();
  } catch (e) {
    if (e instanceof StoreError) throw e;
    throw new StoreError('store_io', 'records_read');
  }
  if (r.kind !== 'ok') throw new StoreError('store_io', `records_${r.kind}`);
  const out: PersonalLifecycleRecord[] = [];
  for (const raw of (r as { value: readonly unknown[] }).value) {
    const p = PersonalLifecycleRecordSchema.safeParse(raw);
    if (!p.success) throw new StoreError('state_invalid', 'record_invalid');
    out.push(p.data);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

const byLocator = (a: { idem_key: string }, b: { idem_key: string }): number =>
  a.idem_key < b.idem_key ? -1 : a.idem_key > b.idem_key ? 1 : 0;

function derivedOf(rec: PersonalLifecycleRecord): DerivedRow[] {
  const rows: DerivedRow[] = rec.transitions.map((e) => ({
    idem_key: e.idem_key,
    row: { ...auditOf(e, rec.id), idem_key: e.idem_key },
    locator: { kind: 'entry', ref: `${rec.id}:${e.idem_key}` },
  }));
  for (const e of terminalEffectsOf(rec)) {
    if (e.type !== 'protection_mark') continue;
    rows.push({
      idem_key: e.idem_key,
      row: { ...e.line, idem_key: e.idem_key },
      locator: { kind: 'protection', ref: `${rec.id}:${e.idem_key}` },
    });
  }
  return rows;
}

/** E2 的 `event_at`:终态那条 lifecycle 条目;取不到则最后一条(与 `protectionAudit` 同一取法) */
const terminalAt = (rec: PersonalLifecycleRecord): string | undefined =>
  (
    [...rec.transitions].reverse().find((e) => e.dim === 'lifecycle' && e.to === rec.lifecycle) ??
    rec.transitions[rec.transitions.length - 1]
  )?.at;

/** E1 的 `event_at`:第一条进入 `rolling_back` 的条目;丢失时取最早留存条目(上界) */
const rollbackEnteredAt = (rec: PersonalLifecycleRecord): string | undefined =>
  (
    rec.transitions.find(
      (e) => e.dim === 'lifecycle' && e.to === 'rolling_back' && e.from !== 'rolling_back',
    ) ?? rec.transitions[0]
  )?.at;

export function createReconcileSource(deps: { records: RecordsPort }): ReconcileSource {
  return {
    async entriesThrough(W: UtcDay): Promise<readonly ReconcileEntry[]> {
      const out: ReconcileEntry[] = [];
      for (const rec of await load(deps.records)) {
        for (const e of rec.transitions) {
          if (utcDay(e.at) <= W) out.push({ id: rec.id, idem_key: e.idem_key, at: e.at });
        }
      }
      return out.sort(byLocator);
    },
    async batchesThrough(W: UtcDay): Promise<readonly RecoveryBatch[]> {
      const out: RecoveryBatch[] = [];
      for (const rec of await load(deps.records)) {
        if (isTerminalLifecycle(rec.lifecycle)) {
          const effects = terminalEffectsOf(rec).filter(
            (e) =>
              e.type === 'blacklist_veto' ||
              e.type === 'write_tombstone' ||
              e.type === 'start_cooldown',
          );
          const at = terminalAt(rec);
          // 有账效果却取不到权威事件时间:无法证明它是否落在封存区间,不能跳过(也不能拿 now 补)= fail-closed
          if (effects.length > 0 && at === undefined) {
            throw new StoreError('state_invalid', 'event_time_missing');
          }
          if (effects.length > 0 && at !== undefined && utcDay(at) <= W) {
            out.push({
              key: terminalEffectKey(rec),
              effects,
              meta: { event_at: at, fp_hmac: rec.fp_hmac },
            });
          }
        } else if (rec.lifecycle === 'rolling_back' && rec.rollback?.reason === 'vetoed') {
          const at = rollbackEnteredAt(rec);
          if (at === undefined) throw new StoreError('state_invalid', 'event_time_missing');
          if (utcDay(at) <= W) {
            out.push({
              key: vetoEffectKey(rec),
              effects: [{ type: 'blacklist_veto', id: rec.id, content_sha256: rec.content_sha256 }],
              meta: { event_at: at, fp_hmac: rec.fp_hmac },
            });
          }
        }
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async derivedThrough(W: UtcDay): Promise<readonly DerivedRow[]> {
      const out: DerivedRow[] = [];
      for (const rec of await load(deps.records)) {
        for (const d of derivedOf(rec)) if (utcDay(d.row.at) <= W) out.push(d);
      }
      return out.sort(byLocator);
    },
    async resolve(locator: SourceLocator, idemKey: string): Promise<AuthoritativeEvent | null> {
      if (!LOCATOR_KINDS.includes(locator.kind) || locator.ref === '') return null;
      for (const rec of await load(deps.records)) {
        const hit = derivedOf(rec).find((d) => d.idem_key === idemKey);
        if (hit !== undefined) return { idem_key: hit.idem_key, row: hit.row };
      }
      return null;
    },
  };
}
