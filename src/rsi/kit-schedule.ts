/**
 * kit 命令结束后的顺带调度(契约 R20-1.7 / R20-6.1 / R20-6.2;A3)。由启动器 `launchAndSchedule` 在 update 的 `scheduleBackground` 之后调用,
 * 与之并列、互不影响;任何失败都吞掉,不改变用户命令的退出码。本模块零网络(只经 `services/spawn-gate.ts` → `update/self-spawn.ts`)。
 *
 * 闸(按序):跳过条件(R20-1.6,含 `KIT_LAUNCHED`)→ stdin 与 stdout 都是 TTY → 命令白名单:`build`、`check`、`sync`、`reflect`
 * (不带 `--run-llm`、不带 `--gc`);带 `--help` / `-h` / `--version` / `-v` 的调用不调度 → 共用闸(读配置失败 / off 不调度,预留 `poke/kit-<窗口>`)。
 */
import type { WriteAudit } from '../io/paths.js';
import { trySpawnL0, type SpawnGateDeps, type SpawnGateResult } from './services/spawn-gate.js';
import { autoSkip } from './skip.js';

type Env = Readonly<Record<string, string | undefined>>;

const SCHEDULED_COMMANDS: readonly string[] = ['build', 'check', 'sync', 'reflect'];
const NO_SCHEDULE_FLAGS: readonly string[] = ['--help', '-h', '--version', '-v'];

/** 命令名:第一个非选项记号(跳过带值的全局选项 `--root` / `--overlay`;与启动器 `commandOf` 同口径) */
function commandOf(argv: readonly string[]): { name: string | undefined; rest: readonly string[] } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--root' || a === '--overlay') {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    return { name: a, rest: argv.slice(i + 1) };
  }
  return { name: undefined, rest: [] };
}

/** 白名单判定(纯函数;R20-1.7) */
export function kitScheduleEligible(argv: readonly string[]): boolean {
  if (argv.some((a) => NO_SCHEDULE_FLAGS.includes(a))) return false;
  const { name, rest } = commandOf(argv);
  if (name === undefined || !SCHEDULED_COMMANDS.includes(name)) return false;
  if (name === 'reflect' && (rest.includes('--run-llm') || rest.includes('--gc'))) return false;
  return true;
}

export interface KitScheduleInput {
  argv: readonly string[];
  env: Env;
  /** stdin 与 stdout 都是 TTY */
  isTty: boolean;
  /** 写审计钩子(测试) */
  writeAudit?: WriteAudit;
}

export async function scheduleRsiAfterCommand(
  input: KitScheduleInput,
  deps: SpawnGateDeps = {},
): Promise<SpawnGateResult> {
  try {
    const skip = autoSkip(input.env, 'kit');
    if (skip !== null) return { kind: 'noop', why: skip };
    if (!input.isTty) return { kind: 'noop', why: 'not_tty' };
    if (!kitScheduleEligible(input.argv)) return { kind: 'noop', why: 'command_excluded' };
    return await trySpawnL0(
      {
        env: input.env,
        agent: 'kit',
        trigger: 'kit',
        ...(input.writeAudit !== undefined ? { writeAudit: input.writeAudit } : {}),
      },
      deps,
    );
  } catch {
    return { kind: 'noop', why: 'error' };
  }
}
