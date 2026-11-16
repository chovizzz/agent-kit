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
import type { HeldStore, LedgerRecoveryPort, TxnPorts } from './ports.js';
import type { SealRegistry } from './seal.js';

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

/**
 * 一次装配的私有关联:真实协调器(`HeldStore`)→ 它所属 acquisition 的区域注册表与恢复端口。
 * `Compactor` 的压缩租约取自注册表,所以注册表必须来自协调器自己的装配,不能信调用方拼的字段(`{ ...store, registry: new SealRegistry() }` 会在空表上拿租约,绕过真实未关闭区域)。
 * 仅 `assembleRsiStore` 绑定;`compactorOf` / `createCompactor` 校验。
 */
export interface CompactorAssembly {
  registry: SealRegistry;
  recovery: LedgerRecoveryPort;
}
const assemblies = new WeakMap<HeldStore, CompactorAssembly>();

export function bindCompactorAssembly(held: HeldStore, a: CompactorAssembly): void {
  assemblies.set(held, a);
}

/** 校验在任何 I/O 之前;`recovery` 不给 = 只验注册表(`createCompactor` 的恢复端口是可注入的测试接缝) */
export function checkCompactorAssembly(
  held: HeldStore,
  registry: SealRegistry,
  recovery?: LedgerRecoveryPort,
): void {
  const a = assemblies.get(held);
  if (a === undefined) throw new StoreError('lock_cap_mismatch', 'compactor_unbound');
  if (a.registry !== registry) throw new StoreError('lock_cap_mismatch', 'compactor_registry');
  if (recovery !== undefined && a.recovery !== recovery) {
    throw new StoreError('lock_cap_mismatch', 'compactor_recovery');
  }
}
