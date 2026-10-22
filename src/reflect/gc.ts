/**
 * 暂存区回收(`reflect --gc`,契约 §17.7):只清「已过期且无引用」的 run,fail-closed。
 *
 * 一个 run 目录 `.state/reflect/<run_id>/` 只有同时满足下列全部条件才进删除候选;任何一项无法判定 → 保留:
 *   1. 目录名通过 `RunIdSchema` 且不含 `..`;是真实目录(lstat,非符号链接);
 *   2. 目录内容**恰好**是一个普通文件 `report.json`(非符号链接、nlink=1)。没有 `proposals/`、`rules/`、`apply.patch`
 *      就意味着:没有暂存提案(也就没有 judge 状态、没有尚未 apply 的提案)、不占任何提案编号;
 *   3. `report.json` 通过 `ReflectRunReportSchema`,`run_id` 与目录名一致,`staged` 为空;
 *   4. 过期:`run_id` 里的 UTC 时间戳(`run-YYYYMMDDTHHMMSSZ-…`)距今 ≥ 保留期(固定 30 天);时间戳解析不了或晚于现在 → 保留;
 *   5. 无引用:仓库 `proposals/*.yaml` 的文本、`lifecycle/**` 的文件名与文本都不含该 run_id。
 *
 * 已用编号的保全:`loadUsedProposalIds` 只从 `proposals/` 目录(仓库与各 run)取编号。候选 run 按条件 2 不含 `proposals/`,
 * 所以删除它们**不可能**释放任何编号;含 `proposals/` 的 run(无论是否过期)一律保留。因此不需要墓碑/高水位记录。
 * 删除只经 safe-fs 的 `remove`(写出口守卫),且在删之前对目录与内容再校验一遍。
 */
import * as path from 'node:path';
import { RunIdSchema } from '../contracts/common.js';
import { ReflectRunReportSchema } from '../contracts/reflect.js';
import type { IoContext } from '../io/paths.js';
import { exists, lstat, readDir, readText, realpath } from '../io/read-fs.js';
import { remove } from '../io/safe-fs.js';

/** 保留期(天),固定值;契约 §17.7。 */
export const REFLECT_GC_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const STAMP_RE = /^run-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/;

export type GcKeepReason =
  | 'not_expired'
  | 'bad_run_id'
  | 'not_real_dir'
  | 'has_other_content'
  | 'report_missing'
  | 'report_invalid'
  | 'report_run_id_mismatch'
  | 'report_has_staged'
  | 'stamp_unparseable'
  | 'stamp_in_future'
  | 'referenced';

export interface GcCandidate {
  readonly runId: string;
  readonly reason: 'expired_unreferenced';
  readonly bytes: number;
}
export interface GcKept {
  readonly runId: string;
  readonly reason: GcKeepReason;
}
export interface GcPlan {
  readonly retentionDays: number;
  readonly scanned: number;
  readonly candidates: readonly GcCandidate[];
  readonly kept: readonly GcKept[];
}
export interface GcResult extends GcPlan {
  readonly write: boolean;
  readonly deleted: readonly string[];
}

/** gc 自身的失败(扫描引用失败、根目录是符号链接、删除前复核不过、写出口拒绝以外的异常);命令层映射退出 3。 */
export class ReflectGcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function stampOf(runId: string): number | 'unparseable' {
  const m = STAMP_RE.exec(runId);
  if (m === null) return 'unparseable';
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  // 往返比对:拒绝 20261340 这类被 Date.UTC 悄悄进位的值
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi ||
    back.getUTCSeconds() !== s
  )
    return 'unparseable';
  return t;
}

/** 收集所有「可能引用某个 run_id」的文本:仓库 proposals/*.yaml 与 lifecycle/** 的文件名和内容。扫描失败 → 抛错(整体不删)。 */
async function referenceCorpus(io: IoContext): Promise<string[]> {
  const out: string[] = [];
  const scanFail = (m: string): never => {
    throw new ReflectGcError('GC_REFERENCE_SCAN_FAILED', m);
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    // 入口与每层目录都先 lstat:只有明确的 ENOENT 算「不存在」;符号链接、非目录、其它错误一律中止
    let st;
    try {
      st = await lstat(dir);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return;
      return scanFail('引用目录无法读取');
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return scanFail('引用目录不是真实目录');
    if (depth > 4) return scanFail('目录过深');
    for (const e of await readDir(dir)) {
      const p = path.join(dir, e.name);
      out.push(e.name);
      if (e.isDirectory) await walk(p, depth + 1);
      else if (e.isFile) out.push(await readText(p));
      else scanFail('引用目录里有非常规条目');
    }
  };
  try {
    await walk(path.join(io.repoRoot, 'proposals'), 0);
    await walk(path.join(io.repoRoot, 'lifecycle'), 0);
  } catch (e) {
    if (e instanceof ReflectGcError) throw e;
    throw new ReflectGcError('GC_REFERENCE_SCAN_FAILED', '读取引用来源失败');
  }
  return out;
}

async function onlyReportJson(
  dir: string,
): Promise<{ ok: boolean; bytes: number; missing: boolean }> {
  const entries = await readDir(dir);
  if (entries.length === 0) return { ok: false, bytes: 0, missing: true };
  const report = entries.find((e) => e.name === 'report.json');
  if (report === undefined) return { ok: false, bytes: 0, missing: true };
  if (entries.length !== 1 || !report.isFile || report.isSymbolicLink) {
    return { ok: false, bytes: 0, missing: false };
  }
  const st = await lstat(path.join(dir, 'report.json'));
  if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1)
    return { ok: false, bytes: 0, missing: false };
  return { ok: true, bytes: st.size, missing: false };
}

function runDirOf(io: IoContext, runId: string): string {
  return path.join(io.stateDir, 'reflect', runId);
}

async function assertReflectRoot(io: IoContext): Promise<string | undefined> {
  const root = path.join(io.stateDir, 'reflect');
  let st;
  try {
    st = await lstat(root);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return undefined; // 不存在 = 没有可回收的东西
    throw new ReflectGcError('GC_ROOT_UNREADABLE', '暂存根无法读取');
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new ReflectGcError('GC_ROOT_NOT_REAL_DIR', '暂存根不是真实目录');
  }
  return root;
}

export async function planReflectGc(io: IoContext, now: Date): Promise<GcPlan> {
  const root = await assertReflectRoot(io);
  if (root === undefined) {
    return { retentionDays: REFLECT_GC_RETENTION_DAYS, scanned: 0, candidates: [], kept: [] };
  }
  const corpus = await referenceCorpus(io);
  const candidates: GcCandidate[] = [];
  const kept: GcKept[] = [];
  let scanned = 0;
  for (const e of await readDir(root)) {
    // 点开头(.tmp-*)与 llm-exec 的固定 cwd 不是 run,不扫也不报
    if (e.name.startsWith('.') || e.name.toLowerCase() === 'cwd') continue;
    scanned++;
    const keep = (reason: GcKeepReason): void => {
      kept.push({ runId: e.name, reason });
    };
    if (!RunIdSchema.safeParse(e.name).success || e.name.includes('..')) {
      keep('bad_run_id');
      continue;
    }
    if (!e.isDirectory || e.isSymbolicLink) {
      keep('not_real_dir');
      continue;
    }
    const dir = runDirOf(io, e.name);
    const content = await onlyReportJson(dir).catch(() => undefined);
    if (content === undefined) {
      keep('not_real_dir');
      continue;
    }
    if (!content.ok) {
      keep(content.missing ? 'report_missing' : 'has_other_content');
      continue;
    }
    let report;
    try {
      report = ReflectRunReportSchema.safeParse(
        JSON.parse(await readText(path.join(dir, 'report.json'))),
      );
    } catch {
      keep('report_invalid');
      continue;
    }
    if (!report.success) {
      keep('report_invalid');
      continue;
    }
    if (report.data.run_id !== e.name) {
      keep('report_run_id_mismatch');
      continue;
    }
    if (report.data.staged.length > 0) {
      keep('report_has_staged');
      continue;
    }
    const stamp = stampOf(e.name);
    if (stamp === 'unparseable') {
      keep('stamp_unparseable');
      continue;
    }
    const age = now.getTime() - stamp;
    if (age < 0) {
      keep('stamp_in_future');
      continue;
    }
    if (age < REFLECT_GC_RETENTION_DAYS * DAY_MS) {
      keep('not_expired');
      continue;
    }
    if (corpus.some((t) => t.includes(e.name))) {
      keep('referenced');
      continue;
    }
    candidates.push({ runId: e.name, reason: 'expired_unreferenced', bytes: content.bytes });
  }
  return { retentionDays: REFLECT_GC_RETENTION_DAYS, scanned, candidates, kept };
}

/** 干跑只出计划;`write` 才删。删除前对每个候选重新校验(目录仍是真实目录、内容仍恰好是 report.json、realpath 仍在暂存根下)。 */
export async function runReflectGc(
  io: IoContext,
  now: Date,
  opts: { write: boolean },
): Promise<GcResult> {
  let plan = await planReflectGc(io, now);
  const deleted: string[] = [];
  if (opts.write && plan.candidates.length > 0) {
    // 删之前整体重判一遍(引用、报告、过期全部重算),只留两次都判为候选的;缩小窗口,不是锁(见契约 §17.7「并发」)
    const again = new Set((await planReflectGc(io, now)).candidates.map((c) => c.runId));
    plan = { ...plan, candidates: plan.candidates.filter((c) => again.has(c.runId)) };
    const root = await realpath(path.join(io.stateDir, 'reflect'));
    for (const c of plan.candidates) {
      if (
        !RunIdSchema.safeParse(c.runId).success ||
        c.runId.includes('..') ||
        /[\\/]/.test(c.runId)
      ) {
        throw new ReflectGcError('GC_RUN_ID_INVALID', 'run_id 不合法');
      }
      const dir = runDirOf(io, c.runId);
      const st = await lstat(dir).catch(() => undefined);
      if (st === undefined) continue; // 已被别处删掉
      if (!st.isDirectory() || st.isSymbolicLink()) {
        throw new ReflectGcError('GC_RECHECK_FAILED', '删除前复核:不是真实目录');
      }
      if (path.dirname(await realpath(dir)) !== root) {
        throw new ReflectGcError('GC_RECHECK_FAILED', '删除前复核:目录不在暂存根下');
      }
      if (!(await onlyReportJson(dir)).ok) {
        throw new ReflectGcError('GC_RECHECK_FAILED', '删除前复核:目录内容已变');
      }
      await remove(io, dir);
      deleted.push(c.runId);
    }
  }
  return { ...plan, write: opts.write, deleted };
}
