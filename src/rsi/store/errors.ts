/**
 * 存储核的错误类型(§21.24 W0-26 第 11 条):一个 `StoreError` 类,`code` 取自 `RSI_STORE_CAUSES`(契约码表是唯一事实源),
 * `reason` 是映射到稳定码 `RSI_FAIL_CLOSED reason=` 的取值(退出码恒为 3)。三个子类只为 `instanceof` 分流与更窄的构造参数。
 * 没有 I/O、不 import 任何写出口。
 */
import {
  RSI_STORE_CAUSES,
  type StoreCause,
  type StoreFailClosedReason,
} from '../../contracts/rsi-store.js';

export class StoreError extends Error {
  readonly code: StoreCause;
  readonly detail: string | undefined;
  constructor(code: StoreCause, detail?: string) {
    super(detail === undefined ? `rsi store: ${code}` : `rsi store: ${code}: ${detail}`);
    this.name = 'StoreError';
    this.code = code;
    this.detail = detail;
  }
  /** `RSI_FAIL_CLOSED reason=` 取值 */
  get reason(): StoreFailClosedReason {
    return RSI_STORE_CAUSES[this.code];
  }
}

/** 账:同键不同内容 / 墓碑冲突 / 批内同键异内容(零写入) */
export class EffectsKeyConflict extends StoreError {
  constructor(detail: string) {
    super('effects_key_conflict', detail);
    this.name = 'EffectsKeyConflict';
  }
}

/** 审计:同键内容不等(默认含 `at`,仅终态空操作行排除;零写入) */
export class AuditKeyConflict extends StoreError {
  constructor(detail: string) {
    super('audit_key_conflict', detail);
    this.name = 'AuditKeyConflict';
  }
}

/** 审计:封存区间(`sealed_interval` / `sealed_unknown_event` / `region_closed`) */
export class AuditSealedError extends StoreError {
  constructor(code: 'sealed_interval' | 'sealed_unknown_event' | 'region_closed', detail?: string) {
    super(code, detail);
    this.name = 'AuditSealedError';
  }
}

export const isStoreError = (e: unknown): e is StoreError => e instanceof StoreError;
