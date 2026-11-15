/**
 * 旧 `KeyedEffectSink`(`rollback-ports.ts`,返回 `'applied' | 'already' | 'deferred'`)→ 新存储核端口(`store/ports.ts`,返回 `{ledger, audit, cause}`)的适配层(设计稿 v3 §D.2 / §D.3;§21.24 W0-26)。
 * 只在**命令装配**里使用(`assemble-write.ts`);W7 / W8 的执行器与恢复函数仍只认旧枚举,一字未改。
 *
 * **映射规则**(头注即契约;`test/rsi/asm/b-effects-adapter.test.ts` 逐格钉住):
 *   | 新结果                                             | 旧枚举     | 说明                                                                                             |
 *   | ledger = committed                                 | `applied`  | 审计层另记在收集器(`audit = pending` 时命令层报「已提交待补审计」)                                 |
 *   | ledger = satisfied                                 | `already`  | 含 H3「状态已满足但键未登记」(登记并提交仍报 satisfied)                                           |
 *   | ledger = not_committed(`effects_full` / `audit_full`)| `deferred` | 撤销优先:权威状态已先落,账待对账;**cause 在收集器**,命令层区分于缩减入口的 deferred(退 3 + 具体码)   |
 *   | ledger = not_applicable ∧ audit = appended         | `applied`  | `appended` 分不出「新追加」与「原本就在」:保守报 `applied`(只影响命令摘要里的 `effects=` 文字,不影响幂等) |
 *   | ledger = not_applicable ∧ audit = compacted        | `already`  | 事件已被水位线覆盖(已计入汇总)                                                                    |
 *   | ledger = not_applicable ∧ audit = pending          | `deferred` | 审计未落:执行器收尾 / `recoverTerminalEffects` 会按同键重放                                          |
 *   | 冲突 / 不合规 / 元信息缺失(`StoreError`)           | **抛**     | 零写入;命令层按 `e.reason` 映射(退 3),不吞成 `deferred`                                           |
 * 完整的 `{ledger, audit, cause}` 一律记进 {@link LayerRecorder}。
 *
 * **元信息(新端口的账类效果必带)**:旧签名不带,这里**持锁读权威记录**现算,绝不取 `now`:`event_at` = 记录里该事件的条目时间(`veto:` 键 = 进入回滚 / 终态的那条 lifecycle 条目,
 * 与 `effects-recover.ts` 的 `auditItemsOf` 同一选择;`terminal:` 键 = 终态那条条目,与终态保护标记同一选择),`fp_hmac` = 记录的 `fp_hmac`,`near_fp = []`。
 * 即时路径与恢复路径读同一份记录、取同一个点,所以同值。读不到记录 / 内容哈希对不上 → 抛 `effects_meta_missing`(fail-closed,**不**映射成 `deferred`)。
 *
 * **user_veto 意图**:装配给了 `userVeto` 时,`veto:<id>:<sha>` 键上单独一项 `blacklist_veto`(命令里被用户否决的那个 `(id, sha)`)走 `userVeto.veto`——
 * 否则「lift 之后再 veto」会被当成 replay 而静默不生效(replay 永不清 lifted)。其余键(`terminal:` 批次含的 `blacklist_veto`、`audit:`)一律 replay。
 * 恢复 / worker 路径的适配器不给 `userVeto`。
 */
import { RSI_STORE_CAUSES, type StoreCause } from '../../contracts/rsi-store.js';
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';
import { StoreError } from '../store/errors.js';
import type {
  ApplyOnceMeta,
  ApplyOnceResult,
  KeyedEffectSink as StoreEffectSink,
  UserVetoPort,
} from '../store/ports.js';
import type { AuthoritativeStore } from './candidate-ports.js';
import type { LayerRecord, LayerRecorder } from './effects-layers.js';
import type { KeyedEffectResult, KeyedEffectSink } from './rollback-ports.js';

const LEDGER_TYPES: ReadonlySet<string> = new Set([
  'blacklist_veto',
  'write_tombstone',
  'start_cooldown',
]);
const KEY_RE = /^(terminal|veto):(ra_[0-9a-f]{12}):([0-9a-f]{64})$/;

const ENTERS_ROLLBACK_OR_TERMINAL = (to: string): boolean =>
  to === 'rolling_back' ||
  to === 'rejected' ||
  to === 'expired' ||
  to === 'rolled_back' ||
  to === 'retired';

const missing = (detail: string): StoreError => new StoreError('effects_meta_missing', detail);

/** `veto:` 键的事件时间:第一条进入回滚 / 终态的 lifecycle 条目(与 `auditItemsOf` 的起点同一选择);没有就取最后一条 */
export function vetoEventAt(rec: PersonalLifecycleRecord): string {
  const hit = rec.transitions.find(
    (e) => e.dim === 'lifecycle' && ENTERS_ROLLBACK_OR_TERMINAL(e.to),
  );
  const at = (hit ?? rec.transitions[rec.transitions.length - 1])?.at;
  if (at === undefined) throw missing('no_entries');
  return at;
}

/** `terminal:` 键的事件时间:终态那条 lifecycle 条目(与终态保护标记行同一选择);没有就取最后一条 */
export function terminalEventAt(rec: PersonalLifecycleRecord): string {
  const hit = [...rec.transitions]
    .reverse()
    .find((e) => e.dim === 'lifecycle' && e.to === rec.lifecycle);
  const at = (hit ?? rec.transitions[rec.transitions.length - 1])?.at;
  if (at === undefined) throw missing('no_entries');
  return at;
}

/** 新结果 → 旧枚举(规则见头注) */
export function toLegacyResult(r: ApplyOnceResult): KeyedEffectResult {
  if (r.ledger === 'committed') return 'applied';
  if (r.ledger === 'satisfied') return 'already';
  if (r.ledger === 'not_committed') return 'deferred';
  if (r.audit === 'appended') return 'applied';
  if (r.audit === 'compacted') return 'already';
  if (r.audit === 'pending') return 'deferred';
  return 'already';
}

const reasonOf = (cause: StoreCause | undefined): string | undefined =>
  cause === undefined ? undefined : RSI_STORE_CAUSES[cause];

export interface LegacyAdapterDeps {
  /** `ReplayPort`(`applyOnce` 的调用方只有 replay 意图) */
  sink: StoreEffectSink;
  /** 只给命令装配(TTY 已校验的路径);缺省 = 恢复 / worker 路径,`veto:` 键也走 replay */
  userVeto?: UserVetoPort;
  /** 持锁读权威记录(取元信息);读不出 → 抛 `effects_meta_missing` */
  store: Pick<AuthoritativeStore, 'read'>;
  recorder: LayerRecorder;
}

export function legacyKeyedEffects(d: LegacyAdapterDeps): KeyedEffectSink {
  const metaFor = async (
    which: 'terminal' | 'veto',
    id: string,
    sha: string,
  ): Promise<ApplyOnceMeta & { fp_hmac: string }> => {
    const r = await d.store.read(id);
    if (r.kind !== 'ok') throw missing(`record_${r.kind}`);
    if (r.record.content_sha256 !== sha) throw missing('record_sha_mismatch');
    return {
      event_at: which === 'veto' ? vetoEventAt(r.record) : terminalEventAt(r.record),
      fp_hmac: r.record.fp_hmac,
      near_fp: [],
    };
  };

  return {
    async applyOnce(key, effects): Promise<KeyedEffectResult> {
      let res: ApplyOnceResult;
      let kind: LayerRecord['kind'] = key.startsWith('audit:') ? 'audit' : 'other';
      let id: string | null = /^audit:(ra_[0-9a-f]{12}):/.exec(key)?.[1] ?? null;
      if (!effects.some((e) => LEDGER_TYPES.has(e.type))) {
        res = await d.sink.applyOnce(key, effects);
      } else {
        const m = KEY_RE.exec(key);
        if (m === null) throw missing('key_shape');
        const which = m[1] as 'terminal' | 'veto';
        id = m[2] as string;
        const sha = m[3] as string;
        kind = which;
        const meta = await metaFor(which, id, sha);
        const only = effects.length === 1 ? effects[0] : undefined;
        if (
          which === 'veto' &&
          d.userVeto !== undefined &&
          only !== undefined &&
          only.type === 'blacklist_veto' &&
          only.id === id &&
          only.content_sha256 === sha
        ) {
          res = await d.userVeto.veto(id, sha, meta);
        } else {
          res = await d.sink.applyOnce(key, effects, meta);
        }
      }
      const reason = reasonOf(res.cause);
      d.recorder.record({
        kind,
        id,
        ledger: res.ledger,
        audit: res.audit,
        ...(res.cause !== undefined ? { cause: res.cause } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      return toLegacyResult(res);
    },
  };
}
