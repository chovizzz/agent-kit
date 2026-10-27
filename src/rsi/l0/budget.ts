/**
 * 读阶段预算(R20-6.7;B4b):计账字节用 lstat 大小(`files_planned` 与预算判定),实际字节由 reader 行钩子报告(含预扫)。
 *  - 改动文件 ≤ `RSI_MAX_FILES_PER_TICK`:停在文件边界,超出的延后到下一次(`RSI_LIMIT_FILES`);
 *  - lstat 大小 > `RSI_MAX_FILE_BYTES`:不读,cursor 记 `too_large`(`RSI_FILE_TOO_LARGE`),不占文件名额;
 *  - 累计实际字节 ≥ `RSI_MAX_BYTES_PER_TICK`:每个文件读完后检查,停止(`RSI_LIMIT_BYTES`);单文件实际字节 > `RSI_MAX_FILE_BYTES` 立即中止该文件(`too_large`)。
 * 纯函数,无 I/O。
 */
import {
  RSI_MAX_BYTES_PER_TICK,
  RSI_MAX_FILE_BYTES,
  RSI_MAX_FILES_PER_TICK,
  RSI_MAX_TICK_MS,
  type RsiCounterCode,
} from '../../contracts/rsi.js';
import type { SessionFile } from './types.js';

export interface BudgetLimits {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxMs: number;
}

export function resolveLimits(over?: Partial<BudgetLimits>): BudgetLimits {
  return {
    maxFiles: over?.maxFiles ?? RSI_MAX_FILES_PER_TICK,
    maxBytes: over?.maxBytes ?? RSI_MAX_BYTES_PER_TICK,
    maxFileBytes: over?.maxFileBytes ?? RSI_MAX_FILE_BYTES,
    maxMs: over?.maxMs ?? RSI_MAX_TICK_MS,
  };
}

export interface BudgetPlan {
  /** 要读的文件(处理顺序) */
  toRead: SessionFile[];
  /** lstat 大小超限、不读的文件 */
  tooLarge: SessionFile[];
  /** 超出文件名额、延后的数量 */
  deferred: number;
  /** `toRead` 的 lstat 大小之和 */
  plannedBytes: number;
  limitsHit: Set<RsiCounterCode>;
}

export function planBudget(changed: readonly SessionFile[], limits: BudgetLimits): BudgetPlan {
  const plan: BudgetPlan = {
    toRead: [],
    tooLarge: [],
    deferred: 0,
    plannedBytes: 0,
    limitsHit: new Set(),
  };
  for (const f of changed) {
    if (f.size > limits.maxFileBytes) {
      plan.tooLarge.push(f);
      plan.limitsHit.add('RSI_FILE_TOO_LARGE');
    } else if (plan.toRead.length < limits.maxFiles) {
      plan.toRead.push(f);
      plan.plannedBytes += f.size;
    } else {
      plan.deferred++;
      plan.limitsHit.add('RSI_LIMIT_FILES');
    }
  }
  return plan;
}

/** 单文件实际读取字节是否超限(读中判) */
export const fileBytesExceeded = (bytes: number, limits: BudgetLimits): boolean =>
  bytes > limits.maxFileBytes;

/** 累计实际字节是否已到本次上限(每个文件读完后判) */
export const tickBytesExhausted = (total: number, limits: BudgetLimits): boolean =>
  total >= limits.maxBytes;
