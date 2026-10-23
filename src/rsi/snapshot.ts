/**
 * 快照清单 `.state/rsi/snapshot.json`(`RsiSnapshot`)的读写原语(docs/contracts.md §20.5 R20-5.6;块 A1)。
 *
 * 清单列出「被提交过的文件」的 `{name, sha256, bytes}`,让**不拿锁的只读方**(hint、`rsi status`、`rsi projects`、`rsi tick` 干跑)
 * 能判断自己读到的是不是一次完整提交:
 *  - 写入方(持 `rsi/lock`)在写完 `state.json` / `projects.json` / `cursor.json` / `counts.json` / 信号库 / 会话计数文件之后,
 *    **最后一步**调 {@link commitSnapshot}:按当前文件重算清单,临时文件 + rename 替换(rename 是提交点)。`generation` 只增。
 *  - 只读方调 {@link readVerified}:先读清单,再读自己需要的文件并核对 sha256 与字节数;不一致重新取清单重读一次,仍不一致 → `busy`
 *    (调用方映射为 `RSI_SNAPSHOT_BUSY` / hint 空串)。只核对自己读的文件,只按白名单拼路径。
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
import { lstat, readBytes, readDir } from '../io/read-fs.js';
import { createExclusive, remove, rename, WriteDeniedError } from '../io/safe-fs.js';
import { rsiDir, type RsiLockHandle } from './lock.js';

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

export type SnapshotValidator = (name: string, bytes: Uint8Array) => boolean;

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

async function basesOf(io: IoContext): Promise<Bases> {
  const rsi = await rsiDir(io);
  return { rsi, state: path.dirname(rsi) };
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
  { kind: 'missing' } | { kind: 'invalid' } | { kind: 'ok'; snapshot: RsiSnapshot };

export async function readSnapshot(io: IoContext): Promise<SnapshotRead> {
  const file = snapshotPath((await basesOf(io)).rsi);
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { kind: 'invalid' };
  try {
    const parsed = RsiSnapshotSchema.safeParse(
      JSON.parse(Buffer.from(await readBytes(file)).toString('utf8')),
    );
    return parsed.success ? { kind: 'ok', snapshot: parsed.data } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function readRegular(file: string): Promise<Buffer | 'missing' | 'unsafe'> {
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
  if (st.isSymbolicLink() || !st.isFile()) return 'unsafe';
  try {
    return Buffer.from(await readBytes(file));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
}

/** 当前磁盘上所有白名单文件(升序)。非普通文件 / 链接 → 视为损坏。 */
async function scanCurrent(
  b: Bases,
): Promise<{ name: string; bytes: Buffer }[]> {
  const names: string[] = [];
  for (const n of RSI_SNAPSHOT_FIXED_NAMES) names.push(n);
  for (const kind of ['signals', 'sessions']) {
    for (const agent of AGENTS) {
      let entries;
      try {
        entries = await readDir(path.join(b.state, kind, agent));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new RsiSnapshotError('signal_store_corrupt');
      }
      for (const ent of entries) {
        if (MONTH_FILE_RE.test(ent.name)) names.push(`${kind}/${agent}/${ent.name}`);
      }
    }
  }
  names.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const out: { name: string; bytes: Buffer }[] = [];
  for (const name of names) {
    const got = await readRegular(fileOf(b, name));
    if (got === 'missing') continue;
    if (got === 'unsafe') throw new RsiSnapshotError(reasonFor(name));
    out.push({ name, bytes: got });
  }
  return out;
}

function entriesOf(cur: { name: string; bytes: Buffer }[]): RsiSnapshot['files'] {
  return cur.map((c) => ({ name: c.name, sha256: sha(c.bytes), bytes: c.bytes.length }));
}

function sameFiles(a: RsiSnapshot['files'], b: RsiSnapshot['files']): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.name === b[i]?.name && x.sha256 === b[i]?.sha256 && x.bytes === b[i]?.bytes)
  );
}

export interface CommitOptions {
  now?: () => Date;
  /** 测试用崩溃注入点:临时清单已写好、尚未 rename */
  beforeRename?: () => Promise<void> | void;
}

/**
 * 提交义务(R20-5.6):持锁写入方写完数据文件后的**最后一步**。按当前文件重算清单,临时文件 + rename 替换。
 * 现有清单损坏 → 抛 `snapshot_invalid`(须先经 {@link recoverSnapshot} / 人工处理);`generation` = 旧值 + 1(首次为 1)。
 */
export async function commitSnapshot(
  io: IoContext,
  lock: RsiLockHandle,
  opts: CommitOptions = {},
): Promise<RsiSnapshot> {
  await lock.assertHeld();
  const b = await basesOf(io);
  const prev = await readSnapshot(io);
  if (prev.kind === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  const files = entriesOf(await scanCurrent(b));
  if (files.length > RSI_SNAPSHOT_MAX_FILES) throw new RsiSnapshotError('snapshot_invalid');
  const next: RsiSnapshot = RsiSnapshotSchema.parse({
    schema_version: 1,
    generation: prev.kind === 'ok' ? prev.snapshot.generation + 1 : 1,
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

export type RecoverOutcome = 'absent' | 'consistent' | 'rebuilt';

/**
 * 持锁写入方拿锁后第一件事(R20-5.6):
 *  - 清单缺失 → `absent`(从未提交过,不是错误);
 *  - 清单损坏 → 抛 `snapshot_invalid`;
 *  - 清单与当前文件一致 → `consistent`;
 *  - 不一致:所有当前文件都过校验 = 未完成提交,按当前文件重建清单 → `rebuilt`(不改任何数据文件);任一文件过不了校验 = 损坏,抛对应原因码,不重建。
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
  const snap = await readSnapshot(io);
  if (snap.kind === 'missing') return 'absent';
  if (snap.kind === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  const cur = await scanCurrent(b);
  if (sameFiles(snap.snapshot.files, entriesOf(cur))) return 'consistent';
  for (const c of cur) {
    if (!validate(c.name, c.bytes)) throw new RsiSnapshotError(reasonFor(c.name));
  }
  await commitSnapshot(io, lock, opts);
  return 'rebuilt';
}

export type VerifiedRead =
  | { status: 'ok'; generation: number; files: Map<string, Buffer | null> }
  | { status: 'no_snapshot' }
  | { status: 'busy' }
  | { status: 'invalid' };

/**
 * 只读方(不拿锁):读清单,再读 `names` 里的文件并核对;不一致重新取清单重读一次,仍不一致 → `busy`。
 * `files` 里 `null` = 清单与磁盘都没有该文件(一致的「不存在」)。`names` 必须在白名单内(否则编程错误)。
 * 返回的是核对过的那份字节,调用方只解析这份,不要再自行重读(免得校验与使用之间被改)。
 */
export async function readVerified(
  io: IoContext,
  names: readonly string[],
  opts: { onMismatch?: () => Promise<void> | void } = {},
): Promise<VerifiedRead> {
  for (const n of names) if (!isRsiSnapshotName(n)) throw new RsiSnapshotError('internal');
  const b = await basesOf(io);
  for (let attempt = 0; attempt < 2; attempt++) {
    const snap = await readSnapshot(io);
    if (snap.kind === 'missing') return { status: 'no_snapshot' };
    if (snap.kind === 'invalid') return { status: 'invalid' };
    const listed = new Map(snap.snapshot.files.map((f) => [f.name, f]));
    const files = new Map<string, Buffer | null>();
    let consistent = true;
    for (const name of names) {
      const entry = listed.get(name);
      const got = await readRegular(fileOf(b, name));
      if (got === 'unsafe') return { status: 'invalid' };
      if (got === 'missing') {
        if (entry !== undefined) consistent = false;
        files.set(name, null);
        continue;
      }
      if (entry === undefined || entry.bytes !== got.length || entry.sha256 !== sha(got)) {
        consistent = false;
      }
      files.set(name, got);
    }
    if (consistent) return { status: 'ok', generation: snap.snapshot.generation, files };
    if (attempt === 0) await opts.onMismatch?.(); // 测试缝:两次尝试之间让「写入方」完成提交
  }
  return { status: 'busy' };
}
