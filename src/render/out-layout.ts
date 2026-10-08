/**
 * `out/<agent>/<target>/<relPath>` 的虚拟布局(设计 §4.1)。
 * `home` 只是路径记号,P2 才会映射到真实 `~`;这里任何代码都不得把它展开成真实 HOME。
 * 所有排序按 UTF-8 字节序(不用 localeCompare,不受 LANG 影响)。
 */
import * as path from 'node:path';
import { canonicalJson } from '../io/canonical-json.js';
import { exists, readBytes, readDir } from '../io/read-fs.js';
import type { IoContext } from '../io/paths.js';
import * as safe from '../io/safe-fs.js';
import type { Layer } from '../contracts/atom.js';
import type { ResolvedAtom } from '../contracts/merge.js';
import type { ChannelName } from '../contracts/config.js';
import { ManifestSchema } from '../contracts/render.js';
import type { Manifest, OutFile } from '../contracts/render.js';
import { sha256Hex } from './managed-block.js';

export const MANIFEST_FILE = 'manifest.json';

export class OutLayoutError extends Error {
  constructor(
    readonly code:
      | 'OUT_DUPLICATE'
      | 'OUT_CASE_COLLISION'
      | 'OUT_FILE_DIR_CONFLICT'
      | 'OUT_PERSONAL_LEAK'
      | 'OUT_UNKNOWN_ATOM'
      | 'OUT_UNSAFE_ENTRY',
    message: string,
  ) {
    super(message);
    this.name = 'OutLayoutError';
  }
}

/** UTF-8 字节序比较(与 `Buffer.compare` 一致)。 */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** `<agent>/<target>/<relPath>`(正斜杠)。 */
export function outKey(f: Pick<OutFile, 'agent' | 'target' | 'relPath'>): string {
  return `${f.agent}/${f.target}/${f.relPath}`;
}

/** 绝对路径:`<outDir>/<agent>/<target>/<relPath>`。 */
export function outFilePath(
  outDir: string,
  f: Pick<OutFile, 'agent' | 'target' | 'relPath'>,
): string {
  return path.join(outDir, f.agent, f.target, ...f.relPath.split('/'));
}

function foldKey(key: string): string {
  return key.normalize('NFC').toLowerCase();
}

/** 按字节序排序(返回新数组)。 */
export function sortOutFiles<T extends Pick<OutFile, 'agent' | 'target' | 'relPath'>>(
  files: readonly T[],
): T[] {
  return [...files].sort((a, b) => byteCompare(outKey(a), outKey(b)));
}

/**
 * 碰撞检查:同一路径重复、仅大小写/Unicode 归一化不同(macOS 默认不区分大小写)、
 * 一个路径是另一个路径的目录前缀。
 */
export function assertNoCollisions(
  files: readonly Pick<OutFile, 'agent' | 'target' | 'relPath'>[],
): void {
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  const keys = files.map(outKey);
  for (const key of keys) {
    if (exact.has(key)) throw new OutLayoutError('OUT_DUPLICATE', `输出路径重复:${key}`);
    exact.add(key);
    const f = foldKey(key);
    const prior = folded.get(f);
    if (prior !== undefined) {
      throw new OutLayoutError(
        'OUT_CASE_COLLISION',
        `输出路径仅大小写/归一化不同:${prior} 与 ${key}`,
      );
    }
    folded.set(f, key);
  }
  for (const key of keys) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      if (exact.has(prefix) || folded.has(foldKey(prefix))) {
        throw new OutLayoutError('OUT_FILE_DIR_CONFLICT', `${prefix} 既是文件又是目录(${key})`);
      }
    }
  }
}

export interface ManifestMeta {
  kitVersion: string;
  channel: ChannelName;
  skippedLayers: readonly Manifest['skippedLayers'][number][];
}

/**
 * 生成 out/manifest.json 的内容对象。sha256 对**最终落盘内容**(含独占头)的 UTF-8 字节计算。
 * 输出里出现 coreEligible=false 的原子(personal)或未知原子 ⇒ 抛错(A15 的依据)。
 */
export function buildManifest(
  files: readonly OutFile[],
  resolved: readonly ResolvedAtom[],
  meta: ManifestMeta,
): Manifest {
  const byId = new Map<string, ResolvedAtom>();
  for (const r of resolved) byId.set(r.atom.fm.id, r);
  assertNoCollisions(files);
  const entries = sortOutFiles(files).map((f) => {
    const atoms = [...f.atomIds].sort(byteCompare).map((id): { id: string; layer: Layer } => {
      const r = byId.get(id);
      if (!r) throw new OutLayoutError('OUT_UNKNOWN_ATOM', `${outKey(f)} 引用了未知原子 ${id}`);
      if (!r.coreEligible) {
        throw new OutLayoutError(
          'OUT_PERSONAL_LEAK',
          `${outKey(f)} 含不得进入 core 输出的原子 ${id}(${r.layer})`,
        );
      }
      return { id, layer: r.layer };
    });
    return {
      path: outKey(f),
      agent: f.agent,
      target: f.target,
      mode: f.mode,
      confidence: f.confidence,
      ...(f.conditional !== undefined ? { conditional: f.conditional } : {}),
      sha256: sha256Hex(f.content),
      atoms,
      sourceRefs: [...(f.sourceRefs ?? [])].sort(byteCompare),
    };
  });
  return ManifestSchema.parse({
    schema_version: 1,
    kit_version: meta.kitVersion,
    channel: meta.channel,
    files: entries,
    skippedLayers: [...meta.skippedLayers].sort((a, b) =>
      byteCompare(canonicalJson(a), canonicalJson(b)),
    ),
  });
}

/** 内存中的树:key = `<agent>/<target>/<relPath>`,按字节序。 */
export function outFilesToTree(files: readonly OutFile[]): Map<string, string> {
  assertNoCollisions(files);
  return new Map(sortOutFiles(files).map((f) => [outKey(f), f.content]));
}

/** 递归列出目录下全部文件(相对路径,正斜杠,字节序)。遇到符号链接等非常规项抛错。 */
export async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    for (const e of await readDir(abs)) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink || (!e.isFile && !e.isDirectory)) {
        throw new OutLayoutError('OUT_UNSAFE_ENTRY', `非常规目录项(符号链接等):${r}`);
      }
      if (e.isDirectory) await walk(path.join(abs, e.name), r);
      else out.push(r);
    }
  }
  if (await exists(dir)) await walk(dir, '');
  return out.sort(byteCompare);
}

/** 读回目录下全部文件为 Map(字节序)。内容按 UTF-8 解码。 */
export async function readTree(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const rel of await listTree(dir)) {
    map.set(rel, Buffer.from(await readBytes(path.join(dir, ...rel.split('/')))).toString('utf8'));
  }
  return map;
}

export interface WriteOutOptions {
  /** 若给出,另写 `<outDir>/manifest.json`(canonicalJson) */
  manifest?: Manifest;
}

/**
 * 把文件写进 ctx.outDir(整树重建:先清掉 outDir 下已有的子项,再写)。
 * 失败语义:写到一半出错时 out/ 可能是半成品——out/ 是可随时重建的产物,调用方重跑即可。
 * 所有写入经 safe-fs,所以 ctx 的写入根不含 outDir 时会抛 WriteDeniedError。
 */
export async function writeOutTree(
  ctx: IoContext,
  files: readonly OutFile[],
  opts: WriteOutOptions = {},
): Promise<string[]> {
  assertNoCollisions(files);
  const sorted = sortOutFiles(files);
  if (await exists(ctx.outDir)) {
    for (const e of await readDir(ctx.outDir)) {
      await safe.remove(ctx, path.join(ctx.outDir, e.name));
    }
  }
  await safe.mkdirp(ctx, ctx.outDir);
  const written: string[] = [];
  for (const f of sorted) {
    const abs = outFilePath(ctx.outDir, f);
    await safe.mkdirp(ctx, path.dirname(abs));
    await safe.writeFile(ctx, abs, f.content);
    written.push(outKey(f));
  }
  if (opts.manifest) {
    await safe.writeFile(ctx, path.join(ctx.outDir, MANIFEST_FILE), canonicalJson(opts.manifest));
    written.push(MANIFEST_FILE);
  }
  return written;
}
