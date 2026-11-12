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
import {
  HOME_WRITE_TABLE,
  HOOKS_PRIVATE_STATE_REL,
  isKitHooksReserved,
} from '../contracts/sync.js';
import { findWriteRootEscape, getRealHome } from './paths.js';
import type { IoContext } from './paths.js';

/**
 * 写审计(R20-A2 B1):每个导出写函数在**入口第一行**调用,早于任何校验,所以被守卫拒绝的调用也会留下记录。
 * 记录的是 `path.resolve(repoRoot, 参数)` 的字面解析结果(不做 realpath、不碰磁盘,不会抛错)。
 * 双路径函数记两条:目标(op 即函数名)与来源(op 为 `<函数名>.from`)。来源先记、目标后记。
 * symlink 只记链接位置(指向的内容不是被写的路径)。
 * 钩子不得抛错(契约);这里不 try/catch,钩子抛错属钩子的 bug,应在测试里暴露而不是被吞。
 */
function audit(ctx: IoContext, op: string, target: string): void {
  ctx.writeAudit?.(op, path.resolve(ctx.repoRoot, target));
}

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
  /** 操作作用于整棵子树(递归删除、rename 的来源):目标是 kit-hooks 保留路径的祖先也拒绝 */
  subtree?: boolean;
}

/**
 * A5 验收评审采纳(§20.15-11 第 3 条):kit-hooks 三个目标与 `hooks/` 私有状态子树归 `hooks-fs.ts` 独占,
 * 普通写出口同样拒绝——否则把 KIT_TMP / KIT_STATE_DIR 指进该子树,`rsi stop` 之类就能经 safe-fs 写进去。
 * 按真实 HOME 下的 realpath 判定(保留判断本身已做 ASCII 大小写折叠);`subtree` 时目标是保留路径的祖先也拒绝。
 */
function assertNotKitHooks(real: string, abs: string, subtree: boolean): void {
  const home = realResolve(getRealHome());
  if (!within(home, real, false)) return;
  const rel = path.relative(home, real).split(path.sep).join('/');
  if (isKitHooksReserved(rel)) {
    throw new WriteDeniedError(`写入被拒绝:kit 钩子保留路径只能由 rsi hooks 写:${abs}`);
  }
  if (!subtree) return;
  const lower = `${rel.toLowerCase()}/`;
  const reserved = [
    HOOKS_PRIVATE_STATE_REL,
    ...HOME_WRITE_TABLE.filter((e) => e.owner === 'kit-hooks').map((e) => e.path),
  ];
  if (reserved.some((r) => r.toLowerCase().startsWith(lower))) {
    throw new WriteDeniedError(`写入被拒绝:目标包含 kit 钩子保留路径:${abs}`);
  }
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
  assertNotKitHooks(real, abs, opts.subtree === true);
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
  audit(ctx, 'writeFile', target);
  const abs = assertWritable(ctx, target);
  await fsp.writeFile(abs, data, { mode: opts.mode ?? 0o644 });
}

export async function appendFile(
  ctx: IoContext,
  target: string,
  data: string | Uint8Array,
  opts: WriteOptions & {
    /**
     * 不跟随末级符号链接(`O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW`,末级是链接 → `ELOOP` 抛出)。
     * 用于「先只读校验、再追加」的调用方(A6 订正 #1 的提醒放弃日志),封住校验与追加之间换成链接的末级窗口;缺省保持原行为。
     */
    noFollow?: boolean;
  } = {},
): Promise<void> {
  audit(ctx, 'appendFile', target);
  const abs = assertWritable(ctx, target);
  if (opts.noFollow !== true) {
    await fsp.appendFile(abs, data, { mode: opts.mode ?? 0o644 });
    return;
  }
  const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
  if (NOFOLLOW === 0) throw new WriteDeniedError('写入被拒绝:平台不支持 O_NOFOLLOW');
  const h = await fsp.open(
    abs,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW,
    opts.mode ?? 0o644,
  );
  try {
    await h.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  } finally {
    await h.close();
  }
}

/**
 * 单行追加并 `fsync`(R21-6.4 分组账 / R21-6.11「未落账不注入」:调用方只在本函数成功返回之后才输出):
 * `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW`,不拿锁;打开后对**句柄**核对为普通文件且 `nlink == 1`(不是则拒绝、不写),
 * 用**一次** `write` 写入并核对写出字节数等于数据长度(短写 = 抛错,不重试续写,免得与别的追加者交错),然后 `sync()`,成功才返回。
 * `mode` 必填(新建文件的权限,不改已有文件权限)。路径守卫同其它写函数。
 * **保证的边界(如实)**:`O_APPEND` 让每次底层 `write` 的定位与写入原子地落在文件尾;本函数据此让小于一个文件系统块的单行落成一次底层写。
 * 这不是「任意文件系统、任意故障下都不交错」的保证(`PIPE_BUF` 只对管道 / FIFO 成立):短写发生时本函数抛错,但已写出的前缀留在文件里,
 * worker / 分析读账时(逐行 schema 校验)会把这样的账判为不合规并 fail-closed;这**不**意味着后续 hint 会停止注入(hint 不读账)。调用方把「抛错」当作未落账、不输出。
 */
export async function appendFileSynced(
  ctx: IoContext,
  target: string,
  data: string | Uint8Array,
  mode: number,
): Promise<void> {
  audit(ctx, 'appendFileSynced', target);
  const abs = assertWritable(ctx, target);
  const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
  if (NOFOLLOW === 0) throw new WriteDeniedError('写入被拒绝:平台不支持 O_NOFOLLOW');
  const h = await fsp.open(
    abs,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW,
    mode,
  );
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink > 1) {
      throw new WriteDeniedError(`写入被拒绝:追加目标不是单链接的普通文件:${abs}`);
    }
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const { bytesWritten } = await h.write(buf, 0, buf.length);
    if (bytesWritten !== buf.length) {
      throw new WriteDeniedError(`写入被拒绝:追加发生短写(${bytesWritten}/${buf.length}):${abs}`);
    }
    await h.sync();
  } finally {
    await h.close();
  }
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
  audit(ctx, 'createExclusive', target);
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

/**
 * 独占创建 + 写入 + `fsync` 文件(R20-A4:digest / 名额文件的「临时文件写完 → fsync」):与 {@link createExclusive} 同样的路径守卫与 `O_EXCL|O_NOFOLLOW`,
 * 额外在关闭前 `sync()`。写失败 / 同步失败 → 尽力删除刚创建的文件再抛错(同 createExclusive 的 dev:ino 核对)。
 */
export async function createExclusiveSynced(
  ctx: IoContext,
  target: string,
  data: string | Uint8Array,
  mode: number,
): Promise<void> {
  audit(ctx, 'createExclusive', target);
  const abs = assertWritable(ctx, target);
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const handle = await fsp.open(abs, flags, mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(data);
    await handle.sync();
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

/** 对已打开的句柄 `fsync`;先发审计钩子(`syncFile`),测试据此核对「落盘发生在后续写之前」的顺序 */
async function syncHandle(ctx: IoContext, h: fsp.FileHandle, abs: string): Promise<void> {
  audit(ctx, 'syncFile', abs);
  await h.sync();
}

/**
 * **持久的**独占创建(熔断标记 `AUTO_PAUSE` 用,R21-12.2 / R21-10.1:标记必须先于状态写入「落盘」,掉电后也不能出现「状态已熔断、标记没了」):
 *  - 不存在 → `O_CREAT|O_EXCL|O_NOFOLLOW` 创建、写入、`fsync` 文件、关闭,再 `fsync` 父目录(目录项落盘),返回 `created`;
 *  - 已存在(`EEXIST`)→ **不覆盖、不改内容**;对已存在的文件(`O_RDONLY|O_NOFOLLOW`,须是单链接普通文件,否则 {@link WriteDeniedError})补一次 `fsync`,再 `fsync` 父目录,
 *    返回 `exists`(别人刚创建、尚未落盘的标记也在这里被我们落盘,不把「可能没落盘的既有文件」当作完成)。
 * 路径守卫同其它写函数;写入 / 同步 / 关闭 / 目录同步任一步失败 → 抛错,调用方不得继续(熔断:不写 state)。**与 {@link createExclusive} 不同,失败不删除刚创建的文件**
 * (无锁并发下别的创建者可能已对它返回 `exists`;留下不完整的标记方向安全,见下方注释)。
 */
export async function createExclusiveDurable(
  ctx: IoContext,
  target: string,
  data: string | Uint8Array,
  mode: number,
): Promise<'created' | 'exists'> {
  audit(ctx, 'createExclusiveDurable', target);
  const abs = assertWritable(ctx, target);
  const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
  if (NOFOLLOW === 0) throw new WriteDeniedError('写入被拒绝:平台不支持 O_NOFOLLOW');
  let outcome: 'created' | 'exists';
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      abs,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
      mode,
    );
    outcome = 'created';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // O_NONBLOCK:已有目标若是没有写端的 FIFO,阻塞式只读打开会永远等下去,到不了下面的类型核对
    handle = await fsp.open(abs, fs.constants.O_RDONLY | NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
    outcome = 'exists';
  }
  try {
    if (outcome === 'exists') {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink > 1) {
        throw new WriteDeniedError(`写入被拒绝:已有标记不是单链接的普通文件:${abs}`);
      }
    } else {
      await handle.chmod(mode);
      await handle.writeFile(data);
    }
    await syncHandle(ctx, handle, abs);
  } catch (e) {
    // 失败只关句柄并抛错,**不删除**刚创建的标记:无锁并发下别的 `ensure` 可能已对同一文件返回 `exists`(并随后写了 state),
    // 删掉它会撤掉对方已确认的标记;留一个内容不全的标记方向安全(hint 只判存在),调用方因抛错不会继续写 state
    await handle.close().catch(() => undefined);
    throw e;
  }
  await handle.close(); // 正常路径的 close 错误要传播(不能把失败降格为成功)
  await fsyncDir(ctx, path.dirname(abs));
  return outcome;
}

/** `fsync` 一个目录(rename / unlink 之后让目录项落盘;R20-16.10 / R20-16.15)。路径守卫同其它写函数(目录须在写入根内)。 */
export async function fsyncDir(ctx: IoContext, target: string): Promise<void> {
  audit(ctx, 'fsyncDir', target);
  const abs = assertWritable(ctx, target, { allowRoot: true });
  const handle = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 递归建目录;目录权限缺省 0o755(.state 传 0o700)。 */
export async function mkdirp(ctx: IoContext, target: string, mode = 0o755): Promise<void> {
  audit(ctx, 'mkdirp', target);
  const abs = assertWritable(ctx, target, { allowRoot: true });
  await fsp.mkdir(abs, { recursive: true, mode });
}

export async function remove(ctx: IoContext, target: string): Promise<void> {
  audit(ctx, 'remove', target);
  const abs = assertWritable(ctx, target, { subtree: true });
  await fsp.rm(abs, { recursive: true, force: true });
}

export async function copyFile(ctx: IoContext, from: string, to: string): Promise<void> {
  audit(ctx, 'copyFile.from', from);
  audit(ctx, 'copyFile', to);
  const dest = assertWritable(ctx, to);
  await fsp.copyFile(assertCopySource(ctx, from), dest);
}

/** 两端都必须在 roots 内。 */
export async function rename(ctx: IoContext, from: string, to: string): Promise<void> {
  audit(ctx, 'rename.from', from);
  audit(ctx, 'rename', to);
  const src = assertWritable(ctx, from, { subtree: true });
  const dest = assertWritable(ctx, to, { subtree: true });
  await fsp.rename(src, dest);
}

export async function chmod(ctx: IoContext, target: string, mode: number): Promise<void> {
  audit(ctx, 'chmod', target);
  const abs = assertWritable(ctx, target, { allowRoot: true });
  await fsp.chmod(abs, mode);
}

/**
 * 在 parent(必须在写入根内)下建一个唯一临时目录并返回其绝对路径。
 * 测试用它拿工作目录:parent 取 `ctx.tmpDir ?? <stateDir>/test-tmp`。
 */
export async function mkdtemp(ctx: IoContext, parent: string, prefix: string): Promise<string> {
  audit(ctx, 'mkdtemp', parent); // 记 parent;在 prefix 校验之前,被拒也记
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
  audit(ctx, 'symlink', linkPath);
  const dest = assertWritable(ctx, linkPath);
  const tgt = path.resolve(path.dirname(dest), target);
  assertWritable(ctx, tgt, { allowRoot: true });
  await fsp.symlink(tgt, dest);
}

/** 硬链接:两端都必须在写入根内。(之后写入任一端仍会被「nlink>1」规则拒绝。) */
export async function hardlink(ctx: IoContext, existing: string, newPath: string): Promise<void> {
  audit(ctx, 'hardlink.from', existing);
  audit(ctx, 'hardlink', newPath);
  const src = assertWritable(ctx, existing);
  const dest = assertWritable(ctx, newPath);
  await fsp.link(src, dest);
}
