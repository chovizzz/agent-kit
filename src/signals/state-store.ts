/**
 * `.state/` 的盐与信号库。写入一律经 safe-fs(KIT_WRITE_ROOTS 守卫);目录 0700、文件 0600。
 *
 * - 盐:`.state/salt`(首次创建非原子:safe-fs 没有 O_EXCL 导出,两个进程同时首跑可能各写一份,P0 按单进程假设;见汇报「待主代理」),32 字节随机数的十六进制,0600,gitignored。已存在但是符号链接、权限宽于 0600
 *   或格式非法 → SaltError(调用方 fail-closed 退出 3),**不静默重生成**(重生成会让历史哈希全部失联)。
 *   `create:false`(--dry)且文件不存在 → 内存临时盐,不落盘。
 * - 信号库:`.state/signals/<agent>/<yyyymm>.jsonl`,按 sig_id 去重(重跑幂等),
 *   写入走「临时文件 + rename」,不会留下半行 JSON;月份按信号 ts(事件时间)的 UTC。
 *   库里有坏行 → SignalStoreError(fail-closed)。假设单进程写入:并发的两次 collect 会互相覆盖(P0 接受)。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { AgentId } from '../contracts/common.js';
import { SignalSchema } from '../contracts/signal.js';
import type { Signal } from '../contracts/signal.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readText } from '../io/read-fs.js';
import { chmod, mkdirp, rename, writeFile } from '../io/safe-fs.js';
import { SALT_RE } from './ids.js';

export class SaltError extends Error {
  readonly code = 'SIGNALS_SALT_INVALID';
}

/** 信号库里有无法解析的行:库已带病,不再往里追加(fail-closed)。 */
export class SignalStoreError extends Error {
  readonly code = 'SIGNALS_STORE_CORRUPT';
}

export interface SaltResult {
  salt: string;
  /** false = 内存临时盐(--dry 且文件不存在) */
  persisted: boolean;
}

export function saltPath(io: IoContext): string {
  return path.join(io.stateDir, 'salt');
}

function newSalt(): string {
  return randomBytes(32).toString('hex');
}

async function readExistingSalt(file: string): Promise<string | undefined> {
  let st;
  try {
    st = await lstat(file);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink()) throw new SaltError('盐文件是符号链接');
  if (!st.isFile()) throw new SaltError('盐文件不是普通文件');
  if ((st.mode & 0o077) !== 0) throw new SaltError('盐文件权限宽于 0600');
  const salt = (await readText(file)).trim();
  if (!SALT_RE.test(salt)) throw new SaltError('盐文件格式非法(应为 64 位十六进制)');
  return salt;
}

export async function loadSalt(io: IoContext, opts: { create: boolean }): Promise<SaltResult> {
  const file = saltPath(io);
  const existing = await readExistingSalt(file);
  if (existing !== undefined) return { salt: existing, persisted: true };
  if (!opts.create) return { salt: newSalt(), persisted: false };
  await mkdirp(io, io.stateDir, 0o700);
  await chmod(io, io.stateDir, 0o700);
  await writeFile(io, file, `${newSalt()}\n`, { mode: 0o600 });
  await chmod(io, file, 0o600);
  // 回读:并发创建时以最终落盘的那份为准
  const final = await readExistingSalt(file);
  if (final === undefined) throw new SaltError('盐文件写入后读不到');
  return { salt: final, persisted: true };
}

export function signalMonth(ts: string): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 键按码元序排序的单行 JSON(Signal 是扁平对象,数组元素是字符串)。 */
export function signalLine(signal: Signal): string {
  const o = signal as unknown as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) sorted[k] = o[k];
  return JSON.stringify(sorted);
}

export function signalsDir(io: IoContext, agent: AgentId): string {
  return path.join(io.stateDir, 'signals', agent);
}

export interface WriteResult {
  written: number;
  deduplicated: number;
  files: string[];
}

async function existingText(file: string): Promise<string> {
  try {
    await lstat(file);
  } catch {
    return '';
  }
  return readText(file);
}

function knownSigIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let id: unknown;
    try {
      id = (JSON.parse(line) as { sig_id?: unknown }).sig_id;
    } catch {
      throw new SignalStoreError('信号库含无法解析的行');
    }
    if (typeof id !== 'string') throw new SignalStoreError('信号库含缺 sig_id 的行');
    ids.add(id);
  }
  return ids;
}

export async function writeSignals(
  io: IoContext,
  agent: AgentId,
  signals: readonly Signal[],
): Promise<WriteResult> {
  const result: WriteResult = { written: 0, deduplicated: 0, files: [] };
  if (signals.length === 0) return result;

  const byMonth = new Map<string, Signal[]>();
  for (const s of signals) {
    SignalSchema.parse(s); // 落盘前最后一道结构校验
    const m = signalMonth(s.ts);
    const list = byMonth.get(m) ?? [];
    list.push(s);
    byMonth.set(m, list);
  }

  const dir = signalsDir(io, agent);
  await mkdirp(io, dir, 0o700);
  for (const d of [io.stateDir, path.join(io.stateDir, 'signals'), dir]) {
    await chmod(io, d, 0o700);
  }

  for (const [month, list] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const file = path.join(dir, `${month}.jsonl`);
    const prev = await existingText(file);
    const seen = knownSigIds(prev);
    const fresh: string[] = [];
    for (const s of list) {
      if (seen.has(s.sig_id)) {
        result.deduplicated++;
        continue;
      }
      seen.add(s.sig_id);
      fresh.push(signalLine(s));
    }
    if (fresh.length === 0) {
      if (prev !== '') await chmod(io, file, 0o600); // 已有文件权限过宽时顺带收紧
      continue;
    }
    const head = prev === '' || prev.endsWith('\n') ? prev : `${prev}\n`;
    const tmp = `${file}.tmp`;
    await writeFile(io, tmp, `${head}${fresh.join('\n')}\n`, { mode: 0o600 });
    await chmod(io, tmp, 0o600);
    await rename(io, tmp, file);
    await chmod(io, file, 0o600);
    result.written += fresh.length;
    result.files.push(file);
  }
  return result;
}
