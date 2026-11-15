/**
 * 分组账 `.state/rsi/canary-ledger.jsonl`(docs/contracts.md R21-6.4;0600,`O_APPEND` 单行、**不拿锁**,与 R20-5.1 末行同类)。
 *
 * - 写:先过 `RsiCanaryLedgerLineSchema`(非法行直接抛,不落盘),序列化为单行(≤ {@link LEDGER_LINE_MAX_BYTES} 字节),经 `appendFileSynced`
 *   (`O_APPEND|O_NOFOLLOW` + `fsync`)追加;**成功返回才算落账**——hint 的第 6 / 7 行只在此之后输出(「未落账不注入」,R21-6.11)。
 * - 读(worker / 分析用):句柄级安全读取、逐行 schema,任一行不合规 → `invalid`(不跳过坏行去「尽量」统计)。
 * - 停止行(R21-9.5):对账写的 stop 行带 `revocation_ref`,**同一 `revocation_ref` 至多一行**:调用方持 `rsi/lock`,先读账再追加;
 *   并发 hint 的 assign 行不受影响(它们不拿锁、只追加)。
 */
import * as path from 'node:path';
import {
  RsiCanaryLedgerLineSchema,
  type RsiCanaryLedgerLine,
} from '../../contracts/rsi-personal.js';
import { RSI_FILE_MODE } from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import { appendFileSynced } from '../../io/safe-fs.js';
import { CANARY_FILES, LEDGER_LINE_MAX_BYTES } from './files.js';
import { readLedger } from './ledger-read.js';

// 读侧已拆到 `ledger-read.ts`(闭包里没有 safe-fs 写出口);这里原样再导出,既有调用点不变
export { LEDGER_READ_MAX_BYTES, parseLedger, readLedger, type LedgerRead } from './ledger-read.js';

export class LedgerError extends Error {
  readonly code = 'RSI_CANARY_LEDGER';
  constructor(readonly kind: 'line_invalid' | 'line_too_large' | 'read_failed' | 'invalid_ledger') {
    super(`canary ledger: ${kind}`);
  }
}

/** 序列化一行(校验 + 单行 + 字节上限);不写盘 */
export function ledgerLineText(line: RsiCanaryLedgerLine): string {
  const p = RsiCanaryLedgerLineSchema.safeParse(line);
  if (!p.success) throw new LedgerError('line_invalid');
  const text = `${JSON.stringify(p.data)}\n`;
  if (Buffer.byteLength(text, 'utf8') > LEDGER_LINE_MAX_BYTES)
    throw new LedgerError('line_too_large');
  return text;
}

/** 追加一行并 fsync;任何失败抛错(调用方据此不输出)。`rsiDir` 是已确认安全的 `.state/rsi` 目录 */
export async function appendLedgerLine(
  io: IoContext,
  rsiDir: string,
  line: RsiCanaryLedgerLine,
): Promise<void> {
  const text = ledgerLineText(line);
  await appendFileSynced(io, path.join(rsiDir, CANARY_FILES.ledger), text, RSI_FILE_MODE);
}

export type StopAppend = 'appended' | 'already_present';

/**
 * 追加 stop 行(R21-6.4 / R21-9.5)。调用方须已持 `rsi/lock`(`assertHeld` 在读账之前与追加之前各调一次)。
 * `revocation_ref` 非空时,账里已有同值的 stop 行 → 不重复写(`already_present`);账读不了 / 不合规 → 抛 `invalid_ledger`(不在坏账上追加)。
 */
export async function appendStopLine(
  io: IoContext,
  rsiDir: string,
  held: { assertHeld(): Promise<void> },
  line: Extract<RsiCanaryLedgerLine, { kind: 'stop' }>,
): Promise<StopAppend> {
  await held.assertHeld();
  const cur = await readLedger(rsiDir);
  if (cur.kind === 'invalid') throw new LedgerError('invalid_ledger');
  if (
    line.revocation_ref !== null &&
    cur.kind === 'ok' &&
    cur.lines.some((l) => l.kind === 'stop' && l.revocation_ref === line.revocation_ref)
  ) {
    return 'already_present';
  }
  await held.assertHeld();
  await appendLedgerLine(io, rsiDir, line);
  return 'appended';
}
