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
import { applyEvent, type ApplyDeps } from './candidate-apply.js';
import type {
  FactsProvider,
  MarksStore,
  PresetSource,
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
import { txnId } from './ids.js';
import { decideShadowStep, pickPromotionHead } from './transition.js';
import {
  evaluationSlotOccupied,
  isTerminalLifecycle,
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
  /** 只用 `assertHeld`(提交底座另有自己的断言) */
  locks: { personal: { assertHeld(): Promise<void> } };
}

export interface StepResult {
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
  let working = new Map((await d.working.list()).map((w) => [w.id, w]));
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
      // 提交已成功但效果 / 审计落地失败:记下来,不回滚(权威副本为准)
      out.effectsFailed.push(`${rec.id}:${e instanceof Error ? e.message : 'error'}`);
      return 'other';
    }
    if (r.kind === 'halt') {
      out.halted = r.halt;
      if (r.halt === 'repo_invalid') out.breaker = 'personal_repo_invalid';
      return 'halt';
    }
    if (r.kind === 'transitioned') {
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
    if (rec === undefined || isTerminalLifecycle(rec.lifecycle)) continue;
    if (rec.lifecycle !== 'proposed' && rec.lifecycle !== 'shadow') continue; // canary 及以上归 V1b / W7
    const evidence = `revocation:${digest(canonicalJson(line)).slice(0, 16)}`;
    const event: TransitionEvent =
      line.reason === 'vetoed'
        ? { kind: 'veto', evidence }
        : line.reason === 'tainted'
          ? { kind: 'taint', evidence }
          : { kind: 'clear', evidence };
    const r = await run(rec, event);
    if (r === 'halt') return out;
    if (r === 'transitioned') out.reconciled.push(rec.id);
  }
  let re = await reload();
  if (re === null) return out;
  records = re;

  // ③ 缺工作副本者重建
  for (const rec of records) {
    if (isTerminalLifecycle(rec.lifecycle) || working.has(rec.id)) continue;
    const wc = rebuildWorkingCopy(rec);
    if (wc === null) continue;
    await d.working.put(wc);
    working.set(rec.id, wc);
  }

  // ④ 创建
  const known = new Set(records.map((r) => r.id));
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
    if (known.has(draft.id)) continue;
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
    known.add(draft.id);
    const wc = newWorkingCopy(draft, dr.signals);
    await d.working.put(wc);
    working.set(draft.id, wc);
    await d.audit.append([creationAudit(rec, now)]);
    out.created.push(draft.id);
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
  const decisions: {
    rec: PersonalLifecycleRecord;
    wc: CandidateWorkingCopy;
    ready: string | null;
    event?: TransitionEvent;
  }[] = [];
  for (const rec of records.filter((r) => r.lifecycle === 'shadow').sort(byId)) {
    const wc = working.get(rec.id);
    if (wc === undefined) continue;
    const pf = await d.facts.promoteFacts(rec, wc);
    if (pf === null) continue; // 事实不可得:不推进、不动计时
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
  for (const x of decisions) {
    if (head2 !== null && x.rec.id === head2.id) continue;
    // 名额将被队首占用:其余具备资格者进入 G7 排队(从今天起算,不追溯)
    const patch = { canary_ready_since: x.ready, queued_since: x.wc.shadow.queued_since ?? today };
    const next = patchShadow(patch)(x.wc);
    if (next !== undefined) {
      await d.working.put(next);
      working.set(x.rec.id, next);
    }
  }
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
          await run(frec, step2.event, patchShadow(step2.patch));
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
  return out;
}
