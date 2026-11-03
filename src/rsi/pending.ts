/**
 * 暂存 / 待审 / 待通知三个集合的**唯一实现**(契约 R20-17.1–R20-17.4a、R20-17.14a;A6)。hint、status、提醒、`rsi dismiss`、doctor D17 都调用它。
 *
 * 只读闭包:只 import read-fs、契约、`lock-read.ts`(只读侧)与 `snapshot-read.ts` 的错误类型;**不含** safe-fs、hooks-fs、子进程
 * (`test/rsi/readonly-zero-write.test.ts` 的闭包审计覆盖 status 入口,本文件在其闭包内)。
 *
 * 集合:
 *  - 暂存 run(R20-17.1):`counts.staged` 里证据非空、全部归属「采集中」(P)、未 tainted 的 run(归属由调用方给的 `classify` 每次现算,R20-4.6);
 *  - 待审 run(R20-17.2):暂存 ∧ `report.json` 过 `ReflectRunReportSchema` ∧ `report.run_id` 等于目录名 ∧ 不在 `dismissed.json`;
 *  - 待通知 run(R20-17.3):待审 ∧ `report.mode = ingest` ∧ 不在 `notice.json` 的已通知集合。
 * 读取协议(R20-17.4):`reflect/` 直接子项至多 1000 个、名字升序;每个 `report.json` 经 `readFileSafe`(不跟随链接、普通文件、`nlink = 1`、≤ 1 MiB);
 * 单次扫描总读取 ≤ 16 MiB;超出一律返回 `known: false`,**不得当作零或空集合**(R20-17.4a)。错误只映射稳定原因,不记录原始异常文本。
 */
import * as path from 'node:path';
import { ReflectRunReportSchema } from '../contracts/reflect.js';
import {
  RSI_ACCOUNT_FILE_MAX_BYTES,
  RSI_NOTICE_MAX,
  RSI_SCAN_MAX_ENTRIES,
  RSI_SCAN_MAX_REPORT_BYTES,
  RSI_SCAN_MAX_TOTAL_BYTES,
  RsiDismissedSchema,
  RsiNoticeReadSchema,
  type RsiCounts,
} from '../contracts/rsi.js';
import { readDir, readFileSafe, statDirSafe } from '../io/read-fs.js';
import { RSI_FILE_OWNER } from './lock-read.js';
import { RsiSnapshotError } from './snapshot-read.js';

export type Classify = (key: string) => 'P' | 'X' | 'U';
type StagedEntry = RsiCounts['staged'][number];

export interface RunRef {
  readonly runId: string;
  readonly proposals: number;
}

export type ScanUnknownReason = 'run_scan_truncated' | 'run_scan_budget';

/** R20-17.4a 的扫描结果类型(`runDirs` / `dirNames` 为 A6 追加:run 上限判定与 `notice_full` 谓词要用) */
export type PendingScan =
  | {
      known: true;
      staged: readonly RunRef[];
      pending: readonly RunRef[];
      toNotify: readonly RunRef[];
      /** 暂存 run 里读不了 / schema 不过 / id 不符 / 目录不在的个数(不计入待审) */
      unreadable: number;
      /** `reflect/` 下非点开头的真实目录数(含全部 mode;R20-17.17 的 run 上限口径) */
      runDirs: number;
      dirNames: ReadonlySet<string>;
    }
  | { known: false; reason: ScanUnknownReason; runDirs: number };

// ---------------------------------------------------------------------------
// dismissed.json / notice.json 的只读读取
// ---------------------------------------------------------------------------
export interface DismissedRead {
  kind: 'absent' | 'invalid' | 'ok';
  ids: ReadonlySet<string>;
  runs: readonly { run_id: string; at: string }[];
}

/** 读取形状(条数可超过写出上限) */
export interface NoticeDoc {
  schema_version: 1;
  proposals_notified: string[];
  collection_started_for: string | null;
}
export type NoticeRead =
  { kind: 'absent' | 'invalid'; notice: null } | { kind: 'ok'; notice: NoticeDoc };

const EMPTY: ReadonlySet<string> = new Set();

async function readAccountFile(rsiDir: string | null, name: string): Promise<unknown> {
  if (rsiDir === null) return undefined;
  const r = await readFileSafe(path.join(rsiDir, name), {
    maxBytes: RSI_ACCOUNT_FILE_MAX_BYTES,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind === 'missing') return undefined;
  if (r.kind === 'unsafe') return null; // 不安全 / 过大 / 权限过宽 = 损坏
  try {
    return JSON.parse(r.bytes.toString('utf8'));
  } catch {
    return null;
  }
}

/** `.state/rsi/dismissed.json`:损坏(非普通文件、权限过宽、schema 不过)→ `invalid`,调用方只读路径按「无已忽略」、写路径退 3 */
export async function readDismissed(rsiDir: string | null): Promise<DismissedRead> {
  const raw = await readAccountFile(rsiDir, 'dismissed.json');
  if (raw === undefined) return { kind: 'absent', ids: EMPTY, runs: [] };
  const p = RsiDismissedSchema.safeParse(raw);
  if (!p.success) return { kind: 'invalid', ids: EMPTY, runs: [] };
  return { kind: 'ok', ids: new Set(p.data.runs.map((r) => r.run_id)), runs: p.data.runs };
}

/** `.state/rsi/notice.json`:读取形状放宽条数(清理后才收紧到 ≤ 1000,R20-17.14a);损坏 → `invalid`(不覆盖、不重建) */
export async function readNotice(rsiDir: string | null): Promise<NoticeRead> {
  const raw = await readAccountFile(rsiDir, 'notice.json');
  if (raw === undefined) return { kind: 'absent', notice: null };
  const p = RsiNoticeReadSchema.safeParse(raw);
  if (!p.success) return { kind: 'invalid', notice: null };
  return { kind: 'ok', notice: p.data };
}

/**
 * `notice_full` 的**唯一谓词**(R20-17.14a):S = `proposals_notified` 中目录仍存在的 run_id,T = 本次待通知集合;
 * 成立当且仅当 |S ∪ T| > 1000。原文件超过 1000 条但清理后不超过、或恰好 1000 且 T 为空,都不是 full。
 */
export function noticeFull(
  notified: readonly string[],
  dirNames: ReadonlySet<string>,
  toNotify: readonly RunRef[],
): boolean {
  const union = new Set<string>(notified.filter((id) => dirNames.has(id)));
  for (const r of toNotify) union.add(r.runId);
  return union.size > RSI_NOTICE_MAX;
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------
export interface ScanInput {
  /** `<repo>/.state`(`reflect/` 的父目录) */
  stateDir: string;
  /** `counts.json` 的 `staged`(`counts` 缺失 = 空) */
  staged: readonly StagedEntry[];
  /** 归属分类器(每次调用现算;不在索引里的 key 一律 U) */
  classify: Classify;
  dismissed: ReadonlySet<string>;
  /** 已通知集合;`null` = 调用方不需要待通知集合(hint / dismiss 不读 notice.json) */
  notified: ReadonlySet<string> | null;
}

export interface ScanDeps {
  /** 每读完一个文件检查一次(提醒的 200ms 预算);为真 → 放弃,返回 `run_scan_budget` */
  over?: () => boolean;
  /** 测试缝:覆盖上限 */
  limits?: { maxEntries?: number; maxTotalBytes?: number; maxReportBytes?: number };
}

/** 暂存 run(R20-17.1):未 tainted、证据非空、全部归属 P */
export function stagedRuns(staged: readonly StagedEntry[], classify: Classify): RunRef[] {
  const out: RunRef[] = [];
  for (const s of staged) {
    if (s.tainted) continue;
    if (s.evidence_keys.length > 0 && s.evidence_keys.every((k) => classify(k) === 'P')) {
      out.push({ runId: s.run_id, proposals: s.proposals });
    }
  }
  return out.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

export async function scanPending(input: ScanInput, deps: ScanDeps = {}): Promise<PendingScan> {
  const maxEntries = deps.limits?.maxEntries ?? RSI_SCAN_MAX_ENTRIES;
  const maxTotal = deps.limits?.maxTotalBytes ?? RSI_SCAN_MAX_TOTAL_BYTES;
  const maxReport = deps.limits?.maxReportBytes ?? RSI_SCAN_MAX_REPORT_BYTES;
  const reflect = path.join(input.stateDir, 'reflect');
  const d = await statDirSafe(reflect);
  if (d.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  const entries = d.kind === 'missing' ? [] : await readDir(reflect);
  const isRunDir = (e: (typeof entries)[number]): boolean =>
    e.isDirectory && !e.isSymbolicLink && !e.name.startsWith('.');
  const runDirs = entries.filter(isRunDir).length;
  if (entries.length > maxEntries) return { known: false, reason: 'run_scan_truncated', runDirs };
  const byName = new Map(entries.map((e) => [e.name, e]));
  // R20-17.14a 的 S 只认「目录仍存在」的 run:同名普通文件 / 符号链接 / 点开头临时项不算(与 runDirs 同口径)
  const dirNames = new Set(entries.filter(isRunDir).map((e) => e.name));
  const staged = stagedRuns(input.staged, input.classify);
  const pending: RunRef[] = [];
  const toNotify: RunRef[] = [];
  let unreadable = 0;
  let total = 0;
  for (const run of staged) {
    const ent = byName.get(run.runId);
    if (ent === undefined || !ent.isDirectory || ent.isSymbolicLink) {
      unreadable++;
      continue;
    }
    const r = await readFileSafe(path.join(reflect, run.runId, 'report.json'), {
      maxBytes: maxReport,
    });
    if (r.kind === 'ok') total += r.bytes.length;
    if (total > maxTotal) return { known: false, reason: 'run_scan_budget', runDirs };
    if (deps.over?.() === true) return { known: false, reason: 'run_scan_budget', runDirs };
    if (r.kind !== 'ok') {
      unreadable++;
      continue;
    }
    let mode: string | null = null;
    try {
      const p = ReflectRunReportSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
      if (p.success && p.data.run_id === run.runId) mode = p.data.mode;
    } catch {
      mode = null;
    }
    if (mode === null) {
      unreadable++;
      continue;
    }
    if (input.dismissed.has(run.runId)) continue;
    pending.push(run);
    if (mode === 'ingest' && input.notified !== null && !input.notified.has(run.runId)) {
      toNotify.push(run);
    }
  }
  return { known: true, staged, pending, toNotify, unreadable, runDirs, dirNames };
}
