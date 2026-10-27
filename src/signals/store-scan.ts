/**
 * 信号库 / 会话计数库月文件的**只读**枚举与逐行扫描(R20-A2 B5c;purge 的计数与重写共用)。只 import read-fs,不含任何写出口。
 *
 * - {@link listMonthFiles}:`.state/{signals|sessions}/<agent>/<yyyymm>.jsonl`(名字判定只有契约里 `RSI_SNAPSHOT_DYNAMIC_NAME_RE` 一份),按路径升序。
 *   名字像月文件却是符号链接 / 目录 / 非普通文件、或父目录是链接 → {@link SignalStoreError}(调用方映射为 `signal_store_corrupt`)。目录不存在 = 没有文件。
 * - {@link scanMonthFile}:句柄级(`openStreamSafe`:`O_NOFOLLOW`、普通文件、`nlink == 1`)流式读,**按字节** `\n` 切行(不去 `\r`、不接受缺尾换行),
 *   一行凑齐后整体按严格 UTF-8 解码再 `JSON.parse`;空行 / 坏 UTF-8 / 非 JSON / 超长行 / 缺尾换行 / 读错误 → {@link SignalStoreError}。
 *   同一次调用里校验与读取用同一个句柄,所以检查之后路径被换成链接或另一个 inode 也读不到别处的内容。返回该句柄的身份 `(dev, ino, size)`,供重写前后核对。
 */
import * as path from 'node:path';
import { RSI_AGENT_IDS, RSI_SNAPSHOT_DYNAMIC_NAME_RE } from '../contracts/rsi.js';
import type { IoContext } from '../io/paths.js';
import { MAX_LINE_BYTES, lstat, openStreamSafe, readDir } from '../io/read-fs.js';
import { SignalStoreError } from './state-store.js';

export type MonthStoreKind = 'signals' | 'sessions';

export interface MonthFileId {
  dev: number;
  ino: number;
  size: number;
}

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const corrupt = (why: string): SignalStoreError => new SignalStoreError(`月文件不合规:${why}`);

async function realDirOrMissing(p: string): Promise<boolean> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink() || !st.isDirectory()) throw corrupt('目录不是真实目录');
    return true;
  } catch (e) {
    if (e instanceof SignalStoreError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw corrupt('目录不可读');
  }
}

/** 全部月文件的绝对路径(升序) */
export async function listMonthFiles(io: IoContext, kind: MonthStoreKind): Promise<string[]> {
  const root = path.join(io.stateDir, kind);
  const out: string[] = [];
  if (!(await realDirOrMissing(root))) return out;
  for (const agent of RSI_AGENT_IDS) {
    const dir = path.join(root, agent);
    if (!(await realDirOrMissing(dir))) continue;
    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      throw corrupt('目录不可读');
    }
    for (const f of entries) {
      if (!RSI_SNAPSHOT_DYNAMIC_NAME_RE.test(`${kind}/${agent}/${f.name}`)) continue;
      if (!f.isFile || f.isSymbolicLink) throw corrupt('月文件不是普通文件');
      out.push(path.join(dir, f.name));
    }
  }
  return out.sort();
}

/**
 * 逐行扫描一个月文件。`onLine(raw, value)`:`raw` 是不含 `\n` 的原始字节,`value` 是解析后的 JSON;返回 false = 该行记录不合规 → 整个文件按损坏处理(回调可以是异步的,逐行按序 await)。
 * 文件不存在返回 `null`(调用方当作没有)。
 */
export async function scanMonthFile(
  absPath: string,
  onLine: (raw: Buffer, value: unknown) => boolean | Promise<boolean>,
  hooks: { beforeOpen?: () => Promise<void> | void } = {},
): Promise<MonthFileId | null> {
  const s = await openStreamSafe(absPath, hooks);
  if (s.kind === 'missing') return null;
  if (s.kind === 'unsafe') throw corrupt('月文件不安全');
  let parts: Buffer[] = [];
  let len = 0;
  const finish = async (): Promise<void> => {
    const raw = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, len);
    parts = [];
    len = 0;
    let value: unknown;
    try {
      value = JSON.parse(DECODER.decode(raw));
    } catch {
      throw corrupt('坏行');
    }
    if (raw.length === 0 || !(await onLine(raw, value))) throw corrupt('行记录不合规');
  };
  const add = (b: Buffer): void => {
    if (b.length === 0) return;
    len += b.length;
    if (len > MAX_LINE_BYTES) throw corrupt('超长行');
    parts.push(b);
  };
  try {
    for await (const chunk of s.chunks()) {
      let pos = 0;
      for (;;) {
        const idx = chunk.indexOf(0x0a, pos);
        if (idx < 0) {
          add(chunk.subarray(pos));
          break;
        }
        add(chunk.subarray(pos, idx));
        await finish();
        pos = idx + 1;
      }
    }
    if (len > 0) throw corrupt('缺尾换行');
  } catch (e) {
    if (e instanceof SignalStoreError) throw e;
    throw corrupt('读取失败');
  } finally {
    await s.close();
  }
  return { dev: s.meta.dev, ino: s.meta.ino, size: s.meta.size };
}

/** 信号库 / 会话计数行的 `project_key`(都是顶层字符串字段);取不到 = null(调用方按损坏处理) */
export function projectKeyOf(line: unknown): string | null {
  if (typeof line !== 'object' || line === null || Array.isArray(line)) return null;
  const k = (line as { project_key?: unknown }).project_key;
  return typeof k === 'string' && k !== '' ? k : null;
}
