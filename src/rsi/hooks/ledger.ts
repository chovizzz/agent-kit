/**
 * 账本的纯变更函数(contracts §20.15 R20-15.12 / 15.21 / 15.23 / 15.24)。不碰文件系统;写盘只经 `HooksFs.commitLedger`。
 *
 * - 同一 `txn_id` 只生效一次:`applyChange` 遇到已记录的 `txn_id` 原样返回(崩溃恢复可重复提交);
 * - `generation`:`applied` 与 `discarded` 事务各加 1(restore 本身是 `applied`);`aborted` 不加;`backup_pruned` 标记不动它;
 * - 压缩(评审采纳,契约未规定「超过 N 条丢最旧」,所以只丢**不再有任何用处**的记录):保留 ① 每个 agent 最新的已提交记录(restore 的依据)、
 *   ② 有 journal 引用的记录(幂等)、③ 备份尚未修剪的记录(修剪要在它上面记 `pruned`);其余丢弃。账本规模因此受「每 agent ≤ 10 份非受保护备份」约束。
 */
import {
  HooksLedgerSchema,
  type HooksLedger,
  type HooksLedgerChange,
  type HooksLedgerEntry,
  type HooksTxnRecord,
} from '../../contracts/rsi-hooks.js';
import type { RsiAgentId } from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';

export class LedgerInvalidError extends Error {
  constructor(detail: string) {
    super(`hooks ledger invalid: ${detail}`);
    this.name = 'LedgerInvalidError';
  }
}

export function emptyLedger(): HooksLedger {
  return { schema_version: 1, generation: 0, entries: [], applied_txns: [] };
}

export function parseLedger(bytes: Buffer): HooksLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new LedgerInvalidError('json');
  }
  const r = HooksLedgerSchema.safeParse(raw);
  if (!r.success) throw new LedgerInvalidError('schema');
  return r.data;
}

export function serializeLedger(l: HooksLedger): string {
  return canonicalJson(l);
}

const entryKey = (e: Pick<HooksLedgerEntry, 'agent' | 'event' | 'fingerprint'>): string =>
  `${e.agent}\0${e.event}\0${e.fingerprint}`;

export function sortEntries(es: readonly HooksLedgerEntry[]): HooksLedgerEntry[] {
  return [...es].sort((a, b) =>
    entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0,
  );
}

export function entriesFor(l: HooksLedger, agent: RsiAgentId): HooksLedgerEntry[] {
  return l.entries.filter((e) => e.agent === agent);
}

/** 该 agent 最新的已提交事务(`aborted` 不算;`restored` / `discarded` 也算——它们之后的 restore 不可用,R20-15.23) */
export function latestCommitted(l: HooksLedger, agent: RsiAgentId): HooksTxnRecord | undefined {
  for (let i = l.applied_txns.length - 1; i >= 0; i--) {
    const t = l.applied_txns[i] as HooksTxnRecord;
    if (t.agent === agent && t.status !== 'aborted') return t;
  }
  return undefined;
}

export function hasTxn(l: HooksLedger, txnId: string): boolean {
  return l.applied_txns.some((t) => t.txn_id === txnId);
}

export class LedgerConflictError extends Error {
  constructor() {
    super('hooks ledger generation differs from the journal expectation');
    this.name = 'LedgerConflictError';
  }
}

export function compactTxns(
  txns: readonly HooksTxnRecord[],
  keepTxnIds: ReadonlySet<string>,
): HooksTxnRecord[] {
  const latest = new Map<string, string>();
  for (const t of txns) if (t.status !== 'aborted') latest.set(t.agent, t.txn_id);
  const keepLatest = new Set(latest.values());
  return txns.filter(
    (t) => keepLatest.has(t.txn_id) || keepTxnIds.has(t.txn_id) || t.backup === 'present',
  );
}

export interface ApplyOptions {
  /** 校验 `expected_generation`(安装 / 卸载 / restore 事务;discard 与 aborted 记录按提交时的现值,不绑定) */
  checkGeneration: boolean;
  /** 有 journal 引用的 `txn_id`(压缩时保护) */
  keepTxnIds: ReadonlySet<string>;
}

export function applyChange(l: HooksLedger, c: HooksLedgerChange, o: ApplyOptions): HooksLedger {
  if (hasTxn(l, c.record.txn_id)) return l;
  if (o.checkGeneration && l.generation !== c.expected_generation) throw new LedgerConflictError();
  const gone = new Set(c.record.removed.map(entryKey));
  let entries = l.entries.filter((e) => !gone.has(entryKey(e)));
  const adding = new Set(c.record.added.map(entryKey));
  entries = [...entries.filter((e) => !adding.has(entryKey(e))), ...c.record.added];
  const txns = l.applied_txns.map((t) =>
    c.set_status !== undefined && t.txn_id === c.set_status.txn_id
      ? { ...t, status: c.set_status.status }
      : t,
  );
  txns.push(c.record);
  const bump = c.record.status === 'applied' || c.record.status === 'discarded' ? 1 : 0;
  return {
    schema_version: 1,
    generation: l.generation + bump,
    entries: sortEntries(entries),
    applied_txns: compactTxns(txns, o.keepTxnIds),
  };
}

/** 备份修剪的账本标记(R20-15.24):只改这些事务的 `backup`,不改归属、不动 generation */
export function markPruned(l: HooksLedger, ids: ReadonlySet<string>): HooksLedger {
  if (!l.applied_txns.some((t) => ids.has(t.txn_id) && t.backup !== 'pruned')) return l;
  return {
    ...l,
    applied_txns: l.applied_txns.map((t) =>
      ids.has(t.txn_id) && t.backup !== 'pruned' ? { ...t, backup: 'pruned' as const } : t,
    ),
  };
}

/** 修剪后顺带压缩(此时 `pruned` 的非最新记录没有用处了) */
export function compactLedger(l: HooksLedger, keepTxnIds: ReadonlySet<string>): HooksLedger {
  const txns = compactTxns(l.applied_txns, keepTxnIds);
  return txns.length === l.applied_txns.length ? l : { ...l, applied_txns: txns };
}

/** restore 对源事务的逆变更:撤回其新增的归属、恢复其移除的归属(R20-15.23) */
export function inverseOf(
  source: HooksTxnRecord,
  restoreTxnId: string,
): { added: HooksLedgerEntry[]; removed: HooksLedgerEntry[] } {
  return {
    added: source.removed.map((e) => ({ ...e, txn_id: restoreTxnId })),
    removed: source.added.map((e) => ({ ...e })),
  };
}
