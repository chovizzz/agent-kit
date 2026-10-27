import { ExitCode } from '../contracts/exit-codes.js';
import { RSI_STUB_CODE } from '../contracts/rsi.js';
import type { RsiEarlyContext } from './types.js';

/** 命令桩:stderr 只有 `RSI_NOT_IMPLEMENTED subcommand=<规范名>\n`,stdout 为空,退出 64。规范名来自代码常量,不回显用户输入。 */
export function rsiStubExit(ctx: Pick<RsiEarlyContext, 'stderr'>, name: string): number {
  ctx.stderr(`${RSI_STUB_CODE} subcommand=${name}\n`);
  return ExitCode.NOT_IMPLEMENTED;
}
