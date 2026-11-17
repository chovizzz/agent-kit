/**
 * §21 V1 装配块 C1b——**静音降级阶梯**(C v2 §2 / v1 §4;纯逻辑 + 注入端口,无 I/O;**阶梯算法只此一份**,S0 与 `safetyFallback` 共用):
 *  ① 静音(`muteCanary`)→ ② 失败则 `removeCanary` → ③ 仍失败则创建 B 标记(`gate_internal`,让 hint 立停)→ ④ 仍失败 = `unreliable`。
 *  每个写点前 `assertHeld`;**rsi 锁丢失在任何一点都立即停写**(兜底入口以 `aborted` 报告返回,S0 入口原样上抛)。
 *
 * 不变量(state 非法 / 读不出时):**`state.json` 与快照清单的字节不变**,也不建 B(除非 ① ② 都失败的阶梯 ③);**允许**对 `canary.json` 的静音 / 删除(它们只收紧)。
 * 兜底(`runFallbackLadder`)的端口 `FallbackPorts` 没有任何写 state / 清单的成员;S0(`runEnforceLadder`)的完整 `enforceFull` 由装配注入(内含 B / 状态补做,沿用 `breaker.ts`)。
 * `tripAndMuteGuarded`:`tripAndMute` 在 state 写抛错时(`breaker.ts` 里会跳过紧随的静音)**仍**走阶梯静音,然后把原错误原样抛出(调用方记故障并使本轮未决)。
 */
import { tripAndMute, type BreakerDeps } from '../breaker.js';
import { isRsiLockLost } from './errors.js';
import type {
  EnforceResult,
  FallbackPorts,
  MuteResult,
  SafetyFaultKind,
  TripResult,
} from './ports.js';
import type { FallbackReport, TripReason } from './types.js';

/** 阶梯需要的写端口子集(`FallbackPorts` 的窄切片:没有读 state 的成员,更没有写 state 的成员) */
export type MuteLadderPorts = Pick<
  FallbackPorts,
  'muteCanary' | 'removeCanary' | 'ensureBreakerMarker' | 'assertHeld'
>;

/** 阶梯 ①→④;失锁(rsi)抛出由调用方处理(本函数原样抛) */
export async function muteDown(p: MuteLadderPorts): Promise<MuteResult> {
  try {
    await p.assertHeld();
    return (await p.muteCanary()) ? 'muted' : 'nothing';
  } catch (e) {
    if (isRsiLockLost(e)) throw e;
  }
  try {
    await p.assertHeld();
    await p.removeCanary();
    return 'removed';
  } catch (e) {
    if (isRsiLockLost(e)) throw e;
  }
  try {
    await p.assertHeld();
    await p.ensureBreakerMarker('gate_internal');
    return 'marker';
  } catch (e) {
    if (isRsiLockLost(e)) throw e;
  }
  return 'unreliable';
}

const lockLostReport: FallbackReport = { kind: 'aborted', why: 'rsi_lock_lost' };

/**
 * `safetyFallback` 的阶梯:读标记 + 读 state(纯读)→ 需要静音(B / U 在,或 state 暂停,或 state 读不出 / 非法 = fail-closed)才进阶梯。**永不抛**。
 * 标记读失败也按「需要静音」(不确定时收紧)。
 */
export async function runFallbackLadder(p: FallbackPorts): Promise<FallbackReport> {
  try {
    await p.assertHeld();
    let need = false;
    try {
      const m = await p.markers();
      need = m.B || m.U;
    } catch (e) {
      if (isRsiLockLost(e)) throw e;
      need = true;
    }
    if (!need) {
      try {
        const s = await p.readStateRaw();
        need = s.kind !== 'ok' || s.paused;
      } catch (e) {
        if (isRsiLockLost(e)) throw e;
        need = true;
      }
    }
    if (!need) return { kind: 'nothing' };
    return { kind: await muteDown(p) };
  } catch (e) {
    if (isRsiLockLost(e)) return lockLostReport;
    return { kind: 'threw', name: e instanceof Error ? e.name : typeof e };
  }
}

/** `state.json` 的读判:`missing`(合法,无熔断)/ `valid` / `schema`(整份不合规,含 confirm 不合规)/ `unreadable`(路径不安全 / I/O) */
export type S0StateKind = 'valid' | 'missing' | 'schema' | 'unreadable';

export interface S0Ports extends MuteLadderPorts {
  /** `breaker.enforceMute` 全量(补 B / 补码 / 删解除残留 / 静音);返回 canary 是否被静音 */
  enforceFull(): Promise<boolean>;
  stateKind(): Promise<S0StateKind>;
}

/**
 * S0:先读 state 形状;**整份不合规 / 读不出 → 不调 `enforceFull`(它会读写 state),直接走阶梯,`state.json` / 清单字节不变**;
 * 否则调 `enforceFull`,它抛错(state 写失败等)→ 再读一次形状定故障子码并走阶梯静音。rsi 失锁原样上抛;其余一律转成 `EnforceResult.fault`,**不抛**。
 */
export async function runEnforceLadder(p: S0Ports): Promise<EnforceResult> {
  const kindOf = async (): Promise<S0StateKind> => {
    try {
      return await p.stateKind();
    } catch (e) {
      if (isRsiLockLost(e)) throw e;
      return 'unreadable';
    }
  };
  const viaLadder = async (fault: SafetyFaultKind | null): Promise<EnforceResult> => {
    const mute = await muteDown(p);
    return { mute, fault: mute === 'unreliable' ? 'mute_unreliable' : fault };
  };
  const k1 = await kindOf();
  if (k1 === 'schema' || k1 === 'unreadable') return viaLadder('state_invalid:schema');
  try {
    const muted = await p.enforceFull();
    return { mute: muted ? 'muted' : 'nothing', fault: null };
  } catch (e) {
    if (isRsiLockLost(e)) throw e;
  }
  const k2 = await kindOf();
  const fault: SafetyFaultKind =
    k2 === 'missing'
      ? 'state_invalid:missing'
      : k2 === 'valid'
        ? 'safety_unavailable'
        : 'state_invalid:schema';
  return viaLadder(fault);
}

/**
 * `tripAndMute` 的包装(只在 state 写抛错时与 `breaker.ts` 的行为不同):逐码调用;任一码失败 → 仍走阶梯静音,**然后原样抛出第一个错误**;
 * rsi 失锁立即上抛(不再写)。全部成功 → `{ tripped, mute }`(mute = 收尾那一遍阶梯的结果)。
 */
export async function tripAndMuteGuarded(
  d: BreakerDeps,
  ladder: MuteLadderPorts,
  reasons: readonly TripReason[],
): Promise<TripResult> {
  let tripped = false;
  let first: unknown = null;
  let failed = false;
  for (const r of reasons) {
    try {
      const out = await tripAndMute(d, r);
      if (out.kind === 'tripped') tripped = true;
    } catch (e) {
      if (isRsiLockLost(e)) throw e;
      if (!failed) {
        failed = true;
        first = e;
      }
    }
  }
  // 无论成功与否都走一遍阶梯静音(幂等:已静音 = `nothing`);失败时先静音、再原样抛出第一个错误
  const mute = await muteDown(ladder);
  if (failed) throw first;
  return { tripped, mute };
}
