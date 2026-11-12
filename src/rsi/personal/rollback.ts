/**
 * 回滚四段执行器(docs/contracts.md R21-9.1 / 9.2 / 9.3a / 9.5 / 9.6、§21.24 W0-15 / W0-16 / W0-17)。
 * `rollback.phase` 的四段与 `rsi-personal/txn/<id>.json` 的 journal:
 *   `rollback_requested`(journal 落盘)→ `injection_disabled`(撤销凭据落盘 + 授予缓存清理)→ `static_removal_pending`(私有仓库移除)→ `rollback_complete`(经撤销路径清理 HOME)。
 *
 * **谁说了算**:journal 的 `phase` 是执行器的进度依据(HOME 侧、永远可写),权威记录的 `rollback.phase` **跟随、允许落后**
 * (人工分叉 deferred、提交失败、崩溃都会让它落后)。journal 的 `phase` = 「当前正在这一段」:本段动作做完且**判据从盘上 / 端口重新算出为真**才推进
 * journal 与记录;判据不信 journal 的字面。续做时每个组合的处理:
 *   | journal | 权威记录                       | 处理                                                                                         |
 *   | 有      | 在 canary / shadow / proposed  | 从 journal.phase 起重做各段(都是幂等的);第三段先对记录施加终止事件                          |
 *   | 有      | rolling_back,phase 落后        | 第三段 / 收尾时 `rollback_advance` 逐步追上 journal                                          |
 *   | 有      | rolling_back,phase 领先(提交后崩溃、journal 未推进)| 记录不回退(`advanceRecordTo` 只前进);journal 照常逐段重算判据后推进                  |
 *   | 有      | 终态                           | 跳过记录推进;重新落地终态效果(按键幂等),删 journal                                         |
 *   | 无      | rolling_back                   | `resumeAll` 补一份 `kind=reconcile` 的 journal,从 `rollback_requested` 重做                  |
 *   | 无      | canary(只有 journal 之前崩溃)  | 没有任何影响被改动,下一次终止事件重新来过                                                     |
 * 顺序(R21-9.1 / 安全):journal → 撤销凭据(只写 HOME,第二段)→ 记录 / 私有仓库(第三段,允许 `deferred`)。所以私有仓库分叉 / 不可读时凭据照样落盘,hint 照样停止注入。
 * 同一候选的同一份内容只有一个在途 txn(`txn_id` 由 `(候选 id, content_sha256)` 派生,与 `kind` 无关):重复请求复用它。
 * `identity_changed`(E1,`target_terminal=shadow`)是 V6a:本期入口直接拒绝(`identity_not_available_before_v6a`),不写 journal、不部分执行;读到这种旧 journal 同样不动。
 * journal 首次落盘带 `content_sha256` / `by` / `terminal_event`(W0-20),任一子状态续做都从 journal 取,不依赖私有仓库或权威记录可读;缺这些键的旧 journal 走兜底。
 * 崩溃注入:`onStep` 在 {@link ROLLBACK_STEPS} 的每个命名点被调用,测试里抛错 = 该点之后进程死亡;**只有 {@link PortNotWired} 与凭据文件不合规被转成 `incomplete`,
 * 其余异常原样抛出**(journal 仍在,下一次 `resumeTxn` / `resumeAll` 续做)。
 */
import { RSI_ROLLBACK_PHASES } from '../../contracts/rsi.js';
import type { PersonalLifecycleRecord, PersonalTxn } from '../../contracts/rsi-personal.js';
import { applyEvent, type ApplyDeps, type ApplyResult } from './candidate-apply.js';
import { RsiLockError } from '../lock-error.js';
import type { HeldLock } from '../canary/atomic-write.js';
import { auditKeyOf, landAuditEffects, landTerminalEffects } from './effects-recover.js';
import { txnId } from './ids.js';
import { PersonalStateError } from './home-state.js';
import {
  PortNotWired,
  type CacheCleanup,
  type KeyedEffectSink,
  type PayloadSync,
  type RepoRemoval,
  type RevocationWriter,
  type TxnStore,
} from './rollback-ports.js';
import { byFromReason, revocationSourceProblem, type RevocationBy } from './revoke-write.js';
import {
  TransitionEventSchema,
  isTerminalLifecycle,
  type TransitionEvent,
} from './transition-table.js';

type RollbackPhase = (typeof RSI_ROLLBACK_PHASES)[number];
const PHASES: readonly RollbackPhase[] = RSI_ROLLBACK_PHASES;
const phaseIdx = (p: string): number => PHASES.indexOf(p as RollbackPhase);

/** 崩溃注入点(固定数组,测试 `it.each` 全部覆盖) */
export const ROLLBACK_STEPS: readonly string[] = Object.freeze([
  'before:journal_requested',
  'journal:rollback_requested',
  'enter:rollback_requested',
  'done:rollback_requested',
  'journal:injection_disabled',
  'enter:injection_disabled',
  'after:revocation',
  'after:cache',
  'done:injection_disabled',
  'journal:static_removal_pending',
  'enter:static_removal_pending',
  'after:record_event',
  'after:repo_removal',
  'done:static_removal_pending',
  'journal:rollback_complete',
  'enter:rollback_complete',
  'after:payload',
  'done:rollback_complete',
  'before:finish',
  'after:record_terminal',
  'after:effects',
  'before:journal_remove',
  'after:journal_remove',
]);

export type TxnKind = PersonalTxn['kind'];
export interface RollbackRequest {
  candidate_id: string;
  content_sha256: string;
  kind: TxnKind;
  reason: string;
  /** 撤销来源(W0-17):前台命令发起的保留原来源,worker 自己判的用 `worker`,`exec-run` 事件用 `exec_event` */
  by: RevocationBy;
  target_terminal: PersonalTxn['target_terminal'];
  /** `kind=identity_change` 必填(旧身份的前 12 位);其余必须为 null */
  identity12?: string | null;
  /** 对权威记录施加的终止事件(首次运行;携带调用方的证据串)。缺省 = 按 `reason` 推出(见 {@link eventForReason}) */
  event?: TransitionEvent;
}

export interface RollbackDeps extends ApplyDeps {
  locks: { personal: HeldLock };
  txns: TxnStore;
  revoker: RevocationWriter;
  cache: CacheCleanup;
  repo: RepoRemoval;
  payload: PayloadSync;
  keyedEffects: KeyedEffectSink;
  /**
   * 分叉下撤销完成、仓库移除被推迟时,在**工作副本**记 `repo_removal_deferred=true`(R21-9.3a)。只有能访问工作副本(`.state`)的调用方(worker)装配;
   * 缩减入口不能访问 `.state`,不装配 → 结果里 `workingMarked=false`(待补记任务由保留下来的 journal 承担,不宣称已写)。
   */
  deferralMark?: { mark(candidateId: string): Promise<void> };
  /**
   * 旧 journal(W0-20 之前写的,没有 `content_sha256`)恢复时取候选内容哈希的兜底:权威记录读不到时,生产实现 = 从 `head.json` 记录的提交里只读取
   * (`readRecordedPersonalFiles`)。结果必须与 `txn_id` 对得上才采信。新 journal 自带 `content_sha256`,不走这里。
   */
  recordedSha?: (candidateId: string) => Promise<string | null>;
  /** 崩溃注入 / 观测缝(测试);产品代码不传 */
  onStep?: (step: string) => void | Promise<void>;
}

export type RollbackOutcome =
  | {
      status: 'complete';
      txn: string;
      effects: 'applied' | 'already' | 'deferred' | 'none';
      lateEventNotApplied?: string;
    }
  /**
   * 撤销四段已全部完成(凭据、授予缓存清理 / 待对账、HOME 清理),唯一剩下被 R21-9.3a 推迟的**记录推进与私有仓库移除**(人工分叉 / 属主变化)。
   * 缩减入口据此成功退出;journal 保留,是 HOME 侧「待补记」任务:分叉解除后首个持锁写入方(`resumeAll`)补做并删 journal,届时才是 `complete`。
   * `workingMarked` = 本次是否真的在工作副本写了 `repo_removal_deferred=true`(没有 `deferralMark` 端口 = false)。
   */
  | {
      status: 'revocation_complete';
      txn: string;
      repoRemoval: 'deferred';
      why: string;
      workingMarked: boolean;
      lateEventNotApplied?: string;
    }
  /** 本段 / 收尾没有完成:journal 保留,下一次 `resumeTxn` / `resumeAll` 续做 */
  | {
      status: 'incomplete';
      txn: string;
      phase: RollbackPhase;
      why: string;
      /** 复用在途 txn 时带来的较晚终止事件没有(或尚未)持久化的原因;调用方据此重试(见 {@link lateEventStatus}) */
      lateEventNotApplied?: string;
    }
  | { status: 'refused'; txn: string | null; why: string };

/** 同一候选的同一份内容 → 同一个 txn(与 `kind` 无关) */
export const rollbackTxnId = (candidateId: string, contentSha256: string): string =>
  txnId('rollback', [candidateId], null, contentSha256);

const step = async (d: RollbackDeps, name: string): Promise<void> => {
  await d.onStep?.(name);
};

/**
 * **旧 journal**(W0-20 之前写的,没有 `terminal_event`)的兜底:只有 reason,能还原成终止事件的才还原(`limit_reached` 需要分析证据,不重造)。
 * 新 journal 首次落盘时就带 `terminal_event`,续做从 journal 取,**不走这里**;新请求遇到无法还原事件的需要记录转移的原因,入口直接拒绝(`event_required`)。
 */
export function eventForReason(
  t: Pick<PersonalTxn, 'txn_id' | 'reason'>,
): TransitionEvent | undefined {
  const evidence = `txn:${t.txn_id}`;
  switch (t.reason) {
    case 'cleared':
      return { kind: 'clear', evidence };
    case 'vetoed':
      return { kind: 'veto', evidence };
    case 'tainted':
      return { kind: 'taint', evidence };
    case 'judge_reject':
      return {
        kind: 'judge_reject',
        evidence,
        validated: true,
        verdict_reject: true,
        injection_suspected: false,
      };
    case 'judge_injection':
      return {
        kind: 'judge_reject',
        evidence,
        validated: true,
        verdict_reject: false,
        injection_suspected: true,
      };
    case 'harm_c1':
    case 'harm_c2':
    case 'harm_c3':
    case 'harm_c4':
    case 'harm_c6':
      return { kind: 'harm', evidence, metric: t.reason.slice(5) as 'c1', worse: true };
    default:
      return undefined;
  }
}

/**
 * journal → 撤销来源(W0-17「journal 恢复遵循同样规则」)。新 journal 自带 `by`(W0-20),直接用;**旧 journal**(缺 `by`)靠 (kind, reason) 唯一还原:
 * `kind=clear` → clear;`kind=rollback ∧ reason=cleared` → rollback_to(入口闸 `startRollback` 保证只有 rollback_to 会产生这个组合:clear 必配 kind=clear,
 * worker 拿不到 `cleared`,veto / exec_event 各有自己的原因);其余按原因({@link byFromReason})。
 */
const sourceOf = (t: PersonalTxn): RevocationBy => {
  if (t.kind === 'clear') return 'clear';
  if (t.kind === 'rollback' && t.reason === 'cleared') return 'rollback_to';
  return byFromReason(t.reason);
};

/** 来源 / kind / 原因的相容性(首次请求与读 journal 共用);`null` = 相容 */
function sourceProblem(by: RevocationBy, kind: TxnKind, reason: string): string | null {
  if (reason !== 'identity_changed') {
    const p = revocationSourceProblem(by, reason);
    if (p !== null) return p;
  }
  // rollback_to ⇔ (kind=rollback ∧ reason=cleared):让来源能从旧 journal 唯一还原(见 sourceOf)
  if ((by === 'rollback_to') !== (kind === 'rollback' && reason === 'cleared')) {
    return 'rollback_to_kind_mismatch';
  }
  if (kind === 'clear' && (by !== 'clear' || reason !== 'cleared')) return 'clear_requires_by_clear';
  return null;
}

/** 需要对权威记录施加终止事件的原因(其余:exec / 同步超时 / 撤回 / 无命中由各自的路径推进记录,不经本入口) */
const EVENT_REQUIRED: ReadonlySet<string> = new Set([
  'harm_c1',
  'harm_c2',
  'harm_c3',
  'harm_c4',
  'harm_c6',
  'limit_reached',
  'vetoed',
  'tainted',
  'cleared',
  'judge_reject',
  'judge_injection',
]);

/**
 * 读 journal(含复用在途 txn)得到执行上下文;不合规 → 原因码(fail-closed,不做任何动作)。
 * 新 journal 的 `content_sha256` 必须与 `txn_id` 对得上、`by` 必须与 (kind, reason) 相容、`terminal_event` 必须通过转移引擎的事件 schema(W0-20)。
 */
function journalCtx(
  t: PersonalTxn,
  x: { hint?: TransitionEvent | undefined; sha?: string | undefined },
): RunCtx | string {
  // E1 授权身份变化是 V6a:本期没有交付第二段的缓存 / 拒绝标记判据,旧 journal 里若有这种类型也一律不动
  if (t.kind === 'identity_change') return 'identity_not_available_before_v6a';
  if (t.content_sha256 !== undefined && rollbackTxnId(t.candidate_id, t.content_sha256) !== t.txn_id) {
    return 'txn_invalid';
  }
  let by = sourceOf(t);
  if (t.by !== undefined) {
    if (sourceProblem(t.by, t.kind, t.reason) !== null) return 'txn_invalid';
    by = t.by;
  }
  let event: TransitionEvent | undefined;
  if (t.terminal_event !== undefined) {
    const p = TransitionEventSchema.safeParse(t.terminal_event);
    if (!p.success) return 'txn_invalid';
    event = p.data;
  }
  return { by, event, hint: x.hint, sha: t.content_sha256 ?? x.sha };
}

async function drive(
  d: RollbackDeps,
  t: PersonalTxn,
  x: { hint?: TransitionEvent | undefined; sha?: string | undefined },
): Promise<RollbackOutcome> {
  const c = journalCtx(t, x);
  if (typeof c === 'string') return { status: 'refused', txn: t.txn_id, why: c };
  return runGuarded(d, t, c);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 开始一次回滚 / 撤销:先过来源与原因校验(不合规不写任何东西),再写 journal(第一段),再逐段执行 */
export async function startRollback(
  d: RollbackDeps,
  req: RollbackRequest,
): Promise<RollbackOutcome> {
  const identity = req.kind === 'identity_change';
  if (identity !== (req.reason === 'identity_changed')) {
    return { status: 'refused', txn: null, why: 'identity_kind_mismatch' };
  }
  if (identity !== ((req.identity12 ?? null) !== null)) {
    return { status: 'refused', txn: null, why: 'identity12_mismatch' };
  }
  // E1(V6a)本期没有交付:不写 journal、不动任何东西(不部分执行)
  if (identity) return { status: 'refused', txn: null, why: 'identity_not_available_before_v6a' };
  const sp = sourceProblem(req.by, req.kind, req.reason);
  if (sp !== null) return { status: 'refused', txn: null, why: sp };
  // 事件在写 journal 之前校验:journal 只存通过引擎 schema 的事件(W0-20),续做不再依赖调用方
  let event: TransitionEvent | undefined;
  if (req.event !== undefined) {
    const p = TransitionEventSchema.safeParse(req.event);
    if (!p.success) return { status: 'refused', txn: null, why: 'event_invalid' };
    event = p.data;
  }
  await d.locks.personal.assertHeld();
  const id = rollbackTxnId(req.candidate_id, req.content_sha256);
  const cur = await d.txns.read(id);
  if (cur.kind === 'invalid') return { status: 'refused', txn: id, why: `txn_${cur.why}` };
  if (cur.kind === 'ok') {
    // 已有在途 txn:复用,不新开;来源 / 内容 / 事件一律取 journal 的(请求的 `by` 可能与 journal 的 `reason` 不相容)
    const lateWhy = await lateEventStatus(d, event, req.candidate_id);
    const out = await drive(d, cur.value, { hint: event, sha: req.content_sha256 });
    // `pending_drive`:记录还没进入回滚时由第三段施加;txn 走完了就说明已施加
    if (lateWhy === null || (lateWhy === 'pending_drive' && out.status === 'complete')) return out;
    if (out.status === 'refused') return out;
    return { ...out, lateEventNotApplied: lateWhy };
  }
  if (event === undefined && req.kind !== 'reconcile') {
    event = eventForReason({ txn_id: id, reason: req.reason });
    if (event === undefined && EVENT_REQUIRED.has(req.reason)) {
      return { status: 'refused', txn: null, why: 'event_required' };
    }
  }
  const t: PersonalTxn = {
    schema_version: 1,
    txn_id: id,
    candidate_id: req.candidate_id,
    kind: req.kind,
    reason: req.reason,
    target_terminal: req.target_terminal,
    phase: 'rollback_requested',
    identity12: null,
    at: d.now().toISOString(),
    // W0-20:恢复要用的事实与 journal 一起首次落盘,之后任一子状态都从这里取(不依赖仓库 / 权威记录可读)
    content_sha256: req.content_sha256,
    by: req.by,
    ...(event !== undefined ? { terminal_event: event } : {}),
  };
  await step(d, 'before:journal_requested');
  await d.txns.write(t);
  await step(d, 'journal:rollback_requested');
  return drive(d, t, { hint: event, sha: req.content_sha256 });
}

/** 续做一个在途 journal */
export async function resumeTxn(d: RollbackDeps, id: string): Promise<RollbackOutcome> {
  await d.locks.personal.assertHeld();
  const cur = await d.txns.read(id);
  if (cur.kind === 'absent') return { status: 'refused', txn: id, why: 'txn_absent' };
  if (cur.kind === 'invalid') return { status: 'refused', txn: id, why: `txn_${cur.why}` };
  return drive(d, cur.value, {});
}

/** worker 拿锁后:续做全部在途 journal;再为「权威记录在 rolling_back、却没有 journal」的候选补 journal 并执行 */
export async function resumeAll(d: RollbackDeps): Promise<RollbackOutcome[]> {
  const out: RollbackOutcome[] = [];
  const ids = await d.txns.list();
  for (const id of ids) out.push(await resumeTxn(d, id));
  const all = await d.store.readAll();
  if (all.kind !== 'ok') return out;
  for (const rec of all.value) {
    if (rec.lifecycle !== 'rolling_back' || rec.rollback === null) continue;
    const id = rollbackTxnId(rec.id, rec.content_sha256);
    if (ids.includes(id)) continue;
    out.push(
      await startRollback(d, {
        candidate_id: rec.id,
        content_sha256: rec.content_sha256,
        kind: 'reconcile',
        reason: rec.rollback.reason,
        by: byFromReason(rec.rollback.reason),
        target_terminal: rec.rollback.target_terminal,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// 逐段执行
// ---------------------------------------------------------------------------
interface RunCtx {
  by: RevocationBy;
  /** journal 自带的终止事件(W0-20):记录还在 proposed / shadow / canary 时用它推进;**不**触发 rolling_back 下的自环(那是 `hint` 的事) */
  event?: TransitionEvent | undefined;
  /** 本次调用方带来的终止事件(首次运行 / 复用在途 txn 的较晚事件):记录在 rolling_back 时作为自环(R21-4.4a ①)施加 */
  hint?: TransitionEvent | undefined;
  /** 内容哈希:journal 的 `content_sha256`;旧 journal 缺它时回退 {@link contentShaOf} 的其它来源 */
  sha?: string | undefined;
}

async function runGuarded(d: RollbackDeps, t: PersonalTxn, c: RunCtx): Promise<RollbackOutcome> {
  try {
    return await run(d, t, c);
  } catch (e) {
    if (e instanceof PortNotWired) {
      return {
        status: 'incomplete',
        txn: t.txn_id,
        phase: t.phase,
        why: `port_not_wired:${e.port}`,
      };
    }
    if (e instanceof PersonalStateError && e.kind === 'revocations_invalid') {
      return { status: 'incomplete', txn: t.txn_id, phase: t.phase, why: 'revocations_invalid' };
    }
    throw e;
  }
}

type PhaseResult = { ok: true } | { ok: false; why: string };

async function run(d: RollbackDeps, t0: PersonalTxn, c: RunCtx): Promise<RollbackOutcome> {
  let t = t0;
  for (const phase of PHASES.slice(phaseIdx(t.phase))) {
    await step(d, `enter:${phase}`);
    const r = await doPhase(d, t, phase, c);
    if (!r.ok) return { status: 'incomplete', txn: t.txn_id, phase, why: r.why };
    await step(d, `done:${phase}`);
    const next = PHASES[phaseIdx(phase) + 1];
    if (next !== undefined) {
      t = { ...t, phase: next, at: d.now().toISOString() };
      await d.locks.personal.assertHeld();
      await d.txns.write(t);
      await step(d, `journal:${next}`);
    }
  }
  return finish(d, t, c);
}

async function doPhase(
  d: RollbackDeps,
  t: PersonalTxn,
  phase: RollbackPhase,
  c: RunCtx,
): Promise<PhaseResult> {
  switch (phase) {
    case 'rollback_requested':
      return { ok: true }; // 判据 = journal 已落盘:能走到这里就是读到了它
    case 'injection_disabled':
      return injectionDisabled(d, t, c);
    case 'static_removal_pending':
      return staticRemoval(d, t, c);
    case 'rollback_complete':
      return rollbackComplete(d, t);
  }
}

/** 候选的 `content_sha256`:journal 自带的(新)→ 权威记录 → 撤销凭据 → `recordedSha` 兜底(旧 journal);每个来源都必须与 `txn_id` 对得上才采信(txn_id 绑定了内容) */
async function contentShaOf(d: RollbackDeps, t: PersonalTxn, c: RunCtx): Promise<string | null> {
  const bound = (sha: string | null | undefined): string | null =>
    sha !== null && sha !== undefined && rollbackTxnId(t.candidate_id, sha) === t.txn_id
      ? sha
      : null;
  const given = bound(c.sha);
  if (given !== null) return given;
  const rd = await d.store.read(t.candidate_id);
  if (rd.kind === 'ok') {
    const s = bound(rd.record.content_sha256);
    if (s !== null) return s;
  }
  const rv = await d.revocations.read();
  if (rv.kind === 'ok') {
    for (const l of rv.lines) {
      const s = l.candidate_id === t.candidate_id ? bound(l.content_sha256) : null;
      if (s !== null) return s;
    }
  }
  return bound(d.recordedSha === undefined ? null : await d.recordedSha(t.candidate_id));
}

// --- 第二段:撤销凭据 + 授予缓存清理 ---
async function injectionDisabled(d: RollbackDeps, t: PersonalTxn, c: RunCtx): Promise<PhaseResult> {
  const sha = await contentShaOf(d, t, c);
  if (sha === null) return { ok: false, why: 'content_unknown' };
  await d.locks.personal.assertHeld();
  await d.revoker.write({
    at: d.now().toISOString(),
    candidate_id: t.candidate_id,
    content_sha256: sha,
    identity12: null,
    reason: t.reason,
    by: c.by,
  });
  await step(d, 'after:revocation');
  // 判据:凭据**已在盘上**(重读,不信写入返回值)
  const rv = await d.revocations.read();
  if (rv.kind !== 'ok') return { ok: false, why: 'revocations_invalid' };
  if (!rv.lines.some((l) => l.candidate_id === t.candidate_id && l.content_sha256 === sha)) {
    return { ok: false, why: 'revocation_missing' };
  }
  await d.cache.clean({ candidate_id: t.candidate_id, content_sha256: sha });
  await step(d, 'after:cache');
  return { ok: true };
}

// --- 记录 / 仓库侧 ---
const applyDeps = (d: RollbackDeps): ApplyDeps => ({
  store: d.store,
  working: d.working,
  revocations: d.revocations,
  // 审计行经带键端口落地(键 = 转移条目的稳定事件键,见 `auditKeyOf`):提交后崩溃、落地失败都由收尾按记录补做,同一行不会重复
  audit: {
    append: async (lines) => {
      for (const l of lines) {
        await d.keyedEffects.applyOnce(auditKeyOf(l), [{ type: 'append_audit', line: l }]);
      }
    },
  },
  // 终态效果只经带键的落地(`landTerminalEffects`),这里不重复落(否则同一终态会被无键 + 有键各落一次)
  effects: { apply: async () => undefined },
  env: d.env,
  now: d.now,
});

/** 经 W3 的 `applyEvent` 施加一个事件;提交后发现丢锁(`lockLost`)→ 立即抛 `lock_lost`,不再继续任何写出口(journal 留给新的持锁者续做) */
async function applyOne(
  d: RollbackDeps,
  rec: PersonalLifecycleRecord,
  event: TransitionEvent,
): Promise<ApplyResult> {
  const r = await applyEvent(applyDeps(d), rec, event);
  if (r.kind === 'transitioned' && r.lockLost === true) throw new RsiLockError('lock_lost');
  return r;
}

/**
 * 复用在途 txn 时较晚到达的终止事件(R21-4.4a ① 自环:终态理由取优先级最高者)。事件**只有施加到权威记录才算持久化**(journal 不存它),所以:
 * 记录在 `rolling_back` → 先于任何动作直接施加;记录读不到 / 施加失败 / 记录已终态 / 记录还没进入回滚(留给第三段的 `driveRecord`)→ 返回原因码,
 * 由调用方经 `lateEventNotApplied` 得知并稍后重试。**不阻断撤销事务**:凭据与 HOME 清理(降低影响)照常继续,事件是否已持久化与撤销进度互不依赖。
 * `null` = 已施加,或没有记录可施加(记录不存在)。
 */
async function lateEventStatus(
  d: RollbackDeps,
  event: TransitionEvent | undefined,
  candidateId: string,
): Promise<string | null> {
  if (event === undefined) return null;
  const rd = await d.store.read(candidateId);
  if (rd.kind === 'absent' || rd.kind === 'missing') return null;
  if (rd.kind === 'deferred' || rd.kind === 'invalid') return `repo_${rd.kind}`;
  if (isTerminalLifecycle(rd.record.lifecycle)) return 'record_terminal';
  if (rd.record.lifecycle !== 'rolling_back') return 'pending_drive';
  const r = await applyOne(d, rd.record, event);
  if (r.kind === 'transitioned' || r.kind === 'noop') return null;
  return r.kind === 'halt'
    ? r.halt
    : r.kind === 'refused'
      ? (r.refusal.guard ?? r.refusal.refused)
      : r.kind;
}

/** 撤销路径的目标:凭据全集 + 本候选(identity_changed 不写凭据,只靠本候选);凭据读不到 → null */
async function revokeTargets(d: RollbackDeps, t: PersonalTxn): Promise<string[] | null> {
  const rv = await d.revocations.read();
  if (rv.kind !== 'ok') return null;
  return [...new Set([...rv.lines.map((l) => l.candidate_id), t.candidate_id])].sort();
}

type RecordPart =
  | { repo: 'ok'; rec: PersonalLifecycleRecord; note?: string }
  | { repo: 'none' | 'deferred' | 'invalid'; why?: string };

/** 读记录并把非终态、非回滚中的记录用终止事件推进(canary → rolling_back;proposed / shadow → 终态);推进失败不阻断 HOME 侧(凭据已落盘),在 `note` 里报 */
async function driveRecord(d: RollbackDeps, t: PersonalTxn, c: RunCtx): Promise<RecordPart> {
  const rd = await d.store.read(t.candidate_id);
  if (rd.kind === 'absent' || rd.kind === 'missing') return { repo: 'none' };
  if (rd.kind === 'deferred') return { repo: 'deferred', why: rd.why };
  if (rd.kind === 'invalid') return { repo: 'invalid', why: rd.why };
  let rec = rd.record;
  const inFlight = rec.lifecycle === 'rolling_back' && c.hint !== undefined; // 回滚中再来的终止事件(R21-4.4a ① 自环):只在首次运行显式给了事件时施加
  if (
    rec.lifecycle === 'proposed' ||
    rec.lifecycle === 'shadow' ||
    rec.lifecycle === 'canary' ||
    inFlight
  ) {
    const event = c.hint ?? c.event ?? eventForReason(t);
    if (event === undefined) return { repo: 'ok', rec, note: 'record_unmapped' };
    const r = await applyOne(d, rec, event);
    if (r.kind === 'transitioned') rec = r.next;
    else if (r.kind === 'halt') {
      if (r.halt === 'repo_deferred') return { repo: 'deferred', why: r.why ?? 'deferred' };
      if (r.halt === 'repo_invalid') return { repo: 'invalid', why: r.why ?? 'invalid' };
      if (r.halt === 'repo_absent') return { repo: 'none' };
      return { repo: 'ok', rec, note: `record_halt:${r.halt}` };
    } else if (r.kind === 'refused') {
      return { repo: 'ok', rec, note: `record_refused:${r.refusal.guard ?? r.refusal.refused}` };
    } else if (r.kind === 'stale') return { repo: 'ok', rec, note: 'record_stale' };
  }
  return { repo: 'ok', rec };
}

/** 记录的 `rollback.phase` 逐步追上 `to`(只前进;每一步都是一个 `rollback_advance` 事件,判据已由 journal 的进度保证) */
async function advanceRecordTo(
  d: RollbackDeps,
  t: PersonalTxn,
  rec: PersonalLifecycleRecord,
  to: RollbackPhase,
): Promise<PersonalLifecycleRecord> {
  let cur = rec;
  if (cur.lifecycle !== 'rolling_back' || cur.rollback === null) return cur;
  const from = phaseIdx(cur.rollback.phase);
  for (const p of PHASES.slice(from + 1, phaseIdx(to) + 1)) {
    const r = await applyOne(d, cur, {
      kind: 'rollback_advance',
      evidence: `txn:${t.txn_id}:${p}`,
      to: p,
      current_completed: true,
    });
    if (r.kind === 'transitioned') {
      cur = r.next;
      continue;
    }
    const re = await d.store.read(cur.id);
    if (re.kind !== 'ok') return cur;
    cur = re.record;
    if (
      cur.lifecycle !== 'rolling_back' ||
      cur.rollback === null ||
      phaseIdx(cur.rollback.phase) < phaseIdx(p)
    ) {
      return cur; // 推不动(提交失败 / 并发 / 被拒):保持落后,journal 是进度依据
    }
  }
  return cur;
}

// --- 第三段:私有仓库移除(允许 deferred) ---
async function staticRemoval(d: RollbackDeps, t: PersonalTxn, c: RunCtx): Promise<PhaseResult> {
  const part = await driveRecord(d, t, c);
  await step(d, 'after:record_event');
  if (part.repo === 'invalid') return { ok: false, why: `repo_invalid:${part.why ?? ''}` };
  // 记录没能被推进(事件无法还原 / 引擎拒绝 / 并发变化):不删仓库文件(记录仍在生效状态),本段未完成,journal 保留待续
  if (part.repo === 'ok' && part.note !== undefined) return { ok: false, why: part.note };
  let deferred = part.repo === 'deferred';
  if (part.repo === 'ok') {
    const sha = part.rec.content_sha256;
    const rem = await d.repo.remove(
      { id: part.rec.id, content_sha256: sha, target_paths: part.rec.target_paths },
      t.kind === 'clear' ? 'clear' : 'rollback',
    );
    await step(d, 'after:repo_removal');
    if (rem.status === 'invalid') return { ok: false, why: `repo_invalid:${rem.why}` };
    if (rem.status === 'deferred') deferred = true;
    else await advanceRecordTo(d, t, part.rec, 'static_removal_pending');
  } else {
    await step(d, 'after:repo_removal');
  }
  // 判据:仓库部分已提交 / 本就没有(`committed` / `already` / `absent`);deferred 时改为「本机 payload 已不含该候选」(R21-9.3a)。
  // deferred 下第三段的动作包含「以上次已同步版本减去凭据所列候选为目标重渲染本机 payload」,所以先经撤销路径清,再验证缺席(不能把后一步的结果当前置条件 → 死锁)
  if (deferred) {
    const ids = await revokeTargets(d, t);
    if (ids === null) return { ok: false, why: 'revocations_invalid' };
    const r = await d.payload.revoke(ids);
    if (r.status === 'drift') return { ok: false, why: `drift:${r.why}` };
    if (r.status === 'unavailable') return { ok: false, why: `payload_unavailable:${r.why}` };
    if (!(await d.payload.absent(t.candidate_id))) {
      return { ok: false, why: 'deferred_payload_still_has_candidate' };
    }
  }
  return { ok: true };
}

// --- 第四段:经撤销路径同步 HOME ---
async function rollbackComplete(d: RollbackDeps, t: PersonalTxn): Promise<PhaseResult> {
  // 目标 = 「上次已同步版本减去撤销凭据所列候选」
  const ids = await revokeTargets(d, t);
  if (ids === null) return { ok: false, why: 'revocations_invalid' };
  const r = await d.payload.revoke(ids);
  await step(d, 'after:payload');
  if (r.status === 'drift') return { ok: false, why: `drift:${r.why}` };
  if (r.status === 'unavailable') return { ok: false, why: `payload_unavailable:${r.why}` };
  if (!(await d.payload.absent(t.candidate_id)))
    return { ok: false, why: 'payload_still_has_candidate' };
  return { ok: true };
}

// --- 收尾:记录到终态 → 终态效果 → 删 journal ---
async function finish(d: RollbackDeps, t: PersonalTxn, c: RunCtx): Promise<RollbackOutcome> {
  const inc = (why: string): RollbackOutcome => ({
    status: 'incomplete',
    txn: t.txn_id,
    phase: 'rollback_complete',
    why,
  });
  await step(d, 'before:finish');
  // 撤销四段已全部完成;以下只剩记录推进 / 仓库移除 / 终态效果。分叉(R21-9.3a)只推迟后者,不推翻前者
  const deferredDone = async (why: string): Promise<RollbackOutcome> => {
    let marked = false;
    if (d.deferralMark !== undefined) {
      await d.deferralMark.mark(t.candidate_id);
      marked = true;
    }
    return {
      status: 'revocation_complete',
      txn: t.txn_id,
      repoRemoval: 'deferred',
      why,
      workingMarked: marked,
    };
  };
  let rd = await d.store.read(t.candidate_id);
  if (
    rd.kind === 'ok' &&
    !isTerminalLifecycle(rd.record.lifecycle) &&
    rd.record.lifecycle !== 'rolling_back'
  ) {
    // 记录还没被推进(R21-9.3a:分叉期间被推迟的提交,或续做时第三段已过):先补做被推迟的记录推进与仓库移除(「第一个持锁写入方先补做」)
    const r = await staticRemoval(d, t, c);
    if (!r.ok) return inc(r.why);
    rd = await d.store.read(t.candidate_id);
  }
  let effects: 'applied' | 'already' | 'deferred' | 'none' = 'none';
  if (rd.kind === 'deferred') return deferredDone(`repo_deferred:${rd.why}`);
  if (rd.kind === 'invalid') return inc(`repo_invalid:${rd.why}`);
  if (rd.kind === 'ok') {
    let rec = rd.record;
    // 第三段允许 deferred:分叉解除后在这里补做仓库移除(重新从盘上判据检查,`already` = 已删;不能用 journal 的 phase 推断它做过)
    const rem = await d.repo.remove(
      { id: rec.id, content_sha256: rec.content_sha256, target_paths: rec.target_paths },
      t.kind === 'clear' ? 'clear' : 'rollback',
    );
    if (rem.status === 'invalid') return inc(`repo_invalid:${rem.why}`);
    if (rem.status === 'deferred') return deferredDone(`repo_deferred:${rem.why}`);
    if (rec.lifecycle === 'rolling_back') {
      rec = await advanceRecordTo(d, t, rec, 'rollback_complete');
      if (rec.lifecycle === 'rolling_back' && rec.rollback?.phase !== 'rollback_complete') {
        return inc('record_lagging');
      }
      if (rec.lifecycle === 'rolling_back') {
        for (const agent of ['claude', 'pi', 'codex'] as const) {
          if (rec.deploy[agent] !== 'removal_pending') continue;
          const r = await applyOne(d, rec, {
            kind: 'removal_done',
            evidence: `txn:${t.txn_id}:${agent}`,
            agent,
            criterion_met: await d.payload.absent(t.candidate_id),
          });
          if (r.kind === 'transitioned') rec = r.next;
        }
        const r = await applyOne(d, rec, {
          kind: 'compensation_done',
          evidence: `txn:${t.txn_id}`,
          completion_met: true,
        });
        if (r.kind === 'transitioned') rec = r.next;
        else if (r.kind === 'refused') {
          return inc(`record_refused:${r.refusal.guard ?? r.refusal.refused}`);
        } else if (r.kind === 'halt') return inc(`record_halt:${r.halt}`);
        else {
          const re = await d.store.read(t.candidate_id);
          if (re.kind === 'ok') rec = re.record;
        }
      }
    }
    await step(d, 'after:record_terminal');
    if (!isTerminalLifecycle(rec.lifecycle)) return inc('record_not_terminal');
    effects = await landTerminalEffects(d.keyedEffects, rec);
    await landAuditEffects(d.keyedEffects, rec);
    await step(d, 'after:effects');
  }
  await d.locks.personal.assertHeld();
  await step(d, 'before:journal_remove');
  await d.txns.remove(t.txn_id);
  await step(d, 'after:journal_remove');
  return { status: 'complete', txn: t.txn_id, effects };
}
