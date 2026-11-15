/**
 * 审计追加器(设计稿 v3 §C.3、第 2 版 §1 / §2;§21.24 W0-26 第 6、7、9 条)。
 *
 * - `appendKeyed(items, origin)`:`first{region}`(返回类型**不含 `compacted`**;事件日 ≤ W → `sealed_interval`;尝试结束后区域自动关闭)/
 *   `replay{source}`(事件日 ≤ W 仅当 `resolve` 取回的权威事件逐字段相等才 `compacted`,否则 `sealed_unknown_event`)。
 * - `appendObservation(row)`:无键观察行;日 ≤ W → `clock_regressed`;`kind=transition` 与保护标记行不得走这里(`audit_key_missing`)。
 * - 整个操作在一个事务内:**先分类整个文件并做完全部校验(同键冲突 / 封存 / 容量),再修撕裂尾、再追加**——任何校验失败零写入。
 *   同键同内容 = `already`(不重复追加);同键不同内容 = `audit_key_conflict`;重复键 / 坏行 = fail-closed。
 * 规划函数 `loadAuditState` / `planKeyedAppend` / `commitAuditRows` 在事务内被 `applyOnce` 复用(账提交前做审计预检,账提交后追加)。
 */
import {
  RSI_PROTECTION_MARKS,
  RsiAuditLineSchema,
  type RsiAuditLine,
} from '../../contracts/rsi-personal.js';
import { RSI_AUDIT_LIMIT_LINES, utcDay, type UtcDay } from '../../contracts/rsi-store.js';
import { canonicalJsonLine } from '../../io/canonical-json.js';
import {
  classifyAuditFile,
  sameRowForKey,
  sameSealedFields,
  type GoodAuditClass,
} from './audit-classify.js';
import { AuditKeyConflict, AuditSealedError, StoreError } from './errors.js';
import type {
  AppendReplayResult,
  AuditAppender,
  AuditAppendPort,
  HeldStore,
  ReconcileSource,
  SealRegion,
  SourceLocator,
} from './ports.js';
import { beginAuditAttempt } from './seal.js';

export interface AuditState {
  cls: GoodAuditClass;
  /** 水位线 W(无压缩 = null) */
  wm: UtcDay | null;
}

/** 读审计文件 + 水位线:坏行 / 重复键 / 压缩不受支持 = 抛(fail-closed);撕裂尾不抛(`cls.kind === 'torn_tail'`) */
export async function loadAuditState(port: AuditAppendPort): Promise<AuditState> {
  const read = await port.readAudit();
  const cls = classifyAuditFile(read.kind === 'missing' ? '' : read.text);
  if (cls.kind === 'bad') throw new StoreError(cls.cause, `line:${cls.line}:${cls.detail}`);
  const wm = (await port.readWatermark()).through;
  return { cls, wm };
}

export type KeyedOrigin = { kind: 'first' } | { kind: 'replay'; source: SourceLocator };

export interface KeyedPlan {
  toAppend: RsiAuditLine[];
  results: AppendReplayResult[];
}

/** 纯规划(只读):逐项判 already / compacted / appended,全部通过后检容量。任何违规抛错,此时尚未写任何字节 */
export async function planKeyedAppend(
  st: AuditState,
  items: readonly RsiAuditLine[],
  origin: KeyedOrigin,
  resolve: ReconcileSource['resolve'] | undefined,
): Promise<KeyedPlan> {
  const toAppend: RsiAuditLine[] = [];
  const results: AppendReplayResult[] = [];
  const inBatch = new Map<string, RsiAuditLine>();
  for (const item of items) {
    const p = RsiAuditLineSchema.safeParse(item);
    if (!p.success) throw new StoreError('audit_bad_line', 'item_schema');
    const line = p.data;
    const key = line.idem_key;
    if (key === undefined) throw new StoreError('audit_key_missing');
    const dup = inBatch.get(key);
    if (dup !== undefined) {
      if (!sameRowForKey(dup, line)) throw new AuditKeyConflict(`batch:${key}`);
      results.push('already');
      continue;
    }
    inBatch.set(key, line);
    // `first` 的封存检查先于「文件里已有同键行」的 already:事件日 ≤ W 的 first 一律 sealed_interval(不因残留行而返回 already)
    if (origin.kind === 'first' && st.wm !== null && utcDay(line.at) <= st.wm) {
      throw new AuditSealedError('sealed_interval', key);
    }
    const have = st.cls.byKey.get(key);
    if (have !== undefined) {
      if (!sameRowForKey(have, line)) throw new AuditKeyConflict(key);
      results.push('already');
      continue;
    }
    if (st.wm !== null && utcDay(line.at) <= st.wm) {
      const ev = resolve === undefined ? null : await resolve(origin.source, key);
      if (ev === null || !sameSealedFields(ev, line)) {
        throw new AuditSealedError('sealed_unknown_event', key);
      }
      results.push('compacted');
      continue;
    }
    toAppend.push(line);
    results.push('appended');
  }
  if (st.cls.rows.length + toAppend.length > RSI_AUDIT_LIMIT_LINES) {
    throw new StoreError('audit_full');
  }
  return { toAppend, results };
}

/** 修撕裂尾(有行要追加时才修)后单次追加;`lines` 为空 = 不写 */
export async function commitAuditRows(
  port: AuditAppendPort,
  st: AuditState,
  lines: readonly RsiAuditLine[],
): Promise<void> {
  if (lines.length === 0) return;
  if (st.cls.kind === 'torn_tail') await port.rewrite(st.cls.goodText);
  await port.append(lines.map((l) => canonicalJsonLine(l)).join(''));
}

const isProtectionMark = (r: RsiAuditLine): boolean =>
  r.kind === 'reconcile' && (RSI_PROTECTION_MARKS as readonly string[]).includes(r.reason ?? '');

export interface AuditAppenderDeps {
  held: HeldStore;
  /** 缺省 = 未接线:水位线之下的 replay 一律 `sealed_unknown_event` */
  resolve?: ReconcileSource['resolve'];
}

export function createAuditAppender(deps: AuditAppenderDeps): AuditAppender {
  const run = (
    items: readonly RsiAuditLine[],
    origin: KeyedOrigin,
  ): Promise<readonly AppendReplayResult[]> =>
    deps.held.transaction(async (p) => {
      const st = await loadAuditState(p.auditAppend);
      const plan = await planKeyedAppend(st, items, origin, deps.resolve);
      await commitAuditRows(p.auditAppend, st, plan.toAppend);
      return plan.results;
    });

  const appendKeyed = async (
    items: readonly RsiAuditLine[],
    origin: { kind: 'first'; region: SealRegion } | { kind: 'replay'; source: SourceLocator },
  ): Promise<readonly AppendReplayResult[]> => {
    if (origin.kind === 'replay') return run(items, origin);
    beginAuditAttempt(origin.region);
    try {
      return await run(items, { kind: 'first' });
    } finally {
      origin.region.close();
    }
  };

  return {
    appendKeyed: appendKeyed as unknown as AuditAppender['appendKeyed'],
    appendObservation: async (row) => {
      const p = RsiAuditLineSchema.safeParse(row);
      if (!p.success) throw new StoreError('audit_bad_line', 'item_schema');
      const line = p.data;
      if (line.idem_key !== undefined)
        throw new StoreError('audit_bad_line', 'observation_has_key');
      if (line.kind === 'transition' || isProtectionMark(line)) {
        throw new StoreError('audit_key_missing', 'observation');
      }
      await deps.held.transaction(async (port) => {
        const st = await loadAuditState(port.auditAppend);
        if (st.wm !== null && utcDay(line.at) <= st.wm) {
          throw new StoreError('clock_regressed', `${utcDay(line.at)}<=${st.wm}`);
        }
        if (st.cls.rows.length + 1 > RSI_AUDIT_LIMIT_LINES) throw new StoreError('audit_full');
        await commitAuditRows(port.auditAppend, st, [line]);
      });
      return 'appended';
    },
  };
}
