/**
 * 在持锁临界区内把一个事件应用到一个候选:重读权威记录与撤销凭据 → W1 `transition` → 经 W2 提交 → 更新工作副本 → 审计 / 效果。
 * 顺序固定(R21-3.8 / R21-9.5 / M13-2):**提交权威副本成功后才更新工作副本**;检查结果不作锁外缓存,每次应用都在这里重读。
 */
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
} from '../../contracts/rsi-personal.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type {
  AuditSink,
  AuthoritativeStore,
  EffectSink,
  EnvReader,
  RevocationReader,
  StepHalt,
  WorkingStore,
} from './candidate-ports.js';
import { txnId } from './ids.js';
import { createHash } from 'node:crypto';
import { transition, isRefusal, type Refusal, type TransitionEffect } from './transition.js';
import type { TransitionEvent } from './transition-table.js';

export interface ApplyDeps {
  store: AuthoritativeStore;
  working: WorkingStore;
  revocations: RevocationReader;
  audit: AuditSink;
  effects: EffectSink;
  env: EnvReader;
  now: () => Date;
}

export type ApplyResult =
  /** `effectsFailed`:权威副本已提交,之后的工作副本 / 审计 / 效果落地失败(提交前的失败一律抛出,不会落到这里) */
  | { kind: 'transitioned'; next: PersonalLifecycleRecord; effectsFailed?: string }
  | { kind: 'noop' }
  | { kind: 'refused'; refusal: Refusal }
  /** 权威记录已不是调用方手里的状态(M13-2):不推进 */
  | { kind: 'stale'; authoritative: string }
  | { kind: 'halt'; halt: StepHalt; why?: string };

const digest = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** `event` 是 `transition` 的入参(已由调用方构造);`wcPatch` 在提交成功后写回工作副本(可选) */
export async function applyEvent(
  d: ApplyDeps,
  rec: PersonalLifecycleRecord,
  event: TransitionEvent,
  wcAfter?: (wc: CandidateWorkingCopy | undefined) => CandidateWorkingCopy | undefined,
  wc?: CandidateWorkingCopy,
): Promise<ApplyResult> {
  // 锁内重读权威记录(M13-2)与撤销凭据(R21-9.5 对账先于授予)
  const fresh = await d.store.read(rec.id);
  if (fresh.kind === 'absent') return { kind: 'halt', halt: 'repo_absent' };
  if (fresh.kind === 'deferred') return { kind: 'halt', halt: 'repo_deferred', why: fresh.why };
  if (fresh.kind === 'invalid') return { kind: 'halt', halt: 'repo_invalid', why: fresh.why };
  if (fresh.kind === 'missing') return { kind: 'stale', authoritative: 'missing' };
  if (fresh.record.lifecycle !== rec.lifecycle) {
    return { kind: 'stale', authoritative: fresh.record.lifecycle };
  }
  // 同生命周期也要整份一致:否则提交会用旧快照整份覆盖权威副本里较新的字段
  if (canonicalJson(fresh.record) !== canonicalJson(rec)) {
    return { kind: 'stale', authoritative: 'snapshot_changed' };
  }
  const rv = await d.revocations.read();
  if (rv.kind === 'invalid') return { kind: 'halt', halt: 'revocations_invalid', why: rv.why };
  const env = await d.env.read();
  const now = d.now().toISOString();
  const res = transition(rec, event, {
    phase: env.phase,
    now,
    revocation_listed: rv.lines.some(
      (l) => l.candidate_id === rec.id && l.content_sha256 === rec.content_sha256,
    ),
    authoritative_lifecycle: fresh.record.lifecycle,
    auto_loop_effective: env.autoLoopEffective,
    auto_paused: env.autoPaused,
  });
  if (isRefusal(res)) return { kind: 'refused', refusal: res };
  if (res.outcome === 'noop') {
    // 空操作只跳过提交与工作副本;引擎给的审计 / 黑名单等效果(终态上的 veto 等,R21-4.4a ②)照常落地
    await landEffects(d, res.effects);
    return { kind: 'noop' };
  }

  const json = canonicalJson(res.next);
  const c = await d.store.commit({
    kind: 'transition',
    txnId: txnId('transition', [rec.id], fresh.head, digest(json)),
    candidateIds: [rec.id],
    upserts: [{ path: `lifecycle/${rec.id}.json`, content: json }],
  });
  if (c.status === 'absent') return { kind: 'halt', halt: 'repo_absent' };
  if (c.status === 'deferred') return { kind: 'halt', halt: 'repo_deferred', why: c.why };
  if (c.status === 'invalid') return { kind: 'halt', halt: 'repo_invalid', why: c.why };
  if (c.status !== 'committed') return { kind: 'halt', halt: 'commit_failed', why: c.status };

  // 权威副本已写成功 → 才更新工作副本(R21-3.8)
  const after = wcAfter?.(wc);
  if (after !== undefined) await d.working.put(after);
  const audits = res.effects.flatMap((e) => (e.type === 'append_audit' ? [e.line] : []));
  if (audits.length > 0) await d.audit.append(audits);
  const rest = res.effects.filter(
    (e) => e.type !== 'append_audit' && e.type !== 'commit_lifecycle',
  );
  if (rest.length > 0) await d.effects.apply(rest);
  return { kind: 'transitioned', next: res.next };
}
