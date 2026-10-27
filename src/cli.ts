import { ExitCode } from './contracts/exit-codes.js';
import { CLI_NAME, KIT_VERSION } from './contracts/meta.js';
import { createIoContext, PathsError } from './io/paths.js';
import type { WriteAudit } from './io/paths.js';
import { command as attest } from './commands/attest.js';
import { command as build } from './commands/build.js';
import { command as calibrate } from './commands/calibrate.js';
import { command as check } from './commands/check.js';
import { command as doctor } from './commands/doctor.js';
import { command as inventory } from './commands/inventory.js';
import { command as judge } from './commands/judge.js';
import { command as probe } from './commands/probe.js';
import { command as promote } from './commands/promote.js';
import { command as redact } from './commands/redact-cmd.js';
import { command as reflect } from './commands/reflect.js';
import { command as retire } from './commands/retire.js';
import { command as rsi } from './commands/rsi.js';
import { command as signalsCollect } from './commands/signals-collect.js';
import { command as sync } from './commands/sync.js';
import type { CommandContext, CommandDef } from './commands/types.js';
import { command as update } from './commands/update.js';
import { createBackgroundCommand } from './update/worker.js';

/**
 * 命令注册表。新增命令要在这里登记(导入 + 加入数组);已有命令的实现替换 src/commands/<x>.ts 的内容即可,
 * 保持 `export const command: CommandDef`(或子 runner 的 `run`)的形状,不用动注册。
 */
export const COMMANDS: readonly CommandDef[] = [
  build,
  check,
  redact,
  signalsCollect,
  inventory,
  probe,
  reflect,
  judge,
  attest,
  promote,
  retire,
  calibrate,
  sync,
  doctor,
  update,
  rsi,
];

export interface MainEnv {
  /** 注入环境/cwd(测试用);缺省读真实进程 */
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** 写审计钩子(R20-A2 B1):注入后由 main() 放进它创建的 IoContext;缺省不审计 */
  writeAudit?: WriteAudit;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface GlobalFlags {
  rest: string[];
  root: string | undefined;
  overlay: string | undefined;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

function takeGlobalFlags(args: readonly string[]): GlobalFlags {
  const out: GlobalFlags = {
    rest: [],
    root: undefined,
    overlay: undefined,
    help: false,
    version: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const valueFlag = (name: string): string | undefined => {
      if (a === name) {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} 需要一个值`);
        i++;
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    const root = valueFlag('--root');
    if (root !== undefined) {
      out.root = root;
      continue;
    }
    const overlay = valueFlag('--overlay');
    if (overlay !== undefined) {
      out.overlay = overlay;
      continue;
    }
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else out.rest.push(a);
  }
  return out;
}

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  [${c.phase}] ${c.summary}`);
  return [
    `${CLI_NAME} ${KIT_VERSION}`,
    '',
    `用法:${CLI_NAME} [--root <dir>] [--overlay <path>] <命令> [参数]`,
    '',
    '命令:',
    ...lines,
    '',
    '全局选项:',
    '  --root <dir>      仓库根(缺省:自 cwd 向上找 kit.toml)',
    '  --overlay <path>  覆盖层文件(P0 只经此显式传入)',
    '  -h, --help        帮助',
    '  -v, --version     版本',
    '',
    '退出码:0 成功,1 检查失败,2 用法错误,3 fail-closed,4 未执行,64 未实现(命令桩)',
    '',
  ].join('\n');
}

function resolveCommand(rest: readonly string[]): { def: CommandDef; args: string[] } | undefined {
  // 最长名字优先,子命令 `signals collect` 由前两个 token 匹配
  const sorted = [...COMMANDS].sort((a, b) => b.name.split(' ').length - a.name.split(' ').length);
  for (const def of sorted) {
    const tokens = def.name.split(' ');
    if (tokens.every((t, i) => rest[i] === t)) return { def, args: rest.slice(tokens.length) };
  }
  return undefined;
}

export async function main(argv: readonly string[], env: MainEnv = {}): Promise<number> {
  const stdout = env.stdout ?? ((t: string) => void process.stdout.write(t));
  const stderr = env.stderr ?? ((t: string) => void process.stderr.write(t));

  let flags: GlobalFlags;
  try {
    flags = takeGlobalFlags(argv);
  } catch (e) {
    stderr(`${CLI_NAME}: ${(e as Error).message}\n`);
    return ExitCode.USAGE;
  }

  if (flags.version) {
    stdout(`${KIT_VERSION}\n`);
    return ExitCode.OK;
  }

  // 内部入口:后台 update worker。不在 COMMANDS 里,不进 --help;只有这一个精确形状
  const hidden =
    flags.rest[0] === '__update' && !flags.help
      ? { def: createBackgroundCommand(), args: flags.rest.slice(1) }
      : undefined;
  const resolved = hidden ?? resolveCommand(flags.rest);
  if (flags.help && resolved === undefined) {
    stdout(helpText());
    return ExitCode.OK;
  }
  if (resolved === undefined) {
    if (flags.rest.length === 0) {
      stderr(helpText());
    } else {
      stderr(`${CLI_NAME}: 未知命令:${flags.rest.join(' ')}\n\n${helpText()}`);
    }
    return ExitCode.USAGE;
  }
  if (flags.help) {
    const flagLines = (resolved.def.flags ?? []).map((f) => `  ${f.name}  ${f.description}`);
    stdout(
      [
        `${CLI_NAME} ${resolved.def.name}  [${resolved.def.phase}]`,
        resolved.def.summary,
        ...(flagLines.length > 0 ? ['', '参数:', ...flagLines] : []),
        '',
      ].join('\n'),
    );
    return ExitCode.OK;
  }

  // 自带上下文选择的命令(rsi):在通用路径校验(createIoContext 会校验 KIT_STATE_DIR 等)之前分流,见 EarlyCommandContext
  if (resolved.def.runEarly !== undefined) {
    return await resolved.def.runEarly({
      argv: resolved.args,
      overlayPath: flags.overlay,
      explicitRoot: flags.root,
      ...(env.env !== undefined ? { env: env.env } : {}),
      ...(env.cwd !== undefined ? { cwd: env.cwd } : {}),
      ...(env.writeAudit !== undefined ? { writeAudit: env.writeAudit } : {}),
      stdout,
      stderr,
    });
  }

  let io;
  try {
    io = createIoContext({
      ...(flags.root !== undefined ? { root: flags.root } : {}),
      ...(env.env !== undefined ? { env: env.env } : {}),
      ...(env.cwd !== undefined ? { cwd: env.cwd } : {}),
      ...(env.writeAudit !== undefined ? { writeAudit: env.writeAudit } : {}),
    });
  } catch (e) {
    if (e instanceof PathsError) {
      stderr(`${CLI_NAME}: ${e.message}\n`);
      return ExitCode.FAIL_CLOSED;
    }
    throw e;
  }
  // 宿主环境只在入口处经 main(argv, env) 注入;命令层不读 process.env(reflect/judge 的后端接线用它)
  const ctx: CommandContext = {
    argv: resolved.args,
    io,
    overlayPath: flags.overlay,
    stdout,
    stderr,
    ...(env.env !== undefined ? { env: env.env } : {}),
  };
  return resolved.def.run(ctx);
}
