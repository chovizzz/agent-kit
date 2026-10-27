/* eslint-disable @typescript-eslint/no-unused-vars -- 桩:参数是冻结的签名,由实装块使用 */
/**
 * 暂存区即时闸(契约 R20-4.8;v2 §6)。**B3c 实装**,B3b 在 judge / promote 的接线里调用;本块只冻结签名。
 */
import type {
  ImmediateGateCheck,
  ImmediateGateResult,
  ImmediateGateScope,
  JudgeGateCallbacks,
  RsiServiceCtx,
} from '../types.js';

export type { ImmediateGateResult, ImmediateGateScope, JudgeGateCallbacks };

/**
 * 读暂存区之前(以及外发 / 落盘 / 输出之前)的检查:`TAINTED`、证据归属 X / U、purge journal、配置不可用。每次调用现算,不缓存。
 * 非 `allow` 的结果必须短路(见 `ImmediateGateResult`)。负责块:B3c。
 */
export async function immediateGate(
  _ctx: RsiServiceCtx,
  _scope: ImmediateGateScope,
): Promise<ImmediateGateResult> {
  throw new Error('not implemented');
}

/** 把 {@link immediateGate} 绑定到一个 scope,得到 judge 服务要的三个回调(三个回调各自现算)。负责块:B3c。 */
export function judgeGateCallbacks(
  _ctx: RsiServiceCtx,
  _scope: ImmediateGateScope,
): JudgeGateCallbacks {
  throw new Error('not implemented');
}

export type { ImmediateGateCheck };
