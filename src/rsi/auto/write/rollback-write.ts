/**
 * `rsi rollback --to <日期> --write`(contracts R21-12.7、§21.24 W0-22 第 4 条、W0-20):TTY + 三把锁(rsi → personal → sync)。
 * 顺序:参数(`unknown_arg` / `bad_date`,退 2;写模式不接受 `--json`)→ TTY(2)→ 预检(3,零写入)→ `[rsi]` 关闭退 4 `RSI_NOT_RUN reason=off` 并提示改用 `rsi auto clear` →
 * **无锁预览**(`peekRecords`)选取({@link selectRollbackTo}:严格大于;日期不可知候选**单列纳入**;记录自相矛盾 `invalid` → 退 3 `candidate_invalid`,在任何写入之前)→ 展示两节(计数分开)→
 * 输入精确 `yes` 才继续(只去行尾 `\r`;EOF 算拒绝;拒绝退 1 `RSI_CONFIRM_DECLINED`,零写入、不取锁;没有任何候选则无可确认,退 0)→ 取锁 → **持锁后重读并重选**,与展示的有序 `(id, content_sha256)` 清单不同 →
 * 退 1 `RSI_CONFIRM_STALE`(零写入)→ 按**生效逆序**逐个 `startRollback(kind=rollback, reason=cleared, by=rollback_to, target=rolled_back, event=clear)`(在途 `rolling_back` 候选沿用其 journal)→
 * 日期不可知的候选排在其后(按 id)→ 归并退出码({@link mapClearExit})。权威记录读不出(deferred / invalid)→ 退 3 `personal_repo_invalid`。
 * 批量、对用户可见的操作,与 `rebase-baseline` 一致要求 `yes`(W0-25:`RSI_CONFIRM_DECLINED` / `RSI_CONFIRM_STALE` 退 1)。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import { resolveReadLine } from '../../../commands/types.js';
import { startRollback, type RollbackOutcome } from '../../personal/rollback.js';
import type { RsiEarlyContext } from '../../types.js';
import { parseRollbackToArgs } from '../read/rollback-dry.js';
import { selectRollbackTo, type RollbackCandidate } from '../select-rollback.js';
import { CONFIRM_PROMPT_LINE, failClosed, isTty, notRun, precheck, say, usage } from './common.js';
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
  const peek = p.peekRecords as NonNullable<WritePorts['peekRecords']>;

  // 无锁预览:展示两节清单(计数分开)并要求精确 `yes`;拒绝 / EOF 退 1,零写入、不取锁(与 `rebase-baseline` 同形)
  const pre = await peek();
  if (pre.kind === 'deferred' || pre.kind === 'invalid')
    return failClosed(ctx, 'personal_repo_invalid');
  const sel0 = selectRollbackTo(pre.kind === 'ok' ? pre.value : [], a.date);
  if (sel0.invalid.length > 0) return failClosed(ctx, 'candidate_invalid');
  const shown = await say(ctx, p, [
    `将按生效逆序回滚 ${a.date} 之后(严格大于)进入 canary 的候选: ${sel0.candidates.length}`,
    ...sel0.candidates.map(item),
    `日期不可知,按保守方向纳入: ${sel0.dateUnknown.length}`,
    ...sel0.dateUnknown.map(item),
    ...(sel0.candidates.length + sel0.dateUnknown.length > 0 ? [CONFIRM_PROMPT_LINE] : []),
  ]);
  if (shown !== ExitCode.OK) return shown;
  // 没有任何候选:没有可确认的动作,零写入退 0
  if (sel0.candidates.length + sel0.dateUnknown.length === 0) return ExitCode.OK;
  const raw = await resolveReadLine(ctx)();
  if (raw === undefined || raw.replace(/\r$/, '') !== 'yes') {
    ctx.stderr('RSI_CONFIRM_DECLINED\n');
    return ExitCode.CHECK_FAILED;
  }
  const key = (s: {
    candidates: RollbackCandidate[];
    dateUnknown: RollbackCandidate[];
  }): string[] => [...s.candidates, ...s.dateUnknown].map((c) => `${c.id}:${c.content_sha256}`);

  return locks.withLocks('rsi_personal_sync', async (held) => {
    const d = rollbackDeps(held);
    // 持锁后重读并重选:锁外那次与展示不作数;与展示的有序 `(id, content_sha256)` 清单不同 → `RSI_CONFIRM_STALE`(退 1,零写入)
    const all = await d.store.readAll();
    if (all.kind === 'deferred' || all.kind === 'invalid') {
      return failClosed(ctx, 'personal_repo_invalid');
    }
    const sel = selectRollbackTo(all.kind === 'ok' ? all.value : [], a.date);
    if (sel.invalid.length > 0) return failClosed(ctx, 'candidate_invalid');
    const shownKeys = key(sel0);
    const nowKeys = key(sel);
    if (shownKeys.length !== nowKeys.length || shownKeys.some((k, n) => k !== nowKeys[n])) {
      ctx.stderr('RSI_CONFIRM_STALE\n');
      return ExitCode.CHECK_FAILED;
    }
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
