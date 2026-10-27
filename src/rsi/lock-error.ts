/**
 * `rsi/lock` 的错误类型(从 `lock.ts` 拆出,R20-A2 B3a):只读入口(status / projects)的 import 闭包不得含写出口,
 * 而错误映射需要它,所以单独成文件。`lock.ts` 原样 re-export,既有 import 路径不变。
 */
import { ExitCode, type ExitCodeValue } from '../contracts/exit-codes.js';
import type { RsiFailClosedReason, RsiNotRunReason } from '../contracts/rsi.js';

/** 获取 / 复核失败的分类;`toStable()` 给出契约稳定码(§20.3 R20-3.0) */
export type RsiLockErrorKind =
  'locked' | 'locked_over_ttl' | 'lock_lost' | 'state_dir_unsafe' | 'write_denied' | 'internal';

export class RsiLockError extends Error {
  readonly code = 'RSI_LOCK';
  constructor(readonly kind: RsiLockErrorKind) {
    super(`rsi/lock: ${kind}`);
  }

  /** `RSI_NOT_RUN reason=locked|locked_over_ttl`(退出 4)或 `RSI_FAIL_CLOSED reason=…`(退出 3) */
  toStable(): {
    code: 'RSI_NOT_RUN' | 'RSI_FAIL_CLOSED';
    reason: RsiNotRunReason | RsiFailClosedReason;
    exit: ExitCodeValue;
  } {
    switch (this.kind) {
      case 'locked':
      case 'locked_over_ttl':
        return { code: 'RSI_NOT_RUN', reason: this.kind, exit: ExitCode.NOT_RUN };
      default:
        return { code: 'RSI_FAIL_CLOSED', reason: this.kind, exit: ExitCode.FAIL_CLOSED };
    }
  }
}
