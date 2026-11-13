/**
 * 命令面入口(`rsi auto <status|pause|resume|clear|rebase-baseline>` / `rsi veto` / `rsi rollback --to` / `rsi report` / `rsi show`;contracts R21-12)。
 * 顺序:二级路由({@link routeAuto};缺失 / 未知的二级命令退 2 `unknown_subcommand`,不回显输入)→ **能力闸**(`RSI_AUTO_SUBCOMMAND_CAPS` + `capabilityAvailable(cap, phase)`:
 * 能力未到期 → 命令桩,退 64 `RSI_NOT_IMPLEMENTED subcommand=<规范名>`,**不解析参数、不读任何东西**)→ 分流:
 *   - 只读(`auto status` / `report` / `show` / `auto clear` 干跑 / `rollback --to` 干跑):处理函数在 `read/`,依赖注入的端口(相位 / 时钟 / TTY 也是注入),零写入;
 *   - 写(`pause` / `resume` / `clear --write` / `rebase-baseline` / `veto` / `rollback --write`):W8a 只注册路由,接到「未实现」桩({@link AutoEntryDeps.write} 是 W8b 替换处理函数的缝),
 *     路由、参数分流与能力闸已一次做全。
 * 相位当前恒为 `RSI_AUTO_PHASE = 0`:生产上全部是桩;处理函数只经注入的 `phase` 被测试调用。
 * 异常边界:任何未识别的异常 → `RSI_FAIL_CLOSED reason=internal`(退 3,不回显消息)。
 */
import { ExitCode } from '../../contracts/exit-codes.js';
import {
  RSI_AUTO_PHASE,
  RSI_AUTO_SUBCOMMAND_CAPS,
  capabilityAvailable,
} from '../../contracts/rsi.js';
import { resolveIsTty } from '../../commands/types.js';
import { parseFlags } from '../args.js';
import { failExit } from '../exit.js';
import { forbiddenPaths } from '../output.js';
import { rsiStubExit } from '../stub.js';
import type { RsiEarlyContext, RsiSubcommand } from '../types.js';
import { productionAutoPorts } from './deps.js';
import { runClearDry } from './read/clear-dry.js';
import type { AutoReadPorts } from './read/ports.js';
import { parseReportArgs, runReport } from './read/report.js';
import { runRollbackDry } from './read/rollback-dry.js';
import { runShow } from './read/show.js';
import { runAutoStatus } from './read/status.js';
import { routeAuto, type AutoCanonical, type AutoFamily } from './route.js';

/** 写命令的处理函数(W8b 填;W8a 全部缺省 = 未实现桩) */
export type AutoWriteHandler = (ctx: RsiEarlyContext, rest: readonly string[]) => Promise<number>;

export interface AutoEntryDeps {
  /** 相位(缺省 `RSI_AUTO_PHASE`;测试注入) */
  phase?: number;
  /** 只读端口(缺省 = 生产组装) */
  ports?: (ctx: RsiEarlyContext) => Promise<AutoReadPorts>;
  write?: Partial<Record<AutoCanonical, AutoWriteHandler>>;
}

const usage = (ctx: RsiEarlyContext, reason: string): number => {
  ctx.stderr(`RSI_USAGE reason=${reason}\n`);
  return ExitCode.USAGE;
};

export async function runAutoFamily(
  family: AutoFamily,
  ctx: RsiEarlyContext,
  deps: AutoEntryDeps = {},
): Promise<number> {
  const route = routeAuto(family, ctx.argv);
  if (route === undefined) return usage(ctx, 'unknown_subcommand');
  const phase = deps.phase ?? RSI_AUTO_PHASE;
  // 能力闸先于参数解析:未到期 = 桩(默认拒绝:不在表里也是桩)
  if (!capabilityAvailable(RSI_AUTO_SUBCOMMAND_CAPS[route.canonical], phase)) {
    return rsiStubExit(ctx, route.canonical);
  }
  try {
    if (route.write) {
      const h = deps.write?.[route.canonical];
      return h === undefined ? rsiStubExit(ctx, route.canonical) : await h(ctx, route.rest);
    }
    const ports = await (deps.ports ?? productionAutoPorts)(ctx);
    const sink = { stdout: (t: string) => ctx.stdout(t), stderr: (t: string) => ctx.stderr(t) };
    const forbidden = await forbiddenPaths(ctx.env, []);
    switch (route.canonical) {
      case 'auto status': {
        const f = parseFlags(route.rest, ['--json']);
        if (!f.ok) return usage(ctx, 'unknown_arg');
        return await runAutoStatus(ports, { json: f.flags.has('--json'), phase, forbidden }, sink);
      }
      case 'auto clear': {
        const f = parseFlags(route.rest, ['--json']);
        if (!f.ok) return usage(ctx, 'unknown_arg');
        return await runClearDry(ports, { json: f.flags.has('--json'), forbidden }, sink);
      }
      case 'report': {
        const a = parseReportArgs(route.rest, ports.now());
        if (!a.ok) return usage(ctx, a.reason);
        return await runReport(ports, { json: a.json, range: a.range, forbidden }, sink);
      }
      case 'show':
        return await runShow(ports, route.rest, { isTty: resolveIsTty(ctx), sink, forbidden });
      case 'rollback --to':
        return await runRollbackDry(ports, route.rest, { forbidden }, sink);
      default:
        // 其余规范名恒为写命令(route.write 已在上面分流);走到这里 = 路由表与处理表不一致,fail-closed
        return rsiStubExit(ctx, route.canonical);
    }
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

const make = (name: AutoFamily): RsiSubcommand => ({
  name,
  owner: 'W8',
  run: (ctx) => runAutoFamily(name, ctx),
});

export const autoSubcommand = make('auto');
export const vetoSubcommand = make('veto');
export const rollbackSubcommand = make('rollback');
export const reportSubcommand = make('report');
export const showSubcommand = make('show');
