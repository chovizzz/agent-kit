/**
 * 熔断 `auto_paused`(docs/contracts.md R21-10.1 – 10.4、R21-2.2)。**纯判定 + 窄端口**:
 *  - 任一触发即进入 `auto_paused`:「增加影响」的转移(`shadow → canary`、`→ injected`,转移引擎的 `ctx.auto_paused`)全部禁止,**减少影响的转移与撤销路径不受阻挡**
 *    (引擎的回滚行 / 执行器都不读它);`lifecycle` 不变,解除后恢复注入。
 *  - 码表 `RSI_AUTO_PAUSE_REASONS`(写进 `state.json.auto_pause.reasons`,可同时存在多个);**按期过滤**:`RSI_AUTO_PAUSE_REASON_PHASE` 晚于当前相位的码(V2 的 `apply_failed`、V6b 的 `isolation_unverified`)本期不发。
 *  - 自动解除(worker 持锁重查条件):`budget_high_legacy` / `cost_high_legacy` / `no_observation` / `isolation_unverified`;其余只能 `rsi auto resume`(人工)解除,
 *    条件仍成立的码保留并报 `RSI_AUTO_RESUME_BLOCKED reason=<码>`(R21-10.4)。`rollback_storm` / `gate_internal` 的 resume 重查
 *    `gate_internal`、`apply_failed`、`personal_repo_invalid`、`budget_high_legacy` 四项。
 *  - `personal_repo_diverged` / `personal_owner_changed` 不是熔断码(R21-10.3):单独的 `diverged` / `owner_changed` 标志,`resume` 不动它们(用 `rebase-baseline` 或回到记录提交解除),但同样只阻挡增加影响。
 *  - 「30 个 UTC 日内」「7 个 UTC 日内」按 W0-16 的日期差口径:`今天 − 事件日 < N`(含今天,今天往前 N−1 天)。
 * 写入 `state.json` 的 `auto_pause` 与 `canary.json` 置为不注入是两步:**先写状态、后置 canary**,崩溃后每次 worker 步骤调 {@link enforceMute} 补做(幂等),
 * 所以「状态已写、canary 未置」的窗口不会留下无熔断保护的注入。`state.json` 的真实写入方(保留其它键、持 `rsi/lock`)在装配处注入 `PauseStatePort`(本块没有该写入方,见汇报「遗留」)。
 */
import {
  RSI_AUTO_PAUSE_REASON_PHASE,
  RSI_AUTO_PAUSE_REASONS,
  phaseAtLeast,
  type RsiAutoPauseReason,
} from '../../contracts/rsi.js';
import { utcDayDiff } from './transition-table.js';

export interface AutoPauseState {
  reasons: readonly RsiAutoPauseReason[];
  diverged: boolean;
  owner_changed: boolean;
}
export const NO_PAUSE: AutoPauseState = Object.freeze({
  reasons: Object.freeze([]) as readonly RsiAutoPauseReason[],
  diverged: false,
  owner_changed: false,
});

/** 自动解除的码(worker 持锁重查条件;不需要也不接受 `resume`) */
export const RSI_AUTO_RELEASE_REASONS: ReadonlySet<RsiAutoPauseReason> =
  new Set<RsiAutoPauseReason>([
    'budget_high_legacy',
    'cost_high_legacy',
    'no_observation',
    'isolation_unverified',
  ]);

/** `resume` 时要重查的码(R21-10.2 解除列):`rollback_storm` / `gate_internal` 同一组四项;`apply_failed` / `personal_repo_invalid` 重查自己;其余无条件可解 */
const RESUME_RECHECK_FOUR: readonly RsiAutoPauseReason[] = Object.freeze([
  'gate_internal',
  'apply_failed',
  'personal_repo_invalid',
  'budget_high_legacy',
]);
export const RSI_RESUME_RECHECK: Readonly<
  Record<RsiAutoPauseReason, readonly RsiAutoPauseReason[]>
> = Object.freeze({
  rollback_storm: RESUME_RECHECK_FOUR,
  gate_internal: RESUME_RECHECK_FOUR,
  apply_failed: Object.freeze(['apply_failed'] as const),
  personal_repo_invalid: Object.freeze(['personal_repo_invalid'] as const),
  budget_high_legacy: Object.freeze([]),
  cost_high_legacy: Object.freeze([]),
  no_observation: Object.freeze([]),
  redaction_changed: Object.freeze([]),
  user_vetoes: Object.freeze([]),
  kit_major_changed: Object.freeze([]),
  user_paused: Object.freeze([]),
  isolation_unverified: Object.freeze([]),
});

/** 是否处于 `auto_paused`(转移引擎的 `ctx.auto_paused`):任一熔断码、分叉 / 属主变化标志、或 `AUTO_PAUSE` 标记存在 */
export function isAutoPaused(s: AutoPauseState, autoPauseMarker = false): boolean {
  return autoPauseMarker || s.reasons.length > 0 || s.diverged || s.owner_changed;
}

const ordered = (rs: Iterable<RsiAutoPauseReason>): RsiAutoPauseReason[] => {
  const set = new Set(rs);
  return RSI_AUTO_PAUSE_REASONS.filter((r) => set.has(r));
};

export type TripResult =
  | { kind: 'tripped'; state: AutoPauseState }
  | { kind: 'already'; state: AutoPauseState }
  /** 码的最早期晚于当前相位:本期不发(V2 / V6b 的码) */
  | { kind: 'phase_not_available'; state: AutoPauseState };

export function tripBreaker(
  s: AutoPauseState,
  reason: RsiAutoPauseReason,
  phase: number,
): TripResult {
  if (!phaseAtLeast(RSI_AUTO_PAUSE_REASON_PHASE[reason], phase)) {
    return { kind: 'phase_not_available', state: s };
  }
  if (s.reasons.includes(reason)) return { kind: 'already', state: s };
  return { kind: 'tripped', state: { ...s, reasons: ordered([...s.reasons, reason]) } };
}

// --- 触发条件(纯判定) ---
export const ROLLBACK_STORM_WINDOW_DAYS = 30;
export const ROLLBACK_STORM_AUTO_ROLLBACKS = 3;
export const ROLLBACK_STORM_PROXY_EVENTS = 2;
export const USER_VETOES_WINDOW_DAYS = 7;
export const USER_VETOES_MIN = 2;
export const NO_OBSERVATION_DAYS = 7;
export const BUDGET_HIGH_LEGACY_PCT = 90;

const within = (day: string, today: string, n: number): boolean => {
  const diff = utcDayDiff(today, day);
  return diff >= 0 && diff < n;
};
const countWithin = (days: readonly string[], today: string, n: number): number =>
  days.filter((d) => within(d, today, n)).length;

export interface TriggerFacts {
  /** `YYYY-MM-DD`(UTC) */
  today: string;
  /** 自动回滚(`target_terminal=rolled_back` 且原因为 `harm_*`)发生的 UTC 日 */
  autoRollbackDays: readonly string[];
  /** R21-7.12 上线代理事件发生的 UTC 日 */
  proxyEventDays: readonly string[];
  /** `rsi veto` 发生的 UTC 日 */
  vetoDays: readonly string[];
  /** 最近一个有观测会话的 UTC 日;`null` = 从未有过 */
  lastObservedDay: string | null;
  /** L0 有运行记录 */
  l0HasRuns: boolean;
  /** 自动配额占用百分比;`causedByThisLoop` = 本代循环造成 */
  budgetUsedPct: number;
  budgetCausedByThisLoop: boolean;
  /** M11 注入 / 常驻上限遗留超限 */
  costOverLegacy: boolean;
}

export const rollbackStorm = (
  f: Pick<TriggerFacts, 'today' | 'autoRollbackDays' | 'proxyEventDays'>,
): boolean =>
  countWithin(f.autoRollbackDays, f.today, ROLLBACK_STORM_WINDOW_DAYS) >=
    ROLLBACK_STORM_AUTO_ROLLBACKS ||
  countWithin(f.proxyEventDays, f.today, ROLLBACK_STORM_WINDOW_DAYS) >= ROLLBACK_STORM_PROXY_EVENTS;
export const userVetoes = (f: Pick<TriggerFacts, 'today' | 'vetoDays'>): boolean =>
  countWithin(f.vetoDays, f.today, USER_VETOES_WINDOW_DAYS) >= USER_VETOES_MIN;
export const noObservation = (
  f: Pick<TriggerFacts, 'today' | 'lastObservedDay' | 'l0HasRuns'>,
): boolean =>
  f.l0HasRuns &&
  (f.lastObservedDay === null || utcDayDiff(f.today, f.lastObservedDay) >= NO_OBSERVATION_DAYS);
export const budgetHighLegacy = (
  f: Pick<TriggerFacts, 'budgetUsedPct' | 'budgetCausedByThisLoop'>,
): boolean => f.budgetUsedPct >= BUDGET_HIGH_LEGACY_PCT && !f.budgetCausedByThisLoop;

/** 由事实可直接算出的码(其余码 —— `gate_internal`、`personal_repo_invalid`、`redaction_changed`、`kit_major_changed`、`user_paused` 等 —— 由各自的发现点直接 `tripBreaker`) */
export function evaluateTriggers(f: TriggerFacts): RsiAutoPauseReason[] {
  const out: RsiAutoPauseReason[] = [];
  if (rollbackStorm(f)) out.push('rollback_storm');
  if (userVetoes(f)) out.push('user_vetoes');
  if (noObservation(f)) out.push('no_observation');
  if (budgetHighLegacy(f)) out.push('budget_high_legacy');
  if (f.costOverLegacy) out.push('cost_high_legacy');
  return ordered(out);
}

// --- 解除 ---
/** worker 自动解除:只清自动解除码里**条件已不成立**的;人工码与 `diverged` / `owner_changed` 不动 */
export function autoRelease(
  s: AutoPauseState,
  stillHolds: (r: RsiAutoPauseReason) => boolean,
): { state: AutoPauseState; released: RsiAutoPauseReason[] } {
  const released = s.reasons.filter((r) => RSI_AUTO_RELEASE_REASONS.has(r) && !stillHolds(r));
  return {
    state: { ...s, reasons: s.reasons.filter((r) => !released.includes(r)) },
    released,
  };
}

export interface ResumeResult {
  state: AutoPauseState;
  cleared: RsiAutoPauseReason[];
  /** 条件仍成立而保留的码(命令层:退出 1 `RSI_AUTO_RESUME_BLOCKED reason=<码>`);`reason` = 仍成立的那个码 */
  blocked: { code: RsiAutoPauseReason; reason: RsiAutoPauseReason }[];
  /** `user_paused` 被清:命令层同时删除 `AUTO_PAUSE` 标记 */
  clearMarker: boolean;
}

/** `rsi auto resume`:只清可人工解除的码;自动解除码交给 worker;`diverged` / `owner_changed` 不动 */
export function resume(
  s: AutoPauseState,
  stillHolds: (r: RsiAutoPauseReason) => boolean,
): ResumeResult {
  const cleared: RsiAutoPauseReason[] = [];
  const blocked: ResumeResult['blocked'] = [];
  for (const code of s.reasons) {
    if (RSI_AUTO_RELEASE_REASONS.has(code)) continue;
    const holding = RSI_RESUME_RECHECK[code].find((c) => stillHolds(c));
    if (holding !== undefined) blocked.push({ code, reason: holding });
    else cleared.push(code);
  }
  return {
    state: { ...s, reasons: s.reasons.filter((r) => !cleared.includes(r)) },
    cleared,
    blocked,
    clearMarker: cleared.includes('user_paused'),
  };
}

// --- 落地:状态 + canary 置为不注入 ---
export interface PauseStatePort {
  read(): Promise<AutoPauseState>;
  /** 经 `state.json` 的唯一写入方(保留其它键、持 `rsi/lock`);失败抛错 */
  write(s: AutoPauseState): Promise<void>;
}
export interface CanaryMutePort {
  /** `muteCanary`(持 `rsi/lock`):写了返回 true;无事可做 false(幂等) */
  mute(): Promise<boolean>;
}
export interface BreakerDeps {
  state: PauseStatePort;
  canary: CanaryMutePort;
  phase: number;
}

/** 触发:先写状态、后置 canary。已处于该码 → 只补做 canary 的置位(幂等) */
export async function tripAndMute(d: BreakerDeps, reason: RsiAutoPauseReason): Promise<TripResult> {
  const cur = await d.state.read();
  const r = tripBreaker(cur, reason, d.phase);
  if (r.kind === 'phase_not_available') return r;
  if (r.kind === 'tripped') await d.state.write(r.state);
  await d.canary.mute();
  return r;
}

/** worker 每次拿锁后调:处于熔断就确保 canary 不注入(补做崩溃留下的窗口) */
export async function enforceMute(d: BreakerDeps, autoPauseMarker = false): Promise<boolean> {
  const cur = await d.state.read();
  if (!isAutoPaused(cur, autoPauseMarker)) return false;
  return d.canary.mute();
}
