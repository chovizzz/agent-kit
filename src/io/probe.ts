import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { lstat, readBytes } from './read-fs.js';
import { inspectManagedBlock } from '../render/managed-block.js';
import type { BlockSnapshot, DiskEntry, DiskKind } from '../sync/types.js';

/**
 * HOME 相对路径的只读单路径探测(D-AU1 / 评审 M3:从 `sync/snapshot.ts` 下沉,钩子入口的零网络 update 读取只需要这一块,
 * 不必把整个快照构建器带进 import 闭包)。`sync/snapshot.ts` re-export,既有调用点不变。只读:不建目录、不改 mtime。
 */

/** 单文件读入上限:超过的当作非常规文件(不读、不改)。 */
export const MAX_READ_BYTES = 32 * 1024 * 1024;

export const sha256Of = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');

export async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

export interface Probe {
  entry: DiskEntry;
  /** kind=file 时的权限位(& 0o777) */
  mode?: number;
  /** kind=file 且未超上限时的 UTF-8 文本 */
  text?: string;
}

/**
 * 探测一个 HOME 相对路径。`home` 是 realpath。
 * 中间段是符号链接 → `linkedSegment: true`(不再往下走);中间段不是目录 → `kind: 'other'`。
 */
export async function probePath(
  home: string,
  rel: string,
  opts: { blockIds?: readonly string[]; readText?: boolean } = {},
): Promise<Probe> {
  const segments = rel.split('/');
  let cur = home;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(cur, segments[i] as string);
    const st = await lstatOrNull(next);
    if (st === null) return { entry: { kind: 'missing' } };
    const last = i === segments.length - 1;
    if (!last) {
      if (st.isSymbolicLink()) return { entry: { kind: 'missing', linkedSegment: true } };
      if (!st.isDirectory()) return { entry: { kind: 'other' } };
      cur = next;
      continue;
    }
    let kind: DiskKind;
    if (st.isSymbolicLink()) kind = 'symlink';
    else if (st.isDirectory()) kind = 'dir';
    else if (st.isFile()) kind = st.nlink > 1 ? 'hardlink' : 'file';
    else kind = 'other';
    if (kind !== 'file') return { entry: { kind } };
    if (st.size > MAX_READ_BYTES) return { entry: { kind: 'other' } };
    const bytes = await readBytes(next);
    const text = Buffer.from(bytes).toString('utf8');
    const entry: DiskEntry = { kind: 'file', sha256: sha256Of(bytes) };
    if (opts.blockIds !== undefined && opts.blockIds.length > 0) {
      const blocks: Record<string, BlockSnapshot> = {};
      for (const id of opts.blockIds) blocks[id] = blockSnapshotOf(text, id);
      entry.blocks = blocks;
    }
    return { entry, mode: st.mode & 0o777, ...(opts.readText === false ? {} : { text }) };
  }
  return { entry: { kind: 'missing' } };
}

/** 一个托管块在文本里的状态;restBlank = 去掉该块之后其余内容只剩空白(含 BOM)。 */
export function blockSnapshotOf(text: string, id: string): BlockSnapshot {
  const r = inspectManagedBlock(text, id);
  switch (r.state) {
    case 'corrupt':
      return { state: 'corrupt' };
    case 'block-missing':
    case 'file-missing':
      return { state: 'block-missing' };
    default:
      return {
        state: r.state,
        bodySha: r.block.actualSha,
        restBlank: `${r.before}${r.after}`.trim() === '',
      };
  }
}
