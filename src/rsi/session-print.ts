/**
 * `agent-kit rsi session --print`(契约 §20.10 A5 行;R20-2.1、§20.16-1;A5)。
 *
 * 只打印一段可粘贴的 `[rsi.session]` 配置:**kit 不写用户配置**(R20-2.1),本命令不读不写任何文件、不建上下文、不看 `[rsi]` 状态(状态无关)。
 * 打印的值能过 `RsiSessionSchema`(测试对拍):`enabled = true`、三家 agent、`expires` = UTC 今天 + 30 天(R20-16.3 ④ 要求 ≤ 90 天)、`auto = "s1"`。
 * `agents` 必须是用户配置里 `[rsi] agents` 的子集(R20-16.3 ③),本命令不读配置,所以在注释里写明让用户自己删到合适的子集。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { RSI_AGENT_IDS, RSI_SESSION_MAX_DAYS, RsiSessionSchema } from '../contracts/rsi.js';
import type { RsiEarlyContext, RsiSubcommand } from './types.js';

/** 打印的有效期天数(≤ {@link RSI_SESSION_MAX_DAYS}) */
export const SESSION_PRINT_DAYS = 30;

export interface SessionPrintDeps {
  now?: () => Date;
}

/** 生成要打印的文本(纯函数;测试直接调用) */
export function sessionSnippet(now: Date): string {
  const expires = new Date(now.getTime() + SESSION_PRINT_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const agents = RSI_AGENT_IDS.map((a) => JSON.stringify(a)).join(', ');
  return [
    '# 把下面这段粘贴进 ~/.config/agent-kit/config.toml;agent-kit 不会替你写这个文件。',
    `# agents 须是 [rsi] agents 的子集(不需要的删掉);expires 须晚于今天、最多 ${RSI_SESSION_MAX_DAYS} 天;auto 目前只校验、不消费。`,
    '# 授权不是安全边界:它只决定 agent-kit 是否把脱敏摘录交给会话、是否接收会话交回的提案。',
    '[rsi.session]',
    'enabled = true',
    `agents = [${agents}]`,
    `expires = "${expires}"`,
    'auto = "s1"',
    '',
  ].join('\n');
}

/** 打印值的静态校验(测试用):返回 `RsiSessionSchema` 的解析结果 */
export function sessionSnippetValues(now: Date): unknown {
  const expires = new Date(now.getTime() + SESSION_PRINT_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return RsiSessionSchema.safeParse({
    enabled: true,
    agents: [...RSI_AGENT_IDS],
    expires,
    auto: 's1',
  });
}

export async function runSessionPrint(
  ctx: Pick<RsiEarlyContext, 'argv' | 'stdout' | 'stderr'>,
  deps: SessionPrintDeps = {},
): Promise<number> {
  if (ctx.argv.length !== 1 || ctx.argv[0] !== '--print') {
    ctx.stderr('RSI_USAGE reason=unknown_arg\n');
    return ExitCode.USAGE;
  }
  ctx.stdout(sessionSnippet((deps.now ?? ((): Date => new Date()))()));
  return ExitCode.OK;
}

export const subcommand: RsiSubcommand = {
  name: 'session',
  owner: 'A5',
  run: (ctx) => runSessionPrint(ctx),
};
