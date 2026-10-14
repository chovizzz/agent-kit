/**
 * 严格 tar(.tgz)读取器(S7a;docs/contracts.md §19.5「解包」)。
 *
 * 输入内存字节,输出文件清单;**不碰磁盘**(落盘由安装器经 home-fs 完成)。Node 只有 zlib 没有 tar,也不能 exec `tar`,
 * 所以自己读。只接受 `package/` 前缀下的普通文件与目录;其余一律拒绝并给稳定码 `TAR_*`(见 {@link TarErrorCode})。
 *
 * 拒绝:符号链接、硬链接、设备 / FIFO、GNU 长名(L/K)、全局 pax 头、绝对路径、`..`、`.` 段、空段(含 `//`)、
 * 反斜杠、盘符、路径段含 NUL、非 UTF-8 路径、`package/` 之外的路径、重复路径(含大小写 / Unicode 归一后折叠重复)、
 * 文件与目录同名冲突、gzip 截断 / 多余尾部 / 多成员、tar 缺结束块 / 结束块后有数据。
 * 限制:单文件、总大小、条目数、路径长度、解压比。支持 pax(`path` / `size` 记录)长路径。
 * 权限统一归一:带任何可执行位 → 0755,否则 0644(忽略 setuid / setgid / sticky / 组与其它写位)。
 *
 * gzip 层手工解析头 / 尾(不用 gunzipSync:它会静默忽略尾部垃圾),用 `inflateRawSync` 的 `engine.bytesWritten`
 * 取得实际消耗字节数,尾部必须恰好 8 字节(CRC32 + ISIZE)且都核对。
 */
import { inflateRawSync } from 'node:zlib';

export type TarErrorCode =
  | 'TAR_GZIP_INVALID'
  | 'TAR_GZIP_TRUNCATED'
  | 'TAR_GZIP_TRAILING'
  | 'TAR_INPUT_TOO_LARGE'
  | 'TAR_RATIO'
  | 'TAR_BAD_HEADER'
  | 'TAR_TRUNCATED'
  | 'TAR_TRAILING_DATA'
  | 'TAR_BAD_PAX'
  | 'TAR_UNSUPPORTED_TYPE'
  | 'TAR_SYMLINK'
  | 'TAR_HARDLINK'
  | 'TAR_DEVICE'
  | 'TAR_ABSOLUTE_PATH'
  | 'TAR_PATH_TRAVERSAL'
  | 'TAR_EMPTY_SEGMENT'
  | 'TAR_NUL_IN_PATH'
  | 'TAR_BAD_PATH'
  | 'TAR_PATH_TOO_LONG'
  | 'TAR_BAD_PREFIX'
  | 'TAR_DUPLICATE_PATH'
  | 'TAR_PATH_CONFLICT'
  | 'TAR_FILE_TOO_LARGE'
  | 'TAR_TOTAL_TOO_LARGE'
  | 'TAR_TOO_MANY_ENTRIES';

export class TarError extends Error {
  readonly code: TarErrorCode;
  constructor(code: TarErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'TarError';
    this.code = code;
  }
}

export interface TarLimits {
  /** 压缩输入上限(字节) */
  maxInputBytes: number;
  /** 单个文件上限(字节) */
  maxFileBytes: number;
  /** 所有文件总大小上限(字节) */
  maxTotalBytes: number;
  /** 条目(文件 + 目录)数上限 */
  maxEntries: number;
  /** 解压后 tar 大小 / 压缩输入大小 的上限(另有 1 MiB 的小包宽限) */
  maxRatio: number;
  /** 路径总长上限(字节,含 `package/`) */
  maxPathBytes: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxInputBytes: 32 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 5000,
  maxRatio: 200,
  maxPathBytes: 512,
};

export interface TarFile {
  /** 相对包根(已去掉 `package/`),POSIX 分隔,例 `dist/cli.js` */
  path: string;
  /** 归一后的权限:0o644 或 0o755 */
  mode: 0o644 | 0o755;
  bytes: Buffer;
}

export interface TarListing {
  /** 按 tar 内顺序 */
  files: TarFile[];
  /** 显式目录条目(相对包根,不含包根自身与末尾斜杠);文件的隐含父目录由调用方 mkdir -p */
  dirs: string[];
}

const BLOCK = 512;
const PAX_MAX_BYTES = 64 * 1024;
const RATIO_ALLOWANCE = 1024 * 1024;

// ---------------------------------------------------------------------------
// gzip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 解出完整、单成员、无尾部的 gzip 流 */
function gunzipStrict(input: Uint8Array, limits: TarLimits): Buffer {
  if (input.length > limits.maxInputBytes) {
    throw new TarError('TAR_INPUT_TOO_LARGE', `${input.length} > ${limits.maxInputBytes}`);
  }
  const buf = Buffer.from(input.buffer, input.byteOffset, input.length);
  if (buf.length < 18) throw new TarError('TAR_GZIP_TRUNCATED', 'shorter than a gzip member');
  if (buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 8) {
    throw new TarError('TAR_GZIP_INVALID', 'bad gzip magic / method');
  }
  const flg = buf[3] as number;
  if ((flg & 0xe0) !== 0) throw new TarError('TAR_GZIP_INVALID', 'reserved gzip flags set');
  let pos = 10;
  if (flg & 4) {
    if (pos + 2 > buf.length) throw new TarError('TAR_GZIP_TRUNCATED', 'FEXTRA');
    pos += 2 + buf.readUInt16LE(pos);
  }
  for (const bit of [8, 16]) {
    if (flg & bit) {
      const z = buf.indexOf(0, pos);
      if (z === -1) throw new TarError('TAR_GZIP_TRUNCATED', 'FNAME / FCOMMENT');
      pos = z + 1;
    }
  }
  if (flg & 2) pos += 2;
  if (pos >= buf.length) throw new TarError('TAR_GZIP_TRUNCATED', 'no deflate data');

  const ratioCap = input.length * limits.maxRatio + RATIO_ALLOWANCE;
  const sizeCap = limits.maxTotalBytes + limits.maxEntries * 2048 + PAX_MAX_BYTES;
  const cap = Math.min(ratioCap, sizeCap);
  let out: Buffer;
  let consumed: number;
  try {
    // `info: true` 时返回 { buffer, engine };@types/node 只声明了 Buffer 重载
    const r = inflateRawSync(buf.subarray(pos), {
      info: true,
      maxOutputLength: cap,
    } as Parameters<typeof inflateRawSync>[1]) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    out = r.buffer;
    consumed = r.engine.bytesWritten;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw ratioCap <= sizeCap
        ? new TarError('TAR_RATIO', `decompressed size exceeds ${limits.maxRatio}x input`)
        : new TarError('TAR_TOTAL_TOO_LARGE', `decompressed size exceeds ${sizeCap} bytes`);
    }
    if (code === 'Z_BUF_ERROR')
      throw new TarError('TAR_GZIP_TRUNCATED', 'deflate stream truncated');
    throw new TarError('TAR_GZIP_INVALID', String((e as Error).message).slice(0, 120));
  }
  const trailerAt = pos + consumed;
  if (trailerAt + 8 > buf.length) throw new TarError('TAR_GZIP_TRUNCATED', 'missing gzip trailer');
  if (trailerAt + 8 < buf.length) {
    throw new TarError(
      'TAR_GZIP_TRAILING',
      `${buf.length - trailerAt - 8} extra bytes after gzip member`,
    );
  }
  if (
    buf.readUInt32LE(trailerAt) !== crc32(out) ||
    buf.readUInt32LE(trailerAt + 4) !== out.length >>> 0
  ) {
    throw new TarError('TAR_GZIP_INVALID', 'gzip CRC32 / ISIZE mismatch');
  }
  return out;
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

function isZeroBlock(b: Buffer): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

/** 字符串字段:到第一个 NUL 为止,其后必须全是 NUL(否则可藏数据) */
function strField(hdr: Buffer, off: number, len: number, what: string): Buffer {
  const slice = hdr.subarray(off, off + len);
  const z = slice.indexOf(0);
  if (z === -1) return slice;
  for (let i = z; i < slice.length; i++) {
    if (slice[i] !== 0) throw new TarError('TAR_NUL_IN_PATH', `${what}: data after NUL`);
  }
  return slice.subarray(0, z);
}

function octal(hdr: Buffer, off: number, len: number, what: string): number {
  const raw = hdr.subarray(off, off + len).toString('latin1');
  const s = raw.replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]{1,16}$/.test(s)) throw new TarError('TAR_BAD_HEADER', `${what}: not octal`);
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw new TarError('TAR_BAD_HEADER', `${what}: out of range`);
  return n;
}

function checksumOk(hdr: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (hdr[i] as number);
  return sum === octal(hdr, 148, 8, 'chksum');
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function decodePath(bytes: Buffer, what: string): string {
  if (bytes.includes(0)) throw new TarError('TAR_NUL_IN_PATH', what);
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new TarError('TAR_BAD_PATH', `${what}: not valid UTF-8`);
  }
}

interface Pax {
  path?: string;
  size?: number;
}

function parsePax(data: Buffer): Pax {
  if (data.length === 0 || data.length > PAX_MAX_BYTES) {
    throw new TarError('TAR_BAD_PAX', 'pax header size out of range');
  }
  const out: Pax = {};
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp === -1) throw new TarError('TAR_BAD_PAX', 'record without length');
    const lenStr = data.subarray(pos, sp).toString('latin1');
    if (!/^[1-9][0-9]{0,6}$/.test(lenStr)) throw new TarError('TAR_BAD_PAX', 'bad record length');
    const len = Number(lenStr);
    if (pos + len > data.length || data[pos + len - 1] !== 0x0a || sp + 1 >= pos + len) {
      throw new TarError('TAR_BAD_PAX', 'record length mismatch');
    }
    const rec = data.subarray(sp + 1, pos + len - 1);
    const eq = rec.indexOf(0x3d);
    if (eq <= 0) throw new TarError('TAR_BAD_PAX', 'record without key');
    const key = rec.subarray(0, eq).toString('latin1');
    const val = rec.subarray(eq + 1);
    if (key === 'path') {
      out.path = decodePath(val, 'pax path');
    } else if (key === 'size') {
      const s = val.toString('latin1');
      if (!/^[0-9]{1,15}$/.test(s)) throw new TarError('TAR_BAD_PAX', 'bad pax size');
      out.size = Number(s);
    }
    pos += len;
  }
  return out;
}

function foldKey(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

/** 校验并去掉 `package/` 前缀;返回相对路径('' = 包根自身) */
function normalizePath(raw: string, isDir: boolean, limits: TarLimits): string {
  if (Buffer.byteLength(raw) > limits.maxPathBytes) {
    throw new TarError('TAR_PATH_TOO_LONG', `${Buffer.byteLength(raw)} bytes`);
  }
  if (raw === '') throw new TarError('TAR_BAD_PATH', 'empty path');
  if (raw.startsWith('/')) throw new TarError('TAR_ABSOLUTE_PATH', raw);
  if (raw.includes('\\')) throw new TarError('TAR_BAD_PATH', 'backslash');
  if (/^[A-Za-z]:/.test(raw)) throw new TarError('TAR_BAD_PATH', 'drive letter');
  // 控制字符一律拒(含 DEL)
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new TarError('TAR_BAD_PATH', 'control character');
  let p = raw;
  if (isDir && p.endsWith('/')) p = p.slice(0, -1);
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '') throw new TarError('TAR_EMPTY_SEGMENT', raw);
    if (s === '..') throw new TarError('TAR_PATH_TRAVERSAL', raw);
    if (s === '.') throw new TarError('TAR_BAD_PATH', `dot segment: ${raw}`);
  }
  if (segs[0] !== 'package') throw new TarError('TAR_BAD_PREFIX', raw);
  if (segs.length === 1) {
    if (!isDir) throw new TarError('TAR_BAD_PREFIX', `file named package: ${raw}`);
    return '';
  }
  return segs.slice(1).join('/');
}

export function readTgz(input: Uint8Array, limits: TarLimits = DEFAULT_TAR_LIMITS): TarListing {
  const tar = gunzipStrict(input, limits);
  const files: TarFile[] = [];
  const dirs: string[] = [];
  const seen = new Map<string, 'file' | 'dir'>();
  /** 所有已出现路径的祖先(折叠后),用来发现「先有 a/b 后来又出现文件 a」 */
  const ancestors = new Set<string>();
  let total = 0;
  let entries = 0;
  let pos = 0;
  let pendingPax: Pax | undefined;
  let ended = false;

  const claim = (rel: string, kind: 'file' | 'dir'): void => {
    // 父路径不得是文件,自身不得重复
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = foldKey(parts.slice(0, i).join('/'));
      if (seen.get(parent) === 'file')
        throw new TarError('TAR_PATH_CONFLICT', `${rel} under a file`);
    }
    const key = foldKey(rel);
    if (kind === 'file' && ancestors.has(key)) {
      throw new TarError('TAR_PATH_CONFLICT', `${rel} is also a directory`);
    }
    for (let i = 1; i < parts.length; i++) ancestors.add(foldKey(parts.slice(0, i).join('/')));
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new TarError(prev === kind ? 'TAR_DUPLICATE_PATH' : 'TAR_PATH_CONFLICT', rel);
    }
    seen.set(key, kind);
  };

  while (pos < tar.length) {
    if (pos + BLOCK > tar.length) throw new TarError('TAR_TRUNCATED', 'partial header block');
    const hdr = tar.subarray(pos, pos + BLOCK);
    if (isZeroBlock(hdr)) {
      // 结束标记:两个零块,其后只能是零
      if (
        pos + 2 * BLOCK > tar.length ||
        !isZeroBlock(tar.subarray(pos + BLOCK, pos + 2 * BLOCK))
      ) {
        throw new TarError('TAR_TRUNCATED', 'incomplete end-of-archive marker');
      }
      if (!isZeroBlock(tar.subarray(pos + 2 * BLOCK))) {
        throw new TarError('TAR_TRAILING_DATA', 'data after end-of-archive marker');
      }
      ended = true;
      break;
    }
    if (!checksumOk(hdr)) throw new TarError('TAR_BAD_HEADER', 'checksum mismatch');
    if (
      hdr.subarray(257, 263).toString('latin1') !== 'ustar\0' ||
      hdr.toString('latin1', 263, 265) !== '00'
    ) {
      throw new TarError('TAR_BAD_HEADER', 'not a POSIX ustar header');
    }
    const type = String.fromCharCode(hdr[156] as number);
    let size = octal(hdr, 124, 12, 'size');
    const mode = octal(hdr, 100, 8, 'mode');
    const name = decodePath(strField(hdr, 0, 100, 'name'), 'name');
    const prefix = decodePath(strField(hdr, 345, 155, 'prefix'), 'prefix');
    pos += BLOCK;

    const pax = pendingPax;
    if (type !== 'x') pendingPax = undefined;
    if (pax?.size !== undefined && type !== 'x') size = pax.size;
    if (size > limits.maxFileBytes && (type === '0' || type === '\0')) {
      throw new TarError('TAR_FILE_TOO_LARGE', `${size} > ${limits.maxFileBytes}`);
    }
    if (pos + size > tar.length)
      throw new TarError('TAR_TRUNCATED', 'entry data past end of archive');
    const dataEnd = pos + size;
    const next = pos + Math.ceil(size / BLOCK) * BLOCK;
    if (next > tar.length) throw new TarError('TAR_TRUNCATED', 'entry padding past end of archive');

    switch (type) {
      case 'x': {
        if (pendingPax !== undefined) throw new TarError('TAR_BAD_PAX', 'consecutive pax headers');
        pendingPax = parsePax(tar.subarray(pos, dataEnd));
        break;
      }
      case '0':
      case '\0':
      case '5': {
        const isDir = type === '5';
        if (isDir && size !== 0) throw new TarError('TAR_BAD_HEADER', 'directory with data');
        if (++entries > limits.maxEntries) {
          throw new TarError('TAR_TOO_MANY_ENTRIES', `> ${limits.maxEntries}`);
        }
        const full = pax?.path ?? (prefix === '' ? name : `${prefix}/${name}`);
        const rel = normalizePath(full, isDir, limits);
        if (isDir) {
          if (rel !== '') {
            claim(rel, 'dir');
            dirs.push(rel);
          }
        } else {
          total += size;
          if (total > limits.maxTotalBytes) {
            throw new TarError('TAR_TOTAL_TOO_LARGE', `> ${limits.maxTotalBytes}`);
          }
          claim(rel, 'file');
          files.push({
            path: rel,
            mode: mode & 0o111 ? 0o755 : 0o644,
            bytes: Buffer.from(tar.subarray(pos, dataEnd)),
          });
        }
        break;
      }
      case '2':
        throw new TarError('TAR_SYMLINK', name);
      case '1':
        throw new TarError('TAR_HARDLINK', name);
      case '3':
      case '4':
      case '6':
        throw new TarError('TAR_DEVICE', name);
      default:
        throw new TarError('TAR_UNSUPPORTED_TYPE', `typeflag ${JSON.stringify(type)}`);
    }
    pos = next;
  }
  if (!ended) throw new TarError('TAR_TRUNCATED', 'missing end-of-archive marker');
  if (pendingPax !== undefined) throw new TarError('TAR_BAD_PAX', 'pax header without entry');
  return { files, dirs };
}
