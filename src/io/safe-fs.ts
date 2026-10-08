/**
 * 唯一的文件系统「写」出口。除本文件外,任何源码不得 import node:fs(eslint 强制)。
 * 每次写入前校验目标(解析 symlink 后)落在 ctx.writeRoots 之内,违者抛 WriteDeniedError。
 *
 * - 相对路径按 ctx.repoRoot 解析(不按 cwd)。
 * - 校验用 realpath:目标不存在时取「最深的已存在祖先」的 realpath 再拼剩余段,
 *   所以经 symlink 逃出 root 的写入同样被拒;悬空 symlink 一律拒。
 * - 写文件/删除要求目标严格位于 root 之下(不能写 root 本身,不能删 root 本身);mkdirp 允许等于 root。
 * - 目标是硬链接(nlink>1 的普通文件)一律拒绝;copyFile 的来源限定在仓库或写入根内。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { IoContext } from './paths.js';

export class WriteDeniedError extends Error {
  readonly code = 'IO_WRITE_DENIED';
}

function realResolve(abs: string): string {
  // 找到最深的已存在祖先(lstat 不跟随 symlink),对它做 realpath,再拼回剩余段。
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(cur);
    } catch {
      st = undefined;
    }
    if (st) {
      let real: string;
      try {
        real = fs.realpathSync(cur);
      } catch {
        throw new WriteDeniedError(`悬空或不可解析的符号链接,拒绝写入:${cur}`);
      }
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    }
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

function within(root: string, target: string, allowEqual: boolean): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return allowEqual;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface AssertOptions {
  /** 允许目标等于 root 本身(仅 mkdirp) */
  allowRoot?: boolean;
}

/** 校验并返回解析后的绝对路径(未做 realpath 的那份,供调用 fs 用)。 */
export function assertWritable(ctx: IoContext, target: string, opts: AssertOptions = {}): string {
  if (ctx.writeRoots.length === 0) {
    throw new WriteDeniedError('没有任何允许写入的根目录(KIT_WRITE_ROOTS 为空)');
  }
  const abs = path.resolve(ctx.repoRoot, target);
  const real = realResolve(abs);
  const ok = ctx.writeRoots.some((root) =>
    within(realResolve(root), real, opts.allowRoot === true),
  );
  if (!ok) {
    throw new WriteDeniedError(`写入被拒绝:目标不在允许的根目录内:${abs}`);
  }
  // 硬链接:root 内的一个名字可能指向 root 外的 inode,写它等于改写外部文件。
  try {
    const st = fs.lstatSync(real); // 用解析后的真实路径:经 symlink 指向的硬链接别名同样要拦
    if (st.isFile() && st.nlink > 1) {
      throw new WriteDeniedError(`写入被拒绝:目标是硬链接(nlink=${st.nlink}):${abs}`);
    }
  } catch (e) {
    if (e instanceof WriteDeniedError) throw e;
    // 目标尚不存在:没有硬链接问题
  }
  return abs;
}

/** copyFile 的来源:只能是仓库内或写入根内的文件,不能把仓库外的内容(如 ~/.ssh)吸进 out/。 */
function assertCopySource(ctx: IoContext, from: string): string {
  const abs = path.resolve(ctx.repoRoot, from);
  const real = realResolve(abs);
  const bases = [ctx.repoRoot, ...ctx.writeRoots];
  if (!bases.some((b) => within(realResolve(b), real, false))) {
    throw new WriteDeniedError(`复制来源不在仓库或写入根内:${abs}`);
  }
  return abs;
}

export interface WriteOptions {
  /** 文件权限,缺省 0o644;.state 下的文件应传 0o600 */
  mode?: number;
}

export async function writeFile(
  ctx: IoContext,
  target: string,
  data: string | Uint8Array,
  opts: WriteOptions = {},
): Promise<void> {
  const abs = assertWritable(ctx, target);
  await fsp.writeFile(abs, data, { mode: opts.mode ?? 0o644 });
}

export async function appendFile(
  ctx: IoContext,
  target: string,
  data: string | Uint8Array,
  opts: WriteOptions = {},
): Promise<void> {
  const abs = assertWritable(ctx, target);
  await fsp.appendFile(abs, data, { mode: opts.mode ?? 0o644 });
}

/** 递归建目录;目录权限缺省 0o755(.state 传 0o700)。 */
export async function mkdirp(ctx: IoContext, target: string, mode = 0o755): Promise<void> {
  const abs = assertWritable(ctx, target, { allowRoot: true });
  await fsp.mkdir(abs, { recursive: true, mode });
}

export async function remove(ctx: IoContext, target: string): Promise<void> {
  const abs = assertWritable(ctx, target);
  await fsp.rm(abs, { recursive: true, force: true });
}

export async function copyFile(ctx: IoContext, from: string, to: string): Promise<void> {
  const dest = assertWritable(ctx, to);
  await fsp.copyFile(assertCopySource(ctx, from), dest);
}

/** 两端都必须在 roots 内。 */
export async function rename(ctx: IoContext, from: string, to: string): Promise<void> {
  const src = assertWritable(ctx, from);
  const dest = assertWritable(ctx, to);
  await fsp.rename(src, dest);
}

export async function chmod(ctx: IoContext, target: string, mode: number): Promise<void> {
  const abs = assertWritable(ctx, target, { allowRoot: true });
  await fsp.chmod(abs, mode);
}

/**
 * 在 parent(必须在写入根内)下建一个唯一临时目录并返回其绝对路径。
 * 测试用它拿工作目录:parent 取 `ctx.tmpDir ?? <stateDir>/test-tmp`。
 */
export async function mkdtemp(ctx: IoContext, parent: string, prefix: string): Promise<string> {
  const abs = assertWritable(ctx, parent, { allowRoot: true });
  await fsp.mkdir(abs, { recursive: true, mode: 0o700 });
  return fsp.mkdtemp(path.join(abs, prefix));
}

/** 符号链接:链接位置与指向目标都必须在写入根内(不能造出指向根外的链接)。 */
export async function symlink(ctx: IoContext, target: string, linkPath: string): Promise<void> {
  const dest = assertWritable(ctx, linkPath);
  const tgt = path.resolve(path.dirname(dest), target);
  assertWritable(ctx, tgt, { allowRoot: true });
  await fsp.symlink(tgt, dest);
}

/** 硬链接:两端都必须在写入根内。(之后写入任一端仍会被「nlink>1」规则拒绝。) */
export async function hardlink(ctx: IoContext, existing: string, newPath: string): Promise<void> {
  const src = assertWritable(ctx, existing);
  const dest = assertWritable(ctx, newPath);
  await fsp.link(src, dest);
}
