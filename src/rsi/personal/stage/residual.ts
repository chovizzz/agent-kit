/**
 * §21 V1 装配块 C1b——**监测信号的判定内核**(C v2 §3.3;阈值取 `monitoring.ts` 的冻结常量;纯函数,无 I/O)。
 *
 * 只交付「判定」:输入是调用方探测好的只读事实(`peekRsiLock` / `log.jsonl` 末尾 / `state.json` / `canary.json` / B、U 的存在性)。
 * 采集端与承载入口:doctor 检查项 D18(§21 W0-29 ⑥;`src/doctor/rsi-residual.ts` 采集、`src/doctor/checks.ts` 的 `checkD18` 展示);本文件只做判定。
 */
import { MONITOR_THRESHOLDS } from './monitoring.js';

export type ResidualSignalId =
  'lock_starvation' | 'safety_breaker_inject' | 'p_heartbeat_approx' | 'state_written_not_muted';

export interface ResidualFacts {
  readonly nowMs: number;
  /** `peekRsiLock` 的结果(只关心 `held_over_ttl` / `stale`) */
  readonly lock: string;
  /** `log.jsonl` 末尾**连续**的 `skipped_locked` 行:条数与首尾时刻(无 = `count 0`) */
  readonly skippedLockedTail: {
    readonly count: number;
    readonly firstAtMs: number | null;
    readonly lastAtMs: number | null;
  };
  /** `state.json` 读出的事实;`null` = 读不出 / 缺失(信号按「不成立」处理,不臆测) */
  readonly state: {
    readonly breakerKind: 'safety' | 'other' | null;
    readonly breakerOpen: boolean;
    readonly pauseReasonsNonEmpty: boolean;
    readonly flagsSet: boolean;
    readonly lastTickCompletedAtMs: number | null;
    readonly rsiOn: boolean;
  } | null;
  /** `canary.json` 读出的事实;`null` = 文件缺失 / 不合法(hint 不会注入) */
  readonly canary: { readonly agentsInjectNonEmpty: boolean } | null;
  readonly markers: { readonly B: boolean; readonly U: boolean };
  /** 「hint 读已提交 state.json 的 auto_pause / diverged / owner_changed」是否已采纳:已采纳时第 4 个信号不计入 */
  readonly hintReadsPauseState: boolean;
}

export function evaluateSafetyResidual(f: ResidualFacts): readonly ResidualSignalId[] {
  const out: ResidualSignalId[] = [];
  const t = MONITOR_THRESHOLDS;
  const noMarker = !f.markers.B && !f.markers.U;
  const injecting = f.canary !== null && f.canary.agentsInjectNonEmpty;

  const tail = f.skippedLockedTail;
  if (
    (f.lock === 'held_over_ttl' || f.lock === 'stale') &&
    tail.count >= t.skippedLockedMinCount &&
    tail.firstAtMs !== null &&
    tail.lastAtMs !== null &&
    tail.lastAtMs - tail.firstAtMs >= t.skippedLockedMinSpanMs
  ) {
    out.push('lock_starvation');
  }
  if (f.state !== null && f.state.breakerKind === 'safety' && injecting && noMarker) {
    out.push('safety_breaker_inject');
  }
  if (
    f.state !== null &&
    f.state.rsiOn &&
    !f.state.breakerOpen &&
    f.state.lastTickCompletedAtMs !== null &&
    f.nowMs - f.state.lastTickCompletedAtMs > t.lastTickMaxAgeMs
  ) {
    out.push('p_heartbeat_approx');
  }
  if (
    !f.hintReadsPauseState &&
    f.state !== null &&
    (f.state.pauseReasonsNonEmpty || f.state.flagsSet) &&
    injecting &&
    noMarker
  ) {
    out.push('state_written_not_muted');
  }
  return out;
}
