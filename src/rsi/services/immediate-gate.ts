/**
 * 暂存区即时闸(契约 R20-4.8、R20-5.1;v2 §1 / §6;R20-A2 B3c)。B3b 在 judge / promote 的接线里调用。
 *
 * 每次调用**现算、不缓存**:重读 `[rsi]` 配置(来源取 `io.hostEnv.HOME`,不用 `ctx.config` 的快照)、重读索引 / counts / 信号库 / 标记。
 * 判定顺序:
 *  0. `runId` 过冻结的 `RunIdSchema`,否则 `fail_closed internal`(调用方 bug,不拼路径);
 *  1. 配置 → `privacyGate`:`legacyAllowed`(没有 `[rsi]` / 未启用)→ `allow`,不读任何东西;`deny`(`cfg_*` / `repo_invalid` / `overlay_invalid` / `exclude_invalid`)→
 *     `fail_closed(reason)`;`enforce` → 继续。**`cfg_*` 绝不当 legacy 放行**;
 *  2. `TAINTED` 存在(任何类型都算)→ `tainted(reason)`,标记读不出 reason 按 `exclude`;
 *  3. purge journal:present → `fail_closed purge_incomplete`;invalid → `journal_invalid`;unreadable → `purge_incomplete`;
 *  4. 归属:run 的证据 sig 经信号库映射到 key,X > U > P。任一 X → `tainted(exclude)`(不必等 taint 落盘);任一 U(索引缺失 / 损坏、盐不符、key 不在索引、
 *     sig 映射不到、暂存文件读不出 / 无法解析、最近根路径变了)→ `attribution_unknown`;信号库损坏 → `fail_closed signal_store_corrupt`。
 *     run 目录不存在 = 没有证据 = `allow`(调用方自己报「找不到」)。
 * 偏离契约 4.8 的 1-2-3 序:journal(契约第 3 条)放在归属(第 2 条)之前——purge 进行中信号库与索引正被改写,此时的映射不可信。
 * 两者都是非 `allow`,只影响码(`purge_incomplete` 退 3 而不是 `RSI_RUN_TAINTED` 退 1)。
 * 非 `allow` 必须短路(不外发 / 不落盘 / 不打印)由调用方负责;`judgeGateCallbacks` 的三个回调各自现算,不记忆上一次的结果。
 */
import { RunIdSchema } from '../../contracts/common.js';
import { loadRsiConfig } from '../config.js';
import { privacyGate } from '../gate.js';
import {
  RsiFailClosedError,
  type ImmediateGateCheck,
  type ImmediateGateResult,
  type ImmediateGateScope,
  type JudgeGateCallbacks,
  type RsiServiceCtx,
} from '../types.js';
import { classifierFor, loadSigKeys } from './attribution.js';
import { readMark, readRunEvidence } from './staging.js';
import { detectPurgeJournal } from './taint.js';

export type { ImmediateGateResult, ImmediateGateScope, JudgeGateCallbacks };

const failClosed = (
  reason: Extract<ImmediateGateResult, { kind: 'fail_closed' }>['reason'],
): ImmediateGateResult => ({ kind: 'fail_closed', code: 'RSI_FAIL_CLOSED', reason, exit: 3 });

/**
 * 读暂存区之前(以及外发 / 落盘 / 输出之前)的检查:`TAINTED`、证据归属 X / U、purge journal、配置不可用。每次调用现算,不缓存。
 * 非 `allow` 的结果必须短路(见 `ImmediateGateResult`)。
 */
export async function immediateGate(
  ctx: RsiServiceCtx,
  scope: ImmediateGateScope,
): Promise<ImmediateGateResult> {
  if (!RunIdSchema.safeParse(scope.runId).success || scope.runId === 'cwd')
    return failClosed('internal');
  try {
    return await evaluate(ctx, scope);
  } catch (e) {
    if (e instanceof RsiFailClosedError) return failClosed(e.reason);
    throw e;
  }
}

async function evaluate(
  ctx: RsiServiceCtx,
  scope: ImmediateGateScope,
): Promise<ImmediateGateResult> {
  const cfg = await loadRsiConfig({ home: ctx.io.hostEnv['HOME'] });
  const gate = privacyGate(cfg);
  if (gate.kind === 'legacyAllowed') return { kind: 'allow' };
  if (gate.kind === 'deny') return failClosed(gate.reason);
  if (cfg.status !== 'on') return failClosed('internal'); // enforce 只会来自 on;防御

  const mark = await readMark(ctx.io, 'run', scope.runId);
  if (mark.present) {
    return {
      kind: 'tainted',
      code: 'RSI_RUN_TAINTED',
      runId: scope.runId,
      reason: mark.reason,
      exit: 1,
    };
  }

  const journal = await detectPurgeJournal(ctx);
  if (journal.state === 'present' || journal.state === 'unreadable')
    return failClosed('purge_incomplete');
  if (journal.state === 'invalid') return failClosed('journal_invalid');

  const ev = await readRunEvidence(ctx.io, scope.runId);
  if (!ev.exists) return { kind: 'allow' };
  const keys = await loadSigKeys(ctx.io, ev.sigs);
  const classify = await classifierFor(ctx.io, cfg);
  let unknown = ev.unknown;
  for (const sig of [...ev.sigs].sort()) {
    const key = keys.get(sig);
    if (key === undefined) {
      unknown = true;
      continue;
    }
    const cls = await classify(key);
    if (cls === 'X') {
      return {
        kind: 'tainted',
        code: 'RSI_RUN_TAINTED',
        runId: scope.runId,
        reason: 'exclude',
        exit: 1,
      };
    }
    if (cls === 'U') unknown = true;
  }
  return unknown
    ? {
        kind: 'attribution_unknown',
        code: 'RSI_RUN_ATTRIBUTION_UNKNOWN',
        runId: scope.runId,
        exit: 1,
      }
    : { kind: 'allow' };
}

/** 把 {@link immediateGate} 绑定到一个 scope,得到 judge 服务要的三个回调(三个回调各自现算,无共享状态)。 */
export function judgeGateCallbacks(
  ctx: RsiServiceCtx,
  scope: ImmediateGateScope,
): JudgeGateCallbacks {
  const check = (): ImmediateGateCheck => (): Promise<ImmediateGateResult> =>
    immediateGate(ctx, scope);
  return {
    beforeExternalCall: check(),
    beforePersist: check(),
    beforeOutput: check(),
  };
}

export type { ImmediateGateCheck };
