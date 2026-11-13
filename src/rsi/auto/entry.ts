/**
 * 命令面入口(`rsi auto <status|pause|resume|clear|rebase-baseline>` / `rsi veto` / `rsi rollback --to` / `rsi report` / `rsi show`;contracts R21-12)。
 * 顺序:二级路由({@link routeAuto};缺失 / 未知的二级命令退 2 `unknown_subcommand`,不回显输入)→ **能力闸**(`RSI_AUTO_SUBCOMMAND_CAPS` + `capabilityAvailable(cap, phase)`:
 * 能力未到期 → 命令桩,退 64 `RSI_NOT_IMPLEMENTED subcommand=<规范名>`,**不解析参数、不读任何东西**)→ 分流:
 *   - 只读(`auto status` / `report` / `show` / `auto clear` 干跑 / `rollback --to` 干跑):处理函数在 `read/`,依赖注入的端口(相位 / 时钟 / TTY 也是注入),零写入;
 *   - 写(`pause` / `resume` / `clear --write` / `rebase-baseline` / `veto` / `rollback --write`):处理函数在 `write/`(W8b),端口经 `deps-write.ts` 装配(`{@link AutoEntryDeps.write}` 可整表替换),
 *     参数 / TTY 校验先于端口装配,预检先于任何写入;路由、参数分流与能力闸已一次做全。
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
import { productionWritePorts } from './deps-write.js';
import { runClearDry } from './read/clear-dry.js';
import { AutoUsageError, type AutoReadPorts } from './read/ports.js';
import { parseReportArgs, runReport } from './read/report.js';
import { parseRollbackToArgs, runRollbackDry } from './read/rollback-dry.js';
import { checkShowArgs, runShow } from './read/show.js';
import { runAutoStatus } from './read/status.js';
import { routeAuto, type AutoCanonical, type AutoFamily } from './route.js';
import type { WriteHandler } from './write/ports.js';
import { makeWriteHandlers } from './write/index.js';

/** 写命令的处理函数(`write/` 下的 W8b 实现;`deps.write` 里没有的规范名 = 未实现桩) */
export type AutoWriteHandler = WriteHandler;

/** 生产的写处理函数表:端口由 `deps-write.ts` 装配(未接线的缺失 → 预检退 3);只在相位够了且命中写路由时才会被调用 */
const productionWriteHandlers = (): Partial<Record<AutoCanonical, AutoWriteHandler>> =>
  makeWriteHandlers((ctx) => productionWritePorts(ctx));

export interface AutoEntryDeps {
  /** 相位(缺省 `RSI_AUTO_PHASE`;测试注入) */
  phase?: number;
  /** 时钟(缺省系统时间;`report` 的区间解析用;测试注入) */
  now?: () => Date;
  /** 只读端口(缺省 = 生产组装) */
  ports?: (ctx: RsiEarlyContext) => Promise<AutoReadPorts>;
  /** 写处理函数表(缺省 = 生产表;测试注入;表里没有的规范名仍是「未实现」桩) */
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
      const h = (deps.write ?? productionWriteHandlers())[route.canonical];
      return h === undefined ? rsiStubExit(ctx, route.canonical) : await h(ctx, route.rest);
    }
    // 纯参数 / TTY 校验先于端口装配:坏参数、非 TTY 不会先去读配置 / 打开仓库上下文(也就不会因它们失败而退 3)
    const prepared = prepare(route.canonical, route.rest, {
      isTty: resolveIsTty(ctx),
      now: (deps.now ?? ((): Date => new Date()))(),
      phase,
    });
    if ('usage' in prepared) return usage(ctx, prepared.usage);
    const ports = await (deps.ports ?? productionAutoPorts)(ctx);
    const sink = { stdout: (t: string) => ctx.stdout(t), stderr: (t: string) => ctx.stderr(t) };
    return await prepared.run(ports, sink, await forbiddenPaths(ctx.env, ports.outputForbidden));
  } catch (e) {
    if (e instanceof AutoUsageError) return usage(ctx, e.reason);
    return failExit(ctx.stderr, e);
  }
}

type Sink = { stdout(t: string): void; stderr(t: string): void };
type Prepared =
  | { usage: string }
  | { run(p: AutoReadPorts, sink: Sink, forbidden: readonly string[]): Promise<number> };

/** 读命令的参数解析(纯函数):合法 → 带处理函数的 `run`;不合法 → 用法错误原因 */
function prepare(
  canonical: AutoCanonical,
  rest: readonly string[],
  env: { isTty: boolean; now: Date; phase: number },
): Prepared {
  switch (canonical) {
    case 'auto status': {
      const f = parseFlags(rest, ['--json']);
      if (!f.ok) return { usage: 'unknown_arg' };
      const json = f.flags.has('--json');
      return {
        run: (p, sink, forbidden) => runAutoStatus(p, { json, phase: env.phase, forbidden }, sink),
      };
    }
    case 'auto clear': {
      const f = parseFlags(rest, ['--json']);
      if (!f.ok) return { usage: 'unknown_arg' };
      const json = f.flags.has('--json');
      return { run: (p, sink, forbidden) => runClearDry(p, { json, forbidden }, sink) };
    }
    case 'report': {
      const a = parseReportArgs(rest, env.now);
      if (!a.ok) return { usage: a.reason };
      return {
        run: (p, sink, forbidden) =>
          runReport(p, { json: a.json, range: a.range, forbidden }, sink),
      };
    }
    case 'show': {
      const bad = checkShowArgs(rest, env.isTty);
      if (bad !== null) return { usage: bad };
      return {
        run: (p, sink, forbidden) => runShow(p, rest, { isTty: env.isTty, sink, forbidden }),
      };
    }
    case 'rollback --to': {
      const a = parseRollbackToArgs(rest);
      if (!a.ok) return { usage: a.reason };
      return { run: (p, sink, forbidden) => runRollbackDry(p, rest, { forbidden }, sink) };
    }
    default:
      // 其余规范名恒为写命令(route.write 已在上面分流);走到这里 = 路由表与处理表不一致,fail-closed
      return { usage: 'unknown_subcommand' };
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
