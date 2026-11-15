/**
 * 命令结果的「三层」收集器(设计稿 v3 §D.2;§21.24 W0-26 第 5 条):**命令权威状态**(记录 / 凭据 / HOME)、**账**、**审计**各自独立。
 * 存储端 `applyOnce` 只返回 `{ledger, audit}` 两层且不推断 authority;旧 `KeyedEffectSink` 的返回值(`applied | already | deferred`)只有一个枚举,
 * 塌缩会丢信息(审计待补会被当成 `applied`,账因容量未提交会被当成 `deferred` 与「缩减入口待对账」混为一谈)。
 * 所以适配层({@link legacyKeyedEffects},`effects-adapter.ts`)在把结果交给执行器的**同时**,把完整的层信息记进本次命令的收集器;
 * 命令层(`auto/write/outcome-output.ts`)读收集器组合 `authority`(= 执行器 / 引擎的结论)并决定输出与退出码。
 *
 * 本文件**无 I/O、不 import 存储核运行时**(命令层的运行时闭包不得含存储核,见 `test/rsi/store/inert.test.ts`):层的取值用字面量联合,`reason` 由适配层(它能 import 存储核)填好。
 */

export type LedgerLayerName = 'committed' | 'satisfied' | 'not_committed' | 'not_applicable';
export type AuditLayerName = 'appended' | 'pending' | 'compacted' | 'not_applicable';

/** 一次 `applyOnce` 调用的完整层信息 */
export interface LayerRecord {
  /** 键的种类(不记键本身:键里带内容哈希) */
  kind: 'terminal' | 'veto' | 'audit' | 'other';
  /** 候选 id(键里能取到时) */
  id: string | null;
  ledger: LedgerLayerName;
  audit: AuditLayerName;
  /** 存储端 cause(`effects_full` / `audit_full` / `store_io` …) */
  cause?: string;
  /** 该 cause 对应的 `RSI_FAIL_CLOSED reason=` 取值(适配层按存储核码表算好;命令层不 import 码表) */
  reason?: string;
}

/** 封存拒绝事件(取时落在已封存区间,源提交前拒绝) */
export interface SealedEvent {
  cause: 'sealed_interval';
}

export interface LayerRecorder {
  record(r: LayerRecord): void;
  sealed(e: SealedEvent): void;
  readonly records: readonly LayerRecord[];
  readonly sealedEvents: readonly SealedEvent[];
}

export function newLayerRecorder(): LayerRecorder {
  const records: LayerRecord[] = [];
  const sealedEvents: SealedEvent[] = [];
  return {
    record: (r) => {
      records.push(r);
    },
    sealed: (e) => {
      sealedEvents.push(e);
    },
    records,
    sealedEvents,
  };
}

/** 账未提交(权威状态已先落;容量 / 冲突类):命令报「已提交待对账」 */
export const isLedgerPending = (r: LayerRecord): boolean => r.ledger === 'not_committed';
/** 账已提交 / 已满足而审计追加失败 */
export const isAuditPending = (r: LayerRecord): boolean => r.audit === 'pending';
