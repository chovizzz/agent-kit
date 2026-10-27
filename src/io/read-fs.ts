/**
 * 唯一的文件系统「读」出口之一(另一个是 safe-fs.ts 的内部校验)。
 * 本文件只导出读 API:不 import、不导出任何写 API。eslint 把 `node:fs` 系列限定在
 * src/io/{read-fs,safe-fs}.ts 两个文件内(见 eslint.config.js)。
 *
 * 读取本身不受 KIT_WRITE_ROOTS 约束:reader 通过 `--source` 显式读真实会话目录。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

export type { Stats, Dirent } from 'node:fs';

/** 目录项,按名字的 UTF-16 码元序(即字节序近似)排序,保证遍历顺序确定。 */
export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export async function readText(path: string): Promise<string> {
  return fsp.readFile(path, 'utf8');
}

export async function readBytes(path: string): Promise<Uint8Array> {
  return fsp.readFile(path);
}

/** 句柄级安全读取的元数据快照(来自对**已打开句柄**的 fstat,不是对路径的 lstat) */
export interface SafeMeta {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
  uid: number;
  nlink: number;
}

/** 属主与权限校验:属主须为 `uid`(缺省当前进程 uid;平台没有 getuid 时不校验),权限位不得宽于 `maxPerm`(文件 0o600、目录 0o700) */
export interface OwnerPolicy {
  maxPerm: number;
  uid?: number;
}

export type SafeUnsafeWhy =
  'link' | 'not_regular' | 'hardlink' | 'owner' | 'perm' | 'too_large' | 'io';

export type SafeReadResult =
  | { kind: 'ok'; bytes: Buffer; meta: SafeMeta }
  | { kind: 'missing' }
  | { kind: 'unsafe'; why: SafeUnsafeWhy };

export interface SafeReadOptions {
  /** 内容字节上限;fstat 大小或实际读到的字节超过它 → `unsafe/too_large`(有界读取,不把超大文件读进内存) */
  maxBytes: number;
  /** 提供时校验属主与权限;缺省只做 O_NOFOLLOW + 普通文件 + `nlink == 1` */
  owner?: OwnerPolicy;
  /** 测试缝:调用后紧接着 open。用来演练「检查之后、读取之前被换成符号链接 / FIFO」 */
  beforeOpen?: () => Promise<void> | void;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function checkMeta(
  st: fs.Stats,
  kind: 'file' | 'dir',
  owner: OwnerPolicy | undefined,
): SafeUnsafeWhy | undefined {
  if (kind === 'file' ? !st.isFile() : !st.isDirectory()) return 'not_regular';
  if (kind === 'file' && st.nlink > 1) return 'hardlink';
  if (owner !== undefined) {
    const want = owner.uid ?? currentUid();
    if (want !== undefined && st.uid !== want) return 'owner';
    if ((st.mode & 0o777 & ~owner.maxPerm) !== 0) return 'perm';
  }
  return undefined;
}

const metaOf = (st: fs.Stats): SafeMeta => ({
  dev: st.dev,
  ino: st.ino,
  size: st.size,
  mtimeMs: st.mtimeMs,
  mode: st.mode,
  uid: st.uid,
  nlink: st.nlink,
});

type OpenFailure = { kind: 'missing' } | { kind: 'unsafe'; why: SafeUnsafeWhy };

function openFailure(e: unknown): OpenFailure {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return { kind: 'missing' };
  if (code === 'ELOOP') return { kind: 'unsafe', why: 'link' };
  if (code === 'ENOTDIR') return { kind: 'unsafe', why: 'not_regular' };
  return { kind: 'unsafe', why: 'io' };
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * 句柄级安全读取所依赖的平台能力是否齐全(D8):`O_NOFOLLOW`、`O_NONBLOCK`、`O_DIRECTORY` 与 `process.getuid`。
 * 缺任何一个,`readFileSafe` 的「不跟随末级链接 / 不挂住 FIFO / 属主校验」就退化为没有保护,rsi 前台命令据此退出 3。
 */
export function safeOpenSupported(): boolean {
  return (
    NOFOLLOW !== 0 &&
    NONBLOCK !== 0 &&
    (fs.constants.O_DIRECTORY ?? 0) !== 0 &&
    typeof process.getuid === 'function'
  );
}

/**
 * 句柄级安全读取(R20-7.2 读取前校验的唯一实现):`O_NOFOLLOW | O_NONBLOCK` 打开(符号链接 → `ELOOP`;FIFO 不会挂住),
 * 对**句柄** fstat 校验(普通文件、`nlink == 1`、可选的属主 / 权限、大小上限),再有界读取。
 * 因此检查与读取之间**末级文件**被换成符号链接 / FIFO / 另一个 inode,拿到的要么是原来那个已校验的 inode,要么是 `unsafe`,不跟随末级链接、不挂住。
 * 已知残余(不是完整路径保护):`O_NOFOLLOW` 只管末级;**父目录**在目录检查之后、`open` 之前被换成符号链接时,`open` 仍会穿过它(Node 没有 `openat` 式的逐级锚定)。
 * 这与 fstat 只是一个时点的校验同属同 UID 进程的 TOCTOU 残余,见 `docs/contracts.md` R20-A1 订正段。
 * 只读:绝不 chmod / 修复。
 */
export async function readFileSafe(path: string, opts: SafeReadOptions): Promise<SafeReadResult> {
  await opts.beforeOpen?.();
  let h: fsp.FileHandle;
  try {
    h = await fsp.open(path, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    return openFailure(e);
  }
  try {
    const st = await h.stat();
    // 打开之后、fstat 之前被别人 unlink(锁释放 / 回收):nlink 为 0,等同「文件已不存在」,不是硬链接
    if (st.isFile() && st.nlink === 0) return { kind: 'missing' };
    const why = checkMeta(st, 'file', opts.owner);
    if (why !== undefined) return { kind: 'unsafe', why };
    if (st.size > opts.maxBytes) return { kind: 'unsafe', why: 'too_large' };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(65536, opts.maxBytes + 1 - total));
      const { bytesRead } = await h.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > opts.maxBytes) return { kind: 'unsafe', why: 'too_large' };
      chunks.push(buf.subarray(0, bytesRead));
    }
    return { kind: 'ok', bytes: Buffer.concat(chunks, total), meta: metaOf(st) };
  } catch {
    return { kind: 'unsafe', why: 'io' };
  } finally {
    await h.close().catch(() => undefined);
  }
}

export interface StreamOpenOptions {
  /** 提供时校验属主与权限;缺省只做 O_NOFOLLOW + 普通文件 + `nlink == 1` */
  owner?: OwnerPolicy;
  /** 测试缝:调用后紧接着 open */
  beforeOpen?: () => Promise<void> | void;
  /** 单次读取的块大小(字节);缺省 64KiB。测试用小块演练跨块边界 */
  chunkBytes?: number;
}

export type StreamOpenResult =
  | {
      kind: 'ok';
      meta: SafeMeta;
      /**
       * 从**同一个已校验的句柄**按序读完整个文件的原始字节块(不解码、不归一化)。读完、提前 `return`、抛错都会关句柄。
       * 读取错误(`h.read` 抛错)原样抛出,调用方按「该文件损坏 / 读失败」处理。没有字节上限:调用方自己决定要不要停。
       */
      chunks(): AsyncGenerator<Buffer, void, undefined>;
      /** 幂等关闭;**从未迭代 `chunks()` 时调用方必须自己调它**(生成器没启动就不会跑它的 finally) */
      close(): Promise<void>;
    }
  | { kind: 'missing' }
  | { kind: 'unsafe'; why: SafeUnsafeWhy };

/**
 * 句柄级安全**流式**读取的打开原语(R20-A2 B2,contracts §20.5 R20-5.6 订正):与 {@link readFileSafe} 同一套打开与 fstat 校验
 * (`O_NOFOLLOW | O_NONBLOCK`、普通文件、`nlink == 1`、可选属主 / 权限),但不把内容读进内存、不设大小上限:
 * 校验与读取用**同一个句柄**,所以检查之后路径被换成链接 / FIFO / 另一个 inode 也不影响已打开的这一个。
 * 用法:`const s = await openStreamSafe(p); if (s.kind==='ok') try { for await (const c of s.chunks()) … } finally { await s.close() }`。
 */
export async function openStreamSafe(
  path: string,
  opts: StreamOpenOptions = {},
): Promise<StreamOpenResult> {
  await opts.beforeOpen?.();
  let h: fsp.FileHandle;
  try {
    h = await fsp.open(path, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    return openFailure(e);
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await h.close().catch(() => undefined);
  };
  let st: fs.Stats;
  try {
    st = await h.stat();
  } catch {
    await close();
    return { kind: 'unsafe', why: 'io' };
  }
  if (st.isFile() && st.nlink === 0) {
    await close();
    return { kind: 'missing' };
  }
  const why = checkMeta(st, 'file', opts.owner);
  if (why !== undefined) {
    await close();
    return { kind: 'unsafe', why };
  }
  const size = Math.max(1, opts.chunkBytes ?? 65536);
  async function* chunks(): AsyncGenerator<Buffer, void, undefined> {
    try {
      for (;;) {
        const buf = Buffer.allocUnsafe(size);
        const { bytesRead } = await h.read(buf, 0, size, null);
        if (bytesRead === 0) return;
        yield buf.subarray(0, bytesRead);
      }
    } finally {
      await close();
    }
  }
  return { kind: 'ok', meta: metaOf(st), chunks, close };
}

export type SafeDirResult =
  { kind: 'ok'; meta: SafeMeta } | { kind: 'missing' } | { kind: 'unsafe'; why: SafeUnsafeWhy };

/** 目录的句柄级校验(`O_DIRECTORY | O_NOFOLLOW`):真实目录、可选属主 / 权限。只读,不创建、不 chmod。 */
export async function statDirSafe(
  path: string,
  opts: { owner?: OwnerPolicy; beforeOpen?: () => Promise<void> | void } = {},
): Promise<SafeDirResult> {
  await opts.beforeOpen?.();
  let h: fsp.FileHandle;
  try {
    h = await fsp.open(
      path,
      fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK | (fs.constants.O_DIRECTORY ?? 0),
    );
  } catch (e) {
    return openFailure(e);
  }
  try {
    const st = await h.stat();
    const why = checkMeta(st, 'dir', opts.owner);
    return why === undefined ? { kind: 'ok', meta: metaOf(st) } : { kind: 'unsafe', why };
  } catch {
    return { kind: 'unsafe', why: 'io' };
  } finally {
    await h.close().catch(() => undefined);
  }
}

export async function readDir(path: string): Promise<DirEntry[]> {
  const entries = await fsp.readdir(path, { withFileTypes: true });
  return entries
    .map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymbolicLink: e.isSymbolicLink(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function stat(path: string): Promise<fs.Stats> {
  return fsp.stat(path);
}

export async function lstat(path: string): Promise<fs.Stats> {
  return fsp.lstat(path);
}

export async function realpath(path: string): Promise<string> {
  return fsp.realpath(path);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

export function existsSync(path: string): boolean {
  return fs.existsSync(path);
}

export function readTextSync(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

export function lstatSync(path: string): fs.Stats {
  return fs.lstatSync(path);
}

export function statSync(path: string): fs.Stats {
  return fs.statSync(path);
}

export function realpathSync(path: string): string {
  return fs.realpathSync(path);
}

/** {@link readHead} 的测试 / 审计缝 */
export interface ReadHeadHooks {
  /** 测试缝:调用后紧接着 open(演练检查之后被换成符号链接 / FIFO) */
  beforeOpen?: () => Promise<void> | void;
  /**
   * 读审计:每发起一次**物理读取**(`read(2)`)前调用一次,参数是文件路径、偏移(恒为 0)与请求长度。
   * `readHead` 对每个文件只发起一次读取,所以这个钩子对同一个路径至多触发一次(armed 读审计的判据,R20-1.4 / R20-1.11)。
   */
  onRead?: (info: { path: string; offset: 0; length: number }) => void;
}

export type ReadHeadResult =
  /**
   * `firstLine`:偏移 0 起的第一个 `\n` **之前**的原始字节(不含 `\n`,可能为空;行尾的 `\r` 原样保留,交给解析器处理);
   * `null` = 这次读取的窗口里没有 `\n`(窗口外的字节不再读取)——调用方按「首行取不到」处理。
   * 第一个 `\n` 之后的字节**不会出现在返回值里**,所以调用方没有办法把它们交给解析器(R20-1.4,结构性保证)。
   */
  | { kind: 'ok'; firstLine: Buffer | null }
  | { kind: 'missing' }
  | { kind: 'unsafe'; why: SafeUnsafeWhy };

/**
 * armed 头部读取(R20-1.4):同一个句柄级安全打开(`O_NOFOLLOW | O_NONBLOCK`、普通文件、`nlink == 1`),
 * 从偏移 0 起**一次**读取至多 `maxBytes` 字节(调用方传 64KiB),只返回首行字节。不解码、不解析。
 * 一次读取的含义:每个文件恰好一次 `read(2)`;短读(对普通文件只在 EOF 附近出现)不重试,窗口里没有 `\n` 就是 `null`。
 */
export async function readHead(
  path: string,
  maxBytes: number,
  hooks: ReadHeadHooks = {},
): Promise<ReadHeadResult> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes 必须是正整数');
  await hooks.beforeOpen?.();
  let h: fsp.FileHandle;
  try {
    h = await fsp.open(path, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    return openFailure(e);
  }
  try {
    const st = await h.stat();
    if (st.isFile() && st.nlink === 0) return { kind: 'missing' };
    const why = checkMeta(st, 'file', undefined);
    if (why !== undefined) return { kind: 'unsafe', why };
    const buf = Buffer.allocUnsafe(maxBytes);
    hooks.onRead?.({ path, offset: 0, length: maxBytes });
    const { bytesRead } = await h.read(buf, 0, maxBytes, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
    // 拷出首行,让整块读缓冲(含首行之后的字节)随即不可达
    return { kind: 'ok', firstLine: nl < 0 ? null : Buffer.from(buf.subarray(0, nl)) };
  } catch {
    return { kind: 'unsafe', why: 'io' };
  } finally {
    await h.close().catch(() => undefined);
  }
}

export type ReadHeadLinesResult =
  /**
   * `lines`:窗口里前 `maxLines` 个以 `\n` 结束的**完整行**(不含 `\n`,行尾 `\r` 原样保留);没有 `\n` 结束的尾段不返回;
   * `bytesRead`:这次物理读取实际读到的字节数(读审计与 `listArmedDetailed.bytesRead` 记账用)。
   */
  | { kind: 'ok'; lines: Buffer[]; bytesRead: number }
  | { kind: 'missing' }
  | { kind: 'unsafe'; why: SafeUnsafeWhy };

/**
 * armed 头部读取的多行版本(D1):与 {@link readHead} 同一套句柄级安全打开与「一次 `read(2)`」语义,
 * 只是返回窗口内前 `maxLines` 个完整行。pi / codex 传 1,claude 传 `RSI_ARMED_CLAUDE_MAX_LINES`;`onRead` 对同一路径至多触发一次。
 * 超过 `maxLines` 的行、以及窗口里没有 `\n` 结束的尾段,都不会出现在返回值里(结构性保证)。
 */
export async function readHeadLines(
  path: string,
  maxBytes: number,
  maxLines: number,
  hooks: ReadHeadHooks = {},
): Promise<ReadHeadLinesResult> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes 必须是正整数');
  if (!Number.isInteger(maxLines) || maxLines < 1) throw new RangeError('maxLines 必须是正整数');
  await hooks.beforeOpen?.();
  let h: fsp.FileHandle;
  try {
    h = await fsp.open(path, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    return openFailure(e);
  }
  try {
    const st = await h.stat();
    if (st.isFile() && st.nlink === 0) return { kind: 'missing' };
    const why = checkMeta(st, 'file', undefined);
    if (why !== undefined) return { kind: 'unsafe', why };
    const buf = Buffer.allocUnsafe(maxBytes);
    hooks.onRead?.({ path, offset: 0, length: maxBytes });
    const { bytesRead } = await h.read(buf, 0, maxBytes, 0);
    const lines: Buffer[] = [];
    let start = 0;
    while (lines.length < maxLines) {
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a, start);
      if (nl < 0) break;
      // 拷出这一行,让整块读缓冲(含后面不返回的字节)随即不可达
      lines.push(Buffer.from(buf.subarray(start, nl)));
      start = nl + 1;
    }
    return { kind: 'ok', lines, bytesRead };
  } catch {
    return { kind: 'unsafe', why: 'io' };
  } finally {
    await h.close().catch(() => undefined);
  }
}

/** 单行硬上限(UTF-8 字节)。超过的行不拼接正文,readLines 以 TOO_LONG_LINE 占位产出。 */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * 超过硬上限的行的占位串。它含裸 NUL,任何 JSON 文本都不可能等于它(NUL 在 JSON 里非法),
 * 所以调用方用 `=== TOO_LONG_LINE` 判断不会与真实行混淆。
 */
export const TOO_LONG_LINE = '\u0000agent-kit:line-too-large\u0000';

/**
 * 逐行流式读取(行分隔符只认 \n,行尾的一个 \r 一并去掉,保留空行)。reader 读大 JSONL 用它,不要整个读进内存。
 * 不用 node:readline:它还把 U+2028/U+2029/孤立 \r 当行分隔符,会把 JSON 字符串里的裸 U+2028 切成两行,
 * 与口径 C2(只认 \n)及 jq 对不上。
 *
 * 按字节读:换行从上次扫到的位置继续找(线性),整行字节凑齐后再一次性解码(多字节字符跨块也完整)。
 * 单行超过 maxLineBytes(缺省 MAX_LINE_BYTES)时不再累积正文,只数字节直到下一个 \n,产出 TOO_LONG_LINE。
 */
export async function* readLines(
  path: string,
  maxLineBytes: number = MAX_LINE_BYTES,
): AsyncGenerator<string, void, undefined> {
  const stream = fs.createReadStream(path);
  let parts: Buffer[] = [];
  let curLen = 0;
  let tooLong = false;
  let any = false; // 当前行是否已有任何字节(区分「末尾 \n 之后」与「末行无换行」)
  const decode = (): string => {
    const l = Buffer.concat(parts, curLen).toString('utf8');
    return l.endsWith('\r') ? l.slice(0, -1) : l;
  };
  const append = (seg: Buffer): void => {
    if (seg.length === 0) return;
    any = true;
    if (tooLong) return;
    if (curLen + seg.length > maxLineBytes) {
      tooLong = true;
      parts = [];
      curLen = 0;
      return;
    }
    parts.push(seg);
    curLen += seg.length;
  };
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      let pos = 0;
      for (;;) {
        const idx = buf.indexOf(0x0a, pos);
        if (idx < 0) {
          append(buf.subarray(pos));
          break;
        }
        append(buf.subarray(pos, idx));
        yield tooLong ? TOO_LONG_LINE : decode();
        parts = [];
        curLen = 0;
        tooLong = false;
        any = false;
        pos = idx + 1;
      }
    }
    if (any) yield tooLong ? TOO_LONG_LINE : decode();
  } finally {
    stream.destroy();
  }
}
