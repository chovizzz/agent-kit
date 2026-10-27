/**
 * 快照的**只读**部分(从 `snapshot.ts` 拆出,R20-A2 B3a):`readSnapshot` / `readVerified` 与它们共用的路径、校验、读取原语。
 * 只 import read-fs 与 `lock-read.ts`,**不** import safe-fs / `lock.ts`:`rsi status` / `rsi projects` / `rsi hint` 的 import 闭包因此不含任何写出口,
 * 也不含 `acquireRsiLock` / `commitSnapshot` / `recoverSnapshot`(§20.8.1 静态审计)。`snapshot.ts` 原样 re-export,既有 import 路径不变。
 * 语义见 `snapshot.ts` 头注释。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  RSI_SNAPSHOT_FIXED_NAMES,
  RsiSnapshotSchema,
  isRsiSnapshotName,
  type RsiFailClosedReason,
  type RsiSnapshot,
} from '../contracts/rsi.js';
import { ExitCode } from '../contracts/exit-codes.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readFileSafe, type OwnerPolicy } from '../io/read-fs.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from './lock-read.js';

/** 快照相关的 fail-closed:`reason` 是 §20.3 总表里的原因码(`RSI_FAIL_CLOSED reason=…`,退出 3) */
export class RsiSnapshotError extends Error {
  readonly code = 'RSI_FAIL_CLOSED';
  readonly exit = ExitCode.FAIL_CLOSED;
  constructor(readonly reason: RsiFailClosedReason) {
    super(`rsi/snapshot: ${reason}`);
  }
}

export function reasonFor(name: string): RsiFailClosedReason {
  switch (name) {
    case 'state.json':
      return 'state_invalid';
    case 'projects.json':
      return 'index_invalid';
    case 'cursor.json':
      return 'cursor_invalid';
    case 'counts.json':
      return 'counts_invalid';
    default:
      return 'signal_store_corrupt';
  }
}

export interface Bases {
  /** `<realpath(stateDir)>/rsi` */
  rsi: string;
  /** `<realpath(stateDir)>` */
  state: string;
}

/** 只读方:不建目录、不 chmod;状态目录 / `rsi/` 不存在 → `missing`(= 清单缺失) */
export async function basesReadonly(
  io: IoContext,
  hooks: SnapshotReadHooks = {},
): Promise<{ kind: 'ok'; bases: Bases } | { kind: 'missing' } | { kind: 'unsafe' }> {
  const d = await rsiDirReadonly(io, { beforeOpen: hooks.beforeOpen });
  if (d.kind !== 'ok') return d;
  return { kind: 'ok', bases: { rsi: d.dir, state: path.dirname(d.dir) } };
}

/** `signals` / `signals/<agent>` 这类父目录必须是真实目录(不穿符号链接);不存在返回 `missing` */
export async function dirState(dir: string): Promise<'ok' | 'missing' | 'unsafe'> {
  const st = await lstat(dir).catch((e: NodeJS.ErrnoException) => e.code ?? 'ERR');
  if (typeof st === 'string') return st === 'ENOENT' ? 'missing' : 'unsafe';
  return st.isSymbolicLink() || !st.isDirectory() ? 'unsafe' : 'ok';
}

/** 一个白名单 name 的父目录链(相对 `.state/`)是否都是真实目录 */
export async function parentsState(b: Bases, name: string): Promise<'ok' | 'missing' | 'unsafe'> {
  if (RSI_SNAPSHOT_FIXED_NAMES.includes(name)) return 'ok'; // 固定名的父目录 = rsi/,已由 rsiDir* 检查
  const [kind, agent] = name.split('/') as [string, string];
  for (const d of [path.join(b.state, kind), path.join(b.state, kind, agent)]) {
    const r = await dirState(d);
    if (r !== 'ok') return r;
  }
  return 'ok';
}

/** 只按白名单拼路径:固定名在 `.state/rsi/` 下,月文件在 `.state/` 下 */
export function fileOf(b: Bases, name: string): string {
  if (!isRsiSnapshotName(name)) throw new RsiSnapshotError('internal');
  return RSI_SNAPSHOT_FIXED_NAMES.includes(name)
    ? path.join(b.rsi, name)
    : path.join(b.state, ...name.split('/'));
}

export function snapshotPath(rsiDirReal: string): string {
  return path.join(rsiDirReal, 'snapshot.json');
}

export type SnapshotRead =
  | { kind: 'missing' }
  /** 清单自身损坏 / 超过字节上限 / 不过 schema(`snapshot_invalid`) */
  | { kind: 'invalid' }
  /** R20-7.2:路径是符号链接 / 非普通文件 / 硬链接 / 属主不对 / 权限宽于 0600,或 `rsi/` 目录同理(`state_dir_unsafe`);只读入口不收紧 */
  | { kind: 'unsafe' }
  | { kind: 'ok'; snapshot: RsiSnapshot };

/** 测试缝(都在内容读取路径上;生产不传) */
export interface SnapshotReadHooks {
  /** 句柄级 open 之前调用(演练检查之后换链 / FIFO) */
  beforeOpen?: (file: string) => Promise<void> | void;
  /** 每次要读一个白名单**数据文件**内容之前调用(不含 `snapshot.json`);用来断言「超限在读取内容之前就失败」 */
  onRead?: (name: string) => void;
  /** 测试缝:固定小文件整份载入的字节上限(缺省 {@link RSI_DATA_FILE_MAX_BYTES});月文件不受它约束 */
  maxFixedBytes?: number;
  /** 测试缝:月文件单行字节上限(缺省 64MiB) */
  maxLineBytes?: number;
  /** 测试缝:月文件流式读取的块大小(缺省 64KiB);小块用来演练 UTF-8 / CRLF 跨块 */
  chunkBytes?: number;
}

/** `snapshot.json` 自身的字节上限(2000 项 × 每项不到 200 字节 + 头,留余量)。超出在解析前就判 `invalid`。 */
export const RSI_SNAPSHOT_MAX_BYTES = 1024 * 1024;
/**
 * **固定小文件**(`state.json` 等四个)整份读入内存的上限;超出按该文件损坏处理。
 * 月文件(信号库 / 会话计数)不受它约束:提交与恢复都是流式的(B2),`readVerified` 则仍整份载入,只应传固定文件。
 */
export const RSI_DATA_FILE_MAX_BYTES = 256 * 1024 * 1024;

export const isFixed = (name: string): boolean => RSI_SNAPSHOT_FIXED_NAMES.includes(name);

export async function readSnapshot(
  io: IoContext,
  hooks: SnapshotReadHooks = {},
): Promise<SnapshotRead> {
  const b = await basesReadonly(io, hooks);
  if (b.kind === 'missing') return { kind: 'missing' };
  if (b.kind === 'unsafe') return { kind: 'unsafe' };
  const file = snapshotPath(b.bases.rsi);
  const r = await readFileSafe(file, {
    maxBytes: RSI_SNAPSHOT_MAX_BYTES,
    owner: RSI_FILE_OWNER,
    beforeOpen: () => hooks.beforeOpen?.(file),
  });
  if (r.kind === 'missing') return { kind: 'missing' };
  if (r.kind === 'unsafe') return r.why === 'too_large' ? { kind: 'invalid' } : { kind: 'unsafe' };
  try {
    const parsed = RsiSnapshotSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
    return parsed.success ? { kind: 'ok', snapshot: parsed.data } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

export const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export type DataRead =
  | { kind: 'ok'; bytes: Buffer }
  | { kind: 'missing' }
  /** 固定名文件违反 R20-7.2 元数据校验 → `state_dir_unsafe` */
  | { kind: 'unsafe' }
  /** 月文件是链接 / 非普通文件 / 硬链接 / 过大,或固定名文件过大 → 该文件损坏(`reasonFor(name)`) */
  | { kind: 'corrupt' };

/**
 * 读一个白名单数据文件。固定名(在 `.state/rsi/` 下)走完整 R20-7.2 校验(属主、≤0600);
 * 月文件(`.state/{signals,sessions}/…`)沿用 state-store 的口径,只做 O_NOFOLLOW + 普通文件 + nlink==1(R20-7.2 第二条,不拒绝宽权限)。
 * 硬链接(nlink>1)的名字可能指向状态目录之外的 inode,与 safe-fs 的写入口径一致,一律不读。
 */
export async function readData(
  b: Bases,
  name: string,
  hooks: SnapshotReadHooks,
): Promise<DataRead> {
  const file = fileOf(b, name);
  hooks.onRead?.(name);
  const owner: OwnerPolicy | undefined = isFixed(name) ? RSI_FILE_OWNER : undefined;
  const r = await readFileSafe(file, {
    maxBytes: hooks.maxFixedBytes ?? RSI_DATA_FILE_MAX_BYTES,
    owner,
    beforeOpen: () => hooks.beforeOpen?.(file),
  });
  if (r.kind === 'ok') return { kind: 'ok', bytes: r.bytes };
  if (r.kind === 'missing') return { kind: 'missing' };
  if (isFixed(name) && r.why !== 'too_large') return { kind: 'unsafe' };
  return { kind: 'corrupt' };
}

export type VerifiedRead =
  | { status: 'ok'; generation: number; files: Map<string, Buffer | null> }
  | { status: 'no_snapshot' }
  | { status: 'busy' }
  | { status: 'invalid' }
  /** R20-7.2 元数据校验不通过(`state_dir_unsafe`);只读入口不收紧 */
  | { status: 'unsafe' };

/**
 * 只读方(不拿锁):读清单,再读 `names` 里的文件并核对;不一致重新取清单重读一次,仍不一致 → `busy`。
 * `files` 里 `null` = 清单与磁盘都没有该文件(一致的「不存在」)。`names` 必须在白名单内(否则编程错误)。
 * 返回的是核对过的那份字节,调用方只解析这份,不要再自行重读(免得校验与使用之间被改)。
 */
export async function readVerified(
  io: IoContext,
  names: readonly string[],
  opts: SnapshotReadHooks & { onMismatch?: () => Promise<void> | void } = {},
): Promise<VerifiedRead> {
  for (const n of names) if (!isRsiSnapshotName(n)) throw new RsiSnapshotError('internal');
  const rb = await basesReadonly(io, opts);
  if (rb.kind === 'missing') return { status: 'no_snapshot' };
  if (rb.kind === 'unsafe') return { status: 'unsafe' };
  const b = rb.bases;
  for (let attempt = 0; attempt < 2; attempt++) {
    const snap = await readSnapshot(io, opts);
    if (snap.kind === 'missing') return { status: 'no_snapshot' };
    if (snap.kind === 'invalid') return { status: 'invalid' };
    if (snap.kind === 'unsafe') return { status: 'unsafe' };
    const listed = new Map(snap.snapshot.files.map((f) => [f.name, f]));
    const files = new Map<string, Buffer | null>();
    let consistent = true;
    for (const name of names) {
      const entry = listed.get(name);
      const parents = await parentsState(b, name);
      if (parents === 'unsafe') return { status: 'invalid' };
      const got: DataRead =
        parents === 'missing' ? { kind: 'missing' } : await readData(b, name, opts);
      if (got.kind === 'unsafe') return { status: 'unsafe' };
      if (got.kind === 'corrupt') return { status: 'invalid' };
      if (got.kind === 'missing') {
        if (entry !== undefined) consistent = false;
        files.set(name, null);
        continue;
      }
      if (
        entry === undefined ||
        entry.bytes !== got.bytes.length ||
        entry.sha256 !== sha(got.bytes)
      ) {
        consistent = false;
      }
      files.set(name, got.bytes);
    }
    if (consistent) return { status: 'ok', generation: snap.snapshot.generation, files };
    if (attempt === 0) await opts.onMismatch?.(); // 测试缝:两次尝试之间让「写入方」完成提交
  }
  return { status: 'busy' };
}
