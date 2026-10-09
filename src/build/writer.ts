/**
 * build 的写盘部分:只经 safe-fs,写入根只有 `<repo>/out/`。
 * 顺序:读上一次的 manifest → 清掉它登记过的文件(防陈旧)→ 写新文件 → 最后写 manifest.json。
 * manifest 最后写:它存在 = 上一次 build 走完了。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { ManifestSchema, OutRelPathSchema } from '../contracts/render.js';
import type { OutFile } from '../contracts/render.js';
import { MANIFEST_FILE, outFilePath, outKey as outKeyOf } from '../render/out-layout.js';
import type { IoContext } from '../io/paths.js';
import { existsSync, lstat, readBytes, readDir, readText } from '../io/read-fs.js';
import { chmod, mkdirp, remove, writeFile } from '../io/safe-fs.js';

export const MANIFEST_NAME = MANIFEST_FILE;

/** 本命令只产出 `<agent>/<home|project>/<relPath>`;manifest 登记别的形状(如 `tmp/x`)一律不信,避免删到用户自己的文件。 */
const OUT_ENTRY_SHAPE = /^[^/]+\/(?:home|project)\/.+/u;

export class OutDirError extends Error {
  readonly code = 'BUILD_OUT_DIR';
}

export interface PreviousOut {
  /** 上一次 manifest 登记的文件(相对 out/,已校验为安全相对路径) */
  paths: string[];
  /** 登记路径 → 登记的 sha256(用于发现手改);缺省视为不核对 */
  shas?: ReadonlyMap<string, string>;
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

/**
 * 从 out/ 往下逐段 lstat 相对路径 `rel`:任何一段(含中间段;includeLeaf 时含叶子)是符号链接就抛错。
 * 写入根的 realpath 校验只能保证「落在某个写入根内」,挡不住 out/ 里的链接把写/删引到 .state/ 或 KIT_TMP。
 */
export async function assertNoLinkInChain(
  io: IoContext,
  rel: string,
  includeLeaf: boolean,
): Promise<void> {
  const parts = rel.split('/');
  let cur = io.outDir;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i] as string);
    if (i === parts.length - 1 && !includeLeaf) return;
    let st;
    try {
      st = await lstat(cur); // lstat 不跟随链接,悬空链接也能看到
    } catch {
      return; // 不存在:其下更不存在
    }
    if (st.isSymbolicLink()) {
      throw new OutDirError(`out/${parts.slice(0, i + 1).join('/')} 是符号链接,拒绝读写其下路径`);
    }
  }
}

export async function readPreviousOut(io: IoContext): Promise<PreviousOut> {
  const file = path.join(io.outDir, MANIFEST_NAME);
  let mst;
  try {
    mst = await lstat(file); // lstat:悬空链接也看得见(existsSync 会说它不存在)
  } catch {
    return { paths: [] };
  }
  if (mst.isSymbolicLink()) {
    return { paths: [], untrusted: 'out/manifest.json 是符号链接' };
  }
  if (!mst.isFile()) {
    return { paths: [], untrusted: 'out/manifest.json 不是普通文件' };
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
  const shas = new Map<string, string>();
  for (const f of parsed.data.files) {
    if (
      !OutRelPathSchema.safeParse(f.path).success ||
      f.path === MANIFEST_NAME ||
      !OUT_ENTRY_SHAPE.test(f.path)
    ) {
      return { paths: [], untrusted: `out/manifest.json 含不安全路径:${f.path}` };
    }
    try {
      await assertNoLinkInChain(io, f.path, false);
    } catch (e) {
      return { paths: [], untrusted: (e as Error).message };
    }
    const abs = path.join(io.outDir, ...f.path.split('/'));
    if (existsSync(abs) && (await lstat(abs)).isDirectory()) {
      // 登记的是文件,现在却是目录:remove 会递归删掉里面的未登记内容,所以整份 manifest 不信
      return { paths: [], untrusted: `out/manifest.json 登记的 ${f.path} 现在是目录` };
    }
    paths.push(f.path);
    shas.set(f.path, f.sha256);
  }
  return { paths, shas };
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

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * 清掉上一次 build 登记的文件与 manifest.json,以及因此变空的目录。
 * 登记文件的内容与登记的 sha256 不符(被手改过)时不删,返回这些路径供调用方告警。
 * `keep`:本轮还会写的路径——它们无论如何会被覆盖,不必跳过。
 */
export async function cleanPrevious(
  io: IoContext,
  prev: PreviousOut,
  keep: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const modified: string[] = [];
  const kept: string[] = [];
  for (const p of prev.paths) {
    await assertNoLinkInChain(io, p, false);
    const abs = path.join(io.outDir, ...p.split('/'));
    const want = prev.shas?.get(p);
    if (want !== undefined && !keep.has(p) && existsSync(abs)) {
      const st = await lstat(abs);
      if (st.isFile() && sha256Hex(await readBytes(abs)) !== want) {
        modified.push(p);
        kept.push(p);
        continue;
      }
    }
    await remove(io, abs);
  }
  const mf = path.join(io.outDir, MANIFEST_NAME);
  // manifest.json 是目录时不递归删它(里面可能有未登记内容);随后写入会因 EISDIR 失败 → 退出 3
  if (!existsSync(mf) || !(await lstat(mf)).isDirectory()) await remove(io, mf);
  await pruneEmptyDirs(
    io,
    prev.paths.filter((p) => !kept.includes(p)),
  );
  return modified;
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
    await assertNoLinkInChain(io, outKeyOf(f), true);
    if (!dirs.has(dir)) {
      await mkdirp(io, dir);
      dirs.add(dir);
    }
    await writeFile(io, abs, f.content);
    await chmod(io, abs, 0o644); // writeFile 的 mode 只对新建文件生效
  }
  await assertNoLinkInChain(io, MANIFEST_NAME, true);
  await writeFile(io, path.join(io.outDir, MANIFEST_NAME), manifestText);
  await chmod(io, path.join(io.outDir, MANIFEST_NAME), 0o644);
}
