import { ExitCode } from '../contracts/exit-codes.js';
import type { IoContext } from '../io/paths.js';

export interface CommandContext {
  /** 命令名之后的参数(全局选项 --root/--overlay/--help 已被 cli.ts 取走) */
  argv: readonly string[];
  io: IoContext;
  /** `--overlay <path>`;P0 覆盖层只经此显式传入,不自动发现 */
  overlayPath: string | undefined;
  stdout(text: string): void;
  stderr(text: string): void;
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
