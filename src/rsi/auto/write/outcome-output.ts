/**
 * 回滚类写命令(`auto clear --write` / `veto` / `rollback --to --write`)共用的结果输出:经 {@link mapClearExit} 按事务身份归并(先 journal 完整性分类、再归并;已完成的撤销先逐行输出),
 * 再输出处置文案。稳定码行(`RSI_CLEAR_DONE` / `RSI_MANUAL` / `RSI_FAIL_CLOSED` / `RSI_NOT_RUN`)一律 stderr,顺序 = 信息行在前、失败行在后;摘要走 stdout 过泄漏闸。
 */
import type { RollbackOutcome } from '../../personal/rollback.js';
import { mapClearExit, type ClearExitInput } from '../exit-map.js';
import type { LayerRecord } from '../../personal/effects-layers.js';
import { say } from './common.js';
import { INVALID_JOURNAL_LINE, MANUAL_DISPOSAL_LINES } from './stall-text.js';
import type { WritePorts } from './ports.js';
import type { RsiEarlyContext } from '../../types.js';

const FAIL_REASONS: ReadonlySet<string> = new Set(['effects_full', 'audit_full', 'audit_invalid']);

const layerLine = (r: LayerRecord): string =>
  `RSI_EFFECTS_PENDING kind=${r.kind} id=${r.id ?? 'none'} authority=committed ledger=${r.ledger} audit=${r.audit}${r.cause !== undefined ? ` cause=${r.cause}` : ''}`;

/**
 * 三层结果的命令层组合(设计稿 v3 §D.2):**权威状态已先提交**(记录 / 凭据 / HOME;`authority` 来自执行器 / 引擎的结论,本函数只在它之后被调用),
 * 之后任一层有后继失败(账未提交 / 审计待补 / 封存拒绝)= 「已提交」信息行(`RSI_EFFECTS_PENDING`,stderr)+ 退 3(`RSI_FAIL_CLOSED reason=effects_full|audit_full|audit_invalid|internal`)。
 * 返回新的退出码;`exit === 4`(未取到锁,什么都没做)不升级。没有收集器(测试假件)= 原样返回。
 */
export function applyLayers(ctx: RsiEarlyContext, p: WritePorts, exit: number): number {
  const layers = p.layers;
  if (layers === undefined || exit === 4) return exit;
  const pending = layers.records.filter(
    (r) => r.ledger === 'not_committed' || r.audit === 'pending',
  );
  const sealed = layers.sealedEvents.length > 0;
  if (pending.length === 0 && !sealed) return exit;
  for (const r of pending) ctx.stderr(`${layerLine(r)}\n`);
  if (sealed) {
    ctx.stderr(
      'RSI_EFFECTS_PENDING kind=entry authority=committed ledger=not_applicable audit=not_applicable cause=sealed_interval\n',
    );
  }
  if (exit === 3) return 3;
  const first = pending.find((r) => r.reason !== undefined && FAIL_REASONS.has(r.reason));
  const reason = sealed ? 'audit_invalid' : (first?.reason ?? 'internal');
  ctx.stderr(`RSI_FAIL_CLOSED reason=${reason}\n`);
  return 3;
}

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
  return applyLayers(ctx, p, r.exit === 0 && extra.forceNonZero === true ? 1 : r.exit);
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
