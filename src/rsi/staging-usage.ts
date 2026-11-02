/**
 * 暂存区现有用量(docs/contracts.md R20-6.7 / R20-16.15 第 2、11 步:50 个 run / 50MiB,按现有 `.state/reflect/` 计;R20-A4)。只读(readDir / lstat,不跟随链接)。
 * run = `reflect/` 下不以 `.` 开头的子目录;字节 = 其下全部普通文件(含上次失败遗留的 `.tmp-*` 目录里的文件,它们占的盘也算)。
 */
import * as path from 'node:path';
import type { IoContext } from '../io/paths.js';
import { lstat, readDir } from '../io/read-fs.js';

export interface StagingUsage {
  runs: number;
  bytes: number;
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink) continue; // 不跟随
    if (e.isDirectory) total += await dirBytes(p);
    else if (e.isFile) total += (await lstat(p)).size;
  }
  return total;
}

export async function stagingUsage(io: IoContext): Promise<StagingUsage> {
  const root = path.join(io.stateDir, 'reflect');
  let entries;
  try {
    entries = await readDir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { runs: 0, bytes: 0 };
    throw e;
  }
  let runs = 0;
  let bytes = 0;
  for (const e of entries) {
    if (e.isSymbolicLink) continue;
    if (e.isDirectory) {
      if (!e.name.startsWith('.')) runs++;
      bytes += await dirBytes(path.join(root, e.name));
    } else if (e.isFile) {
      bytes += (await lstat(path.join(root, e.name))).size;
    }
  }
  return { runs, bytes };
}
