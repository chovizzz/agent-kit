import { ExitCode } from '../contracts/exit-codes.js';
import type { IoContext, WriteAudit } from '../io/paths.js';

export interface CommandContext {
  /** 命令名之后的参数(全局选项 --root/--overlay/--help 已被 cli.ts 取走) */
  argv: readonly string[];
  io: IoContext;
  /** 注入的宿主环境(测试 / `main(argv, env)`);缺省 undefined = 真实 CLI,子进程环境取 `io.hostEnv`(paths.ts 受控读取) */
  env?: Readonly<Record<string, string | undefined>>;
  /** `--overlay <path>`;P0 覆盖层只经此显式传入,不自动发现 */
  overlayPath: string | undefined;
  stdout(text: string): void;
  stderr(text: string): void;
  /** 是否交互终端(confirm / purge / --ack 用)。可注入;缺省见 `resolveIsTty`。 */
  isTty?: boolean;
  /** 读一行确认输入(不含换行;输入结束返回 undefined)。可注入;缺省见 `resolveReadLine`。 */
  readLine?: () => Promise<string | undefined>;
}

/** 交互终端判定:注入优先;缺省 = stdin 与 stdout 都是 TTY(与 update/launcher 的判法一致)。 */
export function resolveIsTty(ctx: Pick<CommandContext, 'isTty'>): boolean {
  return ctx.isTty ?? (process.stdout.isTTY === true && process.stdin.isTTY === true);
}

/** 读一行:注入优先;缺省从 process.stdin 读(进程内共享同一个缓冲,多次调用不丢输入)。 */
export function resolveReadLine(
  ctx: Pick<CommandContext, 'readLine'>,
): () => Promise<string | undefined> {
  return ctx.readLine ?? (defaultReadLine ??= createLineReader(process.stdin));
}

let defaultReadLine: (() => Promise<string | undefined>) | undefined;

/**
 * 在一个可读流上造「一次读一行」的读取器:多余数据留在读取器自己的缓冲里,供下一次调用;
 * 流结束后再调用,先吐出缓冲里剩下的内容,之后恒返回 undefined(不会永久挂起)。行尾 `\r\n` 与 `\n` 都认。
 * 每次等待期间才 resume 流,读到一行即 pause。
 */
export function createLineReader(stream: NodeJS.ReadableStream): () => Promise<string | undefined> {
  let buf = '';
  let ended = false;
  stream.once('end', () => {
    ended = true;
  });
  const takeLine = (): string | undefined => {
    const i = buf.indexOf('\n');
    if (i < 0) return undefined;
    const line = buf.slice(0, i).replace(/\r$/, '');
    buf = buf.slice(i + 1);
    return line;
  };
  return () =>
    new Promise((resolve) => {
      const ready = takeLine();
      if (ready !== undefined) return resolve(ready);
      const drainEnded = (): string | undefined => {
        if (buf === '') return undefined;
        const rest = buf.replace(/\r$/, '');
        buf = '';
        return rest;
      };
      if (ended || (stream as { readableEnded?: boolean }).readableEnded === true) {
        return resolve(drainEnded());
      }
      const done = (v: string | undefined): void => {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.pause();
        resolve(v);
      };
      const onData = (chunk: Buffer | string): void => {
        buf += chunk.toString();
        const line = takeLine();
        if (line !== undefined) done(line);
      };
      const onEnd = (): void => {
        ended = true;
        done(drainEnded());
      };
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.resume();
    });
}

/**
 * 不需要(也不应该)先建通用 `IoContext` 的命令所用的上下文(R20-A2 B3-0,v2 §5):`rsi` 的状态目录与仓库根只来自 `[rsi] repo`,
 * 通用 `createIoContext` 会先校验 `KIT_STATE_DIR` 等对 rsi 无意义的输入,所以 `main()` 在它**之前**把这类命令分流出去。
 * 因此这里**没有** `io`:命令自己决定何时、用什么根去建上下文(见 `src/rsi/services/open.ts`)。
 */
export interface EarlyCommandContext {
  /** 命令名之后的参数(全局选项已被 cli.ts 取走) */
  argv: readonly string[];
  overlayPath: string | undefined;
  /** 全局 `--root` 的原值(没给 = undefined);rsi 用它与 `[rsi] repo` 的 realpath 比较 */
  explicitRoot: string | undefined;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** 写审计钩子(`MainEnv.writeAudit`);派生上下文时必须经 `deriveIoContext` 继承 */
  writeAudit?: WriteAudit;
  stdout(text: string): void;
  stderr(text: string): void;
  /** 与 `CommandContext` 相同的交互注入点(confirm / purge / --ack 用);缺省见 `resolveIsTty` / `resolveReadLine` */
  isTty?: boolean;
  readLine?: () => Promise<string | undefined>;
}

export type Phase = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface CommandDef {
  /** 完整命令名,子命令用空格:`signals collect` */
  name: string;
  summary: string;
  /** 计划实装阶段 */
  phase: Phase;
  /** 负责替换本文件内容的块(命令桩的说明用) */
  ownerBlock: string;
  /** `agent-kit <命令> --help` 展示的 flag 清单(只做文档,解析在各命令内) */
  flags?: readonly { name: string; description: string }[];
  /** 返回退出码,见 contracts/exit-codes.ts */
  run(ctx: CommandContext): Promise<number>;
  /**
   * 给了它,`main()` 在解析完命令与 `--help` 之后、**创建通用 `IoContext` 之前**直接调用它,不再调用 `run`
   * (`run` 仍是必填字段,这类命令的 `run` 应当抛错:它不会被调用)。
   * 错误边界与 `run` 相同:未捕获的异常照旧冒到进程入口。
   */
  runEarly?(ctx: EarlyCommandContext): Promise<number>;
}

/** `check` 的完整 flag 集合由 B01 定死,子 runner 拿到的是已解析的 CheckOptions。 */
export interface CheckOptions {
  /** 追加运行 G1–G4 本地守卫(需要 base/head) */
  guards: boolean;
  base: string | undefined;
  head: string | undefined;
  label: string | undefined;
  /** 打印机器可读的预算统计表(供验收脚本消费) */
  report: boolean;
}

/** `check` 的子 runner 签名:lint-cmd.ts / check-budget.ts / guards-cmd.ts 各导出一个 `run`。 */
export type CheckStep = (ctx: CommandContext, opts: CheckOptions) => Promise<number>;

/** 命令桩:打印原因并退出 64。绝不静默成功。 */
export function stubExit(ctx: CommandContext, name: string, why: string): number {
  ctx.stderr(`agent-kit ${name}: 未实现 — ${why}\n`);
  return ExitCode.NOT_IMPLEMENTED;
}

export function stubReason(def: Pick<CommandDef, 'phase' | 'ownerBlock'>): string {
  return def.phase === 'P0'
    ? `P0 内由块 ${def.ownerBlock} 实装,当前是命令桩`
    : `${def.phase} 才实现`;
}

/**
 * 合并多步退出码。优先级:3(fail-closed) > 2(用法) > 1(检查失败) > 4(未执行) > 64(未实现) > 0。
 * 含桩时不会返回 0,所以半成品树不会被误判为通过。
 */
export function combineExitCodes(codes: readonly number[]): number {
  for (const c of [
    ExitCode.FAIL_CLOSED,
    ExitCode.USAGE,
    ExitCode.CHECK_FAILED,
    ExitCode.NOT_RUN,
    ExitCode.NOT_IMPLEMENTED,
  ] as const) {
    if (codes.includes(c)) return c;
  }
  return codes.find((c) => c !== 0) ?? ExitCode.OK;
}
