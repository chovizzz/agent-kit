/**
 * 写命令的共用出口(只做输出与退出码;不含 I/O 之外的业务):稳定码行一律走 stderr(§20.3:信息行与失败码都在 stderr),
 * 人读摘要走 stdout 并过清洗与泄漏闸({@link say};禁止集合 = 装配给的额外值 + HOME / `KIT_TMP`)。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import { RSI_AUTO_PAUSE_REASONS, type RsiFailClosedReason } from '../../../contracts/rsi.js';
import { resolveIsTty } from '../../../commands/types.js';
import { emitLines, forbiddenPaths } from '../../output.js';
import type { RsiEarlyContext } from '../../types.js';
import { missingPorts, type WritePortName, type WritePorts } from './ports.js';

export const usage = (ctx: RsiEarlyContext, reason: string): number => {
  ctx.stderr(`RSI_USAGE reason=${reason}\n`);
  return ExitCode.USAGE;
};

export const failClosed = (ctx: RsiEarlyContext, reason: RsiFailClosedReason): number => {
  ctx.stderr(`RSI_FAIL_CLOSED reason=${reason}\n`);
  return ExitCode.FAIL_CLOSED;
};

export const notRun = (ctx: RsiEarlyContext, reason: string): number => {
  ctx.stderr(`RSI_NOT_RUN reason=${reason}\n`);
  return ExitCode.NOT_RUN;
};

export const isTty = (ctx: RsiEarlyContext): boolean => resolveIsTty(ctx);

/** 预检:缺任一必需端口 → 退 3 `internal`(不回显端口名;零写入)。通过 = `null` */
export function precheck(
  ctx: RsiEarlyContext,
  p: WritePorts,
  need: readonly WritePortName[],
): number | null {
  return missingPorts(p, need).length === 0 ? null : failClosed(ctx, 'internal');
}

/** 摘要行(stdout)过闸输出;过不了闸 = 退 3 `output_leak`,stdout 零字节 */
export async function say(
  ctx: RsiEarlyContext,
  p: WritePorts,
  lines: readonly string[],
): Promise<number> {
  const forbidden = await forbiddenPaths(ctx.env, p.outputForbidden ?? []);
  return emitLines(
    ctx,
    lines.map((head) => ({ head })),
    forbidden,
  );
}

/** 熔断码的稳定顺序(`RSI_AUTO_PAUSE_REASONS`) */
export const pauseOrder = <T extends string>(codes: Iterable<T>): T[] => {
  const set = new Set<string>(codes);
  return [...RSI_AUTO_PAUSE_REASONS.filter((c) => set.has(c))] as unknown as T[];
};

/** 确认提示(`rebase-baseline` 与 `rollback --to --write` 共用):精确输入 `yes` 才继续 */
export const CONFIRM_PROMPT_LINE = '输入 yes 确认,其它任何输入都会取消:';
