/**
 * 压缩文件的事务内端口(B1b;**只给 `Compactor`**,存储核内部模块,arch 测试限定只许 `src/rsi/store/**` 与 `test/rsi/store/**` import)。
 *
 * 不进冻结的 `TxnPorts`(`keyof TxnPorts` 被 `ports-freeze.test.ts` 钉住),也不放在 `txn.ts`(`txn.ts` 的导出集合被钉为只有 `createHeldStore`)。
 * 本模块**不能取锁、不能在事务外写**:`bindCompactionPort` 只把「协调器造出的某个事务端口对象」映射到一个已绑定该事务 token 的端口;
 * 端口自己的每次 read / commit 仍经协调器的 `track`(同 token、同串行队列、同一次锁复核),事务结束后再用 = `txn_closed`。
 * 伪造一个 `TxnPorts` 与端口对象并 bind 也拿不到锁、碰不到盘(端口的方法由伪造者自己实现)。
 */
import type { RsiAuditCompaction } from '../../contracts/rsi-store.js';
import { StoreError } from './errors.js';
import type { TxnPorts } from './ports.js';

export interface CompactionTxnPort {
  /** 文件缺失 = `null`;不受支持 → `compaction_unsupported` */
  read(): Promise<RsiAuditCompaction | null>;
  /** P2 的提交点:要求 `next.gen` = 当前 + 1、`through` 不回退、过读侧同一份语义校验;tmp → 复核锁 → rename */
  commit(next: RsiAuditCompaction): Promise<void>;
}

const compactionPorts = new WeakMap<TxnPorts, CompactionTxnPort>();

/** 仅 `createHeldStore` 在造事务端口时调用 */
export function bindCompactionPort(ports: TxnPorts, port: CompactionTxnPort): void {
  compactionPorts.set(ports, port);
}

/** 取事务端口对应的压缩端口;不是本协调器造出的端口(伪造 / 旧事务以外的对象)= `txn_closed` */
export function compactionPortOf(ports: TxnPorts): CompactionTxnPort {
  const c = compactionPorts.get(ports);
  if (c === undefined) throw new StoreError('txn_closed', 'not_a_transaction_port');
  return c;
}
