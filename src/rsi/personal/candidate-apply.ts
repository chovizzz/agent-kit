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
  BeforeRefUpdate,
  EffectSink,
  EnvReader,
  GrowthClaimOp,
  GrowthClaimPort,
  RevocationReader,
  StepHalt,
  WorkingStore,
} from './candidate-ports.js';
import { PERSONAL_LOCK_LOST_CODE, REF_MOVED_AFTER_DENIED } from './commit-reasons.js';
import { creationAuditItems } from './creation-audit.js';
import { growthOpOfEvent } from './growth-events.js';
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
  /**
   * 增影响汇点端口(D1b-2;W0-30):**增影响事件**(`gates_passed` / `shadow_promote` / `deploy_inject`,见 `growth-events.ts`)必须先经它;缺省 = 拒绝(`denied` / `unwired`,零写入)。
   * 减影响事件不看它。生产装配由 D2 / D3 给真实现(`claim` 内 evaluate → veto 现读,钩子内 `requireGrowth`);本块只交端口与缺则拒。
   */
  growth?: GrowthClaimPort;
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
  | { kind: 'halt'; halt: StepHalt; why?: string }
  /**
   * 增影响事件被 {@link GrowthClaimPort} 拒绝(缺端口 / 无法映射 / claim 拒 / 提交前复核拒):零写入或提交前拒绝,`why` 带原因码。**独立分支,不是 `StepHalt`**
   * (`StepHalt` 属 C1a 冻结面,正常的授权拒绝也不是完整性停机):`runPersonalStep` 对增影响事件把它记为 `growthDenied` 而不中止减影响子步骤;
   * 其余消费方(减影响事件不带钩子,出现即底座违约)一律 fail-closed。
   */
  | { kind: 'denied'; why: string };

const digest = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** `event` 是 `transition` 的入参(已由调用方构造);`wcPatch` 在提交成功后写回工作副本(可选) */
export async function applyEvent(
  d: ApplyDeps,
  rec: PersonalLifecycleRecord,
  event: TransitionEvent,
  wcAfter?: (wc: CandidateWorkingCopy | undefined) => CandidateWorkingCopy | undefined,
  wc?: CandidateWorkingCopy,
): Promise<ApplyResult> {
  // 增影响事件先过注入端口:分类与端口存在性是零 IO 判定,`claim` 只读;全部先于 `seal.open` / `store.read` / `store.commit`(缺 / 拒 = 零写入)
  const claimed = await claimGrowth(d, rec, event);
  if (claimed.kind === 'halt' || claimed.kind === 'denied') return claimed;
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
    return await applyIn(d, rec, event, fresh, rv, env, region, wcAfter, wc, claimed.hook);
  } finally {
    region?.close();
  }
}

/** 增影响分类 → 端口:减影响 = 无钩子;增影响 = 取钩子;`unmappable` / 缺端口 / `claim` 拒或返回畸形 = `denied` */
async function claimGrowth(
  d: ApplyDeps,
  rec: PersonalLifecycleRecord,
  event: TransitionEvent,
): Promise<
  | { kind: 'none'; hook?: undefined }
  | { kind: 'claimed'; hook: BeforeRefUpdate }
  | Extract<ApplyResult, { kind: 'halt' | 'denied' }>
> {
  const op = growthOpOfEvent(event.kind);
  if (op === null) return { kind: 'none' };
  if (op === 'unmappable') return { kind: 'denied', why: 'unmappable' };
  const cand =
    op === 'candidate_create' ? null : { id: rec.id, content_sha256: rec.content_sha256 };
  const r = await claimGrowthPort(d.growth, op, cand);
  return r.ok ? { kind: 'claimed', hook: r.hook } : { kind: 'denied', why: r.code };
}

/**
 * 取增影响钩子(`applyEvent` 与 `runPersonalStep` 的创建提交共用):端口缺 → `unwired`;跨端口边界只认 `{ok:true, hook:function}` / `{ok:false, code:string}`,
 * 其余畸形一律拒绝(`claim_malformed`)。端口自己抛出的错误(含丢锁)原样传播,不吞。
 */
export async function claimGrowthPort(
  port: GrowthClaimPort | undefined,
  op: GrowthClaimOp,
  cand: { id: string; content_sha256: string } | null,
): Promise<{ ok: true; hook: BeforeRefUpdate } | { ok: false; code: string }> {
  if (port === undefined) return { ok: false, code: 'unwired' };
  const r: unknown = await port.claim(op, cand);
  const o =
    typeof r === 'object' && r !== null
      ? (r as { ok?: unknown; hook?: unknown; code?: unknown })
      : {};
  // 每个字段只读一次,校验与转交用同一个值(校验通过后不重读同一个对象:带 getter 的返回值不能在两次读取间换成别的)
  const { ok, hook, code } = o;
  if (ok === true && typeof hook === 'function') return { ok: true, hook: hook as BeforeRefUpdate };
  return { ok: false, code: ok === false && typeof code === 'string' ? code : 'claim_malformed' };
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
  hook?: BeforeRefUpdate,
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

  // 创建审计的截断边界(W0-30 第 4 条):本次转移会把记录里的创建条目挤出 256 条窗口 → **先**确认创建审计耐久落地(同键幂等),否则拒绝本次转移(源提交前,零写入)。
  // 窗口外 `recoverCreationAudits` 与 B1b 对账源都失去来源,所以确认必须先于截断;条目仍在窗口内时不额外落行(即时路径与恢复路径负责)
  const unconfirmed = await confirmCreationAuditBeforeTruncation(d, rec, res.next);
  if (unconfirmed !== null) return unconfirmed;

  const json = canonicalJson(res.next);
  const c = await d.store.commit({
    kind: 'transition',
    txnId: txnId('transition', [rec.id], fresh.head, digest(json)),
    candidateIds: [rec.id],
    upserts: [{ path: `lifecycle/${rec.id}.json`, content: json }],
    // 增影响事件:最终复核钩子在 `update-ref` 之前由提交底座调用(拒 → `denied`)
    ...(hook !== undefined ? { beforeRefUpdate: hook } : {}),
  });
  if (c.status === 'denied') return { kind: 'denied', why: c.code };
  if (c.status === 'absent') return { kind: 'halt', halt: 'repo_absent' };
  // 拒绝后引用被别人推进(提交底座保留了现场,完整性不明)不是普通 deferred(那只停本步):按 fail-closed 映射 `commit_failed`(→ stop_step_unsettled),保留 why
  if (c.status === 'deferred' && c.why === REF_MOVED_AFTER_DENIED) {
    return { kind: 'halt', halt: 'commit_failed', why: c.why };
  }
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

/**
 * 本次转移会截掉创建条目 → 先经带键端口落创建审计行(`appendKeyed` 返回 = 已耐久:落地或进入带键的持久待办)。
 * 两种丢锁(`RsiLockError('lock_lost')` 与 `PersonalLockLost`)原样抛(源转移未提交;审计端可能已追加该键行——重试时同键确认,不回滚已追加的审计);`appendKeyed` 返回 `'deferred'`(行没落地)不是确认;`sealed_interval`(创建日已封存 = 该日由 B1b 对账源派生并封存,行不会再丢;该前提由 B1b 的封存前对账保证,本块不重证)视为已确认;缺 `appendKeyed` 或其它失败 → `halt{commit_failed}`(`why` 带原因,转移不提交)。
 */
async function confirmCreationAuditBeforeTruncation(
  d: ApplyDeps,
  rec: PersonalLifecycleRecord,
  next: PersonalLifecycleRecord,
): Promise<Extract<ApplyResult, { kind: 'halt' }> | null> {
  const items = creationAuditItems(rec);
  if (items.length === 0 || next.transitions_dropped <= rec.transitions_dropped) return null;
  if (next.transitions.some((e) => items.some((i) => i.idem_key === e.idem_key))) return null;
  if (d.audit.appendKeyed === undefined) {
    return { kind: 'halt', halt: 'commit_failed', why: 'creation_audit_unconfirmed:port_missing' };
  }
  try {
    const landed = await d.audit.appendKeyed(
      items.map((i) => ({ line: i.line, idem_key: i.idem_key })),
    );
    // `deferred` = 行没有落地(缩减入口记为待对账,续做依赖「当前记录里还有创建条目」,恰是这次转移要截掉的):不是确认
    if (landed === 'deferred') {
      return { kind: 'halt', halt: 'commit_failed', why: 'creation_audit_unconfirmed:deferred' };
    }
  } catch (e) {
    if (isLockLostError(e)) throw e;
    if (isSealedInterval(e)) return null;
    return {
      kind: 'halt',
      halt: 'commit_failed',
      why: `creation_audit_unconfirmed:${e instanceof Error ? e.message : 'error'}`,
    };
  }
  return null;
}

/** rsi 锁 `lock_lost` 与个人锁丢失(`PersonalLockLost`,按 `code` 识别:不 import stage/,candidate-apply 在 worker 类型闭包内)都是锁丢失,不是「确认失败」 */
function isLockLostError(e: unknown): boolean {
  if (e instanceof RsiLockError && e.kind === 'lock_lost') return true;
  return (e as { code?: unknown } | null)?.code === PERSONAL_LOCK_LOST_CODE;
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
