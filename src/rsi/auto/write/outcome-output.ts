/**
 * 回滚类写命令(`auto clear --write` / `veto` / `rollback --to --write`)共用的结果输出:经 {@link mapClearExit} 按事务身份归并(先 journal 完整性分类、再归并;已完成的撤销先逐行输出),
 * 再输出处置文案。稳定码行(`RSI_CLEAR_DONE` / `RSI_MANUAL` / `RSI_FAIL_CLOSED` / `RSI_NOT_RUN`)一律 stderr,顺序 = 信息行在前、失败行在后;摘要走 stdout 过泄漏闸。
 */
import type { RollbackOutcome } from '../../personal/rollback.js';
import { mapClearExit, type ClearExitInput } from '../exit-map.js';
import { say } from './common.js';
import { INVALID_JOURNAL_LINE, MANUAL_DISPOSAL_LINES } from './stall-text.js';
import type { WritePorts } from './ports.js';
import type { RsiEarlyContext } from '../../types.js';

export async function emitOutcomes(
  ctx: RsiEarlyContext,
  p: WritePorts,
  input: ClearExitInput,
  headline: readonly string[],
  extra: { forceNonZero?: boolean } = {},
): Promise<number> {
  const r = mapClearExit(input);
  for (const l of r.info) ctx.stderr(`${l}\n`);
  for (const l of r.errors) ctx.stderr(`${l}\n`);
  // 处置文案只对「未解决」的身份给:取自归并结果本身(被同身份 complete 消除的失败不再出文案)
  const manual = r.info.some((l) => l.startsWith('RSI_MANUAL '));
  const invalid = r.errors.some((l) => l.endsWith('reason=txn_invalid'));
  const lines = [
    ...headline,
    ...(manual ? MANUAL_DISPOSAL_LINES : []),
    ...(invalid ? [INVALID_JOURNAL_LINE] : []),
  ];
  const shown = await say(ctx, p, lines);
  if (shown !== 0) return shown;
  return r.exit === 0 && extra.forceNonZero === true ? 1 : r.exit;
}

/** 已完成 / 未完成的计数摘要(只含枚举与计数) */
export function outcomeCounts(outcomes: readonly RollbackOutcome[]): string {
  const n = (s: RollbackOutcome['status']): number => outcomes.filter((o) => o.status === s).length;
  return `outcomes: complete=${n('complete')} revocation_complete=${n('revocation_complete')} incomplete=${n('incomplete')} refused=${n('refused')}`;
}

/** 中途异常(锁丢失 / 写失败等)时:已完成的撤销先逐行输出(`RSI_CLEAR_DONE`),调用方随后重抛,由入口映射退出码 */
export function flushPartial(ctx: RsiEarlyContext, outcomes: readonly RollbackOutcome[]): void {
  for (const l of mapClearExit({ outcomes }).info) ctx.stderr(`${l}\n`);
}
