/**
 * 装配块 B 段 B1a:**冻结的端口签名**(设计稿 v3 §E 十组;三个里程碑分开:签名冻结 ≠ 实现交付 ≠ 生产启用)。冻结 = 合并前不得改签名,改了须重过评审。
 * 本文件只有类型与常量,无 I/O。哪些端口在 B1a 有真实现:见 `store.ts` 头注的交付矩阵;`ReconcileSource` 只有类型 + 测试假件 + 未接线实现。
 *
 * 与已合并 W7 / W8 的关系:`personal/rollback-ports.ts` 的 `KeyedEffectSink`(返回 `'applied' | 'already' | 'deferred'`)**保持不动**,
 * 它是 W7 / W8 的出口;这里同名端口 `KeyedEffectSink`(返回 `{ledger, audit}`)是存储端的新形状,B2 接线时把旧出口适配到它。两者在不同模块,互不替换。
 */
import type { IsoTimestamp } from '../../contracts/common.js';
import type { RsiAuditLine } from '../../contracts/rsi-personal.js';
import type { RsiEffectsLedger, StoreCause, UtcDay } from '../../contracts/rsi-store.js';
import type { TransitionEffect } from '../personal/transition.js';

// ---------- 1. 事务协调器 ----------
/** 已持有的一把锁的能力(`assertHeld` 比盘上 nonce;`release` 释放)。真实现 = `RsiLockHandle` / `PersonalLockHandle` */
export interface LockCap {
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}
/**
 * 需要的锁集合(与 `auto/write/ports.ts` 的 `LockOrder` 同一字面量集合,类型测试钉住):`personal_sync` = 缩减入口;`rsi_personal_sync` = 三把锁。
 * 锁序固定 `rsi → personal → sync`,**不暴露单独取锁函数**,所以无法表达逆序。
 */
export type LockOrder = 'personal_sync' | 'rsi_personal_sync';

export type AuditTextRead = { kind: 'missing' } | { kind: 'ok'; text: string };
/** 水位线读出:文件缺失 = `{through: null, gen: 0}`(虚拟,合法) */
export interface Watermark {
  through: UtcDay | null;
  gen: number;
}

/** 绑定本次事务 token 的账写端口;事务结束即失效 */
export interface LedgerWritePort {
  /** 解码后的账(文件缺失 = 虚拟空账 `gen: 0`;不合规抛 `state_invalid`) */
  read(): Promise<RsiEffectsLedger>;
  /** 提交一份新账:要求 `next.gen === 当前 gen + 1`,过 schema 与字节上限;写临时文件 → 复核锁 → rename */
  commit(next: RsiEffectsLedger): Promise<void>;
}
/** 绑定本次事务 token 的审计端口 */
export interface AuditAppendPort {
  readAudit(): Promise<AuditTextRead>;
  readWatermark(): Promise<Watermark>;
  /** 单次 `O_APPEND` + fsync(多行一次写) */
  append(text: string): Promise<void>;
  /** 整文件重写(tmp + rename):撕裂尾修复用 */
  rewrite(text: string): Promise<void>;
}
export interface TxnPorts {
  readonly ledgerWrite: LedgerWritePort;
  readonly auditAppend: AuditAppendPort;
}

/** 单层事务协调器:`rsi + personal` 两把能力在整个临界区固定 */
export interface HeldStore {
  /** `release()` 已开始(同步标志) */
  readonly closing: boolean;
  /** 串行执行;`fn` 拒绝后队列照常继续;`closing` 后拒绝(`txn_closing`);事务内再开事务拒绝(`txn_nested`) */
  transaction<T>(fn: (ports: TxnPorts) => Promise<T>): Promise<T>;
  /** 置 `closing` 后等在途事务,再逆序释放 personal → rsi;并发多次调用共享同一 promise;本把锁事务回调内调用 = `release_inside_transaction` */
  release(): Promise<void>;
}

// ---------- 2. KeyedEffectSink ----------
export type LedgerLayer = 'committed' | 'satisfied' | 'not_committed' | 'not_applicable';
/** `appended` = 本次带的每一行都已在文件里(新追加或原本就在);`compacted` = 每一行都被水位线覆盖;`pending` = 账已提交 / 已满足而审计追加失败 */
export type AuditLayer = 'appended' | 'pending' | 'compacted' | 'not_applicable';
/**
 * 存储端结果只有两层(命令层另组合 `authority`,存储端不推断)。`cause`:`ledger = not_committed` 时是 `effects_full` / `audit_full`(容量,撤销优先,不抛);
 * `audit = pending` 时是 `store_io`。冲突与不合规一律**抛** `StoreError`(零写入)。
 */
export interface ApplyOnceResult {
  ledger: LedgerLayer;
  audit: AuditLayer;
  cause?: StoreCause;
}
/** 账类效果必须带的元信息(不改 `TransitionEffect`):`event_at` 取自记录条目,绝不取 now;黑名单效果须带 `fp_hmac`(16 位十六进制) */
export interface ApplyOnceMeta {
  event_at: IsoTimestamp;
  fp_hmac?: string;
  near_fp?: readonly string[];
}
export interface KeyedEffectSink {
  /** 同键同内容 = `already`(`ledger: satisfied`);账类效果缺 `meta` → `effects_meta_missing`;`audit:` 前缀的键只路由审计,不进账 `applied` */
  applyOnce(
    key: string,
    effects: readonly TransitionEffect[],
    meta?: ApplyOnceMeta,
  ): Promise<ApplyOnceResult>;
}

// ---------- 3. LedgerRecoveryPort ----------
export interface RecoveryBatch {
  key: string;
  effects: readonly TransitionEffect[];
  meta: ApplyOnceMeta;
}
export type RecoveryState = 'satisfied' | 'ledger_committed' | 'ledger_not_committed';
export interface RecoveryResult {
  batch_id: string;
  state: RecoveryState;
  cause?: StoreCause;
}
/**
 * 压缩专用恢复:**只由 `Compactor` 注入**(`KeyedEffectSink` 不含它);无审计预检、不追加任何审计行;每批事件日须 ≤ W,否则整个调用拒绝 `out_of_range`(零写入)。
 * 需要提交的批次在一个事务内**一次 rename**;失败时只把需要提交的批次标 `ledger_not_committed`,调用前已 `satisfied` 的保持 `satisfied`。
 */
export interface LedgerRecoveryPort {
  recoverThrough(W: UtcDay, batches: readonly RecoveryBatch[]): Promise<readonly RecoveryResult[]>;
}

// ---------- 4. UserVetoPort / ReplayPort ----------
/** 只由命令装配持有(TTY 已校验的路径);内部表达 `intent = user_veto`。`ReplayPort` / `recoverThrough` / `applyOnce` 的调用方无法表达该意图 */
export interface UserVetoPort {
  veto(
    id: string,
    contentSha256: string,
    meta: ApplyOnceMeta & { fp_hmac: string },
  ): Promise<ApplyOnceResult>;
  /** 只解除指纹黑名单;项不存在或已 lifted = `absent`;`at` 仅展示,排序靠 `gen` */
  lift(id: string, contentSha256: string, at: IsoTimestamp): Promise<'lifted' | 'absent'>;
}
/** 恢复 / 重放侧:`applyOnce` 的调用方只有 `replay` 意图 */
export type ReplayPort = KeyedEffectSink;

// ---------- 5. AuditAppender ----------
/** 审计行的来源定位(`ReconcileSource.resolve` 的参数;B1a 对它不透明) */
export type SourceLocator = { kind: string; ref: string };
export type AppendFirstResult = 'appended' | 'already';
export type AppendReplayResult = 'appended' | 'already' | 'compacted';
export interface AuditAppender {
  /** `first`:条目刚由本区域 stamp 产生,**返回类型不含 `compacted`**;事件日 ≤ W 抛 `sealed_interval`;尝试结束(成功 / 失败)后区域关闭 */
  appendKeyed(
    items: readonly RsiAuditLine[],
    origin: { kind: 'first'; region: SealRegion },
  ): Promise<readonly AppendFirstResult[]>;
  /** `replay`:事件日 ≤ W 仅当 `resolve` 取回的权威事件逐字段相等才 `compacted`,否则 `sealed_unknown_event` */
  appendKeyed(
    items: readonly RsiAuditLine[],
    origin: { kind: 'replay'; source: SourceLocator },
  ): Promise<readonly AppendReplayResult[]>;
  /** 无键观察行(R8):日 ≤ W → `clock_regressed`;`kind=transition` 与保护标记行不得走这里(`audit_key_missing`) */
  appendObservation(row: RsiAuditLine): Promise<'appended'>;
}

// ---------- 6. SealGuard ----------
export type SealRegionState =
  'open' | 'stamped' | 'source_committed' | 'audit_attempted' | 'closed';
export interface SealRegion {
  readonly state: SealRegionState;
  /** `open` 时读到的水位线(之后不再重读) */
  readonly watermark: UtcDay | null;
  /** 先于 `now()` 已读好 W;取值后校验 `utcDay(at) > W`,否则抛 `sealed_interval`。**每个区域只取一次时**:再次调用返回同一时刻,不再调 `now` */
  stampFirst(now: () => Date): IsoTimestamp;
  /** 源(私有仓库)提交成功后调用(B2 / C 在生产者里接线) */
  markSourceCommitted(): void;
  /** 释放(幂等);首次审计追加尝试结束后由追加器自动调用 */
  close(): void;
}
export interface SealGuard {
  /** 要求持有 personal 锁(`assertHeld`);读 compaction 文件一次得 W,并登记「区域占用」 */
  open(held: { assertHeld(): Promise<void> }): Promise<SealRegion>;
}

// ---------- 7. ReconcileSource ----------
/** 权威记录里的 lifecycle 条目(只带压缩 P1 要的信息) */
export interface ReconcileEntry {
  id: string;
  idem_key: string;
  at: IsoTimestamp;
}
export interface AuthoritativeEvent {
  idem_key: string;
  /** 规范化审计行(含 `idem_key`) */
  row: RsiAuditLine;
}
export interface DerivedRow {
  idem_key: string;
  row: RsiAuditLine;
  locator: SourceLocator;
}
/** C 注入的权威记录读取端口;B1a 只有类型与测试假件,B1b 有真适配器;未接线 = `compact_unwired`(`unwiredReconcileSource`) */
export interface ReconcileSource {
  entriesThrough(W: UtcDay): Promise<readonly ReconcileEntry[]>;
  batchesThrough(W: UtcDay): Promise<readonly RecoveryBatch[]>;
  /** R1–R4(lifecycle 条目)与 R7(终态保护标记)的派生行描述;R5 / R6 / R8 不在内 */
  derivedThrough(W: UtcDay): Promise<readonly DerivedRow[]>;
  resolve(locator: SourceLocator, idemKey: string): Promise<AuthoritativeEvent | null>;
}
