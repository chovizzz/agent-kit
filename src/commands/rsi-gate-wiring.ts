/**
 * judge / promote 的 rsi 隐私闸与即时闸的共用接线(契约 R20-4.8、§20.9 第 11 / 21 条;R20-A2 B5g)。
 *
 * - {@link privacyCheck}:命令入口处、在读暂存区 / 构造后端 / 拿锁**之前**判定,判定之前零副作用。
 *   配置来源 `loadRsiConfig({ env: ctx.env })`(与 `withRsiWriterLock` 同源;即时闸内部另用 `io.hostEnv.HOME` 重读,两者一致性由 B5g 测试钉住)。
 *   `legacyAllowed`(没有 `[rsi]` / 未启用)→ `legacy`:调用方走**现有代码,逐字节不变**;`deny`(`cfg_*` / `repo_invalid` / `overlay_invalid` /
 *   `exclude_invalid`)→ 退出 3 `RSI_FAIL_CLOSED reason=<原因>`,`cfg_*` 绝不当 legacy 放行;`enforce` → 调用方过即时闸。
 * - {@link gateExitOf}:即时闸结果 → 退出码与稳定码(只含稳定码与 run_id,不含任何摘录)。
 * - {@link GateStop}:回调 / 写出口里用来短路的异常,携带 {@link GateExit};调用方 catch 后原样输出,不打印部分结果。
 *
 * 本文件**不**import `commands/reflect.ts`(promote 的闭包里不能出现 llm-exec)。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { getRealHome } from '../io/paths.js';
import type { IoContext } from '../io/paths.js';
import { deriveIoContext } from '../io/paths.js';
import { loadRsiConfig, type RsiConfigOn } from '../rsi/config.js';
import { privacyGate } from '../rsi/gate.js';
import type { ImmediateGateResult } from '../rsi/types.js';
import type { CommandContext } from './types.js';

/** 退出码 + 完整的 stderr 行(以换行结尾) */
export interface GateExit {
  readonly exit: number;
  readonly stderr: string;
}

export type PrivacyCheck =
  { kind: 'legacy' } | { kind: 'enforce'; config: RsiConfigOn; home: string } | GateExit;

/** `PrivacyCheck` 是否为拒绝(带退出码) */
export function isGateExit(r: PrivacyCheck): r is GateExit {
  return 'exit' in r;
}

export async function privacyCheck(ctx: Pick<CommandContext, 'env'>): Promise<PrivacyCheck> {
  const cfg = await loadRsiConfig(ctx.env !== undefined ? { env: ctx.env } : {});
  const g = privacyGate(cfg);
  switch (g.kind) {
    case 'legacyAllowed':
      return { kind: 'legacy' };
    case 'deny':
      return { exit: ExitCode.FAIL_CLOSED, stderr: `RSI_FAIL_CLOSED reason=${g.reason}\n` };
    case 'enforce':
      // enforce 只会来自 status 'on'(privacyGate 的契约);防御:其余按 fail-closed
      if (cfg.status !== 'on') {
        return { exit: ExitCode.FAIL_CLOSED, stderr: 'RSI_FAIL_CLOSED reason=internal\n' };
      }
      return { kind: 'enforce', config: cfg, home: getRealHome(ctx.env) };
  }
}

/** allow → null;其余 → 退出码与稳定码 */
export function gateExitOf(r: ImmediateGateResult): GateExit | null {
  switch (r.kind) {
    case 'allow':
      return null;
    case 'tainted':
      return {
        exit: ExitCode.CHECK_FAILED,
        stderr: `RSI_RUN_TAINTED reason=${r.reason} run_id=${r.runId}\n`,
      };
    case 'attribution_unknown':
      return {
        exit: ExitCode.CHECK_FAILED,
        stderr: `RSI_RUN_ATTRIBUTION_UNKNOWN run_id=${r.runId}\n`,
      };
    case 'fail_closed':
      return { exit: ExitCode.FAIL_CLOSED, stderr: `RSI_FAIL_CLOSED reason=${r.reason}\n` };
  }
}

/** 回调 / 写出口里用来短路:携带要输出的 {@link GateExit};消息不含任何内容 */
export class GateStop extends Error {
  constructor(readonly gate: GateExit) {
    super('rsi_gate_stop');
  }
}

/**
 * 喂给即时闸 / 回调的 io:`hostEnv.HOME` 强制取 `privacyCheck` 读配置用的那个 home。
 * 即时闸(B3c 服务,已冻结)按 `io.hostEnv.HOME` 重读配置,`privacyCheck` 按 `ctx.env`;生产里两者同源(main() 用同一份 env),
 * 但直接构造 ctx / io 时可分叉,分叉的方向是 fail-open。这里在接线层把两者钉成同一来源。
 */
export function gateIoOf(io: IoContext, home: string): IoContext {
  return deriveIoContext(io, { hostEnv: Object.freeze({ ...io.hostEnv, HOME: home }) });
}
