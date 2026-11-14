/**
 * `rsi veto <id>` / `rsi veto --lift <id>`(contracts R21-12.6、R21-11.3、§21.24 W0-22 第 3、4、9、10 条):TTY + **三把锁**(契约表;设计稿 §8 的两把以契约为准)。
 * 顺序:参数(`unknown_arg` / 非法 id = `unknown_id`,退 2)→ TTY(2)→ 预检(3,零写入)→ `[rsi]` 关闭(4)→ **无锁读**判 `unknown_id`(仅在仓库可读而确认没有该 id 时才是 `unknown_id`;
 * 仓库 deferred / invalid / absent 读不出 ≠ 不存在,退 3 `personal_repo_invalid`)→ 取锁 → **持锁后重读记录再判**(锁外读只用来判 `unknown_id`,从不据以动作)。
 * 持锁后按记录当前生命周期分流:
 *   - 终态:只写黑名单(引擎 `veto` 事件的空操作只产出 E1 `blacklist_veto`,键 {@link vetoEffectKey});
 *   - `proposed` / `shadow`:引擎 `veto` 事件直接 → `rejected`(`vetoed`),终态批次 E2 经 {@link landTerminalEffects} 整批落地(与回滚执行器收尾同一函数);
 *   - 已部署 / `rolling_back` / `retiring`:`startRollback(kind=rollback, reason=vetoed, by=veto, target=rolled_back, event=veto)`;`lateEventNotApplied` 按 W7 约定**重试一次**,仍未落 → 退 1 并写明;
 *   - `blocked` 等引擎不接受 veto 的状态:引擎拒绝 → 退 3 `candidate_invalid`(不绕过引擎)。
 * `--lift`:只解除指纹黑名单(`VetoLift` 端口),候选记录不动、仍是终态。
 * 持锁后候选消失(锁外读到过):退 3 `candidate_invalid`(不判 `unknown_id`:它在锁外已经存在过,消失说明并发写入 / 记录异常)。
 */
import { RsiLockError } from '../../lock-error.js';
import { RsiCandidateIdSchema } from '../../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../../contracts/rsi-personal.js';
import { RSI_VETO_EVIDENCE } from './evidence.js';
import { applyEvent, type ApplyDeps, type ApplyResult } from '../../personal/candidate-apply.js';
import {
  keyedAuditSink,
  landAuditEffects,
  landTerminalEffects,
  vetoEffectKey,
} from '../../personal/effects-recover.js';
import {
  startRollback,
  type RollbackOutcome,
  type RollbackRequest,
} from '../../personal/rollback.js';
import type { KeyedEffectResult } from '../../personal/rollback-ports.js';
import { isTerminalLifecycle, type TransitionEvent } from '../../personal/transition-table.js';
import type { RsiEarlyContext } from '../../types.js';
import { failClosed, isTty, notRun, precheck, say, usage } from './common.js';
import { emitOutcomes, outcomeCounts } from './outcome-output.js';
import {
  REQUIRED_PORTS,
  type WritePortName,
  type WritePorts,
  type WritePortsGetter,
} from './ports.js';

type Args = { ok: true; id: string; lift: boolean } | { ok: false; reason: string };

export function parseVetoArgs(rest: readonly string[]): Args {
  let lift = false;
  let id: string | undefined;
  for (const a of rest) {
    if (a === '--lift' && !lift) lift = true;
    else if (!a.startsWith('--') && id === undefined) id = a;
    else return { ok: false, reason: 'unknown_arg' };
  }
  if (id === undefined) return { ok: false, reason: 'unknown_arg' };
  // 形状不对的 id 不可能存在:同样是 unknown_id(不回显)
  if (!RsiCandidateIdSchema.safeParse(id).success) return { ok: false, reason: 'unknown_id' };
  return { ok: true, id, lift };
}

const DIRECT = new Set(['proposed', 'shadow']);

const haltExit = (ctx: RsiEarlyContext, r: Extract<ApplyResult, { kind: 'halt' }>): number => {
  switch (r.halt) {
    case 'repo_absent':
    case 'repo_deferred':
    case 'repo_invalid':
      return failClosed(ctx, 'personal_repo_invalid');
    case 'revocations_invalid':
      return failClosed(ctx, 'revocations_invalid');
    case 'candidate_invalid':
      return failClosed(ctx, 'candidate_invalid');
    case 'commit_failed':
    case 'lock_lost':
      return failClosed(ctx, 'internal');
  }
};

export async function runVeto(
  ctx: RsiEarlyContext,
  rest: readonly string[],
  getPorts: WritePortsGetter,
): Promise<number> {
  const a = parseVetoArgs(rest);
  if (!a.ok) return usage(ctx, a.reason);
  if (!isTty(ctx)) return usage(ctx, 'not_tty');
  const p = await getPorts();
  const need: WritePortName[] = [
    ...REQUIRED_PORTS.veto,
    ...(a.lift ? (['vetoLift'] as const) : []),
  ];
  const bad = precheck(ctx, p, need);
  if (bad !== null) return bad;
  if (!(await (p.config as NonNullable<WritePorts['config']>)()).rsiOn) return notRun(ctx, 'off');

  // 无锁读:只判 unknown_id(读不出 ≠ 不存在)
  const peek = await (p.peekRecord as NonNullable<WritePorts['peekRecord']>)(a.id);
  if (peek.kind === 'missing') return usage(ctx, 'unknown_id');
  if (peek.kind !== 'ok') return failClosed(ctx, 'personal_repo_invalid');

  const locks = p.locks as NonNullable<WritePorts['locks']>;
  const rollbackDeps = p.rollbackDeps as NonNullable<WritePorts['rollbackDeps']>;
  return locks.withLocks('rsi_personal_sync', async (held) => {
    const d = rollbackDeps(held);
    // 持锁后重读再判:锁外那次读不作数
    const cur = await d.store.read(a.id);
    if (cur.kind === 'missing') return failClosed(ctx, 'candidate_invalid');
    if (cur.kind !== 'ok') return failClosed(ctx, 'personal_repo_invalid');
    const rec = cur.record;

    if (a.lift) {
      const lifted = await (p.vetoLift as NonNullable<WritePorts['vetoLift']>).lift(
        rec.id,
        rec.content_sha256,
      );
      return say(ctx, p, [`veto_lift=${lifted} id=${rec.id} lifecycle=${rec.lifecycle}`]);
    }

    const event: TransitionEvent = { kind: 'veto', evidence: RSI_VETO_EVIDENCE };
    if (isTerminalLifecycle(rec.lifecycle) || DIRECT.has(rec.lifecycle)) {
      return directVeto(ctx, p, d, rec, event);
    }
    const req: RollbackRequest = {
      candidate_id: rec.id,
      content_sha256: rec.content_sha256,
      kind: 'rollback',
      reason: 'vetoed',
      by: 'veto',
      target_terminal: 'rolled_back',
      event,
    };
    let out: RollbackOutcome = await startRollback(d, req);
    // 复用在途 txn 时较晚的 veto 事件没有(或尚未)持久化:按 W7 约定重试一次
    if (out.status !== 'refused' && out.lateEventNotApplied !== undefined) {
      if (out.status === 'complete') {
        // 事务已走完(journal 已删):记录已按原理由进终态,重走 startRollback 只会新开一个空事务并静默丢掉 veto → 改走终态 veto(只落黑名单 E1)
        const again = await d.store.read(a.id);
        if (again.kind !== 'ok') return failClosed(ctx, 'personal_repo_invalid');
        return directVeto(ctx, p, d, again.record, event);
      }
      out = await startRollback(d, req);
    }
    const late = out.status !== 'refused' ? out.lateEventNotApplied : undefined;
    return emitOutcomes(
      ctx,
      p,
      { outcomes: [out] },
      [
        `veto: id=${rec.id} lifecycle=${rec.lifecycle}`,
        outcomeCounts([out]),
        ...(late !== undefined ? [`late_event_not_applied=${late}`] : []),
      ],
      { forceNonZero: late !== undefined },
    );
  });
}

/** E1 deferred 的终态 veto:否决没有落地,输出明确信息行(摘要过泄漏闸),退 1;stdout 不含成功行 */
async function failedVeto(ctx: RsiEarlyContext, p: WritePorts, id: string): Promise<number> {
  const shown = await say(ctx, p, [`veto: id=${id} 否决未落地(黑名单落地推迟),请重跑 rsi veto`]);
  return shown !== 0 ? shown : 1;
}

/** 终态 / 无部署候选:经引擎 `veto` 事件(终态上是空操作,只落 E1);转移提交后落终态批次 E2 与审计 */
async function directVeto(
  ctx: RsiEarlyContext,
  p: WritePorts,
  d: ReturnType<NonNullable<WritePorts['rollbackDeps']>>,
  rec: PersonalLifecycleRecord,
  event: TransitionEvent,
): Promise<number> {
  const landed: KeyedEffectResult[] = [];
  const ad: ApplyDeps = {
    store: d.store,
    working: d.working,
    revocations: d.revocations,
    audit: keyedAuditSink(d.keyedEffects),
    // E1:`veto` 事件的即时黑名单按 `vetoEffectKey` 落(终态上的空操作只产出它)
    effects: {
      apply: async (effects) => {
        for (const e of effects) {
          if (e.type === 'blacklist_veto') {
            landed.push(await d.keyedEffects.applyOnce(vetoEffectKey(e), [e]));
          }
        }
      },
    },
    env: d.env,
    now: d.now,
  };
  const r = await applyEvent(ad, rec, event);
  if (r.kind === 'halt') return haltExit(ctx, r);
  if (r.kind === 'refused' || r.kind === 'stale') return failClosed(ctx, 'candidate_invalid');
  if (r.kind === 'transitioned') {
    // 转移已提交但丢锁:立即结束本步,不再调用任何写出口(E2 / 审计),交给已提交终态记录的恢复机制续做(candidate-apply 的 `lockLost` 约定)
    if (r.lockLost === true) throw new RsiLockError('lock_lost');
    // E2:终态批次整批落地(与回滚执行器收尾同一函数)
    const batch = await landTerminalEffects(d.keyedEffects, r.next);
    const audit = await landAuditEffects(d.keyedEffects, r.next);
    if (batch !== 'none') landed.push(batch);
    if (audit !== 'none') landed.push(audit);
    if (r.effectsFailed !== undefined) {
      await say(ctx, p, [`veto: id=${rec.id} 已提交,效果落地失败(重跑 rsi veto 补做)`]);
      return failClosed(ctx, 'internal');
    }
  }
  // 终态记录上的空操作 veto:没有提交任何新事实,E1 黑名单一旦 deferred,恢复扫描(只扫 `rolling_back ∧ reason=vetoed`)推不出这次否决 →
  // 不得退 0 宣告成功;退 1(可重跑的未完成)。重跑时黑名单按 `(id, sha)` 集合插入,幂等
  if (r.kind === 'noop' && landed.includes('deferred') && rec.terminal_reason !== 'vetoed') {
    return failedVeto(ctx, p, rec.id);
  }
  const effects = landed.includes('deferred')
    ? 'deferred'
    : landed.includes('applied')
      ? 'applied'
      : 'already';
  return say(ctx, p, [
    `veto: id=${rec.id} from=${rec.lifecycle} result=${r.kind === 'noop' ? 'blacklist_only' : 'rejected'} effects=${effects}`,
  ]);
}
