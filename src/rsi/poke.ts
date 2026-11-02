/**
 * `agent-kit rsi poke --agent <claude|codex|pi>`(契约 R20-3.2;A3,钩子专用)。
 *
 * 不阻塞宿主:退出码恒 0,stdout / stderr 恒空(参数错误也不输出),**不读 stdin**、不等 stdin 关闭(R20-1.9)。
 * 判定:跳过条件(R20-1.6)→ 参数(恰好 `--agent <id>`,其余一律空操作)→ 共用闸 `trySpawnL0`(配置、状态、熔断、到期、预留、spawn)。
 * 只有走到启动预留才写(预留标记 + 日志一行,R20-3.2.3)。1s 尽力预算(`RSI_POKE_BUDGET_MS`):步骤间查已耗时,超出即放弃。
 *
 * 两条到达路径共用 {@link runPoke}:根入口 `cli.ts` → `hook-entry.ts`(钩子实际走的,不经启动器);`src/cli.ts` → `rsi` 分发器(进程内调用)。
 * 不 import llm-exec / reflect 后端 / net / 更新启动器(R20-1.1)。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { RSI_AGENT_IDS, RSI_POKE_BUDGET_MS, type RsiAgentId } from '../contracts/rsi.js';
import { trySpawnL0, type SpawnGateDeps, type SpawnGateResult } from './services/spawn-gate.js';
import type { WriteAudit } from '../io/paths.js';
import { autoSkip } from './skip.js';
import type { RsiSubcommand } from './types.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface RunPokeDeps extends Omit<SpawnGateDeps, 'overBudget'> {
  env?: Env;
  writeAudit?: WriteAudit;
  /** 墙钟毫秒(预算用;缺省 `Date.now`) */
  clockMs?: () => number;
}

/** 参数恰好是 `--agent <id>`(id 合法)才返回 id;缺失、重复、多余、`--agent=x` 写法 → undefined(空操作,不报错,R20-3.2.4) */
export function parseAgentArg(argv: readonly string[]): RsiAgentId | undefined {
  if (argv.length !== 2 || argv[0] !== '--agent') return undefined;
  const id = argv[1];
  return (RSI_AGENT_IDS as readonly string[]).includes(id as string)
    ? (id as RsiAgentId)
    : undefined;
}

export async function runPoke(
  argv: readonly string[],
  deps: RunPokeDeps = {},
): Promise<SpawnGateResult> {
  const clock = deps.clockMs ?? ((): number => Date.now());
  const t0 = clock();
  try {
    const env: Env = deps.env ?? {};
    const skip = autoSkip(env, 'poke');
    if (skip !== null) return { kind: 'noop', why: skip };
    const agent = parseAgentArg(argv);
    if (agent === undefined) return { kind: 'noop', why: 'bad_args' };
    return await trySpawnL0(
      {
        env,
        agent,
        trigger: 'poke',
        ...(deps.writeAudit !== undefined ? { writeAudit: deps.writeAudit } : {}),
      },
      { ...deps, overBudget: () => clock() - t0 > RSI_POKE_BUDGET_MS },
    );
  } catch {
    return { kind: 'noop', why: 'error' };
  }
}

export const subcommand: RsiSubcommand = {
  name: 'poke',
  owner: 'A3',
  run: async (ctx) => {
    await runPoke(ctx.argv, {
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      ...(ctx.writeAudit !== undefined ? { writeAudit: ctx.writeAudit } : {}),
    });
    return ExitCode.OK;
  },
};
