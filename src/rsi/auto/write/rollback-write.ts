/**
 * `rsi rollback --to <日期> --write`(contracts R21-12.7、§21.24 W0-22 第 4 条、W0-20):TTY + 三把锁(rsi → personal → sync)。
 * 顺序:参数(`unknown_arg` / `bad_date`,退 2;写模式不接受 `--json`)→ TTY(2)→ 预检(3,零写入)→ `[rsi]` 关闭退 4 `RSI_NOT_RUN reason=off` 并提示改用 `rsi auto clear` →
 * 取锁 → **持锁后**读权威记录并选取({@link selectRollbackTo}:严格大于;日期不可知候选**单列纳入**;记录自相矛盾 `invalid` → 退 3 `candidate_invalid`,在任何写入之前)→
 * 展示两节(计数分开,先于任何写入)→ 按**生效逆序**逐个 `startRollback(kind=rollback, reason=cleared, by=rollback_to, target=rolled_back, event=clear)`(在途 `rolling_back` 候选沿用其 journal)→
 * 日期不可知的候选排在其后(按 id)→ 归并退出码({@link mapClearExit})。权威记录读不出(deferred / invalid)→ 退 3 `personal_repo_invalid`。
 * 「TTY 确认」只要求 TTY 并展示两节,不另加 `yes` 输入(契约退出码表里该命令没有 decline 码;见状态文件「问题」)。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import { startRollback, type RollbackOutcome } from '../../personal/rollback.js';
import type { RsiEarlyContext } from '../../types.js';
import { parseRollbackToArgs } from '../read/rollback-dry.js';
import { selectRollbackTo, type RollbackCandidate } from '../select-rollback.js';
import { failClosed, isTty, notRun, precheck, say, usage } from './common.js';
import { RSI_ROLLBACK_TO_EVIDENCE } from './evidence.js';
import { emitOutcomes, flushPartial, outcomeCounts } from './outcome-output.js';
import { REQUIRED_PORTS, type WritePorts, type WritePortsGetter } from './ports.js';

const item = (c: RollbackCandidate): string =>
  `  id=${c.id} lifecycle=${c.lifecycle} entered_on=${c.entered_on ?? 'unknown'}`;

export async function runRollbackWrite(
  ctx: RsiEarlyContext,
  rest: readonly string[],
  getPorts: WritePortsGetter,
): Promise<number> {
  // 路由已确认含 `--write`;重复的 `--write` 是未知参数
  const w = rest.filter((x) => x === '--write').length;
  if (w !== 1) return usage(ctx, 'unknown_arg');
  const a = parseRollbackToArgs(rest.filter((x) => x !== '--write'));
  if (!a.ok) return usage(ctx, a.reason);
  if (a.json) return usage(ctx, 'unknown_arg');
  if (!isTty(ctx)) return usage(ctx, 'not_tty');
  const p = await getPorts();
  const bad = precheck(ctx, p, REQUIRED_PORTS['rollback --to']);
  if (bad !== null) return bad;
  if (!(await (p.config as NonNullable<WritePorts['config']>)()).rsiOn) {
    notRun(ctx, 'off');
    await say(ctx, p, ['提示:[rsi] 关闭时请改用 rsi auto clear(它不依赖 [rsi])']);
    return ExitCode.NOT_RUN;
  }
  const locks = p.locks as NonNullable<WritePorts['locks']>;
  const rollbackDeps = p.rollbackDeps as NonNullable<WritePorts['rollbackDeps']>;
  return locks.withLocks('rsi_personal_sync', async (held) => {
    const d = rollbackDeps(held);
    // 持锁后读权威记录再选取
    const all = await d.store.readAll();
    if (all.kind === 'deferred' || all.kind === 'invalid') {
      return failClosed(ctx, 'personal_repo_invalid');
    }
    const sel = selectRollbackTo(all.kind === 'ok' ? all.value : [], a.date);
    if (sel.invalid.length > 0) return failClosed(ctx, 'candidate_invalid');
    const shown = await say(ctx, p, [
      `将按生效逆序回滚 ${a.date} 之后(严格大于)进入 canary 的候选: ${sel.candidates.length}`,
      ...sel.candidates.map(item),
      `日期不可知,按保守方向纳入: ${sel.dateUnknown.length}`,
      ...sel.dateUnknown.map(item),
    ]);
    if (shown !== ExitCode.OK) return shown;
    const outcomes: RollbackOutcome[] = [];
    try {
      for (const c of [...sel.candidates, ...sel.dateUnknown]) {
        outcomes.push(
          await startRollback(d, {
            candidate_id: c.id,
            content_sha256: c.content_sha256,
            kind: 'rollback',
            reason: 'cleared',
            by: 'rollback_to',
            target_terminal: 'rolled_back',
            event: { kind: 'clear', evidence: RSI_ROLLBACK_TO_EVIDENCE },
          }),
        );
      }
    } catch (e) {
      flushPartial(ctx, outcomes);
      throw e;
    }
    return emitOutcomes(ctx, p, { outcomes }, [
      `rollback --to ${a.date}: 已处理 ${outcomes.length} 个候选(日期可知 ${sel.candidates.length},日期不可知 ${sel.dateUnknown.length})`,
      outcomeCounts(outcomes),
    ]);
  });
}
