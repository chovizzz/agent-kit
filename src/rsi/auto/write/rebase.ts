/**
 * `rsi auto rebase-baseline [--adopt-owner]`(contracts R21-12.5、R21-3.5 情形 ② / ④、R21-10.3、§21.24 W0-22):TTY + 三把锁(rsi → personal → sync)。
 * 只在**分叉**(情形 ②,无标志)或**换主**(情形 ④,必须 `--adopt-owner`)时可用,其余退 4 `RSI_NOT_RUN reason=not_diverged`(情形 ③ = 记录不可读 → 退 3 `personal_repo_invalid`)。
 * 流程:参数(2)→ TTY(2)→ 预检(3,零写入)→ `[rsi]` 关闭(4)→ 无锁只读判情形并展示 `记录..HEAD` 的相对路径清单(输出例外:清洗 + 泄漏闸 + `RSI_AUTO_LABEL`)→
 * 输入精确 `yes`(只去行尾 `\r`;EOF 算拒绝)才继续,否则退 1 `RSI_CONFIRM_DECLINED`、零写入 → 取锁 → **持锁后重判**(不再分叉 / 换主 → 退 4 `not_diverged`;HEAD 与展示时不同 → 退 1 `RSI_CONFIRM_STALE`,零写入)→
 * 改写 `head.json`(`baseline` 或 `owner`)→ 再清 `state.json.auto_pause` 里对应的 `diverged` / `owner_changed` 标志(先改记录后清标志:中途崩溃只会多停注入)。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import { RSI_AUTO_LABEL } from '../../../contracts/rsi.js';
import { resolveReadLine } from '../../../commands/types.js';
import { parseFlags } from '../../args.js';
import { emitLines, forbiddenPaths } from '../../output.js';
import { cleanPath } from '../../sanitize.js';
import type { RsiEarlyContext } from '../../types.js';
import { CONFIRM_PROMPT_LINE, failClosed, isTty, notRun, precheck, say, usage } from './common.js';
import {
  REQUIRED_PORTS,
  type RebaseSituation,
  type WritePorts,
  type WritePortsGetter,
} from './ports.js';

/** 清单最多展示的路径条数(其余只给计数) */
export const REBASE_LIST_MAX = 200;

type Verdict =
  { kind: 'baseline' | 'owner'; head: string } | { kind: 'not_diverged' } | { kind: 'invalid' };

function verdictOf(s: RebaseSituation, adopt: boolean): Verdict {
  if (s.kind === 'invalid') return { kind: 'invalid' };
  if (s.kind === 'diverged' && !adopt) return { kind: 'baseline', head: s.head };
  if (s.kind === 'owner_changed' && adopt) return { kind: 'owner', head: s.head };
  return { kind: 'not_diverged' };
}

export async function runRebase(
  ctx: RsiEarlyContext,
  rest: readonly string[],
  getPorts: WritePortsGetter,
): Promise<number> {
  const f = parseFlags(rest, ['--adopt-owner']);
  if (!f.ok) return usage(ctx, 'unknown_arg');
  const adopt = f.flags.has('--adopt-owner');
  if (!isTty(ctx)) return usage(ctx, 'not_tty');
  const p = await getPorts();
  const bad = precheck(ctx, p, REQUIRED_PORTS['auto rebase-baseline']);
  if (bad !== null) return bad;
  if (!(await (p.config as NonNullable<WritePorts['config']>)()).rsiOn) return notRun(ctx, 'off');
  const rb = p.rebase as NonNullable<WritePorts['rebase']>;
  const pauseState = p.pauseState as NonNullable<WritePorts['pauseState']>;
  const locks = p.locks as NonNullable<WritePorts['locks']>;

  const v0 = verdictOf(await rb.classify(), adopt);
  if (v0.kind === 'invalid') return failClosed(ctx, 'personal_repo_invalid');
  if (v0.kind === 'not_diverged') return notRun(ctx, 'not_diverged');

  // 展示:相对路径清单(清洗 + 泄漏闸 + 标签);整份先构造、过闸再一次性输出
  const paths = await rb.changedPaths();
  const shownPaths = paths.slice(0, REBASE_LIST_MAX).map((x) => `  ${cleanPath(x)}`);
  const forbidden = await forbiddenPaths(ctx.env, p.outputForbidden ?? []);
  const shown = emitLines(
    ctx,
    [
      RSI_AUTO_LABEL,
      `rebase-baseline: 将把${v0.kind === 'owner' ? ' owner_repo_fp 改为当前 [rsi] repo' : '当前 HEAD 记为新基线'}(head=${v0.head.slice(0, 12)})`,
      `记录..HEAD 的相对路径: ${paths.length} 个${paths.length > REBASE_LIST_MAX ? `(仅列前 ${REBASE_LIST_MAX} 个)` : ''}`,
      ...shownPaths,
      CONFIRM_PROMPT_LINE,
    ].map((head) => ({ head })),
    forbidden,
  );
  if (shown !== ExitCode.OK) return shown;

  const raw = await resolveReadLine(ctx)();
  if (raw === undefined || raw.replace(/\r$/, '') !== 'yes') {
    ctx.stderr('RSI_CONFIRM_DECLINED\n');
    return ExitCode.CHECK_FAILED;
  }

  return locks.withLocks('rsi_personal_sync', async () => {
    // 持锁后重判:锁外那次判定与展示不作数
    const v1 = verdictOf(await rb.classify(), adopt);
    if (v1.kind === 'invalid') return failClosed(ctx, 'personal_repo_invalid');
    if (v1.kind === 'not_diverged') return notRun(ctx, 'not_diverged');
    if (v1.kind !== v0.kind || v1.head !== v0.head) {
      ctx.stderr('RSI_CONFIRM_STALE\n');
      return ExitCode.CHECK_FAILED;
    }
    await rb.rewriteHead(v1.kind, v1.head);
    const st = await pauseState.read();
    if (v1.kind === 'baseline' && st.diverged) await pauseState.write({ ...st, diverged: false });
    if (v1.kind === 'owner' && st.owner_changed) {
      await pauseState.write({ ...st, owner_changed: false });
    }
    return say(ctx, p, [`rebase-baseline=done kind=${v1.kind} head=${v1.head.slice(0, 12)}`]);
  });
}
