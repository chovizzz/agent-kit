import * as path from 'node:path';
import { RelPathSchema } from '../contracts/common.js';
import {
  HOME_WRITE_TABLE,
  SyncLedgerSchema,
  TXN_ID_RE,
  isHomeWritePath,
  type SyncLedger,
} from '../contracts/sync.js';
import { getRealHome } from '../io/paths.js';
import { readDir, realpath } from '../io/read-fs.js';
import { MAX_READ_BYTES, lstatOrNull, sha256Of } from '../io/probe.js';
import type { DiskEntry, DiskSnapshot } from './types.js';

// 单路径探测已下沉到 io/probe.ts(D-AU1 / M3),此处 re-export,调用点不变
export { MAX_READ_BYTES, blockSnapshotOf, probePath, sha256Of, type Probe } from '../io/probe.js';

/**
 * S4:磁盘快照构建器(只读)。对计划涉及的 HOME 相对路径,用 read-fs 的只读 API 构造 S3 计划器要的 `DiskSnapshot`:
 * 存在性 / 类型 / 内容 sha / 中间段链接 / 托管块解析结果 / 独占目录清单 / 残留事务。
 * 本文件不 import 任何写出口;干跑与 doctor 都可直接用,绝不建目录、不改 mtime。
 */

export const STATE_SYNC_DIR = '.local/state/agent-kit/sync';
export const LEDGER_REL = `${STATE_SYNC_DIR}/ledger.json`;
export const TXN_DIR_REL = `${STATE_SYNC_DIR}/txn`;
export const BACKUPS_DIR_REL = `${STATE_SYNC_DIR}/backups`;
export const LOCK_REL = `${STATE_SYNC_DIR}/lock`;

// ---------------------------------------------------------------------------
// HOME 校验
// ---------------------------------------------------------------------------

async function realOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

function strictlyInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * `--home` / 缺省 HOME 的准入:必须是 `getRealHome(env)`,或 KIT_TMP(`tmpDir`)严格之内的目录。
 * 返回目录的 realpath(之后的逐段探测从它起算);不合格返回 undefined。
 */
export async function resolveAllowedHome(
  home: string,
  tmpDir: string | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<string | undefined> {
  if (!path.isAbsolute(home)) return undefined;
  const canon = await realOrUndefined(home);
  if (canon === undefined) return undefined;
  const real = getRealHome(env);
  if (path.isAbsolute(real)) {
    if (path.resolve(real) === path.resolve(home)) return canon;
    const realCanon = await realOrUndefined(real);
    if (realCanon !== undefined && realCanon === canon) return canon;
  }
  if (tmpDir !== undefined) {
    const tmpCanon = await realOrUndefined(tmpDir);
    if (tmpCanon !== undefined && strictlyInside(tmpCanon, canon)) return canon;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 单路径探测
// ---------------------------------------------------------------------------

/** 目标所在的「条目目录」(如 `.agents/skills/<name>`),仅 adapter 目录条目内部、且不是独占目录时有。 */
export function entryDirOf(rel: string, ownedDirs: readonly string[]): string | undefined {
  for (const t of HOME_WRITE_TABLE) {
    if (t.kind !== 'dir' || t.owner !== 'adapter' || !rel.startsWith(t.path)) continue;
    if (ownedDirs.includes(t.path)) return undefined;
    const rest = rel.slice(t.path.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return undefined;
    return `${t.path}${rest.slice(0, slash)}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 独占目录清单
// ---------------------------------------------------------------------------

async function listFilesRec(
  home: string,
  relDir: string,
  out: string[],
  depth: number,
): Promise<void> {
  if (depth > 8) return;
  let entries;
  try {
    entries = await readDir(path.join(home, relDir));
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory) await listFilesRec(home, rel, out, depth + 1);
    else out.push(rel);
  }
}

/** 独占目录里实际存在的全部文件(递归;目录本身是符号链接或不存在 → 空清单)。 */
export async function listOwnedDir(home: string, dirRel: string): Promise<string[]> {
  const rel = dirRel.replace(/\/$/, '');
  // 逐段确认没有符号链接中间段
  let cur = home;
  for (const seg of rel.split('/')) {
    cur = path.join(cur, seg);
    const st = await lstatOrNull(cur);
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) return [];
  }
  const out: string[] = [];
  await listFilesRec(home, rel, out, 0);
  return out.sort();
}

// ---------------------------------------------------------------------------
// 状态目录:登记表与残留事务
// ---------------------------------------------------------------------------

/** 状态目录路径中是否有符号链接段(有 → fail-closed,不读不写)。 */
export async function stateDirUnsafe(home: string): Promise<boolean> {
  let cur = home;
  for (const seg of STATE_SYNC_DIR.split('/')) {
    cur = path.join(cur, seg);
    const st = await lstatOrNull(cur);
    if (st === null) return false;
    if (st.isSymbolicLink() || !st.isDirectory()) return true;
  }
  return false;
}

export type LedgerRead =
  | { state: 'absent' }
  | { state: 'unsafe' }
  | { state: 'invalid'; text: string; sha256: string }
  | { state: 'ok'; ledger: SyncLedger; text: string; sha256: string };

export async function readLedger(home: string): Promise<LedgerRead> {
  if (await stateDirUnsafe(home)) return { state: 'unsafe' };
  const p = await probePath(home, LEDGER_REL);
  if (p.entry.kind === 'missing') return { state: 'absent' };
  if (p.entry.kind !== 'file' || p.text === undefined || p.entry.sha256 === undefined) {
    return { state: 'unsafe' };
  }
  try {
    const parsed = SyncLedgerSchema.safeParse(JSON.parse(p.text));
    if (parsed.success) {
      return { state: 'ok', ledger: parsed.data, text: p.text, sha256: p.entry.sha256 };
    }
  } catch {
    // 落到 invalid
  }
  return { state: 'invalid', text: p.text, sha256: p.entry.sha256 };
}

/** `txn/` 下残留的事务 id(升序)。目录不存在 → 空。 */
export async function listResidualTxns(home: string): Promise<string[]> {
  if (await stateDirUnsafe(home)) return [];
  let entries;
  try {
    entries = await readDir(path.join(home, TXN_DIR_REL));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith('.json')) continue;
    const id = e.name.slice(0, -'.json'.length);
    if (TXN_ID_RE.test(id)) ids.push(id);
  }
  return ids.sort();
}

/** `backups/` 下的事务 id(升序)。 */
export async function listBackupIds(home: string): Promise<string[]> {
  if (await stateDirUnsafe(home)) return [];
  let entries;
  try {
    entries = await readDir(path.join(home, BACKUPS_DIR_REL));
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory && TXN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------
// 整体快照
// ---------------------------------------------------------------------------

export interface SnapshotRequest {
  /** 已 realpath 的 HOME */
  home: string;
  /** 计划涉及的目标路径(HOME 相对);非法路径跳过(计划器会按 SYNC_WRITE_DENIED 拒绝) */
  paths: readonly string[];
  /** 每个路径上要解析的托管块 id */
  blockIds: Readonly<Record<string, readonly string[]>>;
  /** 登记表里的路径:条目目录里已有我们自己的文件时,不算「被别人占用」 */
  ledgerPaths: readonly string[];
  /** 独占目录(要列清单的) */
  ownedDirs: readonly string[];
}

export interface SnapshotResult {
  snapshot: DiskSnapshot;
  /** 路径 → 当前文本(仅 kind=file) */
  texts: ReadonlyMap<string, string>;
  /** 路径 → 权限位(仅 kind=file) */
  modes: ReadonlyMap<string, number>;
}

export async function buildDiskSnapshot(req: SnapshotRequest): Promise<SnapshotResult> {
  const entries: Record<string, DiskEntry> = {};
  const texts = new Map<string, string>();
  const modes = new Map<string, number>();
  const ledgerUnder = (dir: string): boolean =>
    req.ledgerPaths.some((p) => p.startsWith(`${dir}/`));
  for (const rel of [...new Set(req.paths)].sort()) {
    if (!RelPathSchema.safeParse(rel).success || !isHomeWritePath(rel, 'adapter')) continue;
    const ids = req.blockIds[rel];
    const probe = await probePath(req.home, rel, ids !== undefined ? { blockIds: ids } : {});
    const entry = probe.entry;
    if (entry.kind === 'missing' && entry.linkedSegment !== true) {
      const dir = entryDirOf(rel, req.ownedDirs);
      if (dir !== undefined && !ledgerUnder(dir)) {
        const st = await lstatOrNull(path.join(req.home, ...dir.split('/')));
        if (st !== null) entry.entryOccupied = true;
      }
    }
    entries[rel] = entry;
    if (probe.text !== undefined) texts.set(rel, probe.text);
    if (probe.mode !== undefined) modes.set(rel, probe.mode);
  }
  const ownedDirListings: Record<string, readonly string[]> = {};
  for (const d of req.ownedDirs) ownedDirListings[d] = await listOwnedDir(req.home, d);
  const residual = await listResidualTxns(req.home);
  return {
    snapshot: { entries, ownedDirListings, residualTxn: residual[0] ?? null },
    texts,
    modes,
  };
}
