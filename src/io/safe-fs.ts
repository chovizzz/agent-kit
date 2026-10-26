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
import { findWriteRootEscape } from './paths.js';
import type { IoContext } from './paths.js';

export class WriteDeniedError extends Error {
  readonly code = 'IO_WRITE_DENIED';
}

/** 路径本身(不跟随符号链接)此刻是不是符号链接;不存在 = false;无法判断(权限、IO 错误等)= 拒绝 */
function isSymlinkNow(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw new WriteDeniedError(`无法确认路径是否为符号链接,拒绝写入:${p}`);
  }
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
      let real: string | undefined;
      try {
        real = fs.realpathSync(cur);
      } catch (e) {
        // lstat 与 realpath 之间被别的进程删掉(并发释放锁文件),甚至又被别人重新创建成普通文件:
        // 这不是符号链接,按「不存在」继续向上找(结果由父目录的真实路径 + 末段拼出)。
        // 此刻仍是符号链接(悬空 / 循环)或其它错误码才拒绝——不放宽对链接的守卫
        const vanished = (e as NodeJS.ErrnoException).code === 'ENOENT' && !isSymlinkNow(cur);
        if (!vanished) throw new WriteDeniedError(`悬空或不可解析的符号链接,拒绝写入:${cur}`);
      }
      if (real !== undefined) return rest.length === 0 ? real : path.join(real, ...rest.reverse());
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
  // 每次写入都重新按 realpath 判定写入根:状态目录 / 写入根的链接事后被改指向,下一次写入即被拒
  const escape = findWriteRootEscape(ctx);
  if (escape !== undefined) throw new WriteDeniedError(`写入被拒绝:${escape}`);
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
  // 仓库内的一个名字可能是仓库外 inode 的硬链接(如指向 ~/.ssh 的文件):读它等于吸进外部内容
  try {
    const st = fs.lstatSync(real);
    if (st.isFile() && st.nlink > 1) {
      throw new WriteDeniedError(`复制来源是硬链接(nlink=${st.nlink}):${abs}`);
    }
  } catch (e) {
    if (e instanceof WriteDeniedError) throw e;
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

/**
 * 独占创建并写入(R20-A0,contracts §5 safe-fs 导出表 / §20.9 第 4 条):`O_CREAT|O_EXCL|O_NOFOLLOW`,目标已存在则失败、**不覆盖、不改动**
 * 已有文件。错误分两类,调用方须分开处理:
 *  - 路径守卫拒绝(`WriteDeniedError`):根外、`..` 逃逸、悬空符号链接、指向根外的链接、硬链接(nlink>1)—— fail-closed,不是「被占用」;
 *  - 名字已被占用(`code === 'EEXIST'`):普通文件,或根内已存在目标的符号链接(O_EXCL 不跟随链接)。
 * 受与其它写函数相同的 `writeRoots` 守卫。用途:RSI 锁、预留 / 去重标记。
 * `mode` 必填(无缺省,避免锁文件默认 0644),创建后按 `mode` 显式 fchmod,不受 umask 影响。
 * 独占创建不等于内容原子发布:别的进程可能短暂看到空文件,锁协议自己处理。
 * 创建成功后写入失败时,尽力把刚创建的文件删掉再抛错(删除前核对路径上的 dev:ino 仍是本句柄的文件,否则不删,免得误删别人换上的同名锁);
 * 核对与删除之间仍有极小窗口,属已接受残余——持锁协议靠自己的过期回收兜底,不要依赖这里的清理。
 */
export async function createExclusive(
  ctx: IoContext,
  target: string,
  data: string | Uint8Array,
  mode: number,
): Promise<void> {
  const abs = assertWritable(ctx, target);
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const handle = await fsp.open(abs, flags, mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(data);
  } catch (e) {
    const mine = await handle.stat().catch(() => undefined);
    await handle.close().catch(() => undefined);
    const now = await fsp.lstat(abs).catch(() => undefined);
    if (mine !== undefined && now !== undefined && now.dev === mine.dev && now.ino === mine.ino) {
      await fsp.rm(abs, { force: true }).catch(() => undefined);
    }
    throw e;
  }
  await handle.close();
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
  // prefix 只是文件名前缀:带路径分隔符或 `..` 会让 mkdtemp 跳出已校验的 parent
  if (/[\\/]/.test(prefix) || prefix.includes('..')) {
    throw new WriteDeniedError(`mkdtemp 的 prefix 不得含路径分隔符或 '..':${prefix}`);
  }
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
