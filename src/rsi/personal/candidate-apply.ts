/**
 * 在持锁临界区内把一个事件应用到一个候选:重读权威记录与撤销凭据 → W1 `transition` → 经 W2 提交 → 更新工作副本 → 审计 / 效果。
 * 顺序固定(R21-3.8 / R21-9.5 / M13-2):**提交权威副本成功后才更新工作副本**;检查结果不作锁外缓存,每次应用都在这里重读。
 */
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
} from '../../contracts/rsi-personal.js';
import { canonicalJson } from '../../io/canonical-json.js';
import { RsiLockError } from '../lock-error.js';
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
import {
  isSealedInterval,
  unsealedEntryTime,
  type EntrySeal,
  type StampRegion,
} from './entry-stamp.js';
import { transition, isRefusal, type Refusal, type TransitionEffect } from './transition.js';
import { isTerminalLifecycle, type TransitionEvent } from './transition-table.js';

export interface ApplyDeps {
  store: AuthoritativeStore;
  working: WorkingStore;
  revocations: RevocationReader;
  audit: AuditSink;
  effects: EffectSink;
  env: EnvReader;
  now: () => Date;
  /**
   * 封存区域端口(§21.24 W0-26 第 9 条):给了就在**取时之前**开区域、取值后校验 `utcDay(at) > W`(`sealed_interval` 在源提交前拒绝,零写入),
   * 落地结束后(任何分支)关闭区域。缺省 = 无封存(只有缩减入口 `rsi auto clear` 与既有单测;生产命令装配必给)。
   */
  seal?: EntrySeal;
}

export type ApplyResult =
  /** `effectsFailed`:权威副本已提交,之后的工作副本 / 审计 / 效果落地失败(提交前的失败一律抛出,不会落到这里) */
  | {
      kind: 'transitioned';
      next: PersonalLifecycleRecord;
      effectsFailed?: string;
      /** 提交后发现丢锁:转移已提交,但调用方必须立即结束本步(不得继续任何写出口) */
      lockLost?: true;
    }
  /** `observationRowSealed`:取时被封存区间拒绝,终态记录上的无键空操作审计行**已丢弃**(无权威源、无保证;其余效果照落) */
  | { kind: 'noop'; observationRowSealed?: true }
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
  // 封存区域:取时**之前**开(读水位线一次),落地结束后一定关闭(任何分支,含抛错);注意区域内不得再次打开
  const region = d.seal === undefined ? null : await d.seal.open();
  try {
    return await applyIn(d, rec, event, fresh, rv, env, region, wcAfter, wc);
  } finally {
    region?.close();
  }
}

type Fresh = Extract<Awaited<ReturnType<AuthoritativeStore['read']>>, { kind: 'ok' }>;
type RevRead = Extract<Awaited<ReturnType<RevocationReader['read']>>, { kind: 'ok' }>;

async function applyIn(
  d: ApplyDeps,
  rec: PersonalLifecycleRecord,
  event: TransitionEvent,
  fresh: Fresh,
  rv: RevRead,
  env: Awaited<ReturnType<EnvReader['read']>>,
  region: StampRegion | null,
  wcAfter?: (wc: CandidateWorkingCopy | undefined) => CandidateWorkingCopy | undefined,
  wc?: CandidateWorkingCopy,
): Promise<ApplyResult> {
  // 事件时刻只在这里取一次(条目与同批无键审计行共用);取点见 `entry-stamp.ts`
  let now: string;
  let sealed = false;
  try {
    now = region === null ? unsealedEntryTime(d.now) : region.stampFirst(d.now);
  } catch (e) {
    if (!isSealedInterval(e)) throw e;
    // 封存区间内的时刻:会产生条目的转移一律在源提交前拒绝(零写入);终态记录上的空操作不产生条目,
    // 引擎只用一个确定的时刻求值(最后一条条目的时间),**以它为 `at` 的无键观察行全部丢弃**,E1 / 账类效果照落(保护写不被封存阻断)
    if (!isTerminalLifecycle(rec.lifecycle)) {
      return { kind: 'halt', halt: 'sealed_interval', why: 'stamp' };
    }
    now = rec.transitions[rec.transitions.length - 1]?.at ?? '1970-01-01T00:00:00.000Z';
    sealed = true;
  }
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
    if (!sealed) {
      await landEffects(d, res.effects);
      return { kind: 'noop' };
    }
    const kept = res.effects.filter(
      (e) => !(e.type === 'append_audit' && e.idem_key === undefined),
    );
    await landEffects(d, kept);
    return { kind: 'noop', observationRowSealed: true };
  }
  if (sealed) return { kind: 'halt', halt: 'sealed_interval', why: 'non_terminal_after_stamp' };

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
  region?.markSourceCommitted();

  // 权威副本已写成功 → 才更新工作副本(R21-3.8);此后的失败是「已提交后的落地失败」,与提交前的失败(抛出)区分
  try {
    const after = wcAfter?.(wc);
    if (after !== undefined) await d.working.put(after);
    await landEffects(d, res.effects);
  } catch (e) {
    return {
      kind: 'transitioned',
      next: res.next,
      effectsFailed: e instanceof Error ? e.message : 'error',
      ...(e instanceof RsiLockError && e.kind === 'lock_lost' ? { lockLost: true as const } : {}),
    };
  }
  return { kind: 'transitioned', next: res.next };
}

async function landEffects(d: ApplyDeps, effects: readonly TransitionEffect[]): Promise<void> {
  const audits = effects.flatMap((e) =>
    e.type === 'append_audit'
      ? [{ line: e.line, ...(e.idem_key !== undefined ? { idem_key: e.idem_key } : {}) }]
      : [],
  );
  if (audits.length > 0) {
    if (d.audit.appendKeyed !== undefined) await d.audit.appendKeyed(audits);
    else await d.audit.append(audits.map((a) => a.line));
  }
  const rest = effects.filter((e) => e.type !== 'append_audit' && e.type !== 'commit_lifecycle');
  if (rest.length > 0) await d.effects.apply(rest);
}
