/**
 * §21 V1 装配块 C2——只减影响的候选步骤,从 `candidate-step.ts` **无行为变化地抽出**(C v1 §1「reduce-step」行 / v2 §11.1):
 *  - `makeStepRunner`:原 `runPersonalStep` 里的 `run` 闭包(应用一个事件、归类结果、丢锁立即中止);
 *  - `reconcileRevocationLines`:原 ② 撤销凭据对账(proposed / shadow;终态上的 veto 仍补黑名单);
 *  - `shadowQueueExpiredEvent` / `expireShadowQueues`:原 ⑥ 里「排队到期先于一切」的那一支(到期属减影响类,不走授权令牌)。
 *
 * 依赖方向**只有** `candidate-step.ts → reduce-step.ts`:本文件不 import `candidate-step.ts`(否则 `runPersonalStep` 会经 worker 的个人步闭包进入生产装配)。
 * S2(`steps/s2-reduce.ts`)与 `runPersonalStep` 共用这里的逻辑,所以两条路径的对账 / 到期语义不会漂移。
 */
import { createHash } from 'node:crypto';
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
  RsiRevocationLine,
} from '../../contracts/rsi-personal.js';
import { canonicalJson } from '../../io/canonical-json.js';
import { RsiLockError } from '../lock-error.js';
import { applyEvent, type ApplyDeps } from './candidate-apply.js';
import type { GrowthClaimOp, StepHalt } from './candidate-ports.js';
import { growthOpOfEvent } from './growth-events.js';
import {
  isTerminalLifecycle,
  queueExpired,
  utcDay,
  type TransitionEvent,
} from './transition-table.js';

const digest = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** 撤销凭据的原因 → 对账事件的依据(显式映射;不在表里的原因不对账) */
export const RECONCILE_BASIS: Readonly<
  Record<string, 'veto' | 'taint' | 'clear' | 'judge_reject' | undefined>
> = Object.freeze({
  vetoed: 'veto',
  tainted: 'taint',
  cleared: 'clear',
  judge_reject: 'judge_reject',
  judge_injection: 'judge_reject',
});

/** 提交成功后写回工作副本的补丁(可选) */
export type WcAfter = (wc: CandidateWorkingCopy | undefined) => CandidateWorkingCopy | undefined;

/** 步骤运行器会写的那一部分结果(`StepResult` 的结构化子集;不 import candidate-step) */
export interface RunnerOut {
  halted: StepHalt | null;
  breaker: 'gate_internal' | 'personal_repo_invalid' | null;
  effectsFailed: string[];
  transitions: string[];
  /**
   * 增影响事件被拒的记录(D1b-2;可选):**给了它的运行器**(`runPersonalStep`)把 `growth_denied` 记在这里并返回 `other`——被拒的增影响动作不得中止减影响子步骤
   * (到期 / no_hit / 对账 / 收紧类转移照常);**没给的运行器**(S2 只减影响,不会遇到)把它当 halt(fail-closed,不吞)。
   */
  growthDenied?: { op: GrowthClaimOp | 'unmappable'; code: string }[];
}

export type RunOutcome = 'transitioned' | 'other' | 'halt';
export type StepRunner = (
  rec: PersonalLifecycleRecord,
  event: TransitionEvent,
  wcAfter?: WcAfter,
) => Promise<RunOutcome>;

/**
 * 应用一个事件并归类:`halt` = 之后的子步骤都不做(已提交的转移保留)。
 * 抛出 = 提交之前(或提交本身)失败:锁丢失立即中止;其它错误不吞,向上抛(提交后的落地失败由 `applyEvent` 内部分类,不会到这里)。
 */
export function makeStepRunner(
  d: ApplyDeps,
  working: Map<string, CandidateWorkingCopy>,
  out: RunnerOut,
): StepRunner {
  return async (rec, event, wcAfter) => {
    let r;
    try {
      r = await applyEvent(d, rec, event, wcAfter, working.get(rec.id));
    } catch (e) {
      // 抛出 = 提交之前(或提交本身)失败:锁丢失立即中止;其它错误不吞,向上抛(提交后的落地失败由 applyEvent 内部分类,不会到这里)
      if (e instanceof RsiLockError && e.kind === 'lock_lost') {
        out.halted = 'lock_lost';
        return 'halt';
      }
      throw e;
    }
    // 只对**已分类的增影响事件**降级为记录;减影响事件(`op === null`)不带钩子,出现 growth_denied = 底座违约,走下面的 halt(fail-closed)
    const growthOp = growthOpOfEvent(event.kind);
    if (
      r.kind === 'halt' &&
      r.halt === 'growth_denied' &&
      out.growthDenied !== undefined &&
      growthOp !== null
    ) {
      out.growthDenied.push({ op: growthOp, code: r.why ?? 'unknown' });
      return 'other';
    }
    if (r.kind === 'halt') {
      out.halted = r.halt;
      if (r.halt === 'repo_invalid') out.breaker = 'personal_repo_invalid';
      return 'halt';
    }
    if (r.kind === 'transitioned') {
      if (r.effectsFailed !== undefined) out.effectsFailed.push(`${rec.id}:${r.effectsFailed}`);
      if (r.lockLost === true) {
        out.halted = 'lock_lost';
        out.transitions.push(`${rec.id}: ${rec.lifecycle} -> ${r.next.lifecycle}`);
        return 'halt';
      }
      out.transitions.push(`${rec.id}: ${rec.lifecycle} -> ${r.next.lifecycle}`);
      const w = wcAfter?.(working.get(rec.id));
      if (w !== undefined) working.set(rec.id, w);
      return 'transitioned';
    }
    return 'other';
  };
}

/** 对账的结果(`StepResult` 的结构化子集) */
export interface ReconcileOut {
  unmappedRevocations: string[];
  reconcileIncomplete: boolean;
  reconciled: string[];
}

/** 对账事件的证据串(凭据行的规范 JSON 哈希前 16 位;同一凭据恒得同一证据 = 重放幂等) */
export const reconcileEvidence = (line: RsiRevocationLine): string =>
  `revocation:${digest(canonicalJson(line)).slice(0, 16)}`;

/**
 * 撤销凭据对账(proposed / shadow):凭据列出的非终态候选推进到终态;终态上的 `vetoed` 仍补黑名单(R21-4.4a ②)。
 * 返回 `halt` = 步骤中止(`out.halted` 已由运行器写入),调用方立即返回。
 */
export async function reconcileRevocationLines(
  run: StepRunner,
  records: readonly PersonalLifecycleRecord[],
  lines: readonly RsiRevocationLine[],
  out: ReconcileOut,
): Promise<'ok' | 'halt'> {
  for (const line of lines) {
    const rec = records.find(
      (r) => r.id === line.candidate_id && r.content_sha256 === line.content_sha256,
    );
    if (rec === undefined) continue;
    if (isTerminalLifecycle(rec.lifecycle)) {
      // R21-4.4a ②:终态上的 veto 仍要写黑名单(效果幂等;其余终止事件对终态无事可做)
      if (line.reason === 'vetoed') {
        const r = await run(rec, {
          kind: 'veto',
          evidence: reconcileEvidence(line),
        });
        if (r === 'halt') return 'halt';
      }
      continue;
    }
    if (rec.lifecycle !== 'proposed' && rec.lifecycle !== 'shadow') continue; // canary 及以上归 V1b / W7
    const evidence = reconcileEvidence(line);
    // R21-9.5:对账转移的原因是 revocation_reconciled;终态理由按凭据依据显式映射(未知依据不兜底成 clear:
    // 记 unmappedRevocations,不转移——撤销凭据本身已让该候选不得被推进,见 ctx.revocation_listed)
    const basis = RECONCILE_BASIS[line.reason];
    if (basis === undefined) {
      out.unmappedRevocations.push(rec.id);
      out.reconcileIncomplete = true;
      continue;
    }
    const r = await run(rec, { kind: 'revocation_reconcile', evidence, basis });
    if (r === 'halt') return 'halt';
    if (r === 'transitioned') out.reconciled.push(rec.id);
  }
  return 'ok';
}

/** shadow 排队到期事件(W0-13 ①:到期先于一切,只依赖 `queued_since` 与日期);调用方先用 `queueExpired` 判到期 */
export function shadowQueueExpiredEvent(wc: CandidateWorkingCopy, today: string): TransitionEvent {
  return {
    kind: 'shadow_queue_expired',
    evidence: `shadow:${today}`,
    queued_since: wc.shadow.queued_since,
  };
}

/**
 * S2 的到期支:对每个 shadow 候选的工作副本,排队到期则转移(减影响类,不走授权令牌、不受暂停限制)。
 * 与 `runPersonalStep` ⑥ 里的同名分支同一事件构造(`shadowQueueExpiredEvent`)。
 */
export async function expireShadowQueues(
  run: StepRunner,
  records: readonly PersonalLifecycleRecord[],
  working: ReadonlyMap<string, CandidateWorkingCopy>,
  nowIso: string,
): Promise<'ok' | 'halt'> {
  const today = utcDay(nowIso);
  for (const rec of [...records].filter((r) => r.lifecycle === 'shadow').sort(byId)) {
    const wc = working.get(rec.id);
    if (wc === undefined) continue;
    if (!queueExpired(wc.shadow.queued_since, today)) continue;
    const r = await run(rec, shadowQueueExpiredEvent(wc, today), (w) =>
      w === undefined
        ? undefined
        : {
            ...w,
            shadow: {
              ...w.shadow,
              canary_ready_since: wc.shadow.canary_ready_since,
              queued_since: wc.shadow.queued_since,
            },
          },
    );
    if (r === 'halt') return 'halt';
  }
  return 'ok';
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
