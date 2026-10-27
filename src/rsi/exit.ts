/**
 * rsi 前台命令的错误 → 稳定码 + 退出码(R20-3.0,R20-A2 B3a)。stderr 只含稳定码,不回显异常消息、文件内容、绝对路径。
 * 未识别的异常一律 `RSI_FAIL_CLOSED reason=internal`(退出 3)——宁可不透明也不泄漏消息。
 */
import { ExitCode, type ExitCodeValue } from '../contracts/exit-codes.js';
import { RSI_SNAPSHOT_BUSY } from '../contracts/rsi.js';
import { PathsError } from '../io/paths.js';
import { RsiLockError } from './lock-error.js';
import { RsiSnapshotError } from './snapshot-read.js';
import { RsiFailClosedError } from './types.js';

/** 读快照两次都与清单不一致(写入方正在提交):退出 4 `RSI_SNAPSHOT_BUSY` */
export class RsiSnapshotBusyError extends Error {
  readonly code = RSI_SNAPSHOT_BUSY;
  constructor() {
    super('rsi: snapshot busy');
  }
}

export interface StableExit {
  line: string;
  exit: ExitCodeValue;
}

export function stableOf(e: unknown): StableExit {
  if (e instanceof RsiSnapshotBusyError) return { line: RSI_SNAPSHOT_BUSY, exit: ExitCode.NOT_RUN };
  if (e instanceof RsiFailClosedError || e instanceof RsiSnapshotError) {
    return { line: `RSI_FAIL_CLOSED reason=${e.reason}`, exit: ExitCode.FAIL_CLOSED };
  }
  if (e instanceof RsiLockError) {
    const s = e.toStable();
    return { line: `${s.code} reason=${s.reason}`, exit: s.exit };
  }
  // `WriteDeniedError`(safe-fs)按稳定码字段识别:本文件在只读命令的 import 闭包里,不得 import 写出口
  if ((e as { code?: unknown } | null)?.code === 'IO_WRITE_DENIED') {
    return { line: 'RSI_FAIL_CLOSED reason=write_denied', exit: ExitCode.FAIL_CLOSED };
  }
  if (e instanceof PathsError) {
    return { line: 'RSI_FAIL_CLOSED reason=state_dir_unsafe', exit: ExitCode.FAIL_CLOSED };
  }
  return { line: 'RSI_FAIL_CLOSED reason=internal', exit: ExitCode.FAIL_CLOSED };
}

/** 写 stderr(只有稳定码一行)并返回退出码 */
export function failExit(stderr: (t: string) => void, e: unknown): number {
  const s = stableOf(e);
  stderr(`${s.line}\n`);
  return s.exit;
}
