/**
 * build 的写盘部分:只经 safe-fs,写入根只有 `<repo>/out/`。
 * 顺序:读上一次的 manifest → 清掉它登记过的文件(防陈旧)→ 写新文件 → 最后写 manifest.json。
 * manifest 最后写:它存在 = 上一次 build 走完了。
 */
import * as path from 'node:path';
import { ManifestSchema, OutRelPathSchema } from '../contracts/render.js';
import type { OutFile } from '../contracts/render.js';
import { MANIFEST_FILE, outFilePath } from '../render/out-layout.js';
import type { IoContext } from '../io/paths.js';
import { existsSync, lstat, readDir, readText } from '../io/read-fs.js';
import { mkdirp, remove, writeFile } from '../io/safe-fs.js';

export const MANIFEST_NAME = MANIFEST_FILE;

export class OutDirError extends Error {
  readonly code = 'BUILD_OUT_DIR';
}

export interface PreviousOut {
  /** 上一次 manifest 登记的文件(相对 out/,已校验为安全相对路径) */
  paths: string[];
  /** manifest 存在但不可信(JSON/schema 非法、含不安全路径)时的说明;此时 paths 为空 */
  untrusted?: string;
}

/** out/ 本身不得是符号链接:否则「写入根」经 realpath 会被悄悄换成仓库外的目录。 */
export async function assertOutDirNotLink(io: IoContext): Promise<void> {
  if (!existsSync(io.outDir)) return;
  const st = await lstat(io.outDir);
  if (st.isSymbolicLink()) throw new OutDirError('out/ 是符号链接,拒绝写入');
  if (!st.isDirectory()) throw new OutDirError('out 存在但不是目录,拒绝写入');
}

export async function readPreviousOut(io: IoContext): Promise<PreviousOut> {
  const file = path.join(io.outDir, MANIFEST_NAME);
  if (!existsSync(file)) return { paths: [] };
  if ((await lstat(file)).isSymbolicLink()) {
    return { paths: [], untrusted: 'out/manifest.json 是符号链接' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(file));
  } catch {
    return { paths: [], untrusted: 'out/manifest.json 不是合法 JSON' };
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) return { paths: [], untrusted: 'out/manifest.json 不符合 ManifestSchema' };
  const paths: string[] = [];
  for (const f of parsed.data.files) {
    if (!OutRelPathSchema.safeParse(f.path).success || f.path === MANIFEST_NAME) {
      return { paths: [], untrusted: `out/manifest.json 含不安全路径:${f.path}` };
    }
    const abs = path.join(io.outDir, ...f.path.split('/'));
    if (existsSync(abs) && (await lstat(abs)).isDirectory()) {
      // 登记的是文件,现在却是目录:remove 会递归删掉里面的未登记内容,所以整份 manifest 不信
      return { paths: [], untrusted: `out/manifest.json 登记的 ${f.path} 现在是目录` };
    }
    paths.push(f.path);
  }
  return { paths };
}

/** 登记在案之外、out/ 里实际存在的文件(相对路径,字节序);build 不动它们,只告警。 */
export async function listUnmanaged(
  io: IoContext,
  managed: ReadonlySet<string>,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = rel === '' ? io.outDir : path.join(io.outDir, ...rel.split('/'));
    if (!existsSync(abs)) return;
    for (const e of await readDir(abs)) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory && !e.isSymbolicLink) await walk(r);
      else if (r !== MANIFEST_NAME && !managed.has(r)) found.push(r);
    }
  };
  await walk('');
  return found;
}

async function pruneEmptyDirs(io: IoContext, relPaths: readonly string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const p of relPaths) {
    const parts = p.split('/').slice(0, -1);
    for (let i = parts.length; i > 0; i--) dirs.add(parts.slice(0, i).join('/'));
  }
  // 深的先删
  for (const d of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const abs = path.join(io.outDir, ...d.split('/'));
    if (!existsSync(abs)) continue;
    if ((await readDir(abs)).length === 0) await remove(io, abs);
  }
}

/** 清掉上一次 build 登记的文件与 manifest.json,以及因此变空的目录。 */
export async function cleanPrevious(io: IoContext, prev: PreviousOut): Promise<void> {
  for (const p of prev.paths) await remove(io, path.join(io.outDir, ...p.split('/')));
  await remove(io, path.join(io.outDir, MANIFEST_NAME));
  await pruneEmptyDirs(io, prev.paths);
}

export async function writeOut(
  io: IoContext,
  files: readonly OutFile[],
  manifestText: string,
): Promise<void> {
  await mkdirp(io, io.outDir);
  const dirs = new Set<string>();
  for (const f of files) {
    const abs = outFilePath(io.outDir, f);
    const dir = path.dirname(abs);
    if (!dirs.has(dir)) {
      await mkdirp(io, dir);
      dirs.add(dir);
    }
    await writeFile(io, abs, f.content);
  }
  await writeFile(io, path.join(io.outDir, MANIFEST_NAME), manifestText);
}
