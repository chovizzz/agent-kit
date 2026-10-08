import { ExitCode } from './contracts/exit-codes.js';
import { CLI_NAME, KIT_VERSION } from './contracts/meta.js';
import { createIoContext, PathsError } from './io/paths.js';
import { command as attest } from './commands/attest.js';
import { command as build } from './commands/build.js';
import { command as check } from './commands/check.js';
import { command as doctor } from './commands/doctor.js';
import { command as inventory } from './commands/inventory.js';
import { command as probe } from './commands/probe.js';
import { command as promote } from './commands/promote.js';
import { command as redact } from './commands/redact-cmd.js';
import { command as reflect } from './commands/reflect.js';
import { command as retire } from './commands/retire.js';
import { command as signalsCollect } from './commands/signals-collect.js';
import { command as sync } from './commands/sync.js';
import type { CommandContext, CommandDef } from './commands/types.js';

/**
 * 命令注册表。**只有 B01 改本文件**:后续块替换 src/commands/<x>.ts 的内容,
 * 保持 `export const command: CommandDef`(或子 runner 的 `run`)的形状即可,不用动注册。
 */
export const COMMANDS: readonly CommandDef[] = [
  build,
  check,
  redact,
  signalsCollect,
  inventory,
  probe,
  reflect,
  attest,
  promote,
  retire,
  sync,
  doctor,
];

export interface MainEnv {
  /** 注入环境/cwd(测试用);缺省读真实进程 */
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
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

  const resolved = resolveCommand(flags.rest);
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

  let io;
  try {
    io = createIoContext({
      ...(flags.root !== undefined ? { root: flags.root } : {}),
      ...(env.env !== undefined ? { env: env.env } : {}),
      ...(env.cwd !== undefined ? { cwd: env.cwd } : {}),
    });
  } catch (e) {
    if (e instanceof PathsError) {
      stderr(`${CLI_NAME}: ${e.message}\n`);
      return ExitCode.FAIL_CLOSED;
    }
    throw e;
  }
  const ctx: CommandContext = {
    argv: resolved.args,
    io,
    overlayPath: flags.overlay,
    stdout,
    stderr,
  };
  return resolved.def.run(ctx);
}
