import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { SyncTxnSchema, TXN_ID_RE, SYNC_BACKUPS_KEPT, type SyncTxn } from '../contracts/sync.js';
import { KIT_VERSION } from '../contracts/meta.js';
import { canonicalJson } from '../io/canonical-json.js';
import {
  HOME_DENY,
  HomeExistsError,
  HomeWriteDeniedError,
  createExclusive,
  createHomeFsContext,
  removeDir,
  remove,
  writeFile,
  type HomeFsContext,
  type HomeFsStage,
  tightenKitStateDir,
  type TightenStateDirResult,
} from '../io/home-fs.js';
import { lstat, readDir } from '../io/read-fs.js';
import type { LoadedPayload } from './payload-load.js';
import {
  BACKUPS_DIR_REL,
  LEDGER_REL,
  LOCK_REL,
  TXN_DIR_REL,
  listBackupIds,
  listResidualTxns,
  probePath,
  readLedger,
  sha256Of,
  type SnapshotResult,
  type LedgerRead,
} from './snapshot.js';
import { buildTxn, computeEdits, fileLevel, newTxnId, wholeFileOp, type FileEdit } from './txn.js';
import type { SyncPlan } from './types.js';

/**
 * S4:sync 执行层。**HOME 写盘全部经 `src/io/home-fs.ts`**(本文件是 eslint 授权的 import 方之一)。
 *
 * 事务(设计稿 §1.3 / 契约 §19.2):预检在计划器(整次拒绝不写)→ 先写 `txn/<id>.json`(phase=planned)→
 * 备份写前全文与登记表、写后全文到 `backups/<id>/` → 逐文件原子写 → 最后写 `ledger.json` → 删 txn。
 * 备份目录里的 `after/` 与 `ledger.after.*` 让 `--resume` 不需要 payload 就能把事务写完。
 */

export type ApplyErrorCode =
  | 'SYNC_TXN_INCOMPLETE'
  | 'SYNC_ROLLBACK_MISMATCH'
  | 'SYNC_PATH_NOT_REGULAR'
  | 'SYNC_WRITE_DENIED'
  | 'SYNC_LOCKED';

/** 命令层不得 import home-fs:写出口拒绝的判断经这里。 */
export const isHomeDenied = (e: unknown): boolean => e instanceof HomeWriteDeniedError;

export class ApplyError extends Error {
  constructor(
    readonly code: ApplyErrorCode,
    readonly detail: string,
  ) {
    super(`${code} ${detail}`);
    this.name = 'ApplyError';
  }
}

export interface ApplyDeps {
  now?: () => Date;
  /** 6 位十六进制随机串 / 锁 nonce(测试可注入) */
  randomHex?: (bytes: number) => string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  /** 测试注入口:在命名点抛错,模拟崩溃 / IO 错误。产品代码不传。 */
  inject?: (point: string) => void | Promise<void>;
  /** home-fs 原子写各阶段的注入口 */
  onStage?: (stage: HomeFsStage) => void | Promise<void>;
}

export interface ApplyEnv {
  /** 传给 home-fs 的 HOME(已通过 resolveAllowedHome) */
  home: string;
  /** HOME 的 realpath(只读探测用) */
  homeReal: string;
  tmpDir: string | undefined;
  env: Readonly<Record<string, string | undefined>> | undefined;
  deps: ApplyDeps;
}

export const SYNC_LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * 把 kit 自己的状态目录(`~/.local/state/agent-kit`)收紧到 0700(contracts §19.3 D14 的写入例外)。
 * `apply=false` 只报「将收紧」;链接 / 非目录 / 他人所有一律不改。命令层只经这里调用。
 */
export function tightenStateDir(env: ApplyEnv, apply: boolean): Promise<TightenStateDirResult> {
  return tightenKitStateDir(mkCtx(env, []), apply);
}

const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

const bdirOf = (id: string): string => `${BACKUPS_DIR_REL}/${id}`;
const journalOf = (id: string): string => `${TXN_DIR_REL}/${id}.json`;

function mkCtx(env: ApplyEnv, scope: readonly string[]): HomeFsContext {
  return createHomeFsContext({
    home: env.home,
    planScope: scope,
    tmpDir: env.tmpDir,
    ...(env.env !== undefined ? { env: env.env } : {}),
    ...(env.deps.onStage !== undefined ? { onStage: env.deps.onStage } : {}),
  });
}

const inject = async (env: ApplyEnv, point: string): Promise<void> => {
  await env.deps.inject?.(point);
};

const writeState = (ctx: HomeFsContext, rel: string, data: string): Promise<void> =>
  writeFile(ctx, rel, data, { mode: STATE_FILE_MODE, dirMode: STATE_DIR_MODE });

const defaultRandomHex = (bytes: number): string => randomBytes(bytes).toString('hex');

export function freshTxnId(env: { deps: ApplyDeps }): string {
  return newTxnId(
    (env.deps.now ?? ((): Date => new Date()))(),
    (env.deps.randomHex ?? defaultRandomHex)(3),
  );
}

// ---------------------------------------------------------------------------
// 锁(`sync/lock`)
// ---------------------------------------------------------------------------

interface LockDoc {
  pid: number;
  started_at: string;
  nonce: string;
}

export interface LockHandle {
  /** 提交点前复核:锁文件里的 nonce 仍是自己的;不是(陈旧锁回收竞态里被别人夺走)→ 抛 SYNC_LOCKED(lost),调用方不得继续写 */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(
  env: ApplyEnv,
): Promise<{ state: 'absent' } | { state: 'bad' } | { state: 'ok'; doc: LockDoc }> {
  const p = await probePath(env.homeReal, LOCK_REL);
  if (p.entry.kind === 'missing') return { state: 'absent' };
  if (p.entry.kind !== 'file' || p.text === undefined) return { state: 'bad' };
  try {
    const v = JSON.parse(p.text) as Partial<LockDoc>;
    if (
      typeof v.pid === 'number' &&
      Number.isInteger(v.pid) &&
      typeof v.started_at === 'string' &&
      typeof v.nonce === 'string'
    ) {
      return { state: 'ok', doc: { pid: v.pid, started_at: v.started_at, nonce: v.nonce } };
    }
  } catch {
    // 落到 bad
  }
  return { state: 'bad' };
}

/**
 * 取 sync 锁:`createExclusive`(O_CREAT|O_EXCL|O_NOFOLLOW,S7c-B 起与 update 锁同一原语),内容 = pid + 开始时间 + nonce,0600。
 * 已存在时:持锁进程还在 → `SYNC_LOCKED`(超过 TTL 15 分钟也只报不杀);持锁进程已不在 / 内容损坏 → 回收(删除前复读确认仍是同一把)后重试一次。
 * 空文件且创建不满 {@link SYNC_LOCK_PARTIAL_GRACE_MS}:正在写(O_EXCL 创建与写入之间的窗口),按被持有。
 * 回收有残余竞态(两个回收者先后删除),由 release 的 nonce 复核与事务自身的预检兜底。
 */
export const SYNC_LOCK_PARTIAL_GRACE_MS = 10_000;

export async function acquireLock(env: ApplyEnv): Promise<LockHandle> {
  const alive = env.deps.isPidAlive ?? defaultAlive;
  const now = env.deps.now ?? ((): Date => new Date());
  const doc: LockDoc = {
    pid: env.deps.pid ?? process.pid,
    started_at: now().toISOString(),
    nonce: (env.deps.randomHex ?? defaultRandomHex)(8),
  };
  const ctx = mkCtx(env, [LOCK_REL]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await createExclusive(ctx, LOCK_REL, canonicalJson(doc), {
        mode: STATE_FILE_MODE,
        dirMode: STATE_DIR_MODE,
      });
      const mine = await readLock(env);
      if (mine.state !== 'ok' || mine.doc.nonce !== doc.nonce) {
        throw new ApplyError('SYNC_LOCKED', 'lost_race');
      }
      return {
        async assertHeld(): Promise<void> {
          const cur = await readLock(env);
          if (cur.state !== 'ok' || cur.doc.nonce !== doc.nonce) {
            throw new ApplyError('SYNC_LOCKED', 'lost');
          }
        },
        async release(): Promise<void> {
          const now2 = await readLock(env);
          if (now2.state === 'ok' && now2.doc.nonce === doc.nonce) {
            await remove(mkCtx(env, [LOCK_REL]), LOCK_REL);
          }
        },
      };
    } catch (e) {
      if (!(e instanceof HomeExistsError)) throw e;
    }
    const cur = await readLock(env);
    if (cur.state === 'absent') continue;
    if (cur.state === 'ok') {
      if (alive(cur.doc.pid)) {
        const age = now().getTime() - Date.parse(cur.doc.started_at);
        throw new ApplyError('SYNC_LOCKED', age > SYNC_LOCK_TTL_MS ? 'held_over_ttl' : 'held');
      }
    } else {
      const p = await probePath(env.homeReal, LOCK_REL);
      if (p.entry.kind !== 'file') throw new ApplyError('SYNC_PATH_NOT_REGULAR', 'lock');
      if (p.text === '') {
        let mtimeMs = 0;
        try {
          mtimeMs = (await lstat(path.join(env.homeReal, ...LOCK_REL.split('/')))).mtimeMs;
        } catch {
          continue;
        }
        if (now().getTime() - mtimeMs < SYNC_LOCK_PARTIAL_GRACE_MS) {
          throw new ApplyError('SYNC_LOCKED', 'held');
        }
      }
    }
    // 回收:删除前复读,确认还是刚才判定为陈旧的那把
    const again = await readLock(env);
    const same =
      cur.state === 'ok'
        ? again.state === 'ok' && again.doc.nonce === cur.doc.nonce
        : again.state === 'bad';
    if (!same) continue;
    await remove(mkCtx(env, [LOCK_REL]), LOCK_REL);
  }
  throw new ApplyError('SYNC_LOCKED', 'lost_race');
}

// ---------------------------------------------------------------------------
// 写文件 / 删文件(+ 清理 sync 自己建的空条目目录)
// ---------------------------------------------------------------------------

/**
 * 删除文件后,沿父目录向上 rmdir 空目录,止于 home-fs 的目录条目边界(条目目录本身与其上级不可删)。
 * 条目目录(如 `.agents/skills/<name>/`)若不为空(用户放了别的文件)保持原样。
 * 这能删的只有「严格位于目录条目内部」的空目录;sync 隐式创建的 `.claude`、`.claude/skills`、`.codex` 等
 * 条目目录本身与上级,home-fs 不允许删,会留空目录(见汇报)。
 */
async function cleanupEmptyDirs(ctx: HomeFsContext, rel: string): Promise<void> {
  let dir = path.posix.dirname(rel);
  while (dir.includes('/')) {
    try {
      await removeDir(ctx, dir);
    } catch (e) {
      if (e instanceof HomeWriteDeniedError) {
        // 到了目录条目边界(条目本身 / 上级 / 计划外)才停;其它拒绝(别名 / 竞态 / 链接)是真问题,不吞
        if (
          e.code === HOME_DENY.DIR_ITSELF ||
          e.code === HOME_DENY.NOT_IN_TABLE ||
          e.code === HOME_DENY.OUT_OF_PLAN_SCOPE
        ) {
          return;
        }
        throw e;
      }
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') return;
      throw e;
    }
    dir = path.posix.dirname(dir);
  }
}

async function currentSha(env: ApplyEnv, rel: string): Promise<string | null> {
  const p = await probePath(env.homeReal, rel, { readText: false });
  if (p.entry.kind === 'missing' && p.entry.linkedSegment !== true) return null;
  if (p.entry.kind === 'file' && p.entry.sha256 !== undefined) return p.entry.sha256;
  throw new ApplyError('SYNC_PATH_NOT_REGULAR', 'target_changed');
}

async function readTextOf(env: ApplyEnv, rel: string): Promise<string | undefined> {
  const p = await probePath(env.homeReal, rel);
  return p.entry.kind === 'file' ? p.text : undefined;
}

// ---------------------------------------------------------------------------
// 备份目录
// ---------------------------------------------------------------------------

interface LedgerAfter {
  action: 'none' | 'write' | 'delete';
  text?: string;
}

function backupScope(id: string, edits: readonly FileEdit[]): string[] {
  const b = bdirOf(id);
  const out = [
    journalOf(id),
    `${b}/txn.json`,
    `${b}/modes.json`,
    `${b}/ledger.before.json`,
    `${b}/ledger.before.absent`,
    `${b}/ledger.after.json`,
    `${b}/ledger.after.delete`,
    `${b}/complete`,
    LEDGER_REL,
  ];
  for (const e of edits) out.push(`${b}/files/${e.path}`, `${b}/after/${e.path}`, e.path);
  return out;
}

async function writeBackups(
  ctx: HomeFsContext,
  doc: SyncTxn,
  edits: readonly FileEdit[],
  ledgerBeforeText: string | null,
  ledgerAfter: LedgerAfter,
): Promise<void> {
  const b = bdirOf(doc.txn_id);
  await writeState(ctx, `${b}/txn.json`, canonicalJson(doc));
  for (const e of edits) {
    if (e.beforeText !== null) await writeState(ctx, `${b}/files/${e.path}`, e.beforeText);
  }
  for (const e of edits) {
    if (e.afterText !== null) await writeState(ctx, `${b}/after/${e.path}`, e.afterText);
  }
  const modes: Record<string, number> = {};
  for (const e of edits) if (e.beforeMode !== undefined) modes[e.path] = e.beforeMode;
  await writeState(ctx, `${b}/modes.json`, canonicalJson(modes));
  if (ledgerBeforeText === null) await writeState(ctx, `${b}/ledger.before.absent`, '');
  else await writeState(ctx, `${b}/ledger.before.json`, ledgerBeforeText);
  if (ledgerAfter.action === 'write') {
    await writeState(ctx, `${b}/ledger.after.json`, ledgerAfter.text as string);
  } else if (ledgerAfter.action === 'delete') {
    await writeState(ctx, `${b}/ledger.after.delete`, '');
  }
  await writeState(ctx, `${b}/complete`, '');
}

// ---------------------------------------------------------------------------
// 逐文件写
// ---------------------------------------------------------------------------

async function writeEdits(
  env: ApplyEnv,
  ctx: HomeFsContext,
  doc: SyncTxn,
  edits: readonly FileEdit[],
  ledgerAfter: LedgerAfter,
  resumed: boolean,
  lock?: LockHandle,
): Promise<void> {
  const id = doc.txn_id;
  const setPhase = async (phase: SyncTxn['phase']): Promise<void> => {
    await writeState(ctx, journalOf(id), canonicalJson({ ...doc, phase }));
  };
  await lock?.assertHeld();
  await setPhase('writing');
  for (const e of edits) {
    await inject(env, `before-write:${e.path}`);
    await lock?.assertHeld();
    const cur = await currentSha(env, e.path);
    if (cur === e.afterSha) {
      if (e.afterText === null) await cleanupEmptyDirs(ctx, e.path);
      await inject(env, `after-write:${e.path}`);
      continue;
    }
    if (cur !== e.beforeSha) {
      throw resumed
        ? new ApplyError('SYNC_TXN_INCOMPLETE', 'changed_since_txn')
        : new ApplyError('SYNC_WRITE_DENIED', 'changed_during_run');
    }
    if (e.afterText !== null) {
      await writeFile(ctx, e.path, e.afterText, { mode: e.beforeMode ?? 0o644 });
    } else {
      await remove(ctx, e.path);
      await cleanupEmptyDirs(ctx, e.path);
    }
    await inject(env, `after-write:${e.path}`);
  }
  await inject(env, 'before-ledger');
  await lock?.assertHeld();
  if (ledgerAfter.action === 'write') await writeState(ctx, LEDGER_REL, ledgerAfter.text as string);
  else if (ledgerAfter.action === 'delete') await remove(ctx, LEDGER_REL);
  await inject(env, 'after-ledger');
  await lock?.assertHeld();
  await setPhase('ledger_written');
  await inject(env, 'before-journal-delete');
  await lock?.assertHeld();
  await remove(ctx, journalOf(id));
}

export interface TxnSpec {
  txn: SyncTxn;
  edits: readonly FileEdit[];
  ledgerBeforeText: string | null;
  ledgerAfter: LedgerAfter;
  /** 已持有的 sync 锁:journal、每个文件、登记表提交前都复核仍持有 */
  lock?: LockHandle;
}

/** 执行一个新事务(journal → 备份 → 逐文件写 → 登记表 → 删 journal → 修剪备份)。 */
export async function executeTxn(env: ApplyEnv, spec: TxnSpec): Promise<void> {
  const id = spec.txn.txn_id;
  const ctx = mkCtx(env, backupScope(id, spec.edits));
  await spec.lock?.assertHeld();
  await writeState(ctx, journalOf(id), canonicalJson(spec.txn));
  await inject(env, 'journal-written');
  await spec.lock?.assertHeld();
  await writeBackups(ctx, spec.txn, spec.edits, spec.ledgerBeforeText, spec.ledgerAfter);
  await inject(env, 'backup-written');
  const backedUp = { ...spec.txn, phase: 'backed_up' as const };
  await writeState(ctx, journalOf(id), canonicalJson(backedUp));
  await writeEdits(env, ctx, backedUp, spec.edits, spec.ledgerAfter, false, spec.lock);
  await spec.lock?.assertHeld();
  await pruneBackups(env, id);
}

// ---------------------------------------------------------------------------
// 备份修剪(保留最近 SYNC_BACKUPS_KEPT 个事务)
// ---------------------------------------------------------------------------

async function walk(env: ApplyEnv, rel: string, files: string[], dirs: string[]): Promise<void> {
  let entries;
  try {
    entries = await readDir(path.join(env.homeReal, ...rel.split('/')));
  } catch {
    return;
  }
  for (const e of entries) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory) {
      await walk(env, child, files, dirs);
      dirs.push(child);
    } else files.push(child);
  }
}

export async function pruneBackups(env: ApplyEnv, current: string): Promise<void> {
  const ids = await listBackupIds(env.homeReal);
  const residual = new Set(await listResidualTxns(env.homeReal));
  const keep = new Set(ids.slice(-SYNC_BACKUPS_KEPT));
  keep.add(current);
  for (const r of residual) keep.add(r);
  for (const id of ids) {
    if (keep.has(id)) continue;
    const files: string[] = [];
    const dirs: string[] = [];
    await walk(env, bdirOf(id), files, dirs);
    if (files.length === 0 && dirs.length === 0) continue;
    const ctx = mkCtx(env, files);
    for (const f of files) await remove(ctx, f);
    for (const d of dirs) await removeDir(ctx, d);
    await removeDir(ctx, bdirOf(id));
  }
}

// ---------------------------------------------------------------------------
// 计划 → 事务
// ---------------------------------------------------------------------------

export interface ApplyPlanInput {
  action: 'sync' | 'adopt' | 'uninstall';
  plan: SyncPlan;
  payload: LoadedPayload | null;
  snapshot: SnapshotResult;
  ledgerRead: LedgerRead;
  txnId: string;
  /** 已持有的 sync 锁(传了就在每个提交点前复核) */
  lock?: LockHandle;
}

export interface ApplyResult {
  /** 实际落盘的事务 id(只改登记表 / 无操作时没有) */
  txnId?: string;
  files: number;
  ledger: 'none' | 'write' | 'delete';
}

function ledgerAfterOf(plan: SyncPlan): LedgerAfter {
  if (plan.ledger.action === 'write' && plan.ledger.next !== null) {
    return { action: 'write', text: canonicalJson(plan.ledger.next) };
  }
  if (plan.ledger.action === 'delete') return { action: 'delete' };
  if (plan.ledger.action !== 'none') throw new TypeError('登记表要写但计划没给新内容');
  return { action: 'none' };
}

/** 执行一份 status=ok 的计划(调用方已持锁)。 */
export async function applyPlan(env: ApplyEnv, input: ApplyPlanInput): Promise<ApplyResult> {
  const { plan } = input;
  if (plan.status !== 'ok') throw new TypeError('applyPlan 只接受 status=ok 的计划');
  const ledgerAfter = ledgerAfterOf(plan);
  const { edits, ops } = computeEdits({
    plan,
    payload: input.payload,
    texts: input.snapshot.texts,
    entries: input.snapshot.snapshot.entries,
    modes: input.snapshot.modes,
  });
  const ledgerBeforeText = input.ledgerRead.state === 'ok' ? input.ledgerRead.text : null;
  if (edits.length === 0) {
    if (ledgerAfter.action === 'none') return { files: 0, ledger: 'none' };
    // 只改登记表(adopt / 仅 agents 变化):单文件原子替换,不开事务
    await input.lock?.assertHeld();
    const ctx = mkCtx(env, [LEDGER_REL]);
    if (ledgerAfter.action === 'write')
      await writeState(ctx, LEDGER_REL, ledgerAfter.text as string);
    else await remove(ctx, LEDGER_REL);
    return { files: 0, ledger: ledgerAfter.action };
  }
  const txn = buildTxn({
    txnId: input.txnId,
    action: input.action,
    kitVersion: input.payload?.manifest.kit_version ?? KIT_VERSION,
    ...(input.action !== 'uninstall' && input.payload !== null
      ? { payloadSha256: input.payload.manifestSha256 }
      : {}),
    ledgerShaBefore: input.ledgerRead.state === 'ok' ? input.ledgerRead.sha256 : null,
    startedAt: (env.deps.now ?? ((): Date => new Date()))().toISOString(),
    ops,
  });
  await executeTxn(env, {
    txn,
    edits,
    ledgerBeforeText,
    ledgerAfter,
    ...(input.lock !== undefined ? { lock: input.lock } : {}),
  });
  return { txnId: txn.txn_id, files: edits.length, ledger: ledgerAfter.action };
}

// ---------------------------------------------------------------------------
// 读事务 / 备份
// ---------------------------------------------------------------------------

async function readTxnDoc(env: ApplyEnv, rel: string): Promise<SyncTxn | undefined> {
  const text = await readTextOf(env, rel);
  if (text === undefined) return undefined;
  try {
    const parsed = SyncTxnSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

interface BackupView {
  doc: SyncTxn;
  ledgerBeforeText: string | null;
  /** 事务写入后的登记表 sha:null = 已删除;undefined 不会出现 */
  ledgerAfterSha: string | null;
  ledgerAfter: LedgerAfter;
  modes: Record<string, number>;
  complete: boolean;
  beforeText(path: string): Promise<string | undefined>;
  afterText(path: string): Promise<string | undefined>;
}

async function loadBackup(env: ApplyEnv, id: string, doc: SyncTxn): Promise<BackupView> {
  const b = bdirOf(id);
  const complete =
    (await probePath(env.homeReal, `${b}/complete`, { readText: false })).entry.kind === 'file';
  const lb = await readTextOf(env, `${b}/ledger.before.json`);
  const la = await readTextOf(env, `${b}/ledger.after.json`);
  const ladel =
    (await probePath(env.homeReal, `${b}/ledger.after.delete`, { readText: false })).entry.kind ===
    'file';
  let modes: Record<string, number> = {};
  const mt = await readTextOf(env, `${b}/modes.json`);
  if (mt !== undefined) {
    try {
      modes = JSON.parse(mt) as Record<string, number>;
    } catch {
      modes = {};
    }
  }
  const ledgerAfter: LedgerAfter =
    la !== undefined
      ? { action: 'write', text: la }
      : ladel
        ? { action: 'delete' }
        : { action: 'none' };
  const ledgerAfterSha = la !== undefined ? sha256Of(la) : ladel ? null : doc.ledger_sha256_before;
  return {
    doc,
    ledgerBeforeText: lb ?? null,
    ledgerAfterSha,
    ledgerAfter,
    modes,
    complete,
    beforeText: (p) => readTextOf(env, `${b}/files/${p}`),
    afterText: (p) => readTextOf(env, `${b}/after/${p}`),
  };
}

async function currentLedgerSha(env: ApplyEnv): Promise<string | null> {
  const l = await readLedger(env.homeReal);
  if (l.state === 'absent') return null;
  if (l.state === 'unsafe') throw new ApplyError('SYNC_PATH_NOT_REGULAR', 'ledger');
  return l.sha256;
}

// ---------------------------------------------------------------------------
// 回滚
// ---------------------------------------------------------------------------

export interface RollbackReport {
  sourceTxn: string;
  /** incomplete = 残留事务(文件可处于写前或写后);completed = 已收尾事务 */
  kind: 'incomplete' | 'completed';
  /** 需要还原的文件(HOME 相对路径) */
  restore: { path: string; op: 'create' | 'update' | 'remove' }[];
  ledgerRestore: boolean;
  /** 实际落盘的回滚事务 id(干跑 / 无事可做时没有) */
  txnId?: string;
  wrote: boolean;
}

/**
 * 回滚事务 `id`(调用方已持锁;干跑传 write=false 不写;传了 `lock` 就在每个写出口前复核仍持有)。
 * 前提:已收尾事务要求每个文件当前 sha == 该事务写入后的 sha,登记表当前 sha == 写入后的 sha;
 * 残留事务放宽为「写前或写后」(崩溃时有的文件已写、有的没写)。任一前提不成立 → `SYNC_ROLLBACK_MISMATCH`,整次不写。
 * 回滚本身也是一个有 journal / 备份的事务(可再回滚)。
 */
export async function rollbackTxn(
  env: ApplyEnv,
  id: string,
  write: boolean,
  freshId: string,
  lock?: LockHandle,
): Promise<RollbackReport> {
  const mismatch = (d: string): ApplyError => new ApplyError('SYNC_ROLLBACK_MISMATCH', d);
  if (!TXN_ID_RE.test(id)) throw mismatch('bad_id');
  const active = await readTxnDoc(env, journalOf(id));
  const kind: RollbackReport['kind'] = active !== undefined ? 'incomplete' : 'completed';
  const doc = active ?? (await readTxnDoc(env, `${bdirOf(id)}/txn.json`));
  if (doc === undefined || doc.txn_id !== id) throw mismatch('unknown_txn');
  const view = await loadBackup(env, id, doc);
  // 已收尾事务的备份必须是完整的(残留事务可能死在备份写完之前,那时还没有任何文件被改)
  if (kind === 'completed' && !view.complete) throw mismatch('backup_incomplete');
  const levels = fileLevel(doc.ops);

  const restores: { path: string; before: string | null; after: string | null }[] = [];
  for (const [p, lv] of levels) {
    const cur = await currentSha(env, p).catch(() => {
      throw mismatch('target_not_regular');
    });
    if (cur === lv.after) {
      restores.push({ path: p, before: lv.before, after: lv.after });
      continue;
    }
    if (kind === 'incomplete' && cur === lv.before) continue;
    throw mismatch('file_changed');
  }
  if (!view.complete && restores.length > 0) throw mismatch('backup_incomplete');
  const curLedger = await currentLedgerSha(env);
  const lbSha = doc.ledger_sha256_before;
  const laSha = view.ledgerAfterSha;
  let ledgerRestore = false;
  if (curLedger === laSha && laSha !== lbSha) ledgerRestore = true;
  else if (!(curLedger === laSha || (kind === 'incomplete' && curLedger === lbSha))) {
    throw mismatch('ledger_changed');
  }

  const report: RollbackReport = {
    sourceTxn: id,
    kind,
    restore: restores.map((r) => ({
      path: r.path,
      op: r.before === null ? 'remove' : r.after === null ? 'create' : 'update',
    })),
    ledgerRestore,
    wrote: false,
  };
  if (!write) return report;

  // 还原用的文本必须齐全且 sha 对得上,否则整次拒绝(在写任何东西之前)
  const edits: FileEdit[] = [];
  const agentsOf = (p: string): SyncTxn['ops'][number]['agents'] => [
    ...new Set(doc.ops.filter((o) => o.path === p).flatMap((o) => o.agents)),
  ];
  for (const r of restores) {
    let target: string | null = null;
    if (r.before !== null) {
      const t = await view.beforeText(r.path);
      if (t === undefined || sha256Of(t) !== r.before) throw mismatch('backup_missing');
      target = t;
    }
    const curText = r.after === null ? null : ((await readTextOf(env, r.path)) ?? null);
    const probe = await probePath(env.homeReal, r.path, { readText: false });
    edits.push({
      path: r.path,
      beforeSha: r.after,
      beforeText: curText,
      beforeMode: probe.mode,
      afterSha: r.before,
      afterText: target,
    });
  }
  // 原先被删除的文件还原时沿用当时的权限位
  for (const e of edits) e.beforeMode ??= view.modes[e.path];
  let ledgerAfter: LedgerAfter = { action: 'none' };
  if (ledgerRestore) {
    if (view.ledgerBeforeText === null) ledgerAfter = { action: 'delete' };
    else {
      if (lbSha === null || sha256Of(view.ledgerBeforeText) !== lbSha)
        throw mismatch('ledger_backup');
      ledgerAfter = { action: 'write', text: view.ledgerBeforeText };
    }
  }

  const finishSource = async (): Promise<void> => {
    if (kind === 'incomplete') {
      await lock?.assertHeld();
      await remove(mkCtx(env, [journalOf(id)]), journalOf(id));
    }
  };

  if (edits.length === 0) {
    if (ledgerAfter.action !== 'none') {
      await lock?.assertHeld();
      const ctx = mkCtx(env, [LEDGER_REL]);
      if (ledgerAfter.action === 'write')
        await writeState(ctx, LEDGER_REL, ledgerAfter.text as string);
      else await remove(ctx, LEDGER_REL);
    }
    await finishSource();
    return { ...report, wrote: ledgerAfter.action !== 'none' || kind === 'incomplete' };
  }
  const ops = edits.map((e) => wholeFileOp(e.path, e.beforeSha, e.afterSha, agentsOf(e.path)));
  const txn = buildTxn({
    txnId: freshId,
    action: 'rollback',
    rollbackOf: id,
    kitVersion: KIT_VERSION,
    ledgerShaBefore: curLedger,
    startedAt: (env.deps.now ?? ((): Date => new Date()))().toISOString(),
    ops,
  });
  const lr = await readLedger(env.homeReal);
  await executeTxn(env, {
    txn,
    edits,
    ledgerBeforeText: lr.state === 'ok' || lr.state === 'invalid' ? lr.text : null,
    ledgerAfter,
    ...(lock !== undefined ? { lock } : {}),
  });
  await finishSource();
  return { ...report, txnId: freshId, wrote: true };
}

// ---------------------------------------------------------------------------
// 续跑
// ---------------------------------------------------------------------------

export interface ResumeReport {
  txn: string | null;
  /** 还没写到写后状态的文件 */
  pending: string[];
  done: string[];
  wrote: boolean;
}

/**
 * 继续残留事务(调用方已持锁;干跑传 write=false;传了 `lock` 就在每个写出口前复核仍持有)。只需要备份目录(不需要 payload):
 * 备份没写完整(`complete` 标记缺失)→ `SYNC_TXN_INCOMPLETE`,请改用 `--rollback`。
 */
export async function resumeTxn(
  env: ApplyEnv,
  write: boolean,
  lock?: LockHandle,
): Promise<ResumeReport> {
  const residual = await listResidualTxns(env.homeReal);
  if (residual.length === 0) return { txn: null, pending: [], done: [], wrote: false };
  if (residual.length > 1) throw new ApplyError('SYNC_TXN_INCOMPLETE', 'multiple');
  const id = residual[0] as string;
  const incomplete = (d: string): ApplyError => new ApplyError('SYNC_TXN_INCOMPLETE', d);
  const doc = await readTxnDoc(env, journalOf(id));
  if (doc === undefined || doc.txn_id !== id) throw incomplete('journal_invalid');
  const view = await loadBackup(env, id, doc);
  if (!view.complete) throw incomplete('backup_incomplete');

  if (doc.phase === 'ledger_written') {
    // 文件与登记表都已写完,只差删 journal:不再要求文件内容仍等于写后(用户可能在崩溃后改过),直接收尾
    if ((await currentLedgerSha(env)) !== view.ledgerAfterSha) throw incomplete('ledger_changed');
    const all = [...fileLevel(doc.ops).keys()];
    const finished: ResumeReport = { txn: id, pending: [], done: all, wrote: false };
    if (!write) return finished;
    await lock?.assertHeld();
    await remove(mkCtx(env, [journalOf(id)]), journalOf(id));
    await lock?.assertHeld();
    await pruneBackups(env, id);
    return { ...finished, wrote: true };
  }
  const edits: FileEdit[] = [];
  const pending: string[] = [];
  const done: string[] = [];
  for (const [p, lv] of fileLevel(doc.ops)) {
    let beforeText: string | null = null;
    if (lv.before !== null) {
      const t = await view.beforeText(p);
      if (t === undefined || sha256Of(t) !== lv.before) throw incomplete('backup_before_invalid');
      beforeText = t;
    }
    let afterText: string | null = null;
    if (lv.after !== null) {
      const t = await view.afterText(p);
      if (t === undefined || sha256Of(t) !== lv.after) throw incomplete('backup_after_invalid');
      afterText = t;
    }
    const cur = await currentSha(env, p).catch(() => {
      throw incomplete('target_not_regular');
    });
    if (cur === lv.after) done.push(p);
    else if (cur === lv.before) pending.push(p);
    else throw incomplete('changed_since_txn');
    edits.push({
      path: p,
      beforeSha: lv.before,
      beforeText,
      beforeMode: view.modes[p],
      afterSha: lv.after,
      afterText,
    });
  }
  if (view.ledgerAfter.action === 'write') {
    if (sha256Of(view.ledgerAfter.text as string) !== view.ledgerAfterSha)
      throw incomplete('ledger_after');
  }
  const curLedger = await currentLedgerSha(env);
  if (curLedger !== doc.ledger_sha256_before && curLedger !== view.ledgerAfterSha) {
    throw incomplete('ledger_changed');
  }
  const report: ResumeReport = { txn: id, pending, done, wrote: false };
  if (!write) return report;
  const ctx = mkCtx(env, backupScope(id, edits));
  await writeEdits(env, ctx, doc, edits, view.ledgerAfter, true, lock);
  await lock?.assertHeld();
  await pruneBackups(env, id);
  return { ...report, wrote: true };
}
