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
 * 数据文件各自的 schema 由调用方注入的 {@link SnapshotValidator} 判定(生产用 `src/rsi/validators.ts` 的 `productionSnapshotValidator`);
 * `recoverSnapshot` / `inspectSnapshot` 的校验器**必填、没有缺省**(R20-A2 B2)。
 *
 * R20-A2 B2 订正:
 *  - 月文件(`signals/…`、`sessions/…`)一律**流式**:同一个安全打开的句柄,对原始字节块同时算 sha256 / 字节数并喂 JSONL 校验引擎
 *    (`jsonl-stream.ts`),不再有 256MiB 单文件载入上限;固定小文件(四个)仍整份载入并保留 `RSI_DATA_FILE_MAX_BYTES` 上限。
 *  - 只读的 {@link inspectSnapshot}(不建目录、不删临时清单、不写清单)与会写的 {@link recoverSnapshot} 共用同一个评估核心。
 *  - 快路径不再绕过校验:`consistent` 时仍整体校验固定文件;`absent`(清单缺失)时对磁盘上已有的全部数据做完整校验,有损坏就抛,不当空。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  RSI_FILE_MODE,
  RSI_SNAPSHOT_FIXED_NAMES,
  RSI_SNAPSHOT_MAX_FILES,
  RsiSnapshotSchema,
  type RsiSnapshot,
} from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { MAX_LINE_BYTES, lstat, openStreamSafe, readDir, realpath } from '../io/read-fs.js';
import { createExclusive, remove, rename, WriteDeniedError } from '../io/safe-fs.js';
import { JsonlStream, JsonlStreamError } from './jsonl-stream.js';
import { rsiDirReadonly } from './lock-read.js';
import { type RsiLockHandle } from './lock.js';
import { rsiDir } from './rsi-dir.js';
import {
  RsiSnapshotError,
  fileOf,
  isFixed,
  parentsState,
  readData,
  readSnapshot,
  reasonFor,
  sha,
  snapshotPath,
  type Bases,
  type SnapshotReadHooks,
} from './snapshot-read.js';

// 拆分(R20-A2 B3a):只读部分在 `snapshot-read.ts`,这里 re-export,既有 import 路径不变
export {
  RSI_DATA_FILE_MAX_BYTES,
  RSI_SNAPSHOT_MAX_BYTES,
  RsiSnapshotError,
  readSnapshot,
  readVerified,
  snapshotPath,
  type SnapshotRead,
  type SnapshotReadHooks,
  type VerifiedRead,
} from './snapshot-read.js';

const AGENTS = ['claude', 'codex', 'pi'] as const;
const MONTH_FILE_RE = /^\d{6}\.jsonl$/;

/**
 * 恢复 / 检查时的校验器(必填,无缺省)。两种形态:
 *  - `fixed(name, bytes)`:四个固定小文件整份载入后判定。`bytes === null` = 「已提交清单里有、磁盘上现在没有」(任何 name 都可能收到,
 *    含月文件):调用方在这里决定它是不是**必需文件**(返回 `false` → 抛该文件的损坏码);
 *  - `record(name, value)`:月文件逐行(引擎已完成切行、UTF-8 解码、JSON 解析)的记录校验,一次一行,不在内存里攒全库。
 * `false` = 该文件(或它的缺失)不可接受 → 抛对应原因码(见 {@link reasonFor})。
 */
export interface SnapshotValidator {
  fixed(name: string, bytes: Uint8Array | null): boolean;
  record(name: string, value: unknown): boolean;
}

/** 写入方:必要时建目录(见 {@link rsiDir}) */
async function basesOf(io: IoContext): Promise<Bases> {
  const rsi = await rsiDir(io);
  return { rsi, state: path.dirname(rsi) };
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

interface ScanMode {
  /** 提供时:固定小文件整份载入后交给 `fixed(name, bytes)` 判定 */
  validateFixed?: SnapshotValidator;
  /** 提供时:月文件在计算摘要的**同一次**流式读取里逐行校验 */
  validateMonths?: SnapshotValidator;
}

type MonthStream = { kind: 'ok'; sha256: string; bytes: number } | { kind: 'missing' };

/**
 * 月文件:一次安全打开(`O_NOFOLLOW | O_NONBLOCK`,句柄 fstat 校验),同一个句柄读完;对**原始**字节块算 sha256 与字节数,
 * 同一批块喂 JSONL 校验引擎(`validate` 给了才校验)。链接 / 非普通文件 / 硬链接 / 读错误 / 超长行 / 非法 UTF-8 / 非 JSON /
 * 记录校验失败 / 尾行缺换行 → 抛 `signal_store_corrupt`。所有路径都关句柄。不设单文件大小上限。
 */
async function streamMonth(
  b: Bases,
  name: string,
  hooks: SnapshotReadHooks,
  validate: SnapshotValidator | undefined,
): Promise<MonthStream> {
  const file = fileOf(b, name);
  hooks.onRead?.(name);
  const s = await openStreamSafe(file, {
    beforeOpen: () => hooks.beforeOpen?.(file),
    ...(hooks.chunkBytes !== undefined ? { chunkBytes: hooks.chunkBytes } : {}),
  });
  if (s.kind === 'missing') return { kind: 'missing' };
  if (s.kind === 'unsafe') throw new RsiSnapshotError(reasonFor(name));
  const hash = createHash('sha256');
  let bytes = 0;
  const lines =
    validate === undefined
      ? undefined
      : new JsonlStream(hooks.maxLineBytes ?? MAX_LINE_BYTES, (v) => validate.record(name, v));
  try {
    for await (const chunk of s.chunks()) {
      hash.update(chunk);
      bytes += chunk.length;
      lines?.push(chunk);
    }
    lines?.end();
  } catch (e) {
    if (e instanceof JsonlStreamError) throw new RsiSnapshotError(reasonFor(name));
    if (e instanceof RsiSnapshotError) throw e;
    throw new RsiSnapshotError(reasonFor(name)); // 读错误
  } finally {
    await s.close();
  }
  return { kind: 'ok', sha256: hash.digest('hex'), bytes };
}

/**
 * 当前磁盘上所有白名单文件的清单项(升序)。固定名整份读入(有上限)、月文件流式;摘要逐文件计算后即释放,不在内存里攒全库。
 * 非普通文件 / 链接 / 元数据不合规 → 抛错(固定名 `state_dir_unsafe`,其余 `reasonFor`)。`mode` 决定顺带做哪些校验。
 */
async function scanCurrent(
  b: Bases,
  hooks: SnapshotReadHooks,
  mode: ScanMode = {},
): Promise<RsiSnapshot['files']> {
  const names = await enumerateCurrent(b);
  const out: RsiSnapshot['files'] = [];
  for (const name of names) {
    if (isFixed(name)) {
      const got = await readData(b, name, hooks);
      if (got.kind === 'missing') continue;
      if (got.kind !== 'ok') throw failOf(name, got);
      if (mode.validateFixed !== undefined && !mode.validateFixed.fixed(name, got.bytes)) {
        throw new RsiSnapshotError(reasonFor(name));
      }
      out.push({ name, sha256: sha(got.bytes), bytes: got.bytes.length });
    } else {
      const got = await streamMonth(b, name, hooks, mode.validateMonths);
      if (got.kind === 'missing') continue;
      out.push({ name, sha256: got.sha256, bytes: got.bytes });
    }
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
/** 只读检查的结论:`needs_rebuild` = 未完成提交(各文件都过校验但与清单不符),持锁写入方的 {@link recoverSnapshot} 会按当前文件重建清单 */
export type InspectOutcome = 'absent' | 'consistent' | 'needs_rebuild';

interface Evaluation {
  outcome: InspectOutcome;
  files: RsiSnapshot['files'];
  /** 现有清单的 generation(`absent` 为 null) */
  generation: number | null;
}

/**
 * 评估核心(只读;{@link inspectSnapshot} 与 {@link recoverSnapshot} 共用),清单已读好且不是 invalid / unsafe:
 *  - 清单缺失 → 对磁盘上已有的**全部**白名单数据(固定文件整份、月文件流式)做完整校验,有损坏就抛,没有才是 `absent`。
 *    「缺失」只说明从未提交过,不说明目录是空的(此前手动 collect 的信号库可能已在):不能把未校验的数据当空放行;
 *  - 清单在:先按当前文件重算摘要,**同一遍里整体校验固定文件**(`consistent` 也不绕过 schema,固定文件小、便宜);
 *    一致 → `consistent`;
 *  - 不一致:第二遍边读边校验(月文件的摘要与校验是同一次流式读取),再核对「清单里有、磁盘上缺」的文件是否可接受
 *    (`fixed(name, null)`),都通过 = 未完成提交 → `needs_rebuild`;任一不可接受 = 损坏,抛原因码。
 */
async function evaluate(
  b: Bases,
  snap: { kind: 'missing' } | { kind: 'ok'; snapshot: RsiSnapshot },
  validate: SnapshotValidator,
  opts: SnapshotReadHooks,
): Promise<Evaluation> {
  if (snap.kind === 'missing') {
    const files = await scanCurrent(b, opts, { validateFixed: validate, validateMonths: validate });
    return { outcome: 'absent', files, generation: null };
  }
  const gen = snap.snapshot.generation;
  const cur = await scanCurrent(b, opts, { validateFixed: validate });
  if (sameFiles(snap.snapshot.files, cur))
    return { outcome: 'consistent', files: cur, generation: gen };
  const files = await scanCurrent(b, opts, { validateFixed: validate, validateMonths: validate });
  const present = new Set(files.map((f) => f.name));
  for (const f of snap.snapshot.files) {
    if (!present.has(f.name) && !validate.fixed(f.name, null)) {
      throw new RsiSnapshotError(reasonFor(f.name));
    }
  }
  return { outcome: 'needs_rebuild', files, generation: gen };
}

/**
 * 只读基准目录(检查用):状态目录真实路径(不建);`rsi/` 不存在也给出基准(固定文件读取会得到 missing),
 * 因为月文件可能在 `.state/` 下先于 `rsi/` 存在。状态目录不存在 = 没有任何数据。`rsi/` 元数据不合规 → 抛 `state_dir_unsafe`。
 */
async function basesForInspect(
  io: IoContext,
  hooks: SnapshotReadHooks,
): Promise<Bases | undefined> {
  const d = await rsiDirReadonly(io, { beforeOpen: hooks.beforeOpen });
  if (d.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  if (d.kind === 'ok') return { rsi: d.dir, state: path.dirname(d.dir) };
  let stateReal: string;
  try {
    stateReal = await realpath(io.stateDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new RsiSnapshotError('state_dir_unsafe');
  }
  return { rsi: path.join(stateReal, 'rsi'), state: stateReal };
}

/**
 * **只读**检查(R20-A2 B2;给 D2 的「拿锁后、无副作用复检」用):与 {@link recoverSnapshot} 同一套判定与校验,但**绝不写**:
 * 不建目录、不 chmod、不删 `snapshot.json.tmp`、不写清单、不要求锁。损坏 / 不安全同样抛 {@link RsiSnapshotError}。
 * 状态目录不存在 = 没有数据 = `absent`。
 */
export async function inspectSnapshot(
  io: IoContext,
  validate: SnapshotValidator,
  opts: SnapshotReadHooks = {},
): Promise<InspectOutcome> {
  const b = await basesForInspect(io, opts);
  if (b === undefined) return 'absent';
  const snap = await readSnapshot(io, opts);
  if (snap.kind === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  if (snap.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  return (await evaluate(b, snap, validate, opts)).outcome;
}

/**
 * 持锁写入方拿锁后第一件事(R20-5.6)。**会写**(建 `rsi/`、删崩溃遗留的临时清单、重建清单);要无副作用的检查用 {@link inspectSnapshot}。
 * `validate` 必填(生产传 `productionSnapshotValidator`):
 *  - 清单缺失 → 先完整校验磁盘上已有的数据(见 {@link evaluate}),通过才 `absent`(从未提交过,不是错误;不替调用方写清单);
 *  - 清单损坏 → 抛 `snapshot_invalid`;清单 / 固定数据文件元数据不合规 → 抛 `state_dir_unsafe`;
 *  - 清单与当前文件一致(固定文件仍整体校验)→ `consistent`;
 *  - 不一致:所有当前文件都过校验,**且清单里有而磁盘上缺的文件也被校验器接受(`fixed(name, null)`)**= 未完成提交,
 *    按当前文件重建清单 → `rebuilt`(不改任何数据文件);任一文件过不了校验 / 必需文件缺失 = 损坏,抛对应原因码,不重建。
 */
export async function recoverSnapshot(
  io: IoContext,
  lock: RsiLockHandle,
  validate: SnapshotValidator,
  opts: CommitOptions = {},
): Promise<RecoverOutcome> {
  await lock.assertHeld();
  const b = await basesOf(io);
  await remove(io, `${snapshotPath(b.rsi)}.tmp`); // 崩溃在 rename 之前留下的临时清单
  const snap = await readSnapshot(io, opts);
  if (snap.kind === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  if (snap.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  const ev = await evaluate(b, snap, validate, opts);
  if (ev.outcome === 'needs_rebuild') {
    await writeManifest(io, lock, b, (ev.generation ?? 0) + 1, ev.files, opts);
    return 'rebuilt';
  }
  return ev.outcome;
}
