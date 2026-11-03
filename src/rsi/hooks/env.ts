/**
 * `rsi hooks` 引擎的共享类型与错误(contracts §20.15)。引擎各文件只往这里取,不各自加共享类型。
 */
import {
  type RsiHooksFailClosedReason,
  type RsiHooksNotRunReason,
  type RsiHooksWriteLevel,
  type ShapeTable,
} from '../../contracts/rsi-hooks.js';
import { HooksFs, HooksFsError } from '../../io/hooks-fs.js';
import { LedgerConflictError, LedgerInvalidError } from './ledger.js';

/** 稳定拒绝:`not_run` → `RSI_HOOKS_NOT_RUN reason=`(退 4);`fail_closed` → `RSI_FAIL_CLOSED reason=`(退 3) */
export class HooksError extends Error {
  constructor(
    readonly kind: 'not_run' | 'fail_closed',
    readonly reason: RsiHooksNotRunReason | RsiHooksFailClosedReason,
  ) {
    super(`${kind}:${reason}`);
    this.name = 'HooksError';
  }
}
export const notRun = (r: RsiHooksNotRunReason): HooksError => new HooksError('not_run', r);
export const failClosed = (r: RsiHooksFailClosedReason): HooksError =>
  new HooksError('fail_closed', r);

/** 任何异常 → 稳定码(stderr 只含稳定码,不回显异常消息 / 路径 / 配置内容,R20-15.26) */
export function toStable(e: unknown): HooksError {
  if (e instanceof HooksError) return e;
  if (e instanceof HooksFsError) {
    if (e.code === 'hooks_target_unsafe') return failClosed('hooks_target_unsafe');
    if (e.code === 'hooks_ledger_invalid') return failClosed('hooks_ledger_invalid');
    if (e.code === 'hooks_backup_invalid') return failClosed('hooks_backup_invalid');
    if (e.code === 'target_changed') return notRun('config_changed_during_write');
    return failClosed('internal');
  }
  if (e instanceof LedgerInvalidError || e instanceof LedgerConflictError) {
    return failClosed('hooks_ledger_invalid');
  }
  return failClosed('internal');
}

/** 执行进度:命令层据此取 `write_level` / `maintenance`(R20-15.24a),按**实际到达的阶段**而不是原因码 */
export interface Progress {
  lockAttempted: boolean;
  /** 残留处理写过东西 */
  recoveryWrote: boolean;
  /** 本次事务的 journal 已写 */
  journalWritten: boolean;
  /** 目标 rename(或受保护删除)已完成 */
  targetCommitted: boolean;
  /** 目标事务已完整完成(目标已替换、账本已提交且持久化、journal 已删除) */
  complete: boolean;
  maintenance: 'none' | 'done' | 'partial';
  maintenanceKind: 'prune' | 'discard' | null;
  txnId: string | null;
}

export function newProgress(): Progress {
  return {
    lockAttempted: false,
    recoveryWrote: false,
    journalWritten: false,
    targetCommitted: false,
    complete: false,
    maintenance: 'none',
    maintenanceKind: null,
    txnId: null,
  };
}

/** 目标事务五级(+ committed)取值;纯维护操作不走这里(`write_level=null`) */
export function writeLevelOf(p: Progress): RsiHooksWriteLevel {
  if (p.complete) return 'committed';
  if (p.targetCommitted) return 'target_written_pending';
  if (p.journalWritten) return 'target_unwritten';
  if (p.recoveryWrote) return 'recovery_only';
  if (p.lockAttempted) return 'lock_only';
  return 'zero_write';
}

export interface HooksEnv {
  fs: HooksFs;
  shapes: ShapeTable;
  now: () => Date;
  randomHex: (bytes: number) => string;
  /** 崩溃 / 故障注入点(测试);产品代码不传 */
  inject?: (point: string) => void | Promise<void>;
  progress: Progress;
}

export async function inject(env: HooksEnv, point: string): Promise<void> {
  await env.inject?.(point);
}
