/**
 * §21 V1 装配块 B 段 B1a「存储核」的契约(docs/contracts.md §21.24 W0-26;owner 2026-11-15 选择框:effects 单账、审计 `idem_key`、压缩与水位线纳入 B 段)。
 * schema 是唯一事实源:`src/rsi/store/**` 的类型由这里的 `z.infer` 得到,不另写一份。
 *
 * 三个文件(`.state/rsi/`,0600,写者 = 持 rsi 锁者):
 *  - `effects.json`:黑名单 / 墓碑 / 冷却单账(取代 R21-11.3 / 11.4 的 `veto.json` / `tombstones.json` 两个位置;元素语义逐项保留);
 *  - `audit.jsonl`:审计行(每行 `RsiAuditLineSchema`,`idem_key` 可选字段见 `rsi-personal.ts`);
 *  - `audit-compaction.json`:水位线与月度汇总(B1a 只有 schema 与读写;推进逻辑归 B1b)。
 * 本文件只有 schema、常量与纯谓词,无 I/O。**生产相位 0 下没有任何入口写这三个文件**(见 `test/rsi/store/inert.test.ts`)。
 */
import { z } from 'zod';
import { IsoDateSchema, IsoTimestampSchema, Sha256Schema } from './common.js';
import { RSI_AUDIT_MAX_LINES, RSI_TERMINAL_REASONS, RsiCandidateIdSchema } from './rsi.js';

const Hex = (n: number): z.ZodString => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`));
const NonNegInt = z.number().int().nonnegative();
/** `gen` 上限 = `Number.MAX_SAFE_INTEGER`:到顶拒写(`gen_overflow`),不回绕 */
const GenInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const RSI_EFFECTS_FILE = 'effects.json';
export const RSI_AUDIT_FILE = 'audit.jsonl';
export const RSI_AUDIT_COMPACTION_FILE = 'audit-compaction.json';

/** 容量(参数,契约原无;W0-26 定):账文件规范化 UTF-8 ≤ 8 MiB;`applied` 只作冲突检测,满则丢键不拒写 */
export const RSI_EFFECTS_LIMITS = Object.freeze({
  blacklist: 1000,
  tombstones: 5000,
  cooldowns: 2000,
  applied: 20000,
  bytes: 8 * 1024 * 1024,
} as const);
/** 软线(只挡增影响,归 C / D 的 `storageHeadroom`)= 硬线的 90% */
export const RSI_STORE_SOFT_RATIO = 0.9;
/** 审计硬线(契约既有) */
export const RSI_AUDIT_LIMIT_LINES = RSI_AUDIT_MAX_LINES;
/** 审计文件读取上限(字节);超限按不合规处理,不截断读 */
export const RSI_AUDIT_READ_MAX_BYTES = 64 * 1024 * 1024;

export const RSI_COOLDOWN_KINDS = Object.freeze([
  'auto_rollback',
  'expired',
  'rejected_streak',
] as const);

// --- effects 账 ---
/** schema 的 refine 消息 = 机器可读的原因(解码时映射为 `StoreError.detail`) */
export const RSI_LEDGER_REFINE = Object.freeze({
  liftedPair: 'lifted_pair',
  genRelation: 'gen_relation',
  duplicate: 'duplicate',
} as const);

export const RsiBlacklistItemSchema = z
  .strictObject({
    candidate_id: RsiCandidateIdSchema,
    content_sha256: Sha256Schema,
    fp_hmac: Hex(16),
    near_fp: z.array(Hex(8)).max(64),
    /** 仅展示;排序依据是 `vetoed_gen` / `lifted_gen`,不是时间 */
    at: IsoTimestampSchema,
    vetoed_gen: GenInt.min(1),
    lifted_at: IsoTimestampSchema.optional(),
    lifted_gen: GenInt.min(1).optional(),
  })
  .superRefine((e, ctx) => {
    if ((e.lifted_at === undefined) !== (e.lifted_gen === undefined)) {
      ctx.addIssue({ code: 'custom', message: RSI_LEDGER_REFINE.liftedPair });
    } else if (e.lifted_gen !== undefined && e.lifted_gen <= e.vetoed_gen) {
      ctx.addIssue({ code: 'custom', message: RSI_LEDGER_REFINE.genRelation });
    }
  });
export type RsiBlacklistItem = z.infer<typeof RsiBlacklistItemSchema>;

export const RsiLedgerTombstoneSchema = z.strictObject({
  id: RsiCandidateIdSchema,
  terminal: z.enum(['rejected', 'expired', 'rolled_back', 'retired']),
  reason: z.enum(RSI_TERMINAL_REASONS),
  at: IsoTimestampSchema,
});
export type RsiLedgerTombstone = z.infer<typeof RsiLedgerTombstoneSchema>;

export const RsiLedgerCooldownSchema = z.strictObject({
  cluster_id: z.string().min(1).max(128),
  kind: z.enum(RSI_COOLDOWN_KINDS),
  days: z.number().int().min(1).max(3650),
  /** 事件时间(取自记录条目,绝不取 now);到期只看 `at + days` */
  at: IsoTimestampSchema,
});
export type RsiLedgerCooldown = z.infer<typeof RsiLedgerCooldownSchema>;

export const RsiAppliedKeySchema = z.strictObject({
  key: z.string().min(1).max(256),
  event_at: IsoTimestampSchema,
  /** 该批效果内容的 sha256(规范化 JSON);同键同内容 = `already`,同键不同内容 = 冲突 */
  batch_sha256: Sha256Schema,
});
export type RsiAppliedKey = z.infer<typeof RsiAppliedKeySchema>;

export const RsiEffectsLedgerSchema = z
  .strictObject({
    schema_version: z.literal(1),
    /** 账级单调代数:每次提交 +1(排序依据,不是时间) */
    gen: GenInt,
    blacklist: z.array(RsiBlacklistItemSchema).max(RSI_EFFECTS_LIMITS.blacklist),
    tombstones: z.array(RsiLedgerTombstoneSchema).max(RSI_EFFECTS_LIMITS.tombstones),
    cooldowns: z.array(RsiLedgerCooldownSchema).max(RSI_EFFECTS_LIMITS.cooldowns),
    applied: z.array(RsiAppliedKeySchema).max(RSI_EFFECTS_LIMITS.applied),
  })
  .superRefine((l, ctx) => {
    const bad = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (
      l.blacklist.some(
        (b) => b.vetoed_gen > l.gen || (b.lifted_gen !== undefined && b.lifted_gen > l.gen),
      )
    ) {
      bad(RSI_LEDGER_REFINE.genRelation);
    }
    const dup = (xs: readonly string[]): boolean => new Set(xs).size !== xs.length;
    if (
      dup(l.blacklist.map((b) => `${b.candidate_id}:${b.content_sha256}`)) ||
      dup(l.tombstones.map((t) => t.id)) ||
      dup(l.cooldowns.map((c) => `${c.cluster_id}:${c.kind}`)) ||
      dup(l.applied.map((a) => a.key))
    ) {
      bad(RSI_LEDGER_REFINE.duplicate);
    }
  });
export type RsiEffectsLedger = z.infer<typeof RsiEffectsLedgerSchema>;

/** 文件缺失 = 虚拟空账(`gen: 0`,合法) */
export const EMPTY_EFFECTS_LEDGER: RsiEffectsLedger = Object.freeze({
  schema_version: 1,
  gen: 0,
  blacklist: [],
  tombstones: [],
  cooldowns: [],
  applied: [],
}) as RsiEffectsLedger;

// --- 压缩与水位线 ---
export const RSI_COMPACTION_REFINE = Object.freeze({
  linesSum: 'lines_sum',
  byKindSum: 'by_kind_sum',
  transitionSum: 'transition_sum',
} as const);

const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);

export const RsiAuditMonthSchema = z
  .strictObject({
    lines: NonNegInt,
    /** 压缩实际删除的唯一行 */
    deleted: NonNegInt,
    /** 缺失但可由权威记录派生的唯一事件 */
    derived_missing: NonNegInt,
    by_kind: z.record(z.string().max(64), NonNegInt),
    transition_by_to: z.record(z.string().max(64), NonNegInt),
  })
  .superRefine((m, ctx) => {
    if (m.lines !== m.deleted + m.derived_missing) {
      ctx.addIssue({ code: 'custom', message: RSI_COMPACTION_REFINE.linesSum });
    }
    if (sum(m.by_kind) !== m.lines) {
      ctx.addIssue({ code: 'custom', message: RSI_COMPACTION_REFINE.byKindSum });
    }
  });
export type RsiAuditMonth = z.infer<typeof RsiAuditMonthSchema>;

export const RsiAuditCompactionSchema = z.strictObject({
  schema_version: z.literal(1),
  /** 首次创建 = 1,每次提交 +1;文件缺失 = 虚拟 `gen: 0` */
  gen: GenInt.min(1),
  /** 水位线 W(UTC 日);≤ W 的事件不再追加明细。`null` = 尚未推进 */
  through: IsoDateSchema.nullable(),
  months: z.record(z.string().regex(/^\d{4}-\d{2}$/), RsiAuditMonthSchema),
});
export type RsiAuditCompaction = z.infer<typeof RsiAuditCompactionSchema>;

// --- 错误 / cause 码表(§E 第 9 项) ---
/** `RSI_FAIL_CLOSED reason=` 取值(与 `RSI_FAIL_CLOSED_REASONS` 子集一致;退出码一律 3,§20.3 总表) */
export type StoreFailClosedReason =
  'state_invalid' | 'audit_invalid' | 'effects_full' | 'audit_full' | 'internal';

/**
 * 存储核全部 cause → 稳定码 `reason=` 的映射(退出码恒为 3)。`as const satisfies`:新增 cause 必须在这里登记。
 * 「已提交」类结果(账已提交、审计待补)不是错误,不在此表(见 `ApplyOnceResult`)。
 */
export const RSI_STORE_CAUSES = Object.freeze({
  // 账
  state_invalid: 'state_invalid',
  effects_key_conflict: 'state_invalid',
  effects_meta_missing: 'internal',
  unsupported_effect: 'internal',
  effects_full: 'effects_full',
  gen_overflow: 'state_invalid',
  out_of_range: 'internal',
  // 审计
  audit_bad_line: 'audit_invalid',
  audit_dup_key: 'audit_invalid',
  audit_key_conflict: 'audit_invalid',
  audit_key_missing: 'audit_invalid',
  audit_full: 'audit_full',
  clock_regressed: 'audit_invalid',
  sealed_interval: 'audit_invalid',
  sealed_unknown_event: 'audit_invalid',
  region_closed: 'internal',
  region_open: 'internal',
  observation_row_sealed: 'audit_invalid',
  // 压缩文件
  compaction_unsupported: 'audit_invalid',
  compaction_unreadable: 'audit_invalid',
  compaction_vanished: 'audit_invalid',
  compact_unwired: 'internal',
  compact_blocked: 'internal',
  // 事务 / 锁
  txn_closing: 'internal',
  txn_closed: 'internal',
  txn_nested: 'internal',
  release_inside_transaction: 'internal',
  store_io: 'internal',
} as const satisfies Record<string, StoreFailClosedReason>);
export type StoreCause = keyof typeof RSI_STORE_CAUSES;

export const failClosedReasonOf = (c: StoreCause): StoreFailClosedReason => RSI_STORE_CAUSES[c];

// --- 日与冷却谓词(§E 第 10 项) ---
/** UTC 日(`YYYY-MM-DD`) */
export type UtcDay = string;

/** 时间戳 → UTC 日(输入已过 `IsoTimestampSchema`;用 `Date` 归一,带偏移的写法按 UTC 折算) */
export function utcDay(at: string): UtcDay {
  return new Date(at).toISOString().slice(0, 10);
}

/** UTC 日 + 整数天(按日历日) */
export function addUtcDays(day: UtcDay, days: number): UtcDay {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 冷却是否仍生效:`utcDay(at) + days > today`(按 UTC 日历日加整数天)。**过期 = 非 active**:`at + days ≤ today` 即不生效、可裁。
 * 裁剪、压缩判据「已过期被裁」、`cooldown_active` 展示三处都用本谓词(YYYY-MM-DD 字典序即日期序)。
 */
export function cooldownActive(
  item: Pick<z.infer<typeof RsiLedgerCooldownSchema>, 'at' | 'days'>,
  today: UtcDay,
): boolean {
  return addUtcDays(utcDay(item.at), item.days) > today;
}
