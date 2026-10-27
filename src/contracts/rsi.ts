/**
 * 自动 RSI 的契约常量(docs/contracts.md §20;R20-A0 起)。本节的数值全部是**不可配置的常量**(§20 开头)。
 * R20-A0 只落地与 RSI 状态无关、且先于其它块的那一个:单行 JSON 嵌套深度上限(§20.9 第 14 条 / R20-6.7)。
 * 稳定码枚举、其余上限常量由后续块(A1 起)在本文件追加,不要在别处另起一份。
 */
import { z } from 'zod';
import {
  IsoDateSchema,
  IsoTimestampSchema,
  RunIdSchema,
  SessionRefIdSchema,
  Sha256Schema,
} from './common.js';

/** 单行 JSON 嵌套深度上限(`{` / `[` 的最大嵌套层数,字符串内的括号不计)。超过 → 该行按超大行处理,不进 JSON 解析。 */
export const RSI_MAX_JSON_DEPTH = 256;

// ---------------------------------------------------------------------------
// A1(锁与快照清单;docs/contracts.md §20.5)
// ---------------------------------------------------------------------------
/** `rsi/lock` 过期告警阈值(分钟,R20-5.5):持锁进程存活但超过它只报 `locked_over_ttl`,不杀、不删。 */
export const RSI_LOCK_TTL_MINUTES = 15;
export const RSI_LOCK_TTL_MS = RSI_LOCK_TTL_MINUTES * 60_000;
/** 空文件 / 内容损坏的锁文件要创建满这么久才可回收(O_EXCL 创建与写入之间的窗口,R20-5.5) */
export const RSI_LOCK_PARTIAL_GRACE_MS = 10_000;
/** 锁文件与快照清单的权限 / 其目录权限 */
export const RSI_FILE_MODE = 0o600;
export const RSI_DIR_MODE = 0o700;
/** 锁文件内容的字节上限(超出按损坏处理) */
export const RSI_LOCK_MAX_BYTES = 4096;
/** 快照清单项数上限(R20-5.6) */
export const RSI_SNAPSHOT_MAX_FILES = 2000;
/** 快照清单 `name` 的固定集合(相对 `.state/rsi/`) */
export const RSI_SNAPSHOT_FIXED_NAMES: readonly string[] = Object.freeze([
  'cursor.json',
  'counts.json',
  'projects.json',
  'state.json',
]);
/** 其余 `name`:相对 `.state/`,只能是信号库 / 会话计数库的月文件 */
export const RSI_SNAPSHOT_DYNAMIC_NAME_RE = /^(signals|sessions)\/(claude|codex|pi)\/\d{6}\.jsonl$/;

export function isRsiSnapshotName(name: string): boolean {
  return RSI_SNAPSHOT_FIXED_NAMES.includes(name) || RSI_SNAPSHOT_DYNAMIC_NAME_RE.test(name);
}

/** 稳定码(§20.3 R20-3.0 总表;A1 用到的子集,命名与大小写照契约,不得新增)。 */
export const RSI_NOT_RUN_REASONS = Object.freeze([
  'off',
  'stopped',
  'collect_blocked',
  'locked',
  'locked_over_ttl',
  'not_confirmed',
  'no_journal',
] as const);
export const RSI_FAIL_CLOSED_REASONS = Object.freeze([
  'cfg_symlink',
  'cfg_owner',
  'cfg_perm',
  'cfg_not_regular',
  'cfg_too_large',
  'cfg_unreadable',
  'cfg_parse',
  'cfg_schema',
  'repo_invalid',
  'overlay_invalid',
  'exclude_invalid',
  'state_invalid',
  'state_dir_unsafe',
  'index_invalid',
  'cursor_invalid',
  'counts_invalid',
  'snapshot_invalid',
  'journal_invalid',
  'signal_store_corrupt',
  'salt_invalid',
  'redactor_init',
  'staging_too_large',
  'lock_lost',
  'write_denied',
  'purge_incomplete',
  'output_leak',
  'internal',
] as const);
export type RsiNotRunReason = (typeof RSI_NOT_RUN_REASONS)[number];
export type RsiFailClosedReason = (typeof RSI_FAIL_CLOSED_REASONS)[number];
/** 顶层码 `RSI_SNAPSHOT_BUSY`(退出 4) */
export const RSI_SNAPSHOT_BUSY = 'RSI_SNAPSHOT_BUSY';

/** `rsi/lock` 文件内容(R20-5.5):`{pid, started_at, nonce, kit_version}` */
export const RsiLockDocSchema = z.strictObject({
  pid: z.number().int().positive(),
  started_at: IsoTimestampSchema,
  nonce: z.string().regex(/^[0-9a-f]{16}$/),
  kit_version: z.string().min(1).max(64),
});
export type RsiLockDoc = z.infer<typeof RsiLockDocSchema>;

/** 快照清单的一项:只允许白名单 `name`(R20-5.6) */
export const RsiSnapshotFileSchema = z.strictObject({
  name: z.string().refine(isRsiSnapshotName, { message: 'name 不在白名单内' }),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
});

/** `.state/rsi/snapshot.json`(R20-5.6):`name` 不重复、按字节序升序、≤ 2000 项;`generation` 只增(首次提交为 1) */
export const RsiSnapshotSchema = z
  .strictObject({
    schema_version: z.literal(1),
    generation: z.number().int().positive(),
    written_at: IsoTimestampSchema,
    files: z.array(RsiSnapshotFileSchema).max(RSI_SNAPSHOT_MAX_FILES),
  })
  .superRefine((snap, ctx) => {
    for (let i = 1; i < snap.files.length; i++) {
      const prev = snap.files[i - 1]?.name ?? '';
      const cur = snap.files[i]?.name ?? '';
      // name 是 ASCII(白名单),UTF-16 码元序 = 字节序
      if (!(prev < cur)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i, 'name'],
          message: prev === cur ? 'name 重复' : 'name 未按字节序升序',
        });
      }
    }
  });
export type RsiSnapshot = z.infer<typeof RsiSnapshotSchema>;

// ---------------------------------------------------------------------------
// A2 B2(R20 schema 全集;docs/contracts.md §20.2 / §20.4 / §20.6 / §20.7)
// ---------------------------------------------------------------------------
export const RSI_AGENT_IDS = ['claude', 'codex', 'pi'] as const;
export const RsiAgentSchema = z.enum(RSI_AGENT_IDS);
export type RsiAgentId = z.infer<typeof RsiAgentSchema>;

/** `[rsi] exclude_dirs` / `exclude_names` 的项数上限(L-base 只校验到这一层) */
export const RSI_MAX_EXCLUDE_ITEMS = 256;
/** 项目索引条目上限(R20-4.2) */
export const RSI_INDEX_MAX_ENTRIES = 10000;
/** 计数投影的上限(R20-4.5) */
export const RSI_COUNTS_MAX_CLUSTERS = 500;
export const RSI_COUNTS_MAX_STAGED = 5000;
/** cursor 条目上限(R20-6.7) */
export const RSI_CURSOR_MAX_FILES = 100000;

/** 项目 key:`p_` + 16 位十六进制(§9) */
export const RsiProjectKeySchema = z.string().regex(/^p_[0-9a-f]{16}$/);
/** 计数投影里「映射不到 key 的证据」的字面量(R20-4.5,按 U 处理) */
export const RSI_UNKNOWN_KEY = '?';
const RsiKeyOrUnknownSchema = z.union([RsiProjectKeySchema, z.literal(RSI_UNKNOWN_KEY)]);
const SaltFpSchema = z.string().regex(/^[0-9a-f]{12}$/);
const NonNegInt = z.number().int().nonnegative();

/** 绝对路径:以 `/` 开头、≤ 4096 字节、无 NUL(R20-4.2) */
const AbsPathSchema = z
  .string()
  .refine(
    (p) => p.startsWith('/') && !p.includes('\0') && Buffer.byteLength(p, 'utf8') <= 4096,
    '必须是绝对路径、≤ 4096 字节、不含 NUL',
  );

const sortedUnique = (a: readonly string[]): boolean =>
  a.every((x, i) => i === 0 || (a[i - 1] as string) < x);

/**
 * `[rsi]` 的 L-base 层(R20-2.6,strict):只校验键与类型。`exclude_*` 只验「字符串数组、≤ 256 项」,内容属 L-policy;
 * `session` 只验为「表或缺省」(P1 的 `RsiSessionSchema` 在 L-session 层)。`agents` 去重后非空,只许 claude / codex / pi(Q12)。
 * v3.1 的 `auto` / `capability` / `contrib` 三个表由 V1 追加,这里不接受。
 */
export const RsiBaseSchema = z.strictObject({
  enabled: z.boolean().optional(),
  repo: z.string().optional(),
  overlay: z.string().optional(),
  agents: z.array(RsiAgentSchema).min(1).optional(),
  exclude_dirs: z.array(z.string()).max(RSI_MAX_EXCLUDE_ITEMS).optional(),
  exclude_names: z.array(z.string()).max(RSI_MAX_EXCLUDE_ITEMS).optional(),
  session: z.record(z.string(), z.unknown()).optional(),
});
export type RsiBase = z.infer<typeof RsiBaseSchema>;

/**
 * 归一化策略(R20-1.5 / R20-6.9 的比较对象):`policy_fp = sha256(canonicalJson(policy))`。
 * `exclude_hashes` 是规范化(canonical + 折叠大小写)排除项的哈希集合,不存路径原文。
 */
export const RsiPolicySchema = z.strictObject({
  schema_version: z.literal(1),
  agents: z.array(RsiAgentSchema).min(1).refine(sortedUnique, '升序且不重复'),
  exclude_hashes: z.array(Sha256Schema).refine(sortedUnique, '升序且不重复'),
  overlay_sha256: Sha256Schema.nullable(),
  kit_major: NonNegInt,
});
export type RsiPolicy = z.infer<typeof RsiPolicySchema>;

/** `state.json` 的确认记录(R20-3.6.3;不存路径原文) */
export const RsiConfirmSchema = z.strictObject({
  confirmed_at: IsoTimestampSchema,
  kit_major: NonNegInt,
  agents: z.array(RsiAgentSchema).min(1).refine(sortedUnique, '升序且不重复'),
  exclude_hashes: z.array(Sha256Schema).refine(sortedUnique, '升序且不重复'),
  /** `sha256(repo 的 realpath)`:R20-1.5 ③ 的 realpath 比较,不存路径 */
  repo_sha256: Sha256Schema,
  repo_dev_ino: z.strictObject({ dev: NonNegInt, ino: NonNegInt }),
  overlay_sha256: Sha256Schema.nullable(),
  policy_fp: Sha256Schema,
  baseline_pending: z.boolean(),
});
export type RsiConfirm = z.infer<typeof RsiConfirmSchema>;

/** worker / tick 的结果码(R20-6.5) */
export const RSI_OUTCOMES = Object.freeze([
  'ok',
  'ok_partial',
  'skipped_off',
  'skipped_stopped',
  'skipped_collect_blocked',
  'skipped_throttled',
  'skipped_locked',
  'skipped_update_busy',
  'skipped_ci',
  'skipped_child',
  'skipped_binding_changed',
  'stopped',
  'io_error',
  'crashed',
  'internal',
  'state_invalid',
  'cursor_invalid',
  'counts_invalid',
  'snapshot_invalid',
  'journal_invalid',
  'signal_store_corrupt',
  'salt_invalid',
  'redactor_init',
  'write_denied',
  'lock_lost',
  'state_dir_unsafe',
  'purge_incomplete',
  'staging_too_large',
] as const);
export const RSI_TRIGGERS = Object.freeze([
  'poke',
  'kit',
  'tick',
  'confirm',
  'purge',
  'stop',
  'rebuild',
  'status',
] as const);
const RsiOutcomeSchema = z.enum(RSI_OUTCOMES);
const RsiTriggerSchema = z.enum(RSI_TRIGGERS);

/** `.state/rsi/state.json`(R20-1.5 / R20-3.4.2 / R20-6.4 / R20-6.6) */
export const RsiStateSchema = z.strictObject({
  schema_version: z.literal(1),
  confirm: RsiConfirmSchema.nullable(),
  /** 「新增项目 n」的基线(R20-4.2a) */
  projects_ack_generation: NonNegInt,
  /** 预写的 attempt(R20-6.4);正常结束清除 */
  attempt: z
    .strictObject({ started_at: IsoTimestampSchema, nonce: z.string().regex(/^[0-9a-f]{16}$/) })
    .nullable(),
  last_tick: z
    .strictObject({
      completed_at: IsoTimestampSchema,
      trigger: RsiTriggerSchema,
      outcome: RsiOutcomeSchema,
      code: z.string().max(64).nullable(),
      duration_ms: NonNegInt,
      files_read: NonNegInt,
      bytes_read: NonNegInt,
    })
    .nullable(),
  /** 熔断关闭期间累计的连续可重试失败(R20-6.6) */
  consecutive_failures: NonNegInt,
  /** 熔断打开记录;`safety` 没有 `until`(不自动半开) */
  breaker: z
    .strictObject({
      kind: z.enum(['retryable', 'safety']),
      opened_at: IsoTimestampSchema,
      until: IsoTimestampSchema.nullable(),
    })
    .nullable(),
});
export type RsiState = z.infer<typeof RsiStateSchema>;

/** `.state/rsi/projects.json`(R20-4.2):`entries` 按 key 严格升序、唯一;`roots` 1..8 条 */
export const RsiProjectIndexSchema = z
  .strictObject({
    schema_version: z.literal(1),
    salt_fp: SaltFpSchema,
    generation: NonNegInt,
    entries: z
      .array(
        z.strictObject({
          key: RsiProjectKeySchema,
          roots: z
            .array(
              z.strictObject({
                path: AbsPathSchema,
                dev: NonNegInt,
                ino: NonNegInt,
                first_seen: IsoDateSchema,
                last_seen: IsoDateSchema,
              }),
            )
            .min(1)
            .max(8),
          sessions: NonNegInt,
          signals: NonNegInt,
          first_indexed_generation: NonNegInt,
        }),
      )
      .max(RSI_INDEX_MAX_ENTRIES),
  })
  .superRefine((idx, ctx) => {
    for (let i = 1; i < idx.entries.length; i++) {
      const prev = idx.entries[i - 1]?.key ?? '';
      const cur = idx.entries[i]?.key ?? '';
      if (!(prev < cur)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i, 'key'],
          message: prev === cur ? 'key 重复' : 'key 未升序',
        });
      }
    }
  });
export type RsiProjectIndex = z.infer<typeof RsiProjectIndexSchema>;

/** `.state/rsi/counts.json`(R20-4.5);`signals_by_day` 只保留最近 8 个 UTC 日 */
export const RsiCountsSchema = z.strictObject({
  schema_version: z.literal(1),
  salt_fp: SaltFpSchema,
  generation: NonNegInt,
  computed_at: IsoTimestampSchema,
  cluster_min: z.number().int().positive(),
  per_key: z.record(
    RsiProjectKeySchema,
    z.strictObject({
      signals_total: NonNegInt,
      sessions: NonNegInt,
      signals_by_day: z
        .record(IsoDateSchema, NonNegInt)
        .refine((r) => Object.keys(r).length <= 8, '至多 8 个 UTC 日'),
    }),
  ),
  clusters: z
    .array(
      z.strictObject({
        cluster_id: z.string().min(1).max(128),
        evidence_by_key: z.record(RsiKeyOrUnknownSchema, NonNegInt),
      }),
    )
    .max(RSI_COUNTS_MAX_CLUSTERS),
  staged: z
    .array(
      z.strictObject({
        run_id: RunIdSchema,
        proposals: NonNegInt,
        evidence_keys: z.array(RsiKeyOrUnknownSchema),
        tainted: z.boolean(),
      }),
    )
    .max(RSI_COUNTS_MAX_STAGED),
  unknown_keys_signals: NonNegInt,
});
export type RsiCounts = z.infer<typeof RsiCountsSchema>;

export const RSI_CURSOR_FILE_STATUSES = Object.freeze([
  'ok',
  'too_large',
  'read_error',
  'excluded',
  'self_state',
  'unknown_project',
] as const);

/** `.state/rsi/cursor.json`(R20-6.9) */
export const RsiCursorSchema = z.strictObject({
  schema_version: z.literal(1),
  fingerprint: Sha256Schema,
  full_scan: z.strictObject({
    epoch: NonNegInt,
    started_at: IsoTimestampSchema.nullable(),
    done: z.boolean(),
    last_completed_at: IsoTimestampSchema.nullable(),
  }),
  files: z
    .record(
      SessionRefIdSchema,
      z.strictObject({
        agent: RsiAgentSchema,
        size: NonNegInt,
        mtime_ms: z.number().nonnegative(),
        dev: NonNegInt,
        ino: NonNegInt,
        project_key: RsiProjectKeySchema.nullable(),
        epoch: NonNegInt,
        status: z.enum(RSI_CURSOR_FILE_STATUSES),
      }),
    )
    .refine((r) => Object.keys(r).length <= RSI_CURSOR_MAX_FILES, '条目超过上限'),
});
export type RsiCursor = z.infer<typeof RsiCursorSchema>;

/** purge journal 的五个阶段(R20-3.8.4) */
export const RSI_PURGE_PHASES = Object.freeze([
  'planned',
  'tainted',
  'signals_rewritten',
  'indexed',
  'done',
] as const);

/** `.state/rsi/purge-journal.json`:续做一律按这里**已记下的**集合,不重新从信号库推导 */
export const RsiPurgeJournalSchema = z.strictObject({
  schema_version: z.literal(1),
  created_at: IsoTimestampSchema,
  phase: z.enum(RSI_PURGE_PHASES),
  keys: z.array(RsiProjectKeySchema).min(1).refine(sortedUnique, '升序且不重复'),
  taint_targets: z.strictObject({
    runs: z.array(RunIdSchema).refine(sortedUnique, '升序且不重复'),
    promotes: z.array(RunIdSchema).refine(sortedUnique, '升序且不重复'),
  }),
});
export type RsiPurgeJournal = z.infer<typeof RsiPurgeJournalSchema>;

/** `TAINTED` 标记(R20-4.7) */
export const RsiTaintMarkSchema = z.strictObject({
  reason: z.enum(['exclude', 'purge']),
  at: IsoTimestampSchema,
});
export type RsiTaintMark = z.infer<typeof RsiTaintMarkSchema>;

/** `STOP` 标记(R20-3.7.1) */
export const RsiStopMarkSchema = z.strictObject({
  at: IsoTimestampSchema,
  by: z.literal('user'),
});
export type RsiStopMark = z.infer<typeof RsiStopMarkSchema>;

export const RSI_LOG_ACTIONS = Object.freeze([
  'spawned',
  'spawn_failed',
  'completed',
  'skipped',
  'stopped',
  'confirmed',
  'declined',
  'purged',
  'rebuilt',
  'acked',
  'recovered',
  'failed',
] as const);

/** `.state/rsi/log.jsonl` 的一行(R20-7.1):不含路径、key、目录名、会话 id、摘录、异常消息 */
export const RsiLogLineSchema = z.strictObject({
  at: IsoTimestampSchema,
  trigger: RsiTriggerSchema,
  agent: RsiAgentSchema.optional(),
  action: z.enum(RSI_LOG_ACTIONS),
  /** 稳定码或结果码;字符集排除 `/`,路径进不来 */
  code: z.string().regex(/^[A-Za-z0-9_=.:-]{1,64}$/),
  counts: z.record(z.string().regex(/^[a-z_]{1,32}$/), NonNegInt).optional(),
  duration_ms: NonNegInt.optional(),
});
export type RsiLogLine = z.infer<typeof RsiLogLineSchema>;

// ---------------------------------------------------------------------------
// 稳定码补充(B2)
// ---------------------------------------------------------------------------
/** `RSI_USAGE reason=`(R20-3.0 总表,退出 2) */
export const RSI_USAGE_REASONS = Object.freeze([
  'unknown_subcommand',
  'unknown_arg',
  'missing:--agent',
  'bad_agent',
  'mode_conflict',
  'not_tty',
  'paths_requires_tty',
  'write_requires_mode',
  'bad_path',
  'root_mismatch',
] as const);
/**
 * 现有写入方拿不到 `rsi/lock` 时的命令级码(D3,§20.9 第 7 条):`<前缀>_NOT_RUN reason=locked`,退出 4,零调用零写入。
 * B2 只登记码,不接线。
 */
export const RSI_LOCKED_NOT_RUN_CODES = Object.freeze([
  'SIGNALS_NOT_RUN',
  'PROMOTE_NOT_RUN',
  'REFLECT_NOT_RUN',
  'JUDGE_NOT_RUN',
] as const);
/** `rsi status` 的 `lock:` 行取值(D7:追加 `unsafe`) */
export const RSI_LOCK_STATES = Object.freeze([
  'free',
  'held',
  'held_over_ttl',
  'stale',
  'unsafe',
] as const);
