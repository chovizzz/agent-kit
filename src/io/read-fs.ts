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
  if (kind === 'file' && st.nlink !== 1) return 'hardlink';
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
 * 句柄级安全读取(R20-7.2 读取前校验的唯一实现):`O_NOFOLLOW | O_NONBLOCK` 打开(符号链接 → `ELOOP`;FIFO 不会挂住),
 * 对**句柄** fstat 校验(普通文件、`nlink == 1`、可选的属主 / 权限、大小上限),再有界读取。
 * 因此检查与读取之间路径被换成符号链接 / FIFO / 另一个 inode,拿到的要么是原来那个已校验的 inode,要么是 `unsafe`,绝不跟随、不挂住。
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
