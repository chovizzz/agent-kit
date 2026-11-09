/**
 * L-auto 层与「自动循环有效」判定(docs/contracts.md §21.2 R21-2.1 / R21-2.2,§21.24 W0-9)。
 *
 * 纯函数、无 I/O:输入是 {@link loadRsiConfig} 已放行的原样 `[rsi.auto]` 表。
 * 失败**只禁自动生效**(`invalid`),不影响 `[rsi]` 的状态、L0 与 hint 计数行。
 * 相位闸经注入参数传入(缺省 {@link RSI_AUTO_PHASE});W0 时恒为 0,所以任何配置下 {@link isAutoLoopEffective} 都为假。
 */
import {
  RSI_AUTO_PHASE,
  RsiAutoSchema,
  phaseAtLeast,
  type RsiAuto,
} from '../contracts/rsi.js';
import type { RsiConfig } from './config.js';

export type RsiAutoConfig =
  | { status: 'absent' }
  | { status: 'invalid' }
  | {
      status: 'ok';
      enabled: boolean;
      profile: NonNullable<RsiAuto['profile']>;
      /** V3 之前固定测试不存在:`medium` / `heavy` 的有效档恒为 `lite`(R21-2.1) */
      profile_effective: 'lite';
      exec: NonNullable<RsiAuto['exec']>;
    };

/** `[rsi]` 不可用(`off`)或没有 `[rsi.auto]` 表 → `absent`;表不合规 → `invalid`(只禁自动生效) */
export function resolveAutoConfig(cfg: RsiConfig): RsiAutoConfig {
  if (cfg.status !== 'on' || cfg.auto === undefined) return { status: 'absent' };
  const r = RsiAutoSchema.safeParse(cfg.auto);
  if (!r.success) return { status: 'invalid' };
  return {
    status: 'ok',
    enabled: r.data.enabled ?? false,
    profile: r.data.profile ?? 'medium',
    profile_effective: 'lite',
    exec: r.data.exec ?? 'off',
  };
}

/**
 * R21-2.2:开启自动循环的有效条件 = 状态 `confirmed` ∧ `enabled === true` ∧ L-auto 通过 ∧ `RSI_AUTO_PHASE ≥ 1`(V1a)。
 * 不满足时 worker 照常做 L0,hint 只出计数行。
 */
export function isAutoLoopEffective(
  confirmed: boolean,
  auto: RsiAutoConfig,
  phase: number = RSI_AUTO_PHASE,
): boolean {
  return confirmed && auto.status === 'ok' && auto.enabled && phaseAtLeast('V1a', phase);
}
