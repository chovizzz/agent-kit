/**
 * 账 + 审计的编排:`KeyedEffectSink.applyOnce`、`LedgerRecoveryPort.recoverThrough`、`UserVetoPort`(设计稿 v3 §A、§D.2、§D.3;§21.24 W0-26 第 2、3 条)。
 *
 * `applyOnce(key, effects, meta?)` 在**一个事务内**固定顺序:读账 / 审计 / 水位线 → **验证 → 合并 → 容量(账)→ 审计预检** → 账 `rename` → 审计追加。
 * 预检与提交之间不会被别的操作插入,所以账提交后只剩 I/O 失败;结果只有 `{ledger, audit}` 两层(命令层另组合 `authority`):
 *  - 容量(`effects_full` / 审计 `audit_full`)**不抛**,按「撤销优先」返回 `ledger: not_committed` + `cause`(账已满足而审计满 = `ledger: satisfied, audit: pending`);
 *  - 冲突 / 不合规 / 元信息缺失 / 压缩不受支持 **抛** `StoreError`(零写入);
 *  - 账提交后审计追加失败 = `audit: pending`(「已提交待补」,不是错误)。
 * `audit:` 前缀的键只路由到审计追加器,不进账 `applied`(否则键额度被审计行占满)。恢复入口 `recoverThrough` 共用 `planBatches`(同一合并规则),无审计预检、不追加审计行。
 */
import { utcDay, type StoreCause } from '../../contracts/rsi-store.js';
import type { RsiAuditLine } from '../../contracts/rsi-personal.js';
import { IsoTimestampSchema } from '../../contracts/common.js';
import { RsiLockError } from '../lock-error.js';
import { loadAuditState, planKeyedAppend, commitAuditRows } from './audit-appender.js';
import { StoreError } from './errors.js';
import {
  partitionEffects,
  planBatch,
  planBatches,
  planLift,
  type AuditEffect,
  type PlanOptions,
  type PlanResult,
} from './ledger-merge.js';
import type {
  ApplyOnceResult,
  AuditLayer,
  HeldStore,
  KeyedEffectSink,
  LedgerLayer,
  LedgerRecoveryPort,
  ReconcileSource,
  RecoveryResult,
  UserVetoPort,
} from './ports.js';

export interface ApplyDeps {
  held: HeldStore;
  /** UTC 日取自它(冷却裁剪、压缩 I1);测试可注入 */
  clock: () => Date;
  resolve?: ReconcileSource['resolve'];
}

/** 审计效果 → 带键的审计行(`idem_key` 取自 effect;行里已有的键必须一致) */
function auditLineOf(e: AuditEffect): RsiAuditLine {
  const key = e.idem_key;
  if (key === undefined) throw new StoreError('audit_key_missing', 'append_audit');
  if (e.line.idem_key !== undefined && e.line.idem_key !== key) {
    throw new StoreError('audit_key_conflict', 'effect_line_key_mismatch');
  }
  return { ...e.line, idem_key: key };
}

const todayOf = (clock: () => Date): string => utcDay(clock().toISOString());

/** 键名:用户否决与终态批次 E1 同形(`veto:<id>:<sha>`),与 `personal/terminal-effects.ts` 的 `vetoEffectKey` 字面一致 */
export const userVetoKey = (id: string, sha: string): string => `veto:${id}:${sha}`;

export function createKeyedEffectSink(deps: ApplyDeps): KeyedEffectSink {
  return {
    async applyOnce(key, effects, meta) {
      const { ledger: lef, audit: aef } = partitionEffects(effects);
      if (key.startsWith('audit:') && lef.length > 0) {
        throw new StoreError('unsupported_effect', 'audit_key_with_ledger_effects');
      }
      const lines = aef.map(auditLineOf);
      if (lef.length === 0 && lines.length === 0) {
        return { ledger: 'not_applicable', audit: 'not_applicable' };
      }
      return deps.held.transaction(async (p): Promise<ApplyOnceResult> => {
        const wm = (await p.auditAppend.readWatermark()).through;
        const opts: PlanOptions = { today: todayOf(deps.clock), watermark: wm };

        // ① 验证 → 合并 → 容量(账)
        let plan: PlanResult | null = null;
        if (lef.length > 0) {
          plan = planBatch(await p.ledgerWrite.read(), key, lef, meta, 'replay', opts);
          if (plan.kind === 'not_committed') {
            return { ledger: 'not_committed', audit: 'not_applicable', cause: plan.cause };
          }
        }
        const ledgerWillCommit = plan?.kind === 'commit';

        // ② 审计预检(只读;账提交之前)
        let auditPlan: Awaited<ReturnType<typeof planKeyedAppend>> | null = null;
        let auditState: Awaited<ReturnType<typeof loadAuditState>> | null = null;
        if (lines.length > 0) {
          auditState = await loadAuditState(p.auditAppend);
          try {
            auditPlan = await planKeyedAppend(
              auditState,
              lines,
              { kind: 'replay', source: { kind: 'effects', ref: key } },
              deps.resolve,
            );
          } catch (e) {
            if (!(e instanceof StoreError) || e.code !== 'audit_full') throw e;
            // 审计满:账还没提交 → 不提交(账提交后只剩 I/O 失败这一不变量);账已满足 → 审计待补
            return ledgerWillCommit
              ? { ledger: 'not_committed', audit: 'not_applicable', cause: 'audit_full' }
              : {
                  ledger: plan === null ? 'not_applicable' : 'satisfied',
                  audit: 'pending',
                  cause: 'audit_full',
                };
          }
        }

        // ③ 账 rename(提交点);失败抛错 = 零变更
        let ledgerLayer: LedgerLayer = 'not_applicable';
        if (plan !== null && plan.kind === 'commit') {
          await p.ledgerWrite.commit(plan.next);
          ledgerLayer = 'committed';
        } else if (plan !== null) {
          ledgerLayer = 'satisfied';
        }

        // ④ 审计追加;账已提交 / 已满足时失败 = 待补
        if (auditPlan === null || auditState === null)
          return { ledger: ledgerLayer, audit: 'not_applicable' };
        try {
          await commitAuditRows(p.auditAppend, auditState, auditPlan.toAppend);
        } catch (e) {
          if (e instanceof RsiLockError) throw e;
          if (ledgerLayer === 'not_applicable') throw e;
          const cause: StoreCause = e instanceof StoreError ? e.code : 'store_io';
          return { ledger: ledgerLayer, audit: 'pending', cause };
        }
        const audit: AuditLayer = auditPlan.results.every((r) => r === 'compacted')
          ? 'compacted'
          : 'appended';
        return { ledger: ledgerLayer, audit };
      });
    },
  };
}

export function createLedgerRecovery(deps: ApplyDeps): LedgerRecoveryPort {
  return {
    async recoverThrough(W, batches) {
      // 先整体校验事件日(零写入):端口不能被当成通用的「跳过审计预检」后门
      for (const b of batches) {
        if (!IsoTimestampSchema.safeParse(b.meta.event_at).success) {
          throw new StoreError('effects_meta_missing', 'event_at');
        }
        if (utcDay(b.meta.event_at) > W) throw new StoreError('out_of_range', b.key);
      }
      return deps.held.transaction(async (p): Promise<readonly RecoveryResult[]> => {
        const wm = (await p.auditAppend.readWatermark()).through;
        const base = await p.ledgerWrite.read();
        const results: RecoveryResult[] = new Array<RecoveryResult>(batches.length);
        const valid: {
          idx: number;
          key: string;
          effects: ReturnType<typeof partitionEffects>['ledger'];
          meta: (typeof batches)[number]['meta'];
        }[] = [];
        batches.forEach((b, idx) => {
          try {
            valid.push({
              idx,
              key: b.key,
              effects: partitionEffects(b.effects).ledger,
              meta: b.meta,
            });
          } catch (e) {
            if (!(e instanceof StoreError)) throw e;
            results[idx] = { batch_id: b.key, state: 'ledger_not_committed', cause: e.code };
          }
        });
        const { outcomes, plan, planError } = planBatches(base, valid, {
          today: todayOf(deps.clock),
          watermark: wm,
        });
        let failCause: StoreCause | null = null;
        let committed = false;
        if (planError !== null) failCause = planError.code;
        else if (plan !== null && plan.kind === 'not_committed') failCause = plan.cause;
        else if (plan !== null && plan.kind === 'commit') {
          try {
            await p.ledgerWrite.commit(plan.next);
            committed = true;
          } catch (e) {
            if (e instanceof RsiLockError) throw e;
            failCause = e instanceof StoreError ? e.code : 'store_io';
          }
        }
        valid.forEach((v, i) => {
          const o = outcomes[i] as (typeof outcomes)[number];
          results[v.idx] =
            o.state === 'satisfied'
              ? { batch_id: v.key, state: 'satisfied' }
              : o.state === 'failed'
                ? { batch_id: v.key, state: 'ledger_not_committed', cause: o.cause }
                : committed
                  ? { batch_id: v.key, state: 'ledger_committed' }
                  : {
                      batch_id: v.key,
                      state: 'ledger_not_committed',
                      cause: failCause ?? 'store_io',
                    };
        });
        return results;
      });
    },
  };
}

export function createUserVetoPort(deps: ApplyDeps): UserVetoPort {
  return {
    async veto(id, contentSha256, meta) {
      const { ledger: lef } = partitionEffects([
        { type: 'blacklist_veto', id, content_sha256: contentSha256 },
      ]);
      return deps.held.transaction(async (p): Promise<ApplyOnceResult> => {
        const wm = (await p.auditAppend.readWatermark()).through;
        const plan = planBatch(
          await p.ledgerWrite.read(),
          userVetoKey(id, contentSha256),
          lef,
          meta,
          'user_veto',
          {
            today: todayOf(deps.clock),
            watermark: wm,
          },
        );
        if (plan.kind === 'not_committed') {
          return { ledger: 'not_committed', audit: 'not_applicable', cause: plan.cause };
        }
        if (plan.kind === 'satisfied') return { ledger: 'satisfied', audit: 'not_applicable' };
        await p.ledgerWrite.commit(plan.next);
        return { ledger: 'committed', audit: 'not_applicable' };
      });
    },
    async lift(id, contentSha256, at) {
      return deps.held.transaction(async (p): Promise<'lifted' | 'absent'> => {
        const wm = (await p.auditAppend.readWatermark()).through;
        const plan = planLift(await p.ledgerWrite.read(), id, contentSha256, at, {
          today: todayOf(deps.clock),
          watermark: wm,
        });
        if (plan.kind === 'absent' || plan.kind === 'satisfied') return 'absent';
        if (plan.kind === 'not_committed') throw new StoreError(plan.cause);
        await p.ledgerWrite.commit(plan.next);
        return 'lifted';
      });
    },
  };
}
