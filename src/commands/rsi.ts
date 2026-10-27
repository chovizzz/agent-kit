/**
 * `agent-kit rsi <子命令>`(docs/contracts.md §20.3;R20-A2 B3-0:分发器与命令桩)。
 *
 * - 经 `CommandDef.runEarly` 分发:`main()` 在创建通用 `IoContext` **之前**调用本命令(v2 §5),所以一个对 rsi 无效的 `KIT_STATE_DIR`
 *   不会让 rsi 在到达自己的逻辑前失败。分发器**只**做子命令解析,不读配置、不建上下文、不碰文件系统。
 * - 无子命令 / 未知子命令 → 退出 2,stderr 只有 `RSI_USAGE reason=unknown_subcommand`(不回显输入)。
 * - P0 子命令各一个入口文件 `src/rsi/<name>.ts`(理由:`test/rsi/import-closure.test.ts` 的真实入口候选表已按这些路径登记,文件一建出就自动纳入
 *   「入口闭包不含 llm-exec / reflect 后端 / net / 启动器」断言)。P1 预留子命令(digest / session / hooks / dismiss / should-continue)不建文件,在这里退 64。
 * - 目前全部是桩:退出 64,stderr 只有 `RSI_NOT_IMPLEMENTED subcommand=<规范名>`,stdout 为空。多余参数不影响(桩不解析参数)。
 * - R20-A2 B5-0:两个会写盘的变体要放进独立入口文件(`status.ts` / `projects.ts` 属只读闭包),分发器按 argv 里**精确 token** 路由({@link routeRsi}):
 *   `status` 带 `--ack` → `status-ack.ts`;`projects` **同时**带 `--rebuild-index` 与 `--write` → `projects-rebuild.ts`。路由是纯函数,只看 token 在不在,
 *   不解析、不校验其它参数(合法性由目标入口自己的 `parseFlags` 判);只带 `--rebuild-index`(干跑)仍走 `projects.ts`。
 * - 上下文选择与调用顺序见 `src/rsi/types.ts` 头注释。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { RSI_P1_RESERVED_SUBCOMMANDS } from '../contracts/rsi.js';
import { subcommand as confirm } from '../rsi/confirm.js';
import { subcommand as hint } from '../rsi/hint.js';
import { subcommand as poke } from '../rsi/poke.js';
import { subcommand as projects } from '../rsi/projects.js';
import { subcommand as projectsRebuild } from '../rsi/projects-rebuild.js';
import { subcommand as purge } from '../rsi/purge.js';
import { subcommand as status } from '../rsi/status.js';
import { subcommand as statusAck } from '../rsi/status-ack.js';
import { subcommand as stop } from '../rsi/stop.js';
import { rsiStubExit } from '../rsi/stub.js';
import { subcommand as tick } from '../rsi/tick.js';
import type { RsiSubcommand } from '../rsi/types.js';
import type { CommandDef, EarlyCommandContext } from './types.js';

export const RSI_SUBCOMMAND_TABLE: readonly RsiSubcommand[] = [
  tick,
  status,
  projects,
  confirm,
  stop,
  purge,
  poke,
  hint,
];

/**
 * 子命令路由(纯函数:只看子命令名与 argv 里有没有精确 token;不读配置、不碰文件系统)。
 * 不认识的名字返回 `undefined`(由调用方按 P1 预留 / 未知处理)。`rest` 是子命令名之后的全部参数。
 */
export function routeRsi(
  name: string | undefined,
  rest: readonly string[],
): RsiSubcommand | undefined {
  if (name === 'status' && rest.includes('--ack')) return statusAck;
  if (name === 'projects' && rest.includes('--rebuild-index') && rest.includes('--write')) {
    return projectsRebuild;
  }
  return RSI_SUBCOMMAND_TABLE.find((s) => s.name === name);
}

export async function runRsi(ctx: EarlyCommandContext): Promise<number> {
  const name = ctx.argv[0];
  const rest = ctx.argv.slice(1);
  const sub = routeRsi(name, rest);
  if (sub !== undefined) return sub.run({ ...ctx, argv: rest });
  const reserved = RSI_P1_RESERVED_SUBCOMMANDS.find((n) => n === name);
  if (reserved !== undefined) return rsiStubExit(ctx, reserved);
  ctx.stderr('RSI_USAGE reason=unknown_subcommand\n');
  return ExitCode.USAGE;
}

export const command: CommandDef = {
  name: 'rsi',
  summary:
    '自动 RSI 的前台入口与状态(tick / status / projects / confirm / stop / purge;当前为命令桩)',
  phase: 'P0',
  ownerBlock: 'R20-A2 B3',
  run: () => {
    throw new Error('rsi 经 runEarly 分发(在通用 IoContext 之前),不应调用 run');
  },
  runEarly: runRsi,
};
