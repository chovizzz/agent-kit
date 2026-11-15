/**
 * 存储核装配(B1a):在已持有的 `rsi + personal` 锁能力上,把事务协调器、effects 账、审计追加器、`SealGuard` 区域注册表接成一组端口。
 * **生产里没有任何地方调用本文件**(B1a 合并后生产惰性:相位 0 下没有入口首次写账 / 写审计;`test/rsi/store/inert.test.ts` 证明)。装配与启用归 B2 / 提相位 PR。
 *
 * 交付矩阵(设计稿 v3 §E,B1a 列):
 *   1 事务协调器 = 真实现(`txn.ts`)| 2/3/4 账、`applyOnce`、`recoverThrough`、`UserVetoPort` / `ReplayPort` = 真实现(`ledger-*.ts`、`apply-once.ts`)|
 *   5 appender = 真实现(`audit-appender.ts`)| 6 `SealGuard` / 区域注册表 = 真实现(`seal.ts`;`Compactor` 对 `region_open` 的消费归 B1b)|
 *   7 `ReconcileSource` = 类型 + 测试假件 + 未接线实现(`reconcile.ts`)| 8 compaction / 账 schema = 真实现(`contracts/rsi-store.ts` + `backend.ts` 读写)|
 *   9/10 码表、谓词 = 真实现(`contracts/rsi-store.ts`)。`Compactor`、真 `ReconcileSource` 适配器、`CommandLocks`、命令接线 = 不在 B1a。
 */
import { createAuditAppender } from './audit-appender.js';
import { createBackend } from './backend.js';
import { createKeyedEffectSink, createLedgerRecovery, createUserVetoPort } from './apply-once.js';
import type { StoreFs } from './fs-port.js';
import type {
  AuditAppender,
  HeldStore,
  KeyedEffectSink,
  LedgerRecoveryPort,
  LockCap,
  ReconcileSource,
  SealGuard,
  UserVetoPort,
} from './ports.js';
import { SealRegistry, createSealGuard } from './seal.js';
import { createHeldStore } from './txn.js';

export interface RsiStoreDeps {
  fs: StoreFs;
  rsi: LockCap;
  personal: LockCap;
  /** 缺省 `() => new Date()`;测试注入 */
  clock?: () => Date;
  /** 水位线之下 replay 的权威事件取回(C 注入);缺省 = 未接线(`sealed_unknown_event`) */
  reconcile?: Pick<ReconcileSource, 'resolve'>;
  /** 与 `Compactor` 共享同一个注册表(B1b);缺省新建 */
  registry?: SealRegistry;
}

export interface RsiStore {
  held: HeldStore;
  /** `ReplayPort`:`applyOnce` 的调用方只有 `replay` 意图 */
  sink: KeyedEffectSink;
  /** 只给命令装配(`user_veto` 意图) */
  userVeto: UserVetoPort;
  /** 只给 `Compactor` */
  recovery: LedgerRecoveryPort;
  appender: AuditAppender;
  seal: SealGuard;
  registry: SealRegistry;
}

export function assembleRsiStore(deps: RsiStoreDeps): RsiStore {
  const clock = deps.clock ?? ((): Date => new Date());
  const backend = createBackend(deps.fs, clock);
  const held = createHeldStore({ rsi: deps.rsi, personal: deps.personal, backend });
  const registry = deps.registry ?? new SealRegistry();
  const apply = {
    held,
    clock,
    ...(deps.reconcile !== undefined
      ? { resolve: deps.reconcile.resolve.bind(deps.reconcile) }
      : {}),
  };
  return {
    held,
    sink: createKeyedEffectSink(apply),
    userVeto: createUserVetoPort(apply),
    recovery: createLedgerRecovery(apply),
    appender: createAuditAppender({
      held,
      ...(apply.resolve !== undefined ? { resolve: apply.resolve } : {}),
    }),
    seal: createSealGuard({ registry, readWatermark: () => backend.readWatermark() }),
    registry,
  };
}
