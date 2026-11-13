/**
 * `rsi auto clear --write`(contracts R21-12.4、R21-9.5 缩减入口、§21.24 W0-22 第 3 条):TTY;**只拿 personal → sync 锁**(不取 `rsi/lock`);调 W7 的 `rsiAutoClear`。
 * `[rsi]` 合法关闭 / 仓库不可达时照常执行(缩减入口,**不走 off 短路**;配置不可信由装配在任何写入与输出之前 fail-closed 退 3,见状态文件「问题」)。
 * 退出码:{@link mapClearExit}(先 journal 完整性分类、再按事务身份 `(id, content_sha256)` 归并;「`resumeAll` 先拒绝、`startRollback` 后成功」同一身份才消除;已完成的撤销先逐行输出)。
 * 终态效果(「保留原保护」)由执行器在收尾按 `terminalEffectsOf` 算出并经缩减入口的带键出口落地(记为待对账,worker 续做):这里只负责把执行器的结果带到输出。
 */
import { parseFlags } from '../../args.js';
import type { RsiEarlyContext } from '../../types.js';
import { rsiAutoClear } from '../../personal/clear.js';
import { isTty, precheck, usage } from './common.js';
import { emitOutcomes, outcomeCounts } from './outcome-output.js';
import { REQUIRED_PORTS, type WritePorts, type WritePortsGetter } from './ports.js';

export async function runClearWrite(
  ctx: RsiEarlyContext,
  rest: readonly string[],
  getPorts: WritePortsGetter,
): Promise<number> {
  if (!parseFlags(rest, ['--write']).ok) return usage(ctx, 'unknown_arg');
  if (!isTty(ctx)) return usage(ctx, 'not_tty');
  const p = await getPorts();
  const bad = precheck(ctx, p, REQUIRED_PORTS['auto clear']);
  if (bad !== null) return bad;
  const locks = p.locks as NonNullable<WritePorts['locks']>;
  const clearDeps = p.clearDeps as NonNullable<WritePorts['clearDeps']>;
  const report = await locks.withLocks('personal_sync', (held) =>
    rsiAutoClear(clearDeps(held), { write: true }),
  );
  return emitOutcomes(
    ctx,
    p,
    {
      outcomes: report.outcomes,
      // 候选枚举不可用(含部分成功后):已成功的撤销照常先输出,整体按第 5 行退 3
      enumerationFailed: report.unavailable !== null,
    },
    [
      `clear: 非终态候选 ${report.candidates.length} 个,在途 journal ${report.inFlight.length} 个`,
      outcomeCounts(report.outcomes),
      ...(report.repoRemovalPending.length > 0
        ? [`repo_removal=deferred: ${report.repoRemovalPending.length}`]
        : []),
    ],
  );
}
