/**
 * 个人层转移引擎:`transition(record, event, ctx)`(docs/contracts.md R21-4;§21.24 W0-13)。**纯函数、无 I/O、不读系统时间**:
 * 返回 `{next, entries, effects}`(`effects` 只是给调用方的类型化描述,由 W3 / W7 / W8 的写模块在锁内执行)或 `{refused}`。
 *
 * 拒绝与判定的**固定顺序**(每一步各有测试钉住):
 *  1. 入参过 schema:record → `candidate_invalid`(含 R21-4.3 非法组合);event / ctx → `bad_input`;
 *  2. 幂等:对该事件种类对应的全部行算 `idem_key`,命中 `record.transitions[]` → `noop`(第二次执行的记录已是新状态,所以必须先于「查行」);
 *  3. 本期没有行的状态(`blocked / adopted / stable / retiring`)→ `phase_not_available`;
 *  4. 终态:终止事件 `veto` 只出黑名单 effect,其余终止事件只写审计(R21-4.4a ②),非终止事件 → `illegal_transition`;
 *  5. 查行(状态 × 事件)→ 无行 `illegal_transition`(例如试图从 canary 直接改到终态:不存在这种行,R21-4.4);
 *  6. 能力:每个 `caps` 键经 `capabilityAvailable(key, ctx.phase)` → `phase_not_available`(默认拒绝);
 *  7. 守卫 → `guard_false`(带守卫码);
 *  8. 应用;出参再过一次 schema,不过 = `candidate_invalid`(fail-closed,引擎自己不产出非法记录)。
 *
 * **调用方前置条件 / 保证边界**:
 *  - 幂等只在 `record.transitions[]` 的 256 条窗口内成立。窗口外的重复事件不保证是空操作,但只会走「终止事件自环」,
 *    **不会增加影响、不会回退 `rollback.phase`、不会降级 `target_terminal` 或终态理由**(R21-4.4a 的只升不降)。
 *  - 重复事件返回**空 effects**。未完成的 effects(黑名单、墓碑、冷却、审计、外部部署)由调用方的持久化事务 / outbox 续做,
 *    **不能靠事件重放补齐**(实现与崩溃测试归 W7)。
 */
import { z } from 'zod';
import { IsoDateSchema } from '../../contracts/common.js';
import {
  RSI_COOLDOWN_DAYS,
  RSI_SHADOW_MIN_HITS,
  RSI_SHADOW_MIN_SESSIONS,
  RSI_TARGET_TERMINALS,
  RSI_TRANSITIONS_MAX,
  capabilityAvailable,
} from '../../contracts/rsi.js';
import {
  PersonalLifecycleRecordSchema,
  type PersonalLifecycleRecord,
  type RsiAuditLine,
} from '../../contracts/rsi-personal.js';
import { idemKey } from './ids.js';
import {
  PromoteBaseSchema,
  isTerminalLifecycle,
  isTerminationKind,
  isUnimplementedLifecycle,
  TransitionCtxSchema,
  TransitionEventSchema,
  promoteEligibilityBlocker,
  queueExpired,
  rowsOfKind,
  slotBlocker,
  targetPriority,
  terminalPriority,
  terminalReasonOf,
  terminationReason,
  terminationTarget,
  utcDay,
  type TransitionCtx,
  type TransitionEvent,
  type TransitionRow,
} from './transition-table.js';

export type TransitionEntry = PersonalLifecycleRecord['transitions'][number];

/** 内部拒绝码(不是用户可见稳定码;`phase_not_available` 对应 R21-12.9 之外的内部通道,命令层自行映射) */
export type RefusalCode =
  'candidate_invalid' | 'bad_input' | 'phase_not_available' | 'illegal_transition' | 'guard_false';
export interface Refusal {
  refused: RefusalCode;
  /** `guard_false` 时的守卫码 */
  guard?: string;
  /** 人读补充(能力键、schema 首个问题等;不含候选正文) */
  detail?: string;
}

/** 调用方在锁内执行的外部效果(本函数只描述,不执行) */
export type TransitionEffect =
  /** R21-3.8:每次转移经一次 `commitPersonal` 写入权威副本,成功后才更新工作副本 */
  | { type: 'commit_lifecycle'; id: string }
  /** `idem_key` = 产生这一行的转移条目的事件身份(R21-4);带键的落地端据此「同一事件只落一次」。终态空操作的审计没有条目,也就没有键 */
  | { type: 'append_audit'; line: RsiAuditLine; idem_key?: string }
  /** R21-11.3:指纹永久黑名单(任何状态收到 veto 都发;终态只发这一个) */
  | { type: 'blacklist_veto'; id: string; content_sha256: string }
  /** R21-11.4:终态 id 进墓碑 */
  | { type: 'write_tombstone'; id: string; terminal: string; reason: string }
  /** R21-11.1:聚类冷却(自动回滚 90 天、`expired` 30 天;连续 rejected 的 7 天需要历史,由调用方判) */
  | { type: 'start_cooldown'; cluster_id: string; kind: 'auto_rollback' | 'expired'; days: number };

export interface Transitioned {
  outcome: 'transitioned' | 'noop';
  /** `noop` 的原因:同一 idem_key 重复到达,或终态上的终止事件 */
  noop_reason?: 'duplicate_idem_key' | 'terminal_state';
  next: PersonalLifecycleRecord;
  /** 本次追加到 `transitions[]` 的条目(`noop` 恒为空) */
  entries: TransitionEntry[];
  effects: TransitionEffect[];
}
export type TransitionResult = Transitioned | Refusal;

export function isRefusal(r: TransitionResult): r is Refusal {
  return 'refused' in r;
}

const refuse = (refused: RefusalCode, guard?: string, detail?: string): Refusal => ({
  refused,
  ...(guard !== undefined ? { guard } : {}),
  ...(detail !== undefined ? { detail } : {}),
});
const firstIssue = (e: z.ZodError): string => {
  const i = e.issues[0];
  return i === undefined ? 'invalid' : `${i.path.map(String).join('.')}: ${i.message}`;
};

const agentOf = (e: TransitionEvent): string | undefined =>
  e.kind === 'deploy_inject' || e.kind === 'removal_done' ? e.agent : undefined;

/** 行的 `to` 的全部可能取值(`target` = 回滚目标终态的四个取值) */
const tosOf = (row: TransitionRow): readonly string[] =>
  row.to === 'target' ? RSI_TARGET_TERMINALS : [row.to];

function dimState(
  record: PersonalLifecycleRecord,
  row: TransitionRow,
  e: TransitionEvent,
): string | undefined {
  switch (row.dim) {
    case 'lifecycle':
      return record.lifecycle;
    case 'deploy': {
      const a = agentOf(e);
      return a === undefined ? undefined : record.deploy[a as 'claude' | 'pi' | 'codex'];
    }
    case 'rollback':
      return record.rollback?.phase;
  }
}

export function auditOf(entry: TransitionEntry, id: string): RsiAuditLine {
  return {
    at: entry.at,
    kind: 'transition',
    id,
    dim: entry.dim,
    ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
    from: entry.from,
    to: entry.to,
    reason: entry.reason,
  };
}

/** R21-4.4a:终态收到事件(②):`veto` 只写黑名单;其余终止事件空操作(只写审计);非终止事件拒绝 */
function onTerminal(
  record: PersonalLifecycleRecord,
  event: TransitionEvent,
  ctx: TransitionCtx,
): TransitionResult {
  if (!isTerminationKind(event.kind)) return refuse('illegal_transition', undefined, 'terminal');
  if (!capabilityAvailable('transition_to_rejected', ctx.phase)) {
    return refuse('phase_not_available', undefined, 'transition_to_rejected');
  }
  // R21-4.4a ②:`veto` 只写黑名单(R21-11.3);其余终止事件是空操作,只写审计
  const effects: TransitionEffect[] =
    event.kind === 'veto'
      ? [{ type: 'blacklist_veto', id: record.id, content_sha256: record.content_sha256 }]
      : [
          {
            type: 'append_audit',
            line: {
              at: ctx.now,
              kind: 'transition',
              id: record.id,
              dim: 'lifecycle',
              from: record.lifecycle,
              to: record.lifecycle,
              reason: terminationReason(event),
            },
          },
        ];
  return { outcome: 'noop', noop_reason: 'terminal_state', next: record, entries: [], effects };
}

export function transition(recordIn: unknown, eventIn: unknown, ctxIn: unknown): TransitionResult {
  const rp = PersonalLifecycleRecordSchema.safeParse(recordIn);
  if (!rp.success) return refuse('candidate_invalid', undefined, firstIssue(rp.error));
  const ep = TransitionEventSchema.safeParse(eventIn);
  if (!ep.success) return refuse('bad_input', undefined, `event ${firstIssue(ep.error)}`);
  const cp = TransitionCtxSchema.safeParse(ctxIn);
  if (!cp.success) return refuse('bad_input', undefined, `ctx ${firstIssue(cp.error)}`);
  const record = rp.data;
  const event = ep.data;
  const ctx = cp.data;
  const candidates = rowsOfKind(event.kind).filter((r) => r.applies(event));

  // 2. 幂等:同一 idem_key 重复 = 空操作(此时记录多半已是新状态,所以先于查行)
  const seen = new Set(record.transitions.map((t) => t.idem_key));
  for (const row of candidates) {
    for (const to of tosOf(row)) {
      const key = idemKey({
        id: record.id,
        dim: row.dim,
        agent: agentOf(event),
        from: row.from,
        to,
        evidence: row.evidence(event),
      });
      if (seen.has(key)) {
        return {
          outcome: 'noop',
          noop_reason: 'duplicate_idem_key',
          next: record,
          entries: [],
          effects: [],
        };
      }
    }
  }

  // 3. 本期没有行的状态
  if (isUnimplementedLifecycle(record.lifecycle)) {
    return refuse('phase_not_available', undefined, `lifecycle=${record.lifecycle}`);
  }
  // 4. 终态
  if (isTerminalLifecycle(record.lifecycle)) return onTerminal(record, event, ctx);

  // 5. 查行
  const row = candidates.find(
    (r) => r.lifecycle === record.lifecycle && dimState(record, r, event) === r.from,
  );
  if (row === undefined) {
    return refuse('illegal_transition', undefined, `${record.lifecycle} × ${event.kind}`);
  }

  // 6. 能力(默认拒绝)
  for (const key of row.caps(event, record)) {
    if (!capabilityAvailable(key, ctx.phase)) return refuse('phase_not_available', undefined, key);
  }

  // 7. 守卫
  const g = row.guard(record, event, ctx);
  if (g !== null) return refuse('guard_false', g);

  // 8. 应用
  return apply(record, event, ctx, row);
}

function apply(
  record: PersonalLifecycleRecord,
  event: TransitionEvent,
  ctx: TransitionCtx,
  row: TransitionRow,
): TransitionResult {
  const next = structuredClone(record);
  const entries: TransitionEntry[] = [];
  const evidence = row.evidence(event);
  const reason = row.reason(event, record);
  const add = (
    dim: TransitionEntry['dim'],
    from: string,
    to: string,
    why: string,
    agent?: 'claude' | 'pi' | 'codex',
  ): void => {
    entries.push({
      dim,
      ...(agent !== undefined ? { agent } : {}),
      from,
      to,
      at: ctx.now,
      reason: why,
      idem_key: idemKey({ id: record.id, dim, agent, from, to, evidence }),
    });
  };

  switch (row.shape) {
    case 'simple': {
      next.lifecycle = row.to as typeof next.lifecycle;
      add('lifecycle', row.from, row.to, reason);
      break;
    }
    case 'to_terminal': {
      const t = row.terminal(event);
      if (t === undefined) return refuse('candidate_invalid', undefined, 'terminal_reason');
      next.lifecycle = row.to as typeof next.lifecycle;
      next.terminal_reason = t;
      add('lifecycle', row.from, row.to, reason);
      break;
    }
    case 'enter_rollback': {
      // R21-4.4:离开注入一律经 rolling_back;R21-4.3:rolling_back 下 agent 只能是 none | removal_pending,所以同一次结果里改 deploy
      next.lifecycle = 'rolling_back';
      next.rollback = {
        phase: 'rollback_requested',
        reason,
        target_terminal: terminationTarget(event),
      };
      add('lifecycle', 'canary', 'rolling_back', reason);
      for (const agent of ['claude', 'pi'] as const) {
        if (next.deploy[agent] === 'injected') {
          next.deploy[agent] = 'removal_pending';
          add('deploy', 'injected', 'removal_pending', reason, agent);
        }
      }
      break;
    }
    case 'repeat_rollback': {
      // R21-4.4a ①:自环条目;不重置已完成的补偿阶段;target 只升不降;终态理由取优先级最高者
      const rb = next.rollback;
      if (rb === null) return refuse('candidate_invalid', undefined, 'rollback');
      const newTarget = terminationTarget(event);
      if (targetPriority(newTarget) < targetPriority(rb.target_terminal))
        rb.target_terminal = newTarget;
      if (terminalPriority(reason) < terminalPriority(rb.reason)) rb.reason = reason;
      add('lifecycle', 'rolling_back', 'rolling_back', reason);
      break;
    }
    case 'complete': {
      const rb = next.rollback;
      const t = rb === null ? undefined : terminalReasonOf(rb.reason);
      if (rb === null || t === undefined) return refuse('candidate_invalid', undefined, 'rollback');
      next.lifecycle = rb.target_terminal as typeof next.lifecycle;
      next.terminal_reason = t;
      add('lifecycle', 'rolling_back', rb.target_terminal, reason);
      break;
    }
    case 'deploy': {
      const agent = agentOf(event) as 'claude' | 'pi' | 'codex';
      next.deploy[agent] = row.to as typeof next.deploy.claude;
      add('deploy', row.from, row.to, reason, agent);
      break;
    }
    case 'rollback_phase': {
      if (next.rollback === null) return refuse('candidate_invalid', undefined, 'rollback');
      next.rollback.phase = row.to as typeof next.rollback.phase;
      add('rollback', row.from, row.to, reason);
      break;
    }
    case 'blocked_decide':
      return refuse('guard_false', 'adopted_not_implemented');
  }

  next.transitions.push(...entries);
  const excess = next.transitions.length - RSI_TRANSITIONS_MAX;
  if (excess > 0) {
    next.transitions.splice(0, excess);
    next.transitions_dropped += excess;
  }

  const out = PersonalLifecycleRecordSchema.safeParse(next);
  if (!out.success)
    return refuse('candidate_invalid', undefined, `output ${firstIssue(out.error)}`);
  const final = out.data;

  const effects: TransitionEffect[] = [{ type: 'commit_lifecycle', id: final.id }];
  for (const e of entries) {
    effects.push({ type: 'append_audit', line: auditOf(e, final.id), idem_key: e.idem_key });
  }
  if (event.kind === 'veto' || (event.kind === 'revocation_reconcile' && event.basis === 'veto')) {
    effects.push({ type: 'blacklist_veto', id: final.id, content_sha256: final.content_sha256 });
  }
  if (!isTerminalLifecycle(record.lifecycle) && isTerminalLifecycle(final.lifecycle)) {
    const tr = final.terminal_reason;
    effects.push({
      type: 'write_tombstone',
      id: final.id,
      terminal: final.lifecycle,
      reason: tr ?? 'unknown',
    });
    if (tr === 'auto_rollback') {
      effects.push({
        type: 'start_cooldown',
        cluster_id: final.cluster_id,
        kind: 'auto_rollback',
        days: RSI_COOLDOWN_DAYS.auto_rollback,
      });
    } else if (final.lifecycle === 'expired') {
      effects.push({
        type: 'start_cooldown',
        cluster_id: final.cluster_id,
        kind: 'expired',
        days: RSI_COOLDOWN_DAYS.expired,
      });
    }
  }
  return { outcome: 'transitioned', next: final, entries, effects };
}

// ---------------------------------------------------------------------------
// W0-13:达标 shadow 的推进(纯判定;产出事件交给 `transition()`,自己不改状态)
// ---------------------------------------------------------------------------
const ShadowStepInputSchema = z.strictObject({
  record: PersonalLifecycleRecordSchema,
  ctx: TransitionCtxSchema,
  facts: PromoteBaseSchema,
  /** 工作副本里的两个日期(`canary_ready_since` 只排序;`queued_since` 只数 G7 等待) */
  shadow: z.strictObject({
    canary_ready_since: IsoDateSchema.nullable(),
    queued_since: IsoDateSchema.nullable(),
  }),
  evidence: z.string().min(1).max(128),
});
export type ShadowStepInput = z.input<typeof ShadowStepInputSchema>;

export interface ShadowPatch {
  canary_ready_since: string | null;
  queued_since: string | null;
}
export type ShadowStep =
  | { action: 'invalid'; detail: string }
  | {
      action: 'expire' | 'promote' | 'wait';
      /** 要写回工作副本的两个日期 */
      patch: ShadowPatch;
      /** `wait` 时的原因(资格项守卫码或 `slot_occupied`) */
      blocker: string | null;
      /** `expire` / `promote` 时交给 `transition()` 的事件 */
      event?: TransitionEvent;
    };

/**
 * 判定顺序(W0-13,同一 `personal/lock` 临界区内):①先查排队到期(`queued_since` 非空且满 30 个 UTC 日 → `expire`,不再参与推进;
 * 第 30 日恰好名额释放也先到期);②再查资格,任一项不成立 → `queued_since` 清零(条件恢复后从当日重新起算,不累计);③最后看名额:
 * 被占 → 起算 / 保持 `queued_since`(**只有这里**置值),空闲 → `promote`。`canary_ready_since` 只在首次达标时记当日、只用于排序,**不参与到期**。
 */
export function decideShadowStep(input: ShadowStepInput): ShadowStep {
  const p = ShadowStepInputSchema.safeParse(input);
  if (!p.success) return { action: 'invalid', detail: firstIssue(p.error) };
  const { record, ctx, facts, shadow, evidence } = p.data;
  const today = utcDay(ctx.now);
  const ready =
    shadow.canary_ready_since === null &&
    facts.sessions >= RSI_SHADOW_MIN_SESSIONS &&
    facts.hits >= RSI_SHADOW_MIN_HITS
      ? today
      : shadow.canary_ready_since;
  const keep: ShadowPatch = { canary_ready_since: ready, queued_since: shadow.queued_since };
  if (record.lifecycle !== 'shadow') return { action: 'wait', patch: keep, blocker: 'not_shadow' };

  // ① 到期(只读 queued_since)
  if (queueExpired(shadow.queued_since, today)) {
    return {
      action: 'expire',
      patch: keep,
      blocker: null,
      event: { kind: 'shadow_queue_expired', evidence, queued_since: shadow.queued_since },
    };
  }
  // ② 资格
  const blocker = promoteEligibilityBlocker(record, facts, ctx);
  if (blocker !== null) {
    return { action: 'wait', patch: { canary_ready_since: ready, queued_since: null }, blocker };
  }
  // ③ 名额
  const slot = slotBlocker(facts);
  if (slot !== null) {
    return {
      action: 'wait',
      patch: { canary_ready_since: ready, queued_since: shadow.queued_since ?? today },
      blocker: slot,
    };
  }
  return {
    action: 'promote',
    patch: { canary_ready_since: ready, queued_since: null },
    blocker: null,
    event: { kind: 'shadow_promote', evidence, ...facts, queued_since: shadow.queued_since },
  };
}

/** 多个候选同时具备推进资格时按 `(canary_ready_since, 候选 id)` 升序取第一个(`null` 排最后;只影响排序,不影响到期或授权) */
export function pickPromotionHead<T extends { id: string; canary_ready_since: string | null }>(
  cands: readonly T[],
): T | null {
  const sorted = [...cands].sort((a, b) => {
    if (a.canary_ready_since !== b.canary_ready_since) {
      if (a.canary_ready_since === null) return 1;
      if (b.canary_ready_since === null) return -1;
      return a.canary_ready_since < b.canary_ready_since ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0] ?? null;
}
