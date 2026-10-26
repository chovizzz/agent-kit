/**
 * 快照清单 `.state/rsi/snapshot.json`(`RsiSnapshot`)的读写原语(docs/contracts.md §20.5 R20-5.6;块 A1)。
 *
 * 清单列出「被提交过的文件」的 `{name, sha256, bytes}`,让**不拿锁的只读方**(hint、`rsi status`、`rsi projects`、`rsi tick` 干跑)
 * 能判断自己读到的是不是一次完整提交:
 *  - 写入方(持 `rsi/lock`)在写完 `state.json` / `projects.json` / `cursor.json` / `counts.json` / 信号库 / 会话计数文件之后,
 *    **最后一步**调 {@link commitSnapshot}:按当前文件重算清单,临时文件 + rename 替换(rename 是提交点)。`generation` 只增。
 *  - 只读方调 {@link readVerified}:先读清单,再读自己需要的文件并核对 sha256 与字节数;不一致重新取清单重读一次,仍不一致 → `busy`
 *    (调用方映射为 `RSI_SNAPSHOT_BUSY` / hint 空串)。只核对自己读的文件,只按白名单拼路径。
 *  - 读取前校验(R20-7.2):`.state/rsi/` 下的目录与固定文件经句柄级校验(O_NOFOLLOW、普通文件、nlink==1、属主为当前 uid、文件 ≤0600 / 目录 ≤0700),
 *    不满足 → `state_dir_unsafe`(只读方返回 `unsafe`),**不自动收紧**;`.state/{signals,sessions}` 月文件沿用 state-store 口径,只拒链接 / 非普通文件 / 硬链接。
 *  - 「不一致 ≠ 损坏」:各文件都过校验但与清单不符 = 未完成提交(上次写入方在替换清单前崩溃)→ 持锁写入方调 {@link recoverSnapshot}
 *    按当前文件重建清单(不改任何数据文件)后继续;任一文件过不了校验 = 损坏 → 抛 fail-closed 错误,安全阻断。清单缺失 = 从未提交过,不是错误。
 *
 * 数据文件各自的 schema(`RsiState` 等)属于 A2;这里的校验函数可注入,缺省只做结构检查(JSON 可解析;JSONL 每行是对象且文件以换行结尾;
 * 信号库行过 `SignalSchema`,会话计数行过 `SessionStatSchema`)。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  RSI_FILE_MODE,
  RSI_SNAPSHOT_FIXED_NAMES,
  RSI_SNAPSHOT_MAX_FILES,
  RsiSnapshotSchema,
  isRsiSnapshotName,
  type RsiFailClosedReason,
  type RsiSnapshot,
} from '../contracts/rsi.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { SessionStatSchema } from '../contracts/session-stat.js';
import { SignalSchema } from '../contracts/signal.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readDir, readFileSafe, type OwnerPolicy } from '../io/read-fs.js';
import { createExclusive, remove, rename, WriteDeniedError } from '../io/safe-fs.js';
import { RSI_FILE_OWNER, rsiDir, rsiDirReadonly, type RsiLockHandle } from './lock.js';

/** 快照相关的 fail-closed:`reason` 是 §20.3 总表里的原因码(`RSI_FAIL_CLOSED reason=…`,退出 3) */
export class RsiSnapshotError extends Error {
  readonly code = 'RSI_FAIL_CLOSED';
  readonly exit = ExitCode.FAIL_CLOSED;
  constructor(readonly reason: RsiFailClosedReason) {
    super(`rsi/snapshot: ${reason}`);
  }
}

const AGENTS = ['claude', 'codex', 'pi'] as const;
const MONTH_FILE_RE = /^\d{6}\.jsonl$/;

/**
 * 恢复时逐文件的校验函数:返回 `false` = 该文件(或它的缺失)不可接受 → 抛对应原因码(见 {@link reasonFor})。
 * `bytes === null` = 「已提交清单里有、磁盘上现在没有」:调用方在这里决定它是不是**必需文件**(例如 A2 对 `state.json` 返回 `false`)。
 * 一次只交给它一个文件的字节(读完即释放,不在内存里攒全库)。
 */
export type SnapshotValidator = (name: string, bytes: Uint8Array | null) => boolean;

function reasonFor(name: string): RsiFailClosedReason {
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

/** 缺省的结构校验(A2 起可注入各文件的完整 schema) */
export const structuralValidator: SnapshotValidator = (name, bytes) => {
  if (bytes === null) return true; // 缺省允许任何文件缺失(cursor / counts 被 purge 重写等);必需文件由调用方注入的校验函数判定
  const text = Buffer.from(bytes).toString('utf8');
  if (RSI_SNAPSHOT_FIXED_NAMES.includes(name)) {
    try {
      const v: unknown = JSON.parse(text);
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    } catch {
      return false;
    }
  }
  if (text === '') return true;
  if (!text.endsWith('\n')) return false; // 被截断的尾行
  const schema = name.startsWith('signals/') ? SignalSchema : SessionStatSchema;
  for (const line of text.slice(0, -1).split('\n')) {
    try {
      if (!schema.safeParse(JSON.parse(line)).success) return false;
    } catch {
      return false;
    }
  }
  return true;
};

interface Bases {
  /** `<realpath(stateDir)>/rsi` */
  rsi: string;
  /** `<realpath(stateDir)>` */
  state: string;
}

/** 写入方:必要时建目录(见 {@link rsiDir}) */
async function basesOf(io: IoContext): Promise<Bases> {
  const rsi = await rsiDir(io);
  return { rsi, state: path.dirname(rsi) };
}

/** 只读方:不建目录、不 chmod;状态目录 / `rsi/` 不存在 → `missing`(= 清单缺失) */
async function basesReadonly(
  io: IoContext,
  hooks: SnapshotReadHooks = {},
): Promise<{ kind: 'ok'; bases: Bases } | { kind: 'missing' } | { kind: 'unsafe' }> {
  const d = await rsiDirReadonly(io, { beforeOpen: hooks.beforeOpen });
  if (d.kind !== 'ok') return d;
  return { kind: 'ok', bases: { rsi: d.dir, state: path.dirname(d.dir) } };
}

/** `signals` / `signals/<agent>` 这类父目录必须是真实目录(不穿符号链接);不存在返回 `missing` */
async function dirState(dir: string): Promise<'ok' | 'missing' | 'unsafe'> {
  const st = await lstat(dir).catch((e: NodeJS.ErrnoException) => e.code ?? 'ERR');
  if (typeof st === 'string') return st === 'ENOENT' ? 'missing' : 'unsafe';
  return st.isSymbolicLink() || !st.isDirectory() ? 'unsafe' : 'ok';
}

/** 一个白名单 name 的父目录链(相对 `.state/`)是否都是真实目录 */
async function parentsState(b: Bases, name: string): Promise<'ok' | 'missing' | 'unsafe'> {
  if (RSI_SNAPSHOT_FIXED_NAMES.includes(name)) return 'ok'; // 固定名的父目录 = rsi/,已由 rsiDir* 检查
  const [kind, agent] = name.split('/') as [string, string];
  for (const d of [path.join(b.state, kind), path.join(b.state, kind, agent)]) {
    const r = await dirState(d);
    if (r !== 'ok') return r;
  }
  return 'ok';
}

/** 只按白名单拼路径:固定名在 `.state/rsi/` 下,月文件在 `.state/` 下 */
function fileOf(b: Bases, name: string): string {
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
}

/** `snapshot.json` 自身的字节上限(2000 项 × 每项不到 200 字节 + 头,留余量)。超出在解析前就判 `invalid`。 */
export const RSI_SNAPSHOT_MAX_BYTES = 1024 * 1024;
/** 单个数据文件读入内存的上限(与 R20-6.9 的 256MiB 单次读取同口径);超出按该文件损坏处理 */
export const RSI_DATA_FILE_MAX_BYTES = 256 * 1024 * 1024;

const isFixed = (name: string): boolean => RSI_SNAPSHOT_FIXED_NAMES.includes(name);

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

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

type DataRead =
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
async function readData(b: Bases, name: string, hooks: SnapshotReadHooks): Promise<DataRead> {
  const file = fileOf(b, name);
  hooks.onRead?.(name);
  const owner: OwnerPolicy | undefined = isFixed(name) ? RSI_FILE_OWNER : undefined;
  const r = await readFileSafe(file, {
    maxBytes: RSI_DATA_FILE_MAX_BYTES,
    owner,
    beforeOpen: () => hooks.beforeOpen?.(file),
  });
  if (r.kind === 'ok') return { kind: 'ok', bytes: r.bytes };
  if (r.kind === 'missing') return { kind: 'missing' };
  if (isFixed(name) && r.why !== 'too_large') return { kind: 'unsafe' };
  return { kind: 'corrupt' };
}

function failOf(name: string, r: { kind: 'unsafe' | 'corrupt' }): RsiSnapshotError {
  return new RsiSnapshotError(r.kind === 'unsafe' ? 'state_dir_unsafe' : reasonFor(name));
}

/**
 * 枚举阶段:当前磁盘上所有白名单文件名(升序)。只做 readdir / lstat,**不读任何内容**;
 * 项数超过 `RSI_SNAPSHOT_MAX_FILES` 就在这里失败(`snapshot_invalid`),不会先把超限的库读进内存。
 */
async function enumerateCurrent(b: Bases): Promise<string[]> {
  const names: string[] = [];
  for (const n of RSI_SNAPSHOT_FIXED_NAMES) {
    try {
      await lstat(fileOf(b, n)); // 只看在不在;链接 / 非普通文件留给读取阶段判
      names.push(n);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new RsiSnapshotError(reasonFor(n));
    }
  }
  for (const kind of ['signals', 'sessions']) {
    for (const agent of AGENTS) {
      const parents = await parentsState(b, `${kind}/${agent}/x`);
      if (parents === 'missing') continue;
      if (parents === 'unsafe') throw new RsiSnapshotError('signal_store_corrupt');
      let entries;
      try {
        entries = await readDir(path.join(b.state, kind, agent));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new RsiSnapshotError('signal_store_corrupt');
      }
      for (const ent of entries) {
        if (MONTH_FILE_RE.test(ent.name)) names.push(`${kind}/${agent}/${ent.name}`);
        if (names.length > RSI_SNAPSHOT_MAX_FILES) throw new RsiSnapshotError('snapshot_invalid');
      }
    }
  }
  names.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return names;
}

/**
 * 当前磁盘上所有白名单文件的清单项(升序)。逐文件读取、算 sha256 / 字节数后即释放;`visit` 在持有该文件字节期间被调用
 * (一次只持一个文件)。非普通文件 / 链接 / 元数据不合规 → 抛错(固定名 `state_dir_unsafe`,其余 `reasonFor`)。
 */
async function scanCurrent(
  b: Bases,
  hooks: SnapshotReadHooks,
  visit?: (name: string, bytes: Buffer) => void,
): Promise<RsiSnapshot['files']> {
  const names = await enumerateCurrent(b);
  const out: RsiSnapshot['files'] = [];
  for (const name of names) {
    const got = await readData(b, name, hooks);
    if (got.kind === 'missing') continue;
    if (got.kind !== 'ok') throw failOf(name, got);
    out.push({ name, sha256: sha(got.bytes), bytes: got.bytes.length });
    visit?.(name, got.bytes);
  }
  return out;
}

function sameFiles(a: RsiSnapshot['files'], b: RsiSnapshot['files']): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.name === b[i]?.name && x.sha256 === b[i]?.sha256 && x.bytes === b[i]?.bytes)
  );
}

export interface CommitOptions extends SnapshotReadHooks {
  now?: () => Date;
  /** 测试用崩溃注入点:临时清单已写好、尚未 rename */
  beforeRename?: () => Promise<void> | void;
}

async function writeManifest(
  io: IoContext,
  lock: RsiLockHandle,
  b: Bases,
  generation: number,
  files: RsiSnapshot['files'],
  opts: CommitOptions,
): Promise<RsiSnapshot> {
  if (files.length > RSI_SNAPSHOT_MAX_FILES) throw new RsiSnapshotError('snapshot_invalid');
  const next: RsiSnapshot = RsiSnapshotSchema.parse({
    schema_version: 1,
    generation,
    written_at: (opts.now ?? ((): Date => new Date()))().toISOString(),
    files,
  });
  const dest = snapshotPath(b.rsi);
  const tmp = `${dest}.tmp`;
  try {
    await remove(io, tmp); // 上次崩溃留下的临时文件
    await createExclusive(io, tmp, canonicalJson(next), RSI_FILE_MODE);
    await opts.beforeRename?.();
    await lock.assertHeld(); // rename 是提交点
    await rename(io, tmp, dest);
  } catch (e) {
    if (e instanceof WriteDeniedError) throw new RsiSnapshotError('write_denied');
    throw e;
  }
  return next;
}

/**
 * 提交义务(R20-5.6):持锁写入方写完数据文件后的**最后一步**。按当前文件重算清单,临时文件 + rename 替换。
 * 现有清单损坏 → 抛 `snapshot_invalid`(须先经 {@link recoverSnapshot} / 人工处理);现有清单或固定数据文件元数据不合规 → `state_dir_unsafe`;
 * `generation` = 旧值 + 1(首次为 1)。枚举阶段就执行 2000 项上限,摘要逐文件计算,不在内存里攒全库。
 */
export async function commitSnapshot(
  io: IoContext,
  lock: RsiLockHandle,
  opts: CommitOptions = {},
): Promise<RsiSnapshot> {
  await lock.assertHeld();
  const b = await basesOf(io);
  const prev = await readSnapshot(io, opts);
  if (prev.kind === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  if (prev.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  const files = await scanCurrent(b, opts);
  return writeManifest(
    io,
    lock,
    b,
    prev.kind === 'ok' ? prev.snapshot.generation + 1 : 1,
    files,
    opts,
  );
}

export type RecoverOutcome = 'absent' | 'consistent' | 'rebuilt';

/**
 * 持锁写入方拿锁后第一件事(R20-5.6):
 *  - 清单缺失 → `absent`(从未提交过,不是错误);
 *  - 清单损坏 → 抛 `snapshot_invalid`;清单 / 固定数据文件元数据不合规 → 抛 `state_dir_unsafe`;
 *  - 清单与当前文件一致 → `consistent`;
 *  - 不一致:所有当前文件都过校验,**且清单里有而磁盘上缺的文件也被校验函数接受(`validate(name, null)`)**= 未完成提交,
 *    按当前文件重建清单 → `rebuilt`(不改任何数据文件);任一文件过不了校验 / 必需文件缺失 = 损坏,抛对应原因码,不重建。
 */
export async function recoverSnapshot(
  io: IoContext,
  lock: RsiLockHandle,
  validate: SnapshotValidator = structuralValidator,
  opts: CommitOptions = {},
): Promise<RecoverOutcome> {
  await lock.assertHeld();
  const b = await basesOf(io);
  await remove(io, `${snapshotPath(b.rsi)}.tmp`); // 崩溃在 rename 之前留下的临时清单
  const snap = await readSnapshot(io, opts);
  if (snap.kind === 'missing') return 'absent';
  if (snap.kind === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  if (snap.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  const cur = await scanCurrent(b, opts);
  if (sameFiles(snap.snapshot.files, cur)) return 'consistent';
  // 第二遍:边读边校验(一次只持一个文件),同时得到重建用的清单项
  const files = await scanCurrent(b, opts, (name, bytes) => {
    if (!validate(name, bytes)) throw new RsiSnapshotError(reasonFor(name));
  });
  const present = new Set(files.map((f) => f.name));
  for (const f of snap.snapshot.files) {
    if (!present.has(f.name) && !validate(f.name, null)) {
      throw new RsiSnapshotError(reasonFor(f.name));
    }
  }
  await writeManifest(io, lock, b, snap.snapshot.generation + 1, files, opts);
  return 'rebuilt';
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
