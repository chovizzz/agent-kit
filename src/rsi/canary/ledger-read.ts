/**
 * 分组账 `.state/rsi/canary-ledger.jsonl` 的**只读**一侧(从 `ledger.ts` 拆出,行为不变;装配块 A 段):读侧的 import 闭包不得含 safe-fs 等写出口。
 * 句柄级安全读取、逐行 schema,任一行不合规 → `invalid`(不跳过坏行去「尽量」统计);文件不存在 = `absent`。写侧(追加 / stop 行)仍在 `ledger.ts`。
 */
import * as path from 'node:path';
import {
  RsiCanaryLedgerLineSchema,
  type RsiCanaryLedgerLine,
} from '../../contracts/rsi-personal.js';
import { readFileSafe } from '../../io/read-fs.js';
import { RSI_FILE_OWNER } from '../lock-read.js';
import { CANARY_FILES } from './files.js';

/** 账文件读取上限(远大于正常规模;超限按 `invalid` 处理,不截断读) */
export const LEDGER_READ_MAX_BYTES = 64 * 1024 * 1024;

export type LedgerRead =
  { kind: 'absent' } | { kind: 'ok'; lines: readonly RsiCanaryLedgerLine[] } | { kind: 'invalid' };

/** 解析账文本:每行都必须过 schema,缺尾换行 / 空行 / 坏 JSON → invalid */
export function parseLedger(text: string): LedgerRead {
  if (text === '') return { kind: 'ok', lines: [] };
  if (!text.endsWith('\n')) return { kind: 'invalid' };
  const lines: RsiCanaryLedgerLine[] = [];
  for (const l of text.slice(0, -1).split('\n')) {
    let raw: unknown;
    try {
      raw = JSON.parse(l);
    } catch {
      return { kind: 'invalid' };
    }
    const p = RsiCanaryLedgerLineSchema.safeParse(raw);
    if (!p.success) return { kind: 'invalid' };
    lines.push(p.data);
  }
  return { kind: 'ok', lines };
}

export async function readLedger(rsiDir: string): Promise<LedgerRead> {
  const r = await readFileSafe(path.join(rsiDir, CANARY_FILES.ledger), {
    maxBytes: LEDGER_READ_MAX_BYTES,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind === 'missing') return { kind: 'absent' };
  if (r.kind === 'unsafe') return { kind: 'invalid' };
  return parseLedger(r.bytes.toString('utf8'));
}
