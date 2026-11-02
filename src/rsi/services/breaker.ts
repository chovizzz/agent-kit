/**
 * 熔断、L0 到期与预留窗口的纯函数(契约 R20-6.2 / R20-6.3 / R20-6.5 / R20-6.6 / R20-6.10;A3)。
 * 只经注入的时钟;不读盘、不写盘。poke、顺带调度、worker 与 `rsi status` 的现算口径都从这里取。
 */
import {
  RSI_BREAKER_MAX_FAILURES,
  RSI_BREAKER_OPEN_MS,
  RSI_L0_MIN_INTERVAL_MS,
  RSI_POKE_WINDOW_MS,
  type RsiOutcome,
  type RsiState,
} from '../../contracts/rsi.js';

/** R20-6.5 结果分类 */
export type OutcomeClass = 'success' | 'skip' | 'retryable' | 'safety';

const SUCCESS: ReadonlySet<RsiOutcome> = new Set(['ok', 'ok_partial']);
const RETRYABLE: ReadonlySet<RsiOutcome> = new Set(['io_error', 'crashed', 'internal']);
const SAFETY: ReadonlySet<RsiOutcome> = new Set([
  'state_invalid',
  'cursor_invalid',
  'counts_invalid',
  'snapshot_invalid',
  'journal_invalid',
  'signal_store_corrupt',
  'salt_invalid',
  'redactor_init',
  'write_denied',
  'lock_lost',
  'state_dir_unsafe',
  'purge_incomplete',
  'staging_too_large',
]);

export function classifyOutcome(o: RsiOutcome): OutcomeClass {
  if (SUCCESS.has(o)) return 'success';
  if (RETRYABLE.has(o)) return 'retryable';
  if (SAFETY.has(o)) return 'safety';
  return 'skip';
}

/** 熔断的现算视图(R20-6.6):`open` = 自动路径空操作;`half_open` = 允许一次尝试 */
export type BreakerView = 'closed' | 'open' | 'half_open';

export function breakerView(state: Pick<RsiState, 'breaker'> | null, nowMs: number): BreakerView {
  const b = state?.breaker ?? null;
  if (b === null) return 'closed';
  if (b.kind === 'safety' || b.until === null) return 'open';
  const until = Date.parse(b.until);
  // until 不可解析 → 按打开处理(fail-closed);时钟往回走(now < opened_at)仍以 until 判
  if (!Number.isFinite(until)) return 'open';
  return nowMs >= until ? 'half_open' : 'open';
}

/**
 * L0 是否到期(R20-6.3):从未完成过 → 到期;距上次完成 ≥ 6 小时 → 到期;时钟往回走(now < completed_at)→ 视为到期。
 * `completed_at` 不可解析 → 到期(下一次运行会重写它)。
 */
export function l0Due(state: Pick<RsiState, 'last_tick'> | null, nowMs: number): boolean {
  const last = state?.last_tick ?? null;
  if (last === null) return true;
  const at = Date.parse(last.completed_at);
  if (!Number.isFinite(at)) return true;
  if (nowMs < at) return true;
  return nowMs - at >= RSI_L0_MIN_INTERVAL_MS;
}

/** 预留 / 去重窗口序号:floor(now / 窗口) */
export function windowIndex(nowMs: number, windowMs: number = RSI_POKE_WINDOW_MS): number {
  return Math.floor(nowMs / windowMs);
}

/**
 * 一次 worker 运行结束后的熔断记账(R20-6.5 / R20-6.6)。`halfOpen`:本次是半开尝试。
 * - 成功:计数清零、熔断关闭。
 * - 正常跳过:原样不动。
 * - 可重试:连续失败 + 1;达到 3,或半开尝试失败 → 打开 24 小时,计数清零。
 * - 安全阻断:立即打开,`kind = safety`,`until = null`(不自动半开)。
 */
export function applyBreaker(
  prev: RsiState,
  outcome: RsiOutcome,
  now: Date,
  halfOpen: boolean,
): RsiState {
  const cls = classifyOutcome(outcome);
  if (cls === 'skip') return prev;
  if (cls === 'success') return { ...prev, breaker: null, consecutive_failures: 0 };
  if (cls === 'safety') {
    return {
      ...prev,
      breaker: { kind: 'safety', opened_at: now.toISOString(), until: null },
      consecutive_failures: 0,
    };
  }
  const n = prev.consecutive_failures + 1;
  if (halfOpen || n >= RSI_BREAKER_MAX_FAILURES) {
    return {
      ...prev,
      breaker: {
        kind: 'retryable',
        opened_at: now.toISOString(),
        until: new Date(now.getTime() + RSI_BREAKER_OPEN_MS).toISOString(),
      },
      consecutive_failures: 0,
    };
  }
  return { ...prev, consecutive_failures: n };
}
