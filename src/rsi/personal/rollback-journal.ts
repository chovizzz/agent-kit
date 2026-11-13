/**
 * 回滚 journal 的事实边界(docs/contracts.md §21.24 W0-20):**新建**与**读取**各一个函数,执行器不在别处拼 / 猜这三项恢复事实
 * (`content_sha256` / `by` / `terminal_event`)。
 *
 *  - {@link newJournal}:**唯一**的新 journal 创建函数,持久化之前强制:三项恢复字段齐备、`terminal_event` 过转移引擎的事件 schema、
 *    `terminationReason(event) === reason`、`terminationTarget(event) === target_terminal`、来源 / kind / 原因相容、`txn_id` 绑定内容。
 *    任一不满足 = `refused`(零副作用,不写 journal、不写凭据)。`kind=reconcile` 不是例外:拿不到终止事实就不创建。
 *  - {@link readJournal}:读已有 journal 得到执行上下文。**字段存在但不合规**(sha 对不上 `txn_id`、`by` 与 (kind, reason) 不相容、事件过不了 schema /
 *    与 reason、target 不一致)= `txn_invalid`(refused,零后续写入);**必需项缺失**(旧格式)= 按契约的来源还原,还原不了 = `incomplete`(不写凭据、不伪造)。
 *    旧格式的三项**先于任何事务动作**一次收齐(尤其先于写撤销凭据)。
 *
 * 旧格式还原规则(只在来源能唯一证明时):
 *  - `by`:`kind=clear` → `clear`;其余由 reason 在 W0-17 表里**唯一**对应的来源(`RSI_REVOCATION_REASONS_BY`)推出;
 *    `cleared` 配 `kind=rollback / reconcile` 可能来自 `rollback_to` 或 `clear` → 不推出。不拿新入口的限制反推历史来源。
 *  - `content_sha256`:只从撤销凭据,或经 `head.json` 记录的提交读到的权威记录({@link ReadDeps.recordedSha});**不**直接信权威副本的当前值,也不信请求带来的值。
 *  - `terminal_event`:只对「原因码本身就是完整事件」的情形重建({@link reconstructEvent}:clear / veto / taint,事件只有 evidence);
 *    harm / judge / limit 等需要原始证据的不伪造。
 * W7 从未发版:生产上不存在真实的旧 journal,这些规则只约束开发期遗留。
 */
import { z } from 'zod';
import {
  RSI_REVOCATION_BY,
  RSI_REVOCATION_REASONS_BY,
  type RSI_ROLLBACK_CAUSES,
} from '../../contracts/rsi.js';
import { Sha256Schema } from '../../contracts/common.js';
import {
  PersonalTxnSchema,
  type PersonalTxn,
  type RsiRevocationLine,
} from '../../contracts/rsi-personal.js';
import { txnId } from './ids.js';
import { revocationSourceProblem, type RevocationBy } from './revoke-write.js';
import {
  TransitionEventSchema,
  terminationReason,
  terminationTarget,
  type TransitionEvent,
} from './transition-table.js';

type TxnKind = PersonalTxn['kind'];
export type RollbackCause = (typeof RSI_ROLLBACK_CAUSES)[number];

/** 同一候选的同一份内容 → 同一个 txn(与 `kind` 无关) */
export const rollbackTxnId = (candidateId: string, contentSha256: string): string =>
  txnId('rollback', [candidateId], null, contentSha256);

/** 新格式 journal:三个恢复键全部必填(W0-20「首次写 journal 时一起落盘」) */
export const NewPersonalTxnSchema = PersonalTxnSchema.extend({
  content_sha256: Sha256Schema,
  by: z.enum(RSI_REVOCATION_BY),
  terminal_event: z.record(z.string(), z.unknown()),
});

/** 来源 / kind / 原因的相容性(新建与读取共用);`null` = 相容 */
export function sourceProblem(by: RevocationBy, kind: TxnKind, reason: string): string | null {
  if (reason !== 'identity_changed') {
    const p = revocationSourceProblem(by, reason);
    if (p !== null) return p;
  }
  // rollback_to ⇔ (kind=rollback ∧ reason=cleared)(入口闸:新请求里这个组合只来自 rollback_to)
  if ((by === 'rollback_to') !== (kind === 'rollback' && reason === 'cleared')) {
    return 'rollback_to_kind_mismatch';
  }
  if (kind === 'clear' && (by !== 'clear' || reason !== 'cleared'))
    return 'clear_requires_by_clear';
  return null;
}

/** 终止事件与 journal 的 reason / target_terminal 是否一致;`null` = 一致 */
export function eventProblem(
  event: TransitionEvent,
  reason: string,
  target: PersonalTxn['target_terminal'],
): string | null {
  if (terminationReason(event) !== reason) return 'event_reason_mismatch';
  if (terminationTarget(event) !== target) return 'event_target_mismatch';
  return null;
}

/**
 * 只对「原因码本身就是完整事件」的情形重建终止事件(事件除 `kind` / `evidence` 外没有别的事实):clear / veto / taint。
 * harm(`worse`、指标证据)/ judge(裁决事实)/ limit(分析证据)等一律不重建,不伪造证据。证据串固定为 `txn:<id>`(只作幂等键的来源)。
 */
export function reconstructEvent(
  txn: Pick<PersonalTxn, 'txn_id' | 'reason'>,
): TransitionEvent | undefined {
  const evidence = `txn:${txn.txn_id}`;
  switch (txn.reason) {
    case 'cleared':
      return { kind: 'clear', evidence };
    case 'vetoed':
      return { kind: 'veto', evidence };
    case 'tainted':
      return { kind: 'taint', evidence };
    default:
      return undefined;
  }
}

/** 旧格式的来源还原(见头注);不能唯一确定 → `undefined` */
export function uniqueBy(kind: TxnKind, reason: string): RevocationBy | undefined {
  if (kind === 'clear') return 'clear';
  const owners = RSI_REVOCATION_BY.filter((b) => RSI_REVOCATION_REASONS_BY[b].includes(reason));
  return owners.length === 1 ? owners[0] : undefined;
}

export interface NewJournalRequest {
  candidate_id: string;
  content_sha256: string;
  kind: TxnKind;
  reason: string;
  by: RevocationBy;
  target_terminal: PersonalTxn['target_terminal'];
  event?: unknown;
}

/** **唯一**的新 journal 创建函数(见头注)。成功返回已通过 {@link NewPersonalTxnSchema} 的 journal 与校验过的事件 */
export function newJournal(
  req: NewJournalRequest,
  at: string,
):
  | { ok: true; txn: PersonalTxn; event: TransitionEvent }
  | { ok: false; why: string; cause: RollbackCause } {
  if (req.kind === 'identity_change' || req.reason === 'identity_changed') {
    return { ok: false, why: 'identity_not_available_before_v6a', cause: 'candidate_invalid' };
  }
  const sp = sourceProblem(req.by, req.kind, req.reason);
  if (sp !== null) return { ok: false, why: sp, cause: 'candidate_invalid' };
  const id = rollbackTxnId(req.candidate_id, req.content_sha256);
  let event: TransitionEvent | undefined;
  if (req.event !== undefined) {
    const p = TransitionEventSchema.safeParse(req.event);
    if (!p.success) return { ok: false, why: 'event_invalid', cause: 'candidate_invalid' };
    event = p.data;
  } else {
    event = reconstructEvent({ txn_id: id, reason: req.reason });
    if (event === undefined) {
      return { ok: false, why: 'event_required', cause: 'manual_event_required' };
    }
  }
  const ep = eventProblem(event, req.reason, req.target_terminal);
  if (ep !== null) return { ok: false, why: ep, cause: 'candidate_invalid' };
  const out = NewPersonalTxnSchema.safeParse({
    schema_version: 1,
    txn_id: id,
    candidate_id: req.candidate_id,
    kind: req.kind,
    reason: req.reason,
    target_terminal: req.target_terminal,
    phase: 'rollback_requested',
    identity12: null,
    at,
    content_sha256: req.content_sha256,
    by: req.by,
    terminal_event: event,
  });
  if (!out.success) return { ok: false, why: 'journal_invalid', cause: 'candidate_invalid' };
  return { ok: true, txn: out.data, event };
}

/** 执行上下文:三项恢复事实都已确定 */
export interface JournalCtx {
  by: RevocationBy;
  event: TransitionEvent;
  sha: string;
}

export interface ReadDeps {
  revocations: {
    read(): Promise<
      { kind: 'ok'; lines: readonly RsiRevocationLine[] } | { kind: 'invalid'; why: string }
    >;
  };
  /** 旧 journal 的内容哈希兜底:`head.json` 记录的提交里的权威记录(读不到 / 没有 = null) */
  recordedSha?: (candidateId: string) => Promise<string | null>;
}

export type JournalRead =
  | { kind: 'ok'; ctx: JournalCtx }
  /** `cause=txn_invalid` = journal 完整性错误(含旧格式缺 content_sha256 无法绑定身份;调用方不得把它当作带事务身份的结果);`identity_not_available_before_v6a` = 本期不支持的合法 journal(cause `candidate_invalid`) */
  | {
      kind: 'invalid';
      why: string;
      cause: RollbackCause;
    }
  | { kind: 'incomplete'; why: string; cause: RollbackCause };

/** 读 journal(含复用在途 txn):逐键校验 / 还原,先于任何事务动作(见头注) */
export async function readJournal(d: ReadDeps, t: PersonalTxn): Promise<JournalRead> {
  // E1 授权身份变化是 V6a:本期没有交付第二段的缓存 / 拒绝标记判据,旧 journal 里若有这种类型也一律不动
  if (t.kind === 'identity_change') {
    return {
      kind: 'invalid',
      why: 'identity_not_available_before_v6a',
      cause: 'candidate_invalid',
    };
  }
  const bad: JournalRead = { kind: 'invalid', why: 'txn_invalid', cause: 'txn_invalid' };
  const missing: string[] = [];

  // by:存在 → 必须与 (kind, reason) 相容;缺失 → 唯一还原
  let by: RevocationBy | undefined;
  if (t.by !== undefined) {
    if (sourceProblem(t.by, t.kind, t.reason) !== null) return bad;
    by = t.by;
  } else {
    by = uniqueBy(t.kind, t.reason);
    if (by === undefined) missing.push('by');
    else if (sourceProblem(by, t.kind, t.reason) !== null) return bad;
  }

  // terminal_event:存在 → 过事件 schema 且与 reason / target 一致;缺失 → 只重建无证据要求的事件
  let event: TransitionEvent | undefined;
  if (t.terminal_event !== undefined) {
    const p = TransitionEventSchema.safeParse(t.terminal_event);
    if (!p.success) return bad;
    event = p.data;
  } else {
    event = reconstructEvent(t);
    if (event === undefined) missing.push('terminal_event');
  }
  if (event !== undefined && eventProblem(event, t.reason, t.target_terminal) !== null) return bad;

  // content_sha256:存在 → 必须绑定 txn_id;缺失 → 撤销凭据 / head.json 记录的提交
  let sha: string | undefined;
  if (t.content_sha256 !== undefined) {
    if (rollbackTxnId(t.candidate_id, t.content_sha256) !== t.txn_id) return bad;
    sha = t.content_sha256;
  } else {
    const rv = await d.revocations.read();
    if (rv.kind !== 'ok') {
      return { kind: 'incomplete', why: 'revocations_invalid', cause: 'credentials_invalid' };
    }
    const bound = (s: string | null | undefined): string | undefined =>
      s !== null && s !== undefined && rollbackTxnId(t.candidate_id, s) === t.txn_id
        ? s
        : undefined;
    for (const l of rv.lines) {
      if (l.candidate_id === t.candidate_id) sha ??= bound(l.content_sha256);
    }
    sha ??= bound(d.recordedSha === undefined ? null : await d.recordedSha(t.candidate_id));
    if (sha === undefined) missing.push('content_sha256');
  }

  if (missing.length > 0 || by === undefined || event === undefined || sha === undefined) {
    const why = `legacy_unrecoverable:${missing.join(',')}`;
    // 缺 content_sha256 = journal 无法绑定事务身份:这是完整性错误(R3-H2),不带事务身份,不被同 (id, sha) 的 complete 消除;仍不写凭据、不动记录
    if (missing.includes('content_sha256')) return { kind: 'invalid', why, cause: 'txn_invalid' };
    // 缺原始证据 = 等人工补事件;只缺来源 = 来源有歧义
    return {
      kind: 'incomplete',
      why,
      cause: missing.includes('terminal_event') ? 'manual_event_required' : 'manual_by_ambiguous',
    };
  }
  return { kind: 'ok', ctx: { by, event, sha } };
}
