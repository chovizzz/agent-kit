/**
 * effects 账的合并 / 容量 / 保留子集(设计稿 v3 §A.2、§D.3、§D.7;§21.24 W0-26 第 2–5 条)。**纯函数,无 I/O。**
 * 本文件含**意图**(`replay` / `user_veto`)与「合并内部函数」:**不得**被 `src/rsi/store/**` 与存储核测试之外的文件 import(`test/rsi/store/arch.test.ts` 钉住),
 * 这样恢复 / 重放侧(`ReplayPort`、`recoverThrough`、`applyOnce`)的调用方无法表达 `user_veto` 意图。公开的纯入口是 `ledger-plan.ts` 的 `planLedgerBatch`(只有 `replay`)。
 *
 * 一个批次的处理顺序固定:**effects 逐项过 schema(跨信任边界)→ 元信息 → 同键校验 → 墓碑冲突 → 合并 → (整次提交前)裁过期冷却 → 容量 → `applied` 保留子集 → 再过账 schema**。
 * 校验全部先于合并(`applyBatch` 抛错时 Working 未被改动),所以一次恢复里多批的失败互不污染。
 * 语义要点:
 *  - 黑名单键 `(id, sha)`;`replay`:不存在则插入、存在(含 lifted)恒为空操作(重放不复活已解除的否决);`user_veto`:不走 `already` 短路,lifted → 清 lifted 并令 `vetoed_gen = gen`。
 *  - 墓碑 `id` 唯一,同 id 异 `(terminal, reason)` = `effects_key_conflict`;重放取账内已有项(最早 `at`)。
 *  - 冷却 `(cluster_id, kind)` 取 `max(at)`、`max(days)`;按 `cooldownActive` 已过期的新项不插入(冷启动重放不重启冷却)。
 *  - `applied` 只作冲突检测:满则丢键不拒写;非键状态超限才 `effects_full`。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Sha256Schema, IsoTimestampSchema } from '../../contracts/common.js';
import { RSI_TERMINAL_REASONS, RsiCandidateIdSchema } from '../../contracts/rsi.js';
import {
  RSI_COOLDOWN_KINDS,
  RSI_EFFECTS_LIMITS,
  RsiEffectsLedgerSchema,
  cooldownActive,
  utcDay,
  type RsiAppliedKey,
  type RsiEffectsLedger,
  type StoreCause,
  type UtcDay,
} from '../../contracts/rsi-store.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { TransitionEffect } from '../personal/transition.js';
import { EffectsKeyConflict, StoreError } from './errors.js';
import type { ApplyOnceMeta } from './ports.js';

export type LedgerIntent = 'replay' | 'user_veto';

export interface PlanOptions {
  /** 当前 UTC 日:给了才裁过期冷却、才拒绝插入已过期的新冷却 */
  today?: UtcDay;
  /** 已提交的水位线 W:事件日 ≤ W 的 `applied` 键不记(可裁) */
  watermark?: UtcDay | null;
}

export type PlanResult =
  | { kind: 'satisfied' }
  | { kind: 'commit'; next: RsiEffectsLedger; droppedKeys: number }
  | { kind: 'not_committed'; cause: 'effects_full' };

// ---------- effects 的运行时校验(跨信任边界) ----------
const LedgerEffectSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('blacklist_veto'),
    id: RsiCandidateIdSchema,
    content_sha256: Sha256Schema,
  }),
  z.strictObject({
    type: z.literal('write_tombstone'),
    id: RsiCandidateIdSchema,
    terminal: z.enum(['rejected', 'expired', 'rolled_back', 'retired']),
    reason: z.enum(RSI_TERMINAL_REASONS),
  }),
  z.strictObject({
    type: z.literal('start_cooldown'),
    cluster_id: z.string().min(1).max(128),
    kind: z.enum(RSI_COOLDOWN_KINDS),
    days: z.number().int().min(1).max(3650),
  }),
]);
export type LedgerEffect = z.infer<typeof LedgerEffectSchema>;

export type AuditEffect = Extract<TransitionEffect, { type: 'append_audit' | 'protection_mark' }>;

/** 把一批效果分成账类与审计类;`commit_lifecycle` 与未知类型 = `unsupported_effect`(不静默忽略) */
export function partitionEffects(effects: readonly TransitionEffect[]): {
  ledger: LedgerEffect[];
  audit: AuditEffect[];
} {
  const ledger: LedgerEffect[] = [];
  const audit: AuditEffect[] = [];
  for (const e of effects) {
    const t = (e as { type?: unknown }).type;
    if (t === 'append_audit' || t === 'protection_mark') {
      audit.push(e as AuditEffect);
    } else if (t === 'blacklist_veto' || t === 'write_tombstone' || t === 'start_cooldown') {
      const p = LedgerEffectSchema.safeParse(e);
      if (!p.success) throw new StoreError('unsupported_effect', `shape:${t}`);
      ledger.push(p.data);
    } else {
      throw new StoreError('unsupported_effect', `type:${String(t)}`);
    }
  }
  return { ledger, audit };
}

// ---------- 元信息 ----------
export interface CheckedMeta {
  event_at: string;
  fp_hmac: string | null;
  near_fp: string[];
}

export function checkMeta(
  effects: readonly LedgerEffect[],
  meta: ApplyOnceMeta | undefined,
): CheckedMeta {
  if (meta === undefined) throw new StoreError('effects_meta_missing', 'meta');
  if (!IsoTimestampSchema.safeParse(meta.event_at).success) {
    throw new StoreError('effects_meta_missing', 'event_at');
  }
  const needsFp = effects.some((e) => e.type === 'blacklist_veto');
  if (needsFp && (meta.fp_hmac === undefined || !/^[0-9a-f]{16}$/.test(meta.fp_hmac))) {
    throw new StoreError('effects_meta_missing', 'fp_hmac');
  }
  const near = meta.near_fp ?? [];
  if (near.length > 64 || near.some((n) => !/^[0-9a-f]{8}$/.test(n))) {
    throw new StoreError('effects_meta_missing', 'near_fp');
  }
  return { event_at: meta.event_at, fp_hmac: meta.fp_hmac ?? null, near_fp: [...near] };
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** 批内容指纹(不含 `event_at`:重试时间不同不算内容不同) */
export const batchSha256 = (effects: readonly LedgerEffect[], m: CheckedMeta): string =>
  sha256Hex(canonicalJson({ effects, fp_hmac: m.fp_hmac, near_fp: m.near_fp }));

// ---------- Working ----------
export interface Working {
  readonly base: RsiEffectsLedger;
  /** 工作副本:`gen` 已预留为 `base.gen + 1`;`applied` 只含旧键 */
  next: RsiEffectsLedger;
  /** 本次新增的键(保留子集里排在旧键之前) */
  newKeys: RsiAppliedKey[];
}

export function beginWorking(base: RsiEffectsLedger): Working {
  const next = structuredClone(base) as RsiEffectsLedger;
  next.gen = base.gen + 1;
  return { base, next, newKeys: [] };
}

const findKey = (w: Working, key: string): RsiAppliedKey | undefined =>
  w.newKeys.find((a) => a.key === key) ?? w.next.applied.find((a) => a.key === key);

/** 只校验、不改 Working:墓碑冲突(对账内已有项与批内) */
function validateTombstones(w: Working, effects: readonly LedgerEffect[]): void {
  const seen = new Map<string, string>();
  for (const e of effects) {
    if (e.type !== 'write_tombstone') continue;
    const sig = `${e.terminal}/${e.reason}`;
    const prior = seen.get(e.id);
    if (prior !== undefined && prior !== sig)
      throw new EffectsKeyConflict(`batch_tombstone:${e.id}`);
    seen.set(e.id, sig);
    const have = w.next.tombstones.find((t) => t.id === e.id);
    if (have !== undefined && `${have.terminal}/${have.reason}` !== sig) {
      throw new EffectsKeyConflict(`tombstone:${e.id}`);
    }
  }
}

function mergeEffect(
  w: Working,
  e: LedgerEffect,
  m: CheckedMeta,
  intent: LedgerIntent,
  today: UtcDay | undefined,
): boolean {
  const gen = w.next.gen;
  switch (e.type) {
    case 'blacklist_veto': {
      const item = w.next.blacklist.find(
        (b) => b.candidate_id === e.id && b.content_sha256 === e.content_sha256,
      );
      if (item === undefined) {
        w.next.blacklist.push({
          candidate_id: e.id,
          content_sha256: e.content_sha256,
          fp_hmac: m.fp_hmac as string,
          near_fp: [...m.near_fp],
          at: m.event_at,
          vetoed_gen: gen,
        });
        return true;
      }
      if (intent === 'user_veto' && item.lifted_gen !== undefined) {
        delete item.lifted_at;
        delete item.lifted_gen;
        item.vetoed_gen = gen;
        item.at = m.event_at;
        return true;
      }
      return false;
    }
    case 'write_tombstone': {
      if (w.next.tombstones.some((t) => t.id === e.id)) return false;
      w.next.tombstones.push({ id: e.id, terminal: e.terminal, reason: e.reason, at: m.event_at });
      return true;
    }
    case 'start_cooldown': {
      const item = w.next.cooldowns.find((c) => c.cluster_id === e.cluster_id && c.kind === e.kind);
      if (item === undefined) {
        if (today !== undefined && !cooldownActive({ at: m.event_at, days: e.days }, today))
          return false;
        w.next.cooldowns.push({
          cluster_id: e.cluster_id,
          kind: e.kind,
          days: e.days,
          at: m.event_at,
        });
        return true;
      }
      let changed = false;
      if (Date.parse(m.event_at) > Date.parse(item.at)) {
        item.at = m.event_at;
        changed = true;
      }
      if (e.days > item.days) {
        item.days = e.days;
        changed = true;
      }
      return changed;
    }
  }
}

/**
 * 处理一个批次;`satisfied` = 无需写(键已满足 / 状态已满足 / 没有账类效果),`changed` = Working 已合并。
 * 任何校验失败抛错且**不改动 Working**。
 */
export function applyBatch(
  w: Working,
  key: string,
  effects: readonly LedgerEffect[],
  meta: ApplyOnceMeta | undefined,
  intent: LedgerIntent,
  opts: PlanOptions,
): 'satisfied' | 'changed' {
  if (effects.length === 0) return 'satisfied';
  const m = checkMeta(effects, meta);
  const hash = batchSha256(effects, m);
  if (intent === 'replay') {
    const have = findKey(w, key);
    if (have !== undefined) {
      if (have.batch_sha256 === hash) return 'satisfied';
      throw new EffectsKeyConflict(`key:${key}`);
    }
  }
  validateTombstones(w, effects);
  let changed = false;
  for (const e of effects) changed = mergeEffect(w, e, m, intent, opts.today) || changed;
  if (!changed) return 'satisfied';
  if (findKey(w, key) === undefined) {
    w.newKeys.push({ key, event_at: m.event_at, batch_sha256: hash });
  }
  return 'changed';
}

const byteLen = (l: RsiEffectsLedger): number => Buffer.byteLength(canonicalJson(l), 'utf8');

/**
 * 整次提交的收尾:gen 溢出拒写 → 裁过期冷却 → 非键状态容量(条数 / 字节)→ **重选整个 `applied` 保留子集**(本批新键在前,其后旧键按 `event_at` 降序、同刻键升序,
 * 取使条数与字节同时合规的最长前缀;旧键不得挤占新效果的空间)→ 账 schema 再校验。非键状态合规时空键集必然合规,所以旧键永远不会把合法效果变成 `effects_full`。
 */
export function finalize(w: Working, opts: PlanOptions): PlanResult {
  if (w.base.gen >= Number.MAX_SAFE_INTEGER) throw new StoreError('gen_overflow');
  const next = w.next;
  if (opts.today !== undefined) {
    const today = opts.today;
    next.cooldowns = next.cooldowns.filter((c) => cooldownActive(c, today));
  }
  const L = RSI_EFFECTS_LIMITS;
  if (
    next.blacklist.length > L.blacklist ||
    next.tombstones.length > L.tombstones ||
    next.cooldowns.length > L.cooldowns
  ) {
    return { kind: 'not_committed', cause: 'effects_full' };
  }
  const wm = opts.watermark ?? null;
  const live = (a: RsiAppliedKey): boolean => wm === null || utcDay(a.event_at) > wm;
  const oldKeys = next.applied
    .filter(live)
    .sort(
      (a, b) =>
        Date.parse(b.event_at) - Date.parse(a.event_at) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const candidates = [...w.newKeys.filter(live), ...oldKeys];
  const build = (k: number): RsiEffectsLedger => ({ ...next, applied: candidates.slice(0, k) });
  if (byteLen(build(0)) > L.bytes) return { kind: 'not_committed', cause: 'effects_full' };
  const kMax = Math.min(candidates.length, L.applied);
  let keep = kMax;
  if (byteLen(build(kMax)) > L.bytes) {
    let lo = 0;
    let hi = kMax;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (byteLen(build(mid)) <= L.bytes) lo = mid;
      else hi = mid - 1;
    }
    keep = lo;
  }
  const final = build(keep);
  if (!RsiEffectsLedgerSchema.safeParse(final).success) {
    throw new StoreError('state_invalid', 'plan_invalid');
  }
  return { kind: 'commit', next: final, droppedKeys: candidates.length - keep };
}

// ---------- 单批 / 多批 / 命令侧入口 ----------
/** 单批(`replay` 或 `user_veto` 意图);`satisfied` 不写 */
export function planBatch(
  state: RsiEffectsLedger,
  key: string,
  effects: readonly LedgerEffect[],
  meta: ApplyOnceMeta | undefined,
  intent: LedgerIntent,
  opts: PlanOptions = {},
): PlanResult {
  const w = beginWorking(state);
  if (applyBatch(w, key, effects, meta, intent, opts) === 'satisfied') return { kind: 'satisfied' };
  return finalize(w, opts);
}

export type BatchOutcome =
  { state: 'satisfied' } | { state: 'changed' } | { state: 'failed'; cause: StoreCause };

/** 多批(压缩前恢复):每批独立校验(失败只标该批),需要提交的批次合并成**一份**新账(`gen` 只 +1) */
export function planBatches(
  state: RsiEffectsLedger,
  batches: readonly { key: string; effects: readonly LedgerEffect[]; meta: ApplyOnceMeta }[],
  opts: PlanOptions = {},
): { outcomes: BatchOutcome[]; plan: PlanResult | null; planError: StoreError | null } {
  const w = beginWorking(state);
  const outcomes: BatchOutcome[] = [];
  let anyChanged = false;
  for (const b of batches) {
    try {
      const r = applyBatch(w, b.key, b.effects, b.meta, 'replay', opts);
      // 前面的批次已改动 Working 时,本批的 `satisfied` 可能只是「依赖本次未提交的修改」:对 base 独立复核,
      // 不独立满足的按 `changed` 处理(提交失败时与前批同命运,不得报成「调用前已满足」)
      if (r === 'satisfied' && anyChanged && b.effects.length > 0) {
        const alone = beginWorking(state);
        try {
          if (applyBatch(alone, b.key, b.effects, b.meta, 'replay', opts) === 'changed') {
            outcomes.push({ state: 'changed' });
            continue;
          }
        } catch (e) {
          if (!(e instanceof StoreError)) throw e;
        }
      }
      if (r === 'changed') anyChanged = true;
      outcomes.push({ state: r });
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
      outcomes.push({ state: 'failed', cause: e.code });
    }
  }
  if (!outcomes.some((o) => o.state === 'changed'))
    return { outcomes, plan: null, planError: null };
  try {
    return { outcomes, plan: finalize(w, opts), planError: null };
  } catch (e) {
    if (!(e instanceof StoreError)) throw e;
    return { outcomes, plan: null, planError: e };
  }
}

/** `rsi veto --lift`:项存在且未 lifted → 置 `lifted_at` / `lifted_gen = gen`;否则 `absent` */
export function planLift(
  state: RsiEffectsLedger,
  id: string,
  contentSha256: string,
  at: string,
  opts: PlanOptions = {},
): PlanResult | { kind: 'absent' } {
  if (!IsoTimestampSchema.safeParse(at).success) throw new StoreError('effects_meta_missing', 'at');
  const w = beginWorking(state);
  const item = w.next.blacklist.find(
    (b) => b.candidate_id === id && b.content_sha256 === contentSha256,
  );
  if (item === undefined || item.lifted_gen !== undefined) return { kind: 'absent' };
  item.lifted_at = at;
  item.lifted_gen = w.next.gen;
  return finalize(w, opts);
}
