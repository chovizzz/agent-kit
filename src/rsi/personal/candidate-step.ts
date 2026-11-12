/**
 * W3 worker 侧推进入口 `runPersonalStep`(docs/contracts.md §21.24 W0-13 / W0-16、R21-9.5 的 V1a 部分、R21-5.2)。
 * **调用方必须已持 `personal/lock`**(正常路径另持 `rsi/lock`);本函数的每个写出口前都经 W2 的提交底座断言锁。一次调用依次:
 *  ① 入口清零:W0-13 列出的入口事件之后的第一个持锁步先清空全部 `queued_since`(M13-5);
 *  ② 撤销凭据对账(proposed / shadow 的部分;canary 及其缓存归 V1b / W7):凭据列出的非终态候选推进到终态;凭据读不到 → 中止、不授予任何影响;
 *  ③ 缺工作副本者按权威记录重建(R21-3.8);
 *  ④ 创建新候选 `(无) → proposed`(W0-6);
 *  ⑤ 对每个 proposed 跑 G0–G7:全过 → shadow,红 → rejected,G7 → 留在 proposed,闸内部错误 → `gate_internal` 熔断(不记 rejected);
 *  ⑥ shadow 步:先到期(M13-6)、再资格(M13-1)、再名额(M13-4,锁内按权威记录现算)、多个具备资格按 `(canary_ready_since, id)` 取队首(M13-7 只排序),
 *     推进前**重读**权威记录 / 撤销凭据 / 环境再判一次(M13-2),不使用锁外的检查结果。
 * 中止(`halted`)= 之后的子步骤都不做,已提交的转移保留。创建与转移都是「先提交权威副本、后写工作副本」,崩溃后下一次调用按权威副本续做。
 */
import { createHash } from 'node:crypto';
import { RSI_SHADOW_MIN_HITS, RSI_SHADOW_MIN_SESSIONS } from '../../contracts/rsi.js';
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
} from '../../contracts/rsi-personal.js';
import { canonicalJson } from '../../io/canonical-json.js';
import { RsiLockError } from '../lock-error.js';
import { applyEvent, type ApplyDeps } from './candidate-apply.js';
import type {
  FactsProvider,
  MarksStore,
  PresetSource,
  ReadySinceRecovery,
  SignalLookup,
  StagedSource,
  StepBreaker,
  StepEnv,
  StepHalt,
  WorkerMarks,
} from './candidate-ports.js';
import {
  creationAudit,
  creationFiles,
  newRecord,
  newWorkingCopy,
  rebuildWorkingCopy,
} from './candidate-record.js';
import { buildDraft, selectable } from './candidate-source.js';
import { overlapsPreset, runGates } from './gates.js';
import type { ShadowCountPort } from './shadow-count.js';
import { txnId } from './ids.js';
import { decideShadowStep, pickPromotionHead } from './transition.js';
import {
  evaluationSlotOccupied,
  isTerminalLifecycle,
  queueExpired,
  utcDay,
  type TransitionCtx,
  type TransitionEvent,
} from './transition-table.js';

export interface StepDeps extends ApplyDeps {
  staged: StagedSource;
  signals: SignalLookup;
  presets: PresetSource;
  facts: FactsProvider;
  marks: MarksStore;
  fingerprint(canonicalBody: string): string;
  /** 可选:信号库历史重算首次达标日;缺省 = 一律「无法重算」 */
  readySince?: ReadySinceRecovery;
  /** 可选(W5):重建工作副本后由真实计数重算 shadow 的 `sessions` / `hits`;缺省 = 清零(旧行为)。读失败 / 事实不可得按缺省处理 */
  shadowCounts?: ShadowCountPort;
  /** 只用 `assertHeld`(提交底座另有自己的断言) */
  locks: { personal: { assertHeld(): Promise<void> } };
}

/** 撤销凭据的原因 → 对账事件的依据(显式映射;不在表里的原因不对账) */
const RECONCILE_BASIS: Readonly<
  Record<string, 'veto' | 'taint' | 'clear' | 'judge_reject' | undefined>
> = Object.freeze({
  vetoed: 'veto',
  tainted: 'taint',
  cleared: 'clear',
  judge_reject: 'judge_reject',
  judge_injection: 'judge_reject',
});

export interface StepResult {
  /** 凭据原因无法映射到终态理由的候选(未转移,凭据仍阻止推进) */
  unmappedRevocations: string[];
  /** 有合法但无法映射的凭据:对账未完成,本步不做任何增加影响的转移(创建与闸不受影响:它们不增加影响) */
  reconcileIncomplete: boolean;
  /** 因事实不可得 / 前置不成立而清零 queued_since 的候选与原因 */
  queueCleared: { id: string; reason: string }[];
  created: string[];
  skipped: { run_id: string; proposal_id: string; reason: string }[];
  reconciled: string[];
  /** 每个 proposed 的闸结果(`green` / `red:<码>` / `queued` / `internal:<闸>`) */
  gated: { id: string; outcome: string }[];
  /** 本次提交的生命周期转移 `id: from -> to` */
  transitions: string[];
  /** 本次入口清零是否发生 */
  queueReset: boolean;
  breaker: StepBreaker | null;
  halted: StepHalt | null;
  /** 效果落地(黑名单 / 墓碑 / 冷却)失败:权威副本已提交,效果须由 W7 的 outbox 续做 */
  effectsFailed: string[];
}

/** W0-13:入口事件 → 清零。`prev = null`(首次)也清零,无害 */
export function entryReset(prev: WorkerMarks | null, cur: WorkerMarks): boolean {
  if (prev === null) return true;
  return (
    prev.enabled !== cur.enabled ||
    prev.paused !== cur.paused ||
    cur.resetGen > prev.resetGen ||
    prev.policyFp !== cur.policyFp ||
    (!prev.repoReachable && cur.repoReachable) ||
    cur.revocationCount > prev.revocationCount
  );
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const digest = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const ctxOf = (
  env: StepEnv,
  nowIso: string,
  revoked: boolean,
  rec: PersonalLifecycleRecord,
): TransitionCtx => ({
  phase: env.phase,
  now: nowIso,
  revocation_listed: revoked,
  authoritative_lifecycle: rec.lifecycle,
  auto_loop_effective: env.autoLoopEffective,
  auto_paused: env.autoPaused,
});

const patchShadow =
  (patch: { canary_ready_since: string | null; queued_since: string | null }) =>
  (wc: CandidateWorkingCopy | undefined): CandidateWorkingCopy | undefined =>
    wc === undefined ? undefined : { ...wc, shadow: { ...wc.shadow, ...patch } };

export async function runPersonalStep(d: StepDeps): Promise<StepResult> {
  const out: StepResult = {
    created: [],
    unmappedRevocations: [],
    reconcileIncomplete: false,
    queueCleared: [],
    skipped: [],
    reconciled: [],
    gated: [],
    transitions: [],
    queueReset: false,
    breaker: null,
    halted: null,
    effectsFailed: [],
  };
  const halt = (h: StepHalt): StepResult => {
    out.halted = h;
    return out;
  };
  await d.locks.personal.assertHeld();
  const env = await d.env.read();
  const rv0 = await d.revocations.read();
  const baseMarks = { ...env.marks, revocationCount: rv0.kind === 'ok' ? rv0.lines.length : 0 };

  const all = await d.store.readAll();
  if (all.kind !== 'ok') {
    await d.marks.write({ ...baseMarks, repoReachable: false });
    if (all.kind === 'invalid') out.breaker = 'personal_repo_invalid';
    return halt(
      all.kind === 'absent'
        ? 'repo_absent'
        : all.kind === 'deferred'
          ? 'repo_deferred'
          : 'repo_invalid',
    );
  }
  if (rv0.kind === 'invalid') return halt('revocations_invalid');

  // ① 入口清零
  const working = new Map((await d.working.list()).map((w) => [w.id, w]));
  const cur: WorkerMarks = { ...baseMarks, repoReachable: true };
  if (entryReset(await d.marks.read(), cur)) {
    for (const w of working.values()) {
      if (w.shadow.queued_since !== null) {
        const next = { ...w, shadow: { ...w.shadow, queued_since: null } };
        await d.working.put(next);
        working.set(w.id, next);
        out.queueReset = true;
      }
    }
  }
  await d.marks.write(cur);

  const run = async (
    rec: PersonalLifecycleRecord,
    event: TransitionEvent,
    wcAfter?: ReturnType<typeof patchShadow>,
  ): Promise<'transitioned' | 'other' | 'halt'> => {
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
  const reload = async (): Promise<PersonalLifecycleRecord[] | null> => {
    const r = await d.store.readAll();
    if (r.kind !== 'ok') {
      out.halted =
        r.kind === 'absent'
          ? 'repo_absent'
          : r.kind === 'deferred'
            ? 'repo_deferred'
            : 'repo_invalid';
      if (r.kind === 'invalid') out.breaker = 'personal_repo_invalid';
      return null;
    }
    return r.value;
  };

  // ② 撤销凭据对账(proposed / shadow)
  let records = all.value;
  for (const line of rv0.lines) {
    const rec = records.find(
      (r) => r.id === line.candidate_id && r.content_sha256 === line.content_sha256,
    );
    if (rec === undefined) continue;
    if (isTerminalLifecycle(rec.lifecycle)) {
      // R21-4.4a ②:终态上的 veto 仍要写黑名单(效果幂等;其余终止事件对终态无事可做)
      if (line.reason === 'vetoed') {
        const r = await run(rec, {
          kind: 'veto',
          evidence: `revocation:${digest(canonicalJson(line)).slice(0, 16)}`,
        });
        if (r === 'halt') return out;
      }
      continue;
    }
    if (rec.lifecycle !== 'proposed' && rec.lifecycle !== 'shadow') continue; // canary 及以上归 V1b / W7
    const evidence = `revocation:${digest(canonicalJson(line)).slice(0, 16)}`;
    // R21-9.5:对账转移的原因是 revocation_reconciled;终态理由按凭据依据显式映射(未知依据不兜底成 clear:
    // 记 unmappedRevocations,不转移——撤销凭据本身已让该候选不得被推进,见 ctx.revocation_listed)
    const basis = RECONCILE_BASIS[line.reason];
    if (basis === undefined) {
      out.unmappedRevocations.push(rec.id);
      out.reconcileIncomplete = true;
      continue;
    }
    const r = await run(rec, { kind: 'revocation_reconcile', evidence, basis });
    if (r === 'halt') return out;
    if (r === 'transitioned') out.reconciled.push(rec.id);
  }
  let re = await reload();
  if (re === null) return out;
  records = re;

  // ③ 缺工作副本者重建
  for (const rec of records) {
    if (isTerminalLifecycle(rec.lifecycle) || working.has(rec.id)) continue;
    // W0-13:canary_ready_since 由信号库历史重算(可选端口);无法重算 → 记重建当日并审计 ready_since_rebuilt(只对 shadow)
    const recovered =
      rec.lifecycle === 'shadow' && d.readySince !== undefined
        ? await d.readySince.recover(rec)
        : null;
    const readyToday = rec.lifecycle === 'shadow' && recovered === null;
    let wc = rebuildWorkingCopy(
      rec,
      recovered ?? (readyToday ? utcDay(d.now().toISOString()) : null),
    );
    if (wc === null) continue;
    if (rec.lifecycle === 'shadow' && d.shadowCounts !== undefined) {
      // W5:重建后的 sessions / hits 由计数重算(R21-3.8);读失败 = 事实不可得,保持 0,下一步经 promoteFacts 现算,不影响推进判定
      let counted: Awaited<ReturnType<ShadowCountPort['count']>> = null;
      try {
        counted = await d.shadowCounts.count(rec);
      } catch (e) {
        if (e instanceof RsiLockError && e.kind === 'lock_lost') return halt('lock_lost');
      }
      if (counted !== null) {
        wc = { ...wc, shadow: { ...wc.shadow, sessions: counted.sessions, hits: counted.hits } };
      }
    }
    await d.working.put(wc);
    working.set(rec.id, wc);
    if (rec.lifecycle === 'shadow') {
      await d.audit.append([
        {
          at: d.now().toISOString(),
          kind: 'evaluation',
          id: rec.id,
          reason: 'ready_since_rebuilt',
          counts: { recovered: recovered === null ? 0 : 1 },
        },
      ]);
    }
  }

  // ④ 创建
  const known = new Map(records.map((r) => [r.id, r.content_sha256]));
  const presets = await d.presets.presets();
  let head = all.head;
  for (const sp of await d.staged.list()) {
    if (!selectable(sp.proposal)) continue;
    const sigs = await d.signals.getMany(sp.proposal.evidence.map((e) => e.sig));
    const dr = buildDraft(sp, sigs, { fingerprint: d.fingerprint });
    if (dr.kind === 'skip') {
      out.skipped.push({ run_id: sp.runId, proposal_id: sp.proposal.id, reason: dr.reason });
      continue;
    }
    const draft = dr.draft;
    const knownSha = known.get(draft.id);
    if (knownSha !== undefined) {
      // W0-6:48 位 id 碰撞而内容哈希不同 → candidate_invalid(安全中止);内容相同才是重复
      if (knownSha !== draft.contentSha256) return halt('candidate_invalid');
      continue;
    }
    const now = d.now().toISOString();
    const rec = newRecord(draft, now, overlapsPreset(draft, presets));
    const files = creationFiles(draft, rec);
    const c = await d.store.commit({
      kind: 'transition',
      txnId: txnId('transition', [draft.id], head, digest(canonicalJson(files))),
      candidateIds: [draft.id],
      upserts: files,
    });
    if (c.status !== 'committed') {
      return halt(
        c.status === 'absent'
          ? 'repo_absent'
          : c.status === 'deferred'
            ? 'repo_deferred'
            : c.status === 'invalid'
              ? 'repo_invalid'
              : 'commit_failed',
      );
    }
    head = c.commit;
    known.set(draft.id, draft.contentSha256);
    // 已提交:先登记创建事实,再落地工作副本与审计(失败不抹掉 created;丢锁立即结束)
    out.created.push(draft.id);
    const wc = newWorkingCopy(draft, dr.signals);
    try {
      await d.working.put(wc);
      working.set(draft.id, wc);
      await d.audit.append([creationAudit(rec, now)]);
    } catch (e) {
      if (e instanceof RsiLockError && e.kind === 'lock_lost') return halt('lock_lost');
      out.effectsFailed.push(`${draft.id}:${e instanceof Error ? e.message : 'error'}`);
    }
  }
  re = await reload();
  if (re === null) return out;
  records = re;

  // ⑤ 闸
  for (const rec of records.filter((r) => r.lifecycle === 'proposed').sort(byId)) {
    const wc = working.get(rec.id);
    if (wc === undefined) continue;
    let outcome;
    try {
      const f = await d.facts.gateFacts(rec, wc);
      if (f === null) throw new Error('gate facts unavailable');
      // G7:同聚类已有更早进入流程的非终态候选(锁内按权威记录现算)
      const busy = records.some(
        (o) =>
          o.id !== rec.id &&
          o.cluster_id === rec.cluster_id &&
          !isTerminalLifecycle(o.lifecycle) &&
          (o.lifecycle !== 'proposed' || o.id < rec.id),
      );
      outcome = runGates({ ...f, clusterBusy: busy });
    } catch (e) {
      if (e instanceof RsiLockError && e.kind === 'lock_lost') return halt('lock_lost');
      outcome = {
        kind: 'internal' as const,
        gate: 'g0' as const,
        detail: e instanceof Error ? e.message : 'error',
      };
    }
    out.gated.push({
      id: rec.id,
      outcome:
        outcome.kind === 'red'
          ? `red:${outcome.reason}`
          : outcome.kind === 'internal'
            ? `internal:${outcome.gate}`
            : outcome.kind,
    });
    if (outcome.kind === 'internal') {
      out.breaker = 'gate_internal';
      continue;
    }
    if (outcome.kind === 'queued') continue;
    const event: TransitionEvent =
      outcome.kind === 'green'
        ? { kind: 'gates_passed', evidence: `gates:${rec.id}`, gates_green: true }
        : { kind: 'gate_red', evidence: outcome.reason, gate_reason: outcome.reason };
    if ((await run(rec, event)) === 'halt') return out;
  }
  re = await reload();
  if (re === null) return out;
  records = re;

  // ⑥ shadow 步
  const rvNow = await d.revocations.read();
  if (rvNow.kind === 'invalid') return halt('revocations_invalid');
  const nowIso = d.now().toISOString();
  const today = utcDay(nowIso);
  const clearQueue = async (
    rec: PersonalLifecycleRecord,
    wc: CandidateWorkingCopy,
    reason: string,
  ): Promise<void> => {
    if (wc.shadow.queued_since === null) return;
    const next = patchShadow({
      canary_ready_since: wc.shadow.canary_ready_since,
      queued_since: null,
    })(wc);
    if (next === undefined) return;
    await d.working.put(next);
    working.set(rec.id, next);
    out.queueCleared.push({ id: rec.id, reason });
    await d.audit.append([{ at: nowIso, kind: 'evaluation', id: rec.id, reason }]);
  };
  const decisions: {
    rec: PersonalLifecycleRecord;
    wc: CandidateWorkingCopy;
    ready: string | null;
    event?: TransitionEvent;
  }[] = [];
  // 本步已发现 gate_internal(B2):不再授予任何影响(只做到期 / 收紧类转移)
  const noGrant = out.breaker !== null || out.reconcileIncomplete;
  for (const rec of records.filter((r) => r.lifecycle === 'shadow').sort(byId)) {
    const wc = working.get(rec.id);
    if (wc === undefined) continue;
    // W0-13 ①:排队到期先于一切(含事实读取与 no-hit),只依赖 queued_since 与日期
    if (queueExpired(wc.shadow.queued_since, today)) {
      const r = await run(
        rec,
        {
          kind: 'shadow_queue_expired',
          evidence: `shadow:${today}`,
          queued_since: wc.shadow.queued_since,
        },
        patchShadow({
          canary_ready_since: wc.shadow.canary_ready_since,
          queued_since: wc.shadow.queued_since,
        }),
      );
      if (r === 'halt') return out;
      continue;
    }
    const pf = await d.facts.promoteFacts(rec, wc);
    if (pf === null) {
      // W0-13:前置无法确认 = 不成立 → queued_since 清零(保留展示日期),记原因
      await clearQueue(rec, wc, 'promote_facts_unavailable');
      continue;
    }
    const revoked = rvNow.lines.some(
      (l) => l.candidate_id === rec.id && l.content_sha256 === rec.content_sha256,
    );
    const ctx = ctxOf(env, nowIso, revoked, rec);
    const others = records.filter((o) => o.id !== rec.id);
    const facts = { ...pf, slot_occupied: evaluationSlotOccupied(others) };
    if (facts.sessions >= RSI_SHADOW_MIN_SESSIONS && facts.hits < RSI_SHADOW_MIN_HITS) {
      const r = await run(rec, {
        kind: 'shadow_no_hit',
        evidence: `no_hit:${facts.sessions}/${facts.hits}`,
        sessions: facts.sessions,
        hits: facts.hits,
      });
      if (r === 'halt') return out;
      continue;
    }
    const step = decideShadowStep({
      record: rec,
      ctx,
      facts,
      shadow: {
        canary_ready_since: wc.shadow.canary_ready_since,
        queued_since: wc.shadow.queued_since,
      },
      evidence: `shadow:${today}`,
    });
    if (step.action === 'invalid') continue;
    if (step.action === 'expire' && step.event !== undefined) {
      const r = await run(rec, step.event, patchShadow(step.patch));
      if (r === 'halt') return out;
      continue;
    }
    if (step.action === 'promote' && step.event !== undefined) {
      if (noGrant) continue;
      decisions.push({ rec, wc, ready: step.patch.canary_ready_since, event: step.event });
      continue;
    }
    // wait:只更新两个日期(有变化才写)
    if (
      step.patch.canary_ready_since !== wc.shadow.canary_ready_since ||
      step.patch.queued_since !== wc.shadow.queued_since
    ) {
      const next = patchShadow(step.patch)(wc);
      if (next !== undefined) {
        await d.working.put(next);
        working.set(rec.id, next);
      }
    }
  }

  const head2 = pickPromotionHead(
    decisions.map((x) => ({ id: x.rec.id, canary_ready_since: x.ready })),
  );
  // 非队首:名额此刻空闲(它们被判为 promote),所以旧 queued_since 立即清零、只记 canary_ready_since(只排序);
  // G7 排队日期要等队首实际提交成功、并按重读的权威记录确认名额被占后再从当日起算(不累计、不追溯)
  for (const x of decisions) {
    if (head2 !== null && x.rec.id === head2.id) continue;
    if (x.ready === x.wc.shadow.canary_ready_since && x.wc.shadow.queued_since === null) continue;
    const next = patchShadow({ canary_ready_since: x.ready, queued_since: null })(x.wc);
    if (next !== undefined) {
      await d.working.put(next);
      working.set(x.rec.id, next);
    }
  }
  let headPromoted = false;
  if (head2 !== null) {
    const x = decisions.find((y) => y.rec.id === head2.id);
    if (x !== undefined) {
      // 推进前在锁内整体重读并重判(不使用上面的检查结果)
      const fresh = await reload();
      if (fresh === null) return out;
      const frec = fresh.find((r) => r.id === x.rec.id);
      const rv2 = await d.revocations.read();
      if (rv2.kind === 'invalid') return halt('revocations_invalid');
      const env2 = await d.env.read();
      const wc2 = working.get(x.rec.id);
      const pf2 =
        frec === undefined || wc2 === undefined ? null : await d.facts.promoteFacts(frec, wc2);
      if (frec !== undefined && wc2 !== undefined && pf2 === null) {
        await clearQueue(frec, wc2, 'promote_facts_unavailable');
      }
      if (frec !== undefined && wc2 !== undefined && pf2 !== null) {
        const step2 = decideShadowStep({
          record: frec,
          ctx: ctxOf(
            env2,
            d.now().toISOString(),
            rv2.lines.some(
              (l) => l.candidate_id === frec.id && l.content_sha256 === frec.content_sha256,
            ),
            frec,
          ),
          facts: {
            ...pf2,
            slot_occupied: evaluationSlotOccupied(fresh.filter((o) => o.id !== frec.id)),
          },
          shadow: {
            canary_ready_since: wc2.shadow.canary_ready_since,
            queued_since: wc2.shadow.queued_since,
          },
          evidence: `shadow:${today}`,
        });
        if (step2.action === 'promote' && step2.event !== undefined) {
          const pr = await run(frec, step2.event, patchShadow(step2.patch));
          if (pr === 'halt') return out;
          headPromoted = pr === 'transitioned';
        } else if (step2.action === 'expire' && step2.event !== undefined) {
          await run(frec, step2.event, patchShadow(step2.patch));
        } else if (step2.action === 'wait') {
          const next = patchShadow(step2.patch)(wc2);
          if (next !== undefined) {
            await d.working.put(next);
            working.set(frec.id, next);
          }
        }
      }
    }
  }
  if (headPromoted) {
    // 队首已实际占用名额:按重读的权威记录,给仍具备资格的其余候选设 G7 排队起算日(从今天起算,不追溯)
    const after = await reload();
    if (after === null) return out;
    for (const x of decisions) {
      if (head2 !== null && x.rec.id === head2.id) continue;
      const wc = working.get(x.rec.id);
      const cur = after.find((r) => r.id === x.rec.id);
      if (wc === undefined || cur === undefined || cur.lifecycle !== 'shadow') continue;
      // 逐个候选重新收集环境 / 撤销 / 推进事实,并基于最新权威记录再判一次:只有结果确为 slot_occupied 才设排队日期;
      // 事实不可得或其它资格失败 → 清零(不累计)
      const rv3 = await d.revocations.read();
      if (rv3.kind === 'invalid') return halt('revocations_invalid');
      const env3 = await d.env.read();
      const pf3 = await d.facts.promoteFacts(cur, wc);
      if (pf3 === null) {
        await clearQueue(cur, wc, 'promote_facts_unavailable');
        continue;
      }
      const step3 = decideShadowStep({
        record: cur,
        ctx: ctxOf(
          env3,
          d.now().toISOString(),
          rv3.lines.some(
            (l) => l.candidate_id === cur.id && l.content_sha256 === cur.content_sha256,
          ),
          cur,
        ),
        facts: {
          ...pf3,
          slot_occupied: evaluationSlotOccupied(after.filter((o) => o.id !== cur.id)),
        },
        shadow: {
          canary_ready_since: wc.shadow.canary_ready_since,
          queued_since: wc.shadow.queued_since,
        },
        evidence: `shadow:${today}`,
      });
      if (step3.action !== 'wait') continue;
      const next = patchShadow({
        canary_ready_since: step3.patch.canary_ready_since,
        queued_since: step3.blocker === 'slot_occupied' ? (wc.shadow.queued_since ?? today) : null,
      })(wc);
      if (next !== undefined) {
        await d.working.put(next);
        working.set(x.rec.id, next);
      }
    }
  }
  return out;
}
