/**
 * 暂存区回收的执行器(`reflect --gc`,契约 §17.7)。计划部分在只读模块 `gc-plan.ts`(A6 拆出,R20-17.18),此处 re-export 以保持既有 import 路径。
 * 删除只经 safe-fs 的 `remove`(写出口守卫),且在删之前对目录与内容再校验一遍。
 */
import * as path from 'node:path';
import { RunIdSchema } from '../contracts/common.js';
import type { IoContext } from '../io/paths.js';
import { lstat, realpath } from '../io/read-fs.js';
import { remove } from '../io/safe-fs.js';
import { planReflectGc, onlyReportJson, runDirOf, ReflectGcError, type GcPlan } from './gc-plan.js';
import type { BeforeWrite } from './types.js';

export {
  REFLECT_GC_RETENTION_DAYS,
  ReflectGcError,
  planReflectGc,
  type GcCandidate,
  type GcKeepReason,
  type GcKept,
  type GcPlan,
} from './gc-plan.js';

export interface GcResult extends GcPlan {
  readonly write: boolean;
  readonly deleted: readonly string[];
}

/** 干跑只出计划;`write` 才删。删除前对每个候选重新校验(目录仍是真实目录、内容仍恰好是 report.json、realpath 仍在暂存根下)。 */
export async function runReflectGc(
  io: IoContext,
  now: Date,
  opts: { write: boolean; beforeDelete?: BeforeWrite },
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
      await opts.beforeDelete?.(); // 每次实际删除前复核(rsi/lock);抛出的错误原样向上传播,不吞、不当成「跳过」
      await remove(io, dir);
      deleted.push(c.runId);
    }
  }
  return { ...plan, write: opts.write, deleted };
}
