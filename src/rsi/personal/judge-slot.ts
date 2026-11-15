/**
 * §21 V1 装配块 C1a——**W9 判决槽**(W9 设计 §4:「空槽由 C 段定义并带 `UNAVAILABLE_JUDGE` 默认实现」;W9b 只替换装配处注入的实现)。
 * **C 定义槽、W9 提供实现**:本文件只有槽的类型、缺省实现(不可用即拒绝)与跨信任边界的运行期校验包装;**不含**任何判决逻辑
 * (`evaluateJudgeSignal` / `ProposalJudgeSource` 归 W9a,本块不复制、不 import)。
 *
 * 约定(W9 §2 / §4):
 *  - `check` 每次**现算**(一次读),不用 S2 缓存;`ok` 仅当结果为确定的 `none` 且无 signal;**缺能力 / 未装配 / 读失败 = 拒绝,绝不缺省为通过**;
 *  - `check` 抛错 / 超时 / 返回非法值 → 一律 `judge_indeterminate`(`checkJudgeGrowth`);
 *  - `source_proposal` 为 null / 缺失的候选:`check` 视为 `ok`(契约:null = 不消费)——**来源缺失由 `evaluateGrowth` 的 G6 另行拒绝**(`source_unknown`),两项各自独立;
 *  - 默认 `UNAVAILABLE_JUDGE`:`run` 空操作并报告 `unavailable: true`;`check` 对带 `source_proposal` 者恒 `judge_unavailable`。
 *    故 D 可先于 W9b 合并,但 D 合并后带非空 `source_proposal` 的候选都无法进 canary,直到 W9b 合入。
 * 冻结:合并后改动 = 回主代理。
 */
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';
import type { StepHalt } from './candidate-ports.js';

export const JUDGE_GROWTH_DENY_CODES = Object.freeze([
  'judge_unavailable',
  'judge_indeterminate',
  'judge_signal_pending',
] as const);
export type JudgeGrowthDeny = (typeof JUDGE_GROWTH_DENY_CODES)[number];
export type JudgeGrowthVerdict =
  { readonly ok: true } | { readonly ok: false; readonly code: JudgeGrowthDeny };

/**
 * `run` 的报告(W9 §4 的 `JudgeReduceReport`,加 `unavailable`——W9 设计稿的形状没有承载「报告 unavailable」的字段,而默认实现要求它)。
 * `halted`:丢锁、仓库完整性(`repo_invalid` / `commit_failed`)、权威状态不明一律写进它并停止本步,不得被逐候选容错吞掉;进入 `classify` / `classifyHalt`。
 */
export interface JudgeReduceReport {
  readonly evaluated: number;
  readonly transitioned: readonly string[];
  readonly blocked: readonly { readonly id: string; readonly code: JudgeGrowthDeny }[];
  readonly deferred: readonly { readonly id: string; readonly why: string }[];
  readonly halted: StepHalt | null;
  readonly unavailable: boolean;
}

/** S2P 4b 与 `runPersonalStep` ④-⑤ 之间;持 rsi + personal 锁;不受 `enabled` / 暂停 / L0 节流影响 */
export interface JudgeReduceSlot {
  run(a: { readonly ids?: readonly string[] }): Promise<JudgeReduceReport>;
}
/** D 的 `GrowthVerdict` 第 8 项(G8) */
export interface JudgeGrowthSlot {
  check(rec: PersonalLifecycleRecord): Promise<JudgeGrowthVerdict>;
}
export interface JudgeSlots {
  readonly reduce: JudgeReduceSlot;
  readonly growth: JudgeGrowthSlot;
}

const EMPTY_UNAVAILABLE: JudgeReduceReport = Object.freeze({
  evaluated: 0,
  transitioned: Object.freeze([]) as readonly string[],
  blocked: Object.freeze([]) as JudgeReduceReport['blocked'],
  deferred: Object.freeze([]) as JudgeReduceReport['deferred'],
  halted: null,
  unavailable: true,
});

/** 缺省实现(未装配 W9b):减影响侧空操作并报告 `unavailable`;增影响侧对带来源的候选恒拒绝 */
export const UNAVAILABLE_JUDGE: JudgeSlots = Object.freeze({
  reduce: Object.freeze({
    run: (): Promise<JudgeReduceReport> => Promise.resolve(EMPTY_UNAVAILABLE),
  }),
  growth: Object.freeze({
    check: (rec: PersonalLifecycleRecord): Promise<JudgeGrowthVerdict> =>
      Promise.resolve(
        rec.source_proposal === null || rec.source_proposal === undefined
          ? { ok: true }
          : { ok: false, code: 'judge_unavailable' },
      ),
  }),
});

/** W9 设计:每次评估 2 s 预算(超时 = `judge_indeterminate`) */
export const JUDGE_CHECK_TIMEOUT_MS = 2000;

const DENY_SET: ReadonlySet<string> = new Set(JUDGE_GROWTH_DENY_CODES);

/** `StepHalt` 的运行期全集(`Record` 保证与类型穷尽一致:新增 / 删除成员即类型错误) */
const STEP_HALTS: Readonly<Record<StepHalt, true>> = Object.freeze({
  repo_absent: true,
  repo_deferred: true,
  repo_invalid: true,
  revocations_invalid: true,
  commit_failed: true,
  candidate_invalid: true,
  lock_lost: true,
});

/** 跨信任边界校验:只认 `{ok:true}` 与 `{ok:false, code ∈ 三码}`;其余 → null */
export function normalizeJudgeVerdict(v: unknown): JudgeGrowthVerdict | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { ok?: unknown; code?: unknown };
  if (o.ok === true) return { ok: true };
  if (o.ok === false && typeof o.code === 'string' && DENY_SET.has(o.code)) {
    return { ok: false, code: o.code as JudgeGrowthDeny };
  }
  return null;
}

/**
 * `check` 的运行期包装(D 在两处调它,不直接调槽):抛错 / 超时 / 非法值 / 读取 `check` 属性抛错 → `judge_indeterminate`。永不抛。
 * 槽对象本身缺失 / 无 `check` 方法(未装配)→ `judge_unavailable`。
 * 限制(不是硬时限):超时预算只约束**异步等待**,打断不了同步阻塞,也不会取消已启动的检查(其结果被丢弃)。
 */
export async function checkJudgeGrowth(
  slot: JudgeGrowthSlot | undefined | null,
  rec: PersonalLifecycleRecord,
  opts: { readonly timeoutMs?: number } = {},
): Promise<JudgeGrowthVerdict> {
  if (slot === undefined || slot === null) return { ok: false, code: 'judge_unavailable' };
  // 跨信任边界:`check` 只读取**一次**(getter / Proxy 的读取异常也收敛成拒绝),调用时保留 receiver
  let check: unknown;
  try {
    check = (slot as { check?: unknown }).check;
  } catch {
    return { ok: false, code: 'judge_indeterminate' };
  }
  if (typeof check !== 'function') return { ok: false, code: 'judge_unavailable' };
  const timeoutMs = opts.timeoutMs ?? JUDGE_CHECK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const r = await Promise.race([
      (check as (r: PersonalLifecycleRecord) => unknown).call(slot, rec),
      timeout,
    ]);
    if (r === 'timeout') return { ok: false, code: 'judge_indeterminate' };
    return normalizeJudgeVerdict(r) ?? { ok: false, code: 'judge_indeterminate' };
  } catch {
    return { ok: false, code: 'judge_indeterminate' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `run` 返回值的运行期校验;非法 → null(调用方记 `judge_report_invalid` 故障、本轮不信任该报告) */
export function normalizeJudgeReport(r: unknown): JudgeReduceReport | null {
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  const strs = (a: unknown): a is string[] =>
    Array.isArray(a) && a.every((x) => typeof x === 'string');
  if (typeof o['evaluated'] !== 'number' || !Number.isInteger(o['evaluated']) || o['evaluated'] < 0)
    return null;
  if (!strs(o['transitioned'])) return null;
  const blocked = o['blocked'];
  if (!Array.isArray(blocked)) return null;
  const blockedOut: { id: string; code: JudgeGrowthDeny }[] = [];
  for (const b of blocked as unknown[]) {
    const x = b as { id?: unknown; code?: unknown } | null;
    if (typeof x !== 'object' || x === null) return null;
    if (typeof x.id !== 'string' || typeof x.code !== 'string' || !DENY_SET.has(x.code))
      return null;
    blockedOut.push({ id: x.id, code: x.code as JudgeGrowthDeny });
  }
  const deferred = o['deferred'];
  if (!Array.isArray(deferred)) return null;
  const deferredOut: { id: string; why: string }[] = [];
  for (const d of deferred as unknown[]) {
    const x = d as { id?: unknown; why?: unknown } | null;
    if (typeof x !== 'object' || x === null) return null;
    if (typeof x.id !== 'string' || typeof x.why !== 'string') return null;
    deferredOut.push({ id: x.id, why: x.why });
  }
  const halted = o['halted'];
  if (halted !== null && typeof halted !== 'string') return null;
  // 未知 halted 值 = 完整性不明:规范化为 `candidate_invalid`(进 `classifyHalt` 即「停本步并 unsettled」),不把任意字符串包装成合法 `StepHalt`;`lock_lost` 原样透传
  const haltedOut: StepHalt | null =
    halted === null
      ? null
      : Object.hasOwn(STEP_HALTS, halted)
        ? (halted as StepHalt)
        : 'candidate_invalid';
  if (typeof o['unavailable'] !== 'boolean') return null;
  return {
    evaluated: o['evaluated'],
    transitioned: [...(o['transitioned'] as string[])],
    blocked: blockedOut,
    deferred: deferredOut,
    halted: haltedOut,
    unavailable: o['unavailable'],
  };
}
