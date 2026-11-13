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
 * **两个标记文件,各有唯一写者(W0-21)**:`AUTO_PAUSE`(U)只归用户命令;`AUTO_PAUSE_BREAKER`(B)只归 worker。worker 对 U 只有存在性读取({@link UserMarkerRead},类型上无写 / 删),
 * `user_paused` 的判据 = U 存在,worker **不再把它写进 state**;自动解除只删 B,所以「熔断 → 用户暂停 → 熔断恢复」之后 U 仍在、hint 仍停注入。
 * 落地三步,顺序固定:**① B 标记 → ② `state.json.auto_pause` → ③ `canary.json` 置为不注入**。hint 与 `exec-run` 只读两个标记(R21-6.10 / 6.11 第 4 行 / R21-16.2b),
 * 不读 `state.json`,所以标记必须最先落盘:此后任一时刻崩溃,worker 还没重启时下一次 hint 即停注入(`excluded` / `paused`)。崩溃后每次 worker 步骤调 {@link enforceMute}
 * 补做(幂等):有码缺 B → 补 B;有 B 缺码 → 用 B 里记的原因补码,**不删标记**(fail-closed);处于熔断(含 U 存在)→ 置 canary。
 * 解除侧对称:{@link applyAutoRelease} / {@link applyResume} 先写状态、后删 B(只在没有剩余码时删;**任何路径都不删 U**,U 的删除归 W8 `rsi auto resume`)。
 * **解除证据(W0-23)**:清空熔断码的那次状态写入同时记 `auto_pause.released_marker_id` = 被解除的 B 的实例标识 `id`({@link stampReleaseEvidence});`enforceMute` 见「B 在、状态无码」时,
 * `id` 与证据都是合规字符串且相等 = 解除窗口的残留 → 删 B、不补码;其余(证据缺 / null、B 无 id、不等)= 触发窗口 → 补码。B 内容里的 `at` 是墙钟时间(可回拨、可重复),只作展示 / 审计,**不参与任何判定**。W8 的 resume 只清状态、B 留给 worker 删,所以它的状态写入同样必须带证据。
 * `state.json` 的真实写入方(保留其它键、持 `rsi/lock`)在装配处注入 `PauseStatePort`(本块没有该写入方,见汇报「遗留」);标记的文件实现见 `canary/pause-marker.ts`。
 */
import {
  RSI_AUTO_PAUSE_REASON_PHASE,
  RSI_AUTO_PAUSE_REASONS,
  phaseAtLeast,
  type RsiAutoPauseReason,
} from '../../contracts/rsi.js';
import { utcDayDiff } from './transition-table.js';

/** B 实例标识的合规格式(与 `parsePauseMarker` 同一口径:16 位小写十六进制) */
const ID_RE = /^[0-9a-f]{16}$/;

export interface AutoPauseState {
  reasons: readonly RsiAutoPauseReason[];
  diverged: boolean;
  owner_changed: boolean;
  /**
   * 解除证据(W0-23;可选,缺键 = `null`):**清空熔断码的那一次状态写入**把它设为当时 B 文件内容里的实例标识 `id`(B 不存在 / 内容读不出 / 无 id = `null`),见 {@link stampReleaseEvidence}。
   * 持久事实「B 在、状态无码」有两种来源——触发窗口(B 已落盘、状态未写,应补码)与解除窗口(状态已清码、B 尚未删,不得复活):
   * {@link enforceMute} 以 B 的 `id` 与本字段相等判定后者(`at` 是墙钟时间,回拨 / 重复时会撞,不作身份)。新的熔断触发成功写入状态时清回 `null`({@link tripBreaker})。
   */
  released_marker_id?: string | null;
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

/** 是否处于 `auto_paused`(转移引擎的 `ctx.auto_paused`):任一熔断码、分叉 / 属主变化标志、或任一标记(U `AUTO_PAUSE` ∨ B `AUTO_PAUSE_BREAKER`)存在 */
export function isAutoPaused(s: AutoPauseState, anyMarkerPresent = false): boolean {
  return anyMarkerPresent || s.reasons.length > 0 || s.diverged || s.owner_changed;
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
  // 新触发清掉旧的解除证据(曾有证据时才写 `null`,没有证据的状态形状不变)
  const cleared =
    typeof s.released_marker_id === 'string' ? { released_marker_id: null } : ({} as const);
  return {
    kind: 'tripped',
    state: { ...s, ...cleared, reasons: ordered([...s.reasons, reason]) },
  };
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
): ReleaseResult {
  const released = s.reasons.filter((r) => RSI_AUTO_RELEASE_REASONS.has(r) && !stillHolds(r));
  const reasons = s.reasons.filter((r) => !released.includes(r));
  return {
    state: { ...s, reasons },
    released,
    clearMarker: released.length > 0 && reasons.length === 0,
  };
}

export interface ReleaseResult {
  state: AutoPauseState;
  released: RsiAutoPauseReason[];
  /** 没有任何剩余码且本次确有码被清:删 worker 写的 B(`AUTO_PAUSE_BREAKER`);U 不归 worker */
  clearMarker: boolean;
}

export interface ResumeResult {
  state: AutoPauseState;
  cleared: RsiAutoPauseReason[];
  /** 条件仍成立而保留的码(命令层:退出 1 `RSI_AUTO_RESUME_BLOCKED reason=<码>`);`reason` = 仍成立的那个码 */
  blocked: { code: RsiAutoPauseReason; reason: RsiAutoPauseReason }[];
  /** 没有任何剩余码且本次确有码被清:交给 worker 路径删 B(`applyResume`);仍有剩余码时 B 保留,hint 继续停注入。U 的删除不在这里(W8 命令层,带实例令牌) */
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
    // `user_paused` 的判据是 U 存在(W0-21),不是 state 码:resume 不据此清码,U 由命令层无条件处理
    if (code === 'user_paused') continue;
    const holding = RSI_RESUME_RECHECK[code].find((c) => stillHolds(c));
    if (holding !== undefined) blocked.push({ code, reason: holding });
    else cleared.push(code);
  }
  const reasons = s.reasons.filter((r) => !cleared.includes(r));
  return {
    state: { ...s, reasons },
    cleared,
    blocked,
    // B 只记 worker 熔断:历史遗留的 state 码 `user_paused` 不算「剩余的熔断码」
    clearMarker: cleared.length > 0 && reasons.every((r) => r === 'user_paused'),
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

/** B 标记的内容(只用于恢复,hint 只判存在):`by` = 谁写的;`reason` = 熔断码。`user` 只在解析历史 / 异常内容时出现(B 的写者只有 worker) */
export interface PauseMarker {
  by: 'user' | 'breaker' | 'unknown';
  reason: RsiAutoPauseReason | null;
  /** B 内容里的 `at`,**只作展示 / 审计,不参与任何判定**(墙钟时间可回拨 / 重复);读不出 = `null` */
  at: string | null;
  /** B 的实例标识(创建时生成的 16 位十六进制;解除证据的比较对象);缺失 / 格式不对 / 非 breaker 标记 = `null`(旧格式 B 永远是 null,不会被当残留删) */
  id: string | null;
}
/**
 * worker 熔断标记 `.state/rsi/AUTO_PAUSE_BREAKER`(B;R21-12.2、W0-21:独占创建,**不拿锁**,唯一写者 = worker)。
 * 与 `PauseStatePort` / `CanaryMutePort` 同一份契约:读失败 = 抛错(不返回「没有」冒充成功),写失败 = 抛错。
 */
export interface BreakerMarkerPort {
  /** 独占创建;已存在 = `exists`,**不覆盖** */
  ensure(reason: RsiAutoPauseReason): Promise<'created' | 'exists'>;
  /** 不存在 = null;存在但内容读不出 = `{by:'unknown'}`(仍算存在) */
  read(): Promise<PauseMarker | null>;
  /** 删 B;返回是否删了。只作用于 B,类型上没有指向 U 的参数 */
  remove(): Promise<boolean>;
}
/** worker 对用户标记 U(`.state/rsi/AUTO_PAUSE`)**只有**存在性读取:ENOENT = false,其它读失败抛错(不冒充「没有」) */
export interface UserMarkerRead {
  exists(): Promise<boolean>;
}
/** U 的实例令牌(`none` = 不存在);四项都取 `lstat(path, { bigint: true })`:`(dev, ino, size, mtimeNs)`(W0-22 第 1 条) */
export type UserMarkerToken = 'none' | { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint };
/**
 * U 的完整端口,**只给命令层**(W8 `rsi auto pause` / `resume`;本块不含命令):`ensureUser` 独占创建 `{at, by:"user"}`(已存在 = `exists`);
 * `remove(token)` 只在当前实例与 `snapshot()` 取得的令牌逐项相等时才删(令牌 `none` 永不删)。worker 的 {@link BreakerDeps.marker} 只收 {@link UserMarkerRead}。
 */
export interface UserMarkerPort extends UserMarkerRead {
  ensureUser(): Promise<'created' | 'exists'>;
  snapshot(): Promise<UserMarkerToken>;
  remove(token: UserMarkerToken): Promise<'removed' | 'changed' | 'absent'>;
}
export interface BreakerDeps {
  state: PauseStatePort;
  canary: CanaryMutePort;
  marker: { breaker: BreakerMarkerPort; user: UserMarkerRead };
  phase: number;
}

/** 触发:**先写 B 标记**、再写状态、后置 canary。已处于该码 → 仍补标记与 canary(幂等) */
export async function tripAndMute(d: BreakerDeps, reason: RsiAutoPauseReason): Promise<TripResult> {
  const cur = await d.state.read();
  const r = tripBreaker(cur, reason, d.phase);
  if (r.kind === 'phase_not_available') return r;
  await d.marker.breaker.ensure(reason);
  if (r.kind === 'tripped') await d.state.write(r.state);
  await d.canary.mute();
  return r;
}

/**
 * worker 每次拿锁后调(补做崩溃留下的窗口):
 *  - 有码而无 B → 补 B(hint 才看得到);
 *  - 有 B 而无码(B 已落盘、状态未写) → 用 B 里记的熔断原因补码,**不删标记**;**不再补 `user_paused`**(判据是 U 存在,不进 state);
 *  - 处于熔断(含 B / U 任一存在、分叉 / 属主变化标志)→ 确保 canary 不注入。
 * `anyMarkerPresent` 缺省由端口读出;调用方已读过时可直接传入(只能把「在」变成更强,不会掩盖端口读到的存在)。
 */
export async function enforceMute(d: BreakerDeps, anyMarkerPresent?: boolean): Promise<boolean> {
  let b = await d.marker.breaker.read();
  const userPresent = await d.marker.user.exists();
  let cur = await d.state.read();
  if (b !== null && b.by === 'breaker' && b.reason !== null) {
    // 只在状态里一个码都没有时才处理。状态里已有别的码时不补:
    // 标记只记首个原因,部分解除后那个原因可能已被合法清掉,不能因为标记还在就复活它
    if (cur.reasons.length === 0) {
      if (isReleasedResidue(b, cur)) {
        // 解除窗口:状态已清码(同一次写入记了这个 B 的 `id`)、B 尚未删(自动解除 / resume 在删 B 前崩溃,或 W8 resume 只清状态)。
        // 删 B,**不补码**;不碰 U。已知边界:残留 B 尚未删除时又发生新触发,`ensure` 因 B 已存在不重写,新码只靠状态写入持久;该次状态写入前崩溃 = 尚未触发
        await d.marker.breaker.remove();
        b = null;
      } else {
        // 触发窗口(标记已落盘、状态没写;证据缺 / 为旧值 / B 无 `id`):用 B 里记的原因补码
        const r = tripBreaker(cur, b.reason, d.phase);
        if (r.kind === 'tripped') {
          await d.state.write(r.state);
          cur = r.state;
        }
      }
    }
  }
  const present = b !== null || userPresent || anyMarkerPresent === true;
  const first = cur.reasons[0];
  if (b === null && first !== undefined) await d.marker.breaker.ensure(first);
  if (!isAutoPaused(cur, present)) return false;
  return d.canary.mute();
}

const isMarkerId = (x: unknown): x is string => typeof x === 'string' && ID_RE.test(x);

/** 状态无码时,B 是否是「已解除的残留」:B 的 `id` 与状态里的解除证据都是合规(16 位十六进制)字符串且相等(缺键 / `null` / 无 id / 格式错一律不等 → 按触发窗口处理,fail-closed);`at` 不参与 */
function isReleasedResidue(b: PauseMarker, s: AutoPauseState): boolean {
  const ev = s.released_marker_id;
  return isMarkerId(b.id) && isMarkerId(ev) && b.id === ev;
}

/**
 * 清空熔断码的那一次状态写入要带的解除证据:读当前 B 的 `id`(B 不存在 / 内容读不出 / 无 id = `null`),返回带证据的状态。
 * 调用方(自动解除、`applyResume`、W8 `rsi auto resume` 第 ④ 步)**必须**在「清到无剩余码」的状态写入里用它,再删 B(或留给 worker 删)。读 B 抛错就往外抛,不写状态。
 */
export async function stampReleaseEvidence(
  marker: Pick<BreakerMarkerPort, 'read'>,
  next: AutoPauseState,
): Promise<AutoPauseState> {
  const b = await marker.read();
  return { ...next, released_marker_id: b?.id ?? null };
}

/** 自动解除落地:先写状态、后删 B(没有剩余码时);U 无论如何不删 */
export async function applyAutoRelease(d: BreakerDeps, r: ReleaseResult): Promise<void> {
  // `released.length === 0` 时残留 B 的收拾统一由 `enforceMute` 做(worker 每次运行都会调到)
  if (r.released.length === 0) return;
  await d.state.write(
    r.clearMarker ? await stampReleaseEvidence(d.marker.breaker, r.state) : r.state,
  );
  if (r.clearMarker) await d.marker.breaker.remove();
}

/**
 * 人工 `resume` 的 worker 侧落地:先写状态、后删 B(没有剩余码时)。**不碰 U**:U 的删除归 W8 命令层(带实例令牌)。
 * B 内容读不出(创建后、写内容前进程被杀)而状态里没有熔断码:没有码可清,但这是 B 唯一的解除路径,照删。
 */
export async function applyResume(d: BreakerDeps, r: ResumeResult): Promise<void> {
  if (r.cleared.length > 0) {
    await d.state.write(
      r.clearMarker ? await stampReleaseEvidence(d.marker.breaker, r.state) : r.state,
    );
  }
  if (r.clearMarker) {
    await d.marker.breaker.remove();
    return;
  }
  if (r.state.reasons.every((x) => x === 'user_paused')) {
    const m = await d.marker.breaker.read();
    // B 的写者只有 worker:内容不是 `by=breaker`(读不出 / 异常)= 损坏
    if (m !== null && m.by !== 'breaker') await d.marker.breaker.remove();
  }
}
