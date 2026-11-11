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
  // R20-A2 B5-0(第一批拍板 Q-B):tick 的 `skipped_binding_changed` 对应的报码(退 4)。契约总表待主代理并入(见 PENDING_DOC)
  'binding_changed',
  // R20-A4(R20-16.21 / R20-16.15 第 4 步;`rate_limited` 与 R21-12.9 共用同一枚举项)。总表待主代理并入(见 test/contracts/rsi-pending-doc.ts)
  'purge_pending',
  'digest_backlog',
  'policy_changed',
  'rate_limited',
  // R20-A6(R20-17.23):`rsi dismiss`
  'run_not_pending',
  'dismiss_full',
  'run_scan_incomplete',
  // §21 W0-12(R21-12.9):不在对应期之前发码,只是枚举常量
  'not_diverged',
  'phase_not_available',
  'ticket_expired',
  'no_runtime',
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
  'staging_unsafe_entry',
  'lock_lost',
  'write_denied',
  'purge_incomplete',
  'output_leak',
  'stdin_unreadable',
  'internal',
  // R20-A5(R20-15.28):`rsi hooks` 的私有状态区 / 目标安全拒绝(`lock_lost` / `internal` 与上面共用同名项)
  'hooks_target_unsafe',
  'hooks_backup_invalid',
  'hooks_ledger_invalid',
  // R20-A6(R20-17.8 / R20-17.23):`dismissed.json` 损坏时写路径不覆盖
  'dismissed_invalid',
  // §21 W0-12(R21-12.9)
  'personal_repo_invalid',
  'candidate_invalid',
  'ledger_line_invalid',
  'txn_invalid',
  'probe_error',
] as const);
/** 顶层(0)信息行(R20-17.23):只在提醒条件下写 stderr,不改退出码 */
export const RSI_INFO_LINE_CODES = Object.freeze([
  'RSI_PROPOSALS_READY',
  'RSI_COLLECTION_STARTED',
] as const);
/** 顶层码,退出 1(R20-3.0 总表「顶层(1)」行):只登记,供「契约表 ↔ 枚举」一致性测试逐行比对 */
export const RSI_EXIT1_CODES = Object.freeze([
  'RSI_RUN_TAINTED',
  'RSI_RUN_ATTRIBUTION_UNKNOWN',
  'RSI_PURGE_NOT_EXCLUDED',
  'RSI_CONFIRM_DECLINED',
  'RSI_CONFIRM_STALE',
  // R20-A4(R20-16.21):ingest 的退出 1 码
  'RSI_INGEST_TOO_LARGE',
  'RSI_STAGING_FULL',
  'RSI_INGEST_REJECTED',
  // R20-A5(R20-15.28):`rsi hooks` 确认输入不是 yes / EOF
  'RSI_HOOKS_DECLINED',
  // §21 W0-12(R21-12.9)
  'RSI_AUTO_RESUME_BLOCKED',
  'RSI_CONTRIB_DEGRADED',
  'RSI_EXEC_DECLINED',
] as const);
/** 计数码(R20-3.0 总表「计数码」行;不改退出码,只进 `--json` 与日志;顺序照总表) */
export const RSI_COUNTER_CODES = Object.freeze([
  'RSI_FILE_TOO_LARGE',
  'RSI_LIMIT_FILES',
  'RSI_LIMIT_BYTES',
  'RSI_LIMIT_TIME',
  'RSI_LIMIT_DEPTH',
  'RSI_LIMIT_ENTRIES',
  'RSI_INDEX_FULL',
] as const);
export type RsiCounterCode = (typeof RSI_COUNTER_CODES)[number];
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

// ---------------------------------------------------------------------------
// R20-6.7 资源上限与 B4 采集常量(B4-0 冻结;全部是不可配置的常量)
// ---------------------------------------------------------------------------
/** 会话根目录项(含目录)上限,`armed` 与 `confirmed` 都算;超出停止列举,`RSI_LIMIT_ENTRIES` */
export const RSI_MAX_DIR_ENTRIES = 50000;
/** `armed` 头部预读的文件数上限(D4:按 mtime 降序取前 N 个,其余计入 `unknown_sessions`),`RSI_LIMIT_FILES` */
export const RSI_ARMED_MAX_FILES = 2000;
/** `armed` 头部读取的窗口:每个文件一次偏移 0、至多这么多字节的物理读取(R20-1.4) */
export const RSI_ARMED_HEAD_BYTES = 64 * 1024;
/** claude 头部解析最多看的完整行数(D1;pi / codex 只看首行);同一次 `RSI_ARMED_HEAD_BYTES` 读取内,找到 cwd 即停 */
export const RSI_ARMED_CLAUDE_MAX_LINES = 32;
/** `confirmed` 单次 L0 读取的改动文件数上限,`RSI_LIMIT_FILES` */
export const RSI_MAX_FILES_PER_TICK = 2000;
/** 单次 L0 读取字节上限(按实际读取字节,文件读完后检查),`RSI_LIMIT_BYTES` */
export const RSI_MAX_BYTES_PER_TICK = 256 * 1024 * 1024;
/** 单文件大小上限:超过(读前按 lstat、读中按实际字节)按 `too_large` 处理,`RSI_FILE_TOO_LARGE` */
export const RSI_MAX_FILE_BYTES = 512 * 1024 * 1024;
/** 单次 L0 墙钟(毫秒;尽力,只在读阶段的检查点判),`RSI_LIMIT_TIME` */
export const RSI_MAX_TICK_MS = 120_000;
/** 行级检查点间隔(R20-6.8:每处理这么多行,含空白行与只有元数据的行) */
export const RSI_CHECKPOINT_LINES = 1000;
/** 全量扫描周期:距 `last_completed_at` 达到它就 `epoch + 1`(R20-6.9) */
export const RSI_FULL_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** `rsi projects --rebuild-index` 的头部读取上限(D11:按 mtime 降序),超出报 `RSI_LIMIT_FILES` */
export const RSI_REBUILD_MAX_FILES = 10000;
/** 盐文件的字节上限(D5 共同只读原语;`salt` 是 64 位十六进制 + 可选换行) */
export const RSI_SALT_MAX_BYTES = 4096;
/** 盐文件空文件的等待 / 回收宽限(D15:持锁、空普通文件、mtime 已满这么久才可删除重建) */
export const RSI_SALT_EMPTY_GRACE_MS = 10_000;
/** `log.jsonl` 的行数与单行字节上限(R20-6.7) */
export const RSI_LOG_MAX_LINES = 200;
export const RSI_LOG_LINE_MAX_BYTES = 1024;

// ---------------------------------------------------------------------------
// A3 常量(R20-3.2 / R20-3.3 / R20-6.2 / R20-6.3 / R20-6.5 / R20-6.6;全部不可配置)
// ---------------------------------------------------------------------------
/** poke / 顺带调度的启动预留窗口(R20-6.2):窗口序号 = floor(now / 30 分钟) */
export const RSI_POKE_WINDOW_MINUTES = 30;
export const RSI_POKE_WINDOW_MS = RSI_POKE_WINDOW_MINUTES * 60_000;
/** worker 持锁时删除早于当前窗口这么多个以上的预留标记(R20-6.2) */
export const RSI_POKE_RESERVATION_KEEP_WINDOWS = 2;
/** poke / hint 自身的尽力预算(R20-3.2.1 / R20-3.3.1) */
export const RSI_POKE_BUDGET_MS = 1000;
export const RSI_HINT_BUDGET_MS = 1000;
/** 相邻两次 L0 完成时间的最小间隔(R20-6.3) */
export const RSI_L0_MIN_INTERVAL_HOURS = 6;
export const RSI_L0_MIN_INTERVAL_MS = RSI_L0_MIN_INTERVAL_HOURS * 60 * 60_000;
/** 可重试失败连续达到这么多次 → 熔断打开(R20-6.5) */
export const RSI_BREAKER_MAX_FAILURES = 3;
/** retryable 熔断的打开时长(R20-6.6) */
export const RSI_BREAKER_OPEN_HOURS = 24;
export const RSI_BREAKER_OPEN_MS = RSI_BREAKER_OPEN_HOURS * 60 * 60_000;
/** hint:confirmed 下输出的聚类门槛 K(R20-3.3.4)、去重窗口、字节上限与计数显示上限(R20-3.3.2) */
export const RSI_HINT_MIN_CLUSTERS = 3;
export const RSI_HINT_DEDUP_MINUTES = 30;
export const RSI_HINT_DEDUP_MS = RSI_HINT_DEDUP_MINUTES * 60_000;
export const RSI_HINT_MAX_BYTES = 200;
export const RSI_HINT_COUNT_CAP = 9999;

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
  // §21 W0-9(R21-2.1 / §21.18 第 19 条订正):三个子表与 session 一样只验「表或缺省」,内容留给 L-auto / L-cap / L-contrib
  auto: z.record(z.string(), z.unknown()).optional(),
  capability: z.record(z.string(), z.unknown()).optional(),
  contrib: z.record(z.string(), z.unknown()).optional(),
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
export type RsiOutcome = z.infer<typeof RsiOutcomeSchema>;
const RsiTriggerSchema = z.enum(RSI_TRIGGERS);

// ---------------------------------------------------------------------------
// §21 W0:相位闸与熔断码(docs/contracts.md §21.24 W0-1;R21-0.1 / R21-10.2)
// ---------------------------------------------------------------------------
/** 相位有序表:**只追加、不插入、不重排**(R21-0.1,W0-1);`RSI_AUTO_PHASE` 取其下标 */
export const RSI_AUTO_PHASE_ORDER = Object.freeze([
  'V0',
  'V1a',
  'V1b',
  'V1.5',
  'V2',
  'V3',
  'V4',
  'V5',
  'V6a',
  'V6b',
] as const);
export type RsiAutoPhaseName = (typeof RSI_AUTO_PHASE_ORDER)[number];
/** 分期闸(R21-0.1):代码常量,由实现块提升,不读配置。W0 落地时为 0(V0);V1a / V1b 各自一个 PR 提升(R21-0.2) */
export const RSI_AUTO_PHASE = 0;

/** 熔断码(R21-10.2 码表;`state.json.auto_pause.reasons` 的封闭枚举) */
export const RSI_AUTO_PAUSE_REASONS = Object.freeze([
  'rollback_storm',
  'gate_internal',
  'apply_failed',
  'personal_repo_invalid',
  'budget_high_legacy',
  'cost_high_legacy',
  'no_observation',
  'redaction_changed',
  'user_vetoes',
  'kit_major_changed',
  'user_paused',
  'isolation_unverified',
] as const);
export type RsiAutoPauseReason = (typeof RSI_AUTO_PAUSE_REASONS)[number];
const RsiAutoPauseReasonSchema = z.enum(RSI_AUTO_PAUSE_REASONS);

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
  /**
   * 首次 `armed` 列举的结果(D2,供 hint 的 `armed` 模板显示 P;B4-0 追加的**可选**字段,老文件仍合法):
   * 绑定 `policy_fp` 与 `agents`——缺失、或与当前不一致时 hint 输出空串;`confirm` 时清空(删除该键)。
   * 不存路径、目录名、key:只有计数。
   */
  armed_listing: z
    .strictObject({
      at: IsoTimestampSchema,
      policy_fp: Sha256Schema,
      agents: z.array(RsiAgentSchema).min(1).refine(sortedUnique, '升序且不重复'),
      projects: NonNegInt,
      excluded: NonNegInt,
      unknown_sessions: NonNegInt,
    })
    .optional(),
  /**
   * §21 W0-7(R21-10.2 / R21-10.3):`auto_pause`。**可选**——缺失 = 无熔断、无分叉、无属主变更(旧 `state.json` 照常通过);
   * 出现但非法(类型错、未知原因码、重复原因码)一律拒绝,不归零恢复。所有 `state.json` 写入方必须保留此键。
   */
  auto_pause: z
    .strictObject({
      reasons: z
        .array(RsiAutoPauseReasonSchema)
        .refine((a) => new Set(a).size === a.length, '不得重复'),
      diverged: z.boolean(),
      owner_changed: z.boolean(),
    })
    .optional(),
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

/** salvage 形态的三个阶段(R20-A2 B5 Q-A:journal 不合规时的可重入出路;阶段表见 B5 方案 §0.5 R1) */
export const RSI_SALVAGE_PHASES = Object.freeze(['planned', 'tainted', 'done'] as const);

const PurgeTaintTargetsSchema = z.strictObject({
  runs: z.array(RunIdSchema).refine(sortedUnique, '升序且不重复'),
  promotes: z.array(RunIdSchema).refine(sortedUnique, '升序且不重复'),
});

/**
 * `.state/rsi/purge-journal.json`:续做一律按这里**已记下的**集合,不重新从信号库推导。
 * R20-A2 B5-0(Q-A):判别联合 purge | salvage(判别字段 `mode`)。
 *  - purge:原有形态;`mode` 缺省为 `'purge'`(B5 之前写下的老文件没有该字段,仍合法);
 *  - salvage:journal 不合规时由 `purge --resume --write` 原子替换成的合法形态,`keys` 恒为空,`taint_targets` 是全部暂存 run / promote;
 *    老版本 kit 读到它会过不了 strict schema → 判 invalid(fail-closed,安全一侧)。
 * 任何其它形态(未知 `mode`、两种形态的字段混用、salvage 的 `keys` 非空 / `phase` 越界)一律不合规。
 */
export const RsiPurgeJournalSchema = z.preprocess(
  // 老文件没有 `mode`:仅当键**不存在**时补 `'purge'`(显式写了 `mode` 的一律原样交给判别联合;`null` / 未知值照旧不合规)
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !Object.prototype.hasOwnProperty.call(v, 'mode')
      ? { ...(v as Record<string, unknown>), mode: 'purge' }
      : v,
  z.discriminatedUnion('mode', [
    z.strictObject({
      schema_version: z.literal(1),
      created_at: IsoTimestampSchema,
      mode: z.literal('purge'),
      phase: z.enum(RSI_PURGE_PHASES),
      keys: z.array(RsiProjectKeySchema).min(1).refine(sortedUnique, '升序且不重复'),
      taint_targets: PurgeTaintTargetsSchema,
    }),
    z.strictObject({
      schema_version: z.literal(1),
      created_at: IsoTimestampSchema,
      mode: z.literal('salvage'),
      phase: z.enum(RSI_SALVAGE_PHASES),
      keys: z.array(RsiProjectKeySchema).max(0),
      taint_targets: PurgeTaintTargetsSchema,
    }),
  ]),
);
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

/**
 * `log.jsonl` 行的触发源(R20-7.1;A6 订正 #1 追加 `notice`)。只用于日志行:`state.json` 的 `last_tick.trigger` 仍用 {@link RSI_TRIGGERS},
 * 不因此放宽(提醒不是 tick)。
 */
export const RSI_LOG_TRIGGERS = Object.freeze([...RSI_TRIGGERS, 'notice'] as const);
/** 提醒放弃时日志行的 `code`(A6 订正 #1;`trigger=notice`、`action=skipped`) */
export const RSI_NOTICE_LOG_CODES = Object.freeze([
  'locked',
  'over_budget',
  'write_failed',
  'not_eligible',
  'internal',
] as const);
export type RsiNoticeLogCode = (typeof RSI_NOTICE_LOG_CODES)[number];
/** 同一 `code` 的提醒放弃日志在此窗口内只记一行(防刷屏,A6 订正 #1) */
export const RSI_NOTICE_LOG_DEDUP_MS = 30 * 60 * 1000;
/** 提醒去重时读 `log.jsonl` 的字节上限(R20-6.7:200 行 × 1 KiB 之外留余量) */
export const RSI_NOTICE_LOG_READ_MAX_BYTES = 256 * 1024;

/** `rsi status` 的 `gc_plan_error`(A6 订正 #1):GC 计划失败的子码,由 `ReflectGcError.code` 白名单映射,未知 → `internal` */
export const RSI_GC_PLAN_ERRORS = Object.freeze([
  'reference_scan_failed',
  'root_unreadable',
  'root_not_real_dir',
  'internal',
] as const);
export type RsiGcPlanError = (typeof RSI_GC_PLAN_ERRORS)[number];

/** `.state/rsi/log.jsonl` 的一行(R20-7.1):不含路径、key、目录名、会话 id、摘录、异常消息 */
export const RsiLogLineSchema = z.strictObject({
  at: IsoTimestampSchema,
  trigger: z.enum(RSI_LOG_TRIGGERS),
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
  // R20-A4(R20-16.5 `--json` 必填;R20-16.14 `--digest` / `--owner` 必填):契约未写具体码,按既有 `missing:--agent` 的写法登记,待主代理并入总表
  'missing:--json',
  'missing:--digest',
  'missing:--owner',
  // §21 W0-12(R21-12.9)
  'bad_date',
  'unknown_id',
  'bad_marker',
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
/**
 * `rsi status` 的 `warnings` 取值(现算;B5-0 起集中登记,原先是 `status.ts` 里的裸字符串)。`index_rebuild_required`(Q-C)由 B5a 在 `status.ts` 接线,
 * 同时文本模式追加一行 `next=rebuild_index`({@link RSI_STATUS_NEXT_REBUILD})。
 */
export const RSI_STATUS_WARNINGS = Object.freeze([
  'overlay_absent',
  'cloud_sync_suspected',
  'index_full',
  'breaker_open',
  'index_rebuild_required',
  // R20-A6(R20-17.4a / R20-17.18)
  'run_scan_truncated',
  'run_scan_budget',
  'dismissed_invalid',
  'notice_invalid',
  'notice_full',
  'gc_plan_failed',
] as const);
export type RsiStatusWarning = (typeof RSI_STATUS_WARNINGS)[number];
/** `rsi status` 文本模式「下一步」行的固定枚举词(`next=<词>`;不含路径) */
export const RSI_STATUS_NEXT_REBUILD = 'rebuild_index';
/** `rsi status` 的 `lock:` 行取值(D7:追加 `unsafe`) */
export const RSI_LOCK_STATES = Object.freeze([
  'free',
  'held',
  'held_over_ttl',
  'stale',
  'unsafe',
] as const);

// ---------------------------------------------------------------------------
// 命令分发与命令桩(B3-0)
// ---------------------------------------------------------------------------
/**
 * 命令桩的 stderr 稳定码(退出 64,§7)。**只属于桩**,不是 R20-3.0 总表里的正式 RSI 码,也不进 `RSI_*_REASONS` 枚举:
 * 子命令一旦实装,这个码就不会再出现。格式固定为 `RSI_NOT_IMPLEMENTED subcommand=<规范名>\n`。
 */
export const RSI_STUB_CODE = 'RSI_NOT_IMPLEMENTED';
/** P0 子命令(R20-3.1 ~ R20-3.8、R20-6.1;`poke` / `hint` 是钩子专用入口) */
export const RSI_SUBCOMMANDS = Object.freeze([
  'tick',
  'status',
  'projects',
  'confirm',
  'stop',
  'purge',
  'poke',
  'hint',
  /** R20-A4:`rsi digest`(会话授权下的脱敏摘要) */
  'digest',
  /** R20-A5:`rsi session --print`(可粘贴的 `[rsi.session]` 配置)与 `rsi hooks`(kit 钩子写入,§20.15) */
  'session',
  'hooks',
  /** R20-A6:`rsi dismiss`(R20-17.5) */
  'dismiss',
] as const);
/** P1 预留子命令(§20.3 末段):注册为命令桩,退出 64;不建入口文件。A6 起 `dismiss` 已是真子命令 */
export const RSI_P1_RESERVED_SUBCOMMANDS = Object.freeze(['should-continue'] as const);

// ---------------------------------------------------------------------------
// A4(会话授权、`rsi digest`、`reflect --ingest`;docs/contracts.md §20.16)
// ---------------------------------------------------------------------------
/** R20-16.21:顶层码。`RSI_SESSION_DENIED` 退出 4、`RSI_DIGEST_REJECTED` 退出 3(其余 A4 顶层码在 {@link RSI_EXIT1_CODES}) */
export const RSI_SESSION_DENIED = 'RSI_SESSION_DENIED';
export const RSI_DIGEST_REJECTED = 'RSI_DIGEST_REJECTED';
/** `RSI_DIGEST_REJECTED reason=`(R20-16.11 ①) */
export const RSI_DIGEST_REJECT_REASONS = Object.freeze(['rescan_hit', 'output_leak'] as const);
/** R20-16.3:会话授权的非 `ok` 判定,即 `RSI_SESSION_DENIED reason=` 的封闭集合 */
export const RSI_SESSION_REASONS = Object.freeze([
  'off',
  'invalid',
  'expired',
  'agent_not_authorized',
] as const);
export type RsiSessionReason = (typeof RSI_SESSION_REASONS)[number];
/** R20-16.3 ④:`expires` 至多是今天 + 90 天 */
export const RSI_SESSION_MAX_DAYS = 90;

const uniqueItems = (a: readonly string[]): boolean => new Set(a).size === a.length;

/**
 * `[rsi.session]` 的 L-session 层(R20-16.2;strictObject,只做静态校验)。有效期范围与「`agents` ⊆ `[rsi] agents`」属 R20-16.3 的第二阶段判定,不在这里。
 * `auto` 缺省 `s1`;A4 只校验、不消费。L-base 的 `RsiBaseSchema.session` 占位保持不变。
 */
export const RsiSessionSchema = z.strictObject({
  enabled: z.boolean(),
  agents: z.array(RsiAgentSchema).min(1).refine(uniqueItems, '不得重复'),
  expires: IsoDateSchema,
  auto: z.enum(['s1', 's2']).default('s1'),
});
export type RsiSession = z.infer<typeof RsiSessionSchema>;

// --- digest(R20-16.5 ~ R20-16.13) ---
export const RSI_DIGEST_SLOT_COUNT = 20;
/** digest 24 小时过期(R20-16.12) */
export const RSI_DIGEST_TTL_MS = 24 * 60 * 60_000;
/** 预留超过这么久仍未发布即可被清理(R20-16.10 ①) */
export const RSI_DIGEST_RESERVE_TTL_MS = 10 * 60_000;
/** 槽位锁获取:最多等 2 秒,每 50ms 试一次(R20-16.10) */
export const RSI_DIGEST_LOCK_WAIT_MS = 2000;
export const RSI_DIGEST_LOCK_POLL_MS = 50;
/** digest 输出上限、簇数、每簇摘录数(R20-16.8) */
export const RSI_DIGEST_MAX_BYTES = 48 * 1024;
export const RSI_DIGEST_MAX_CLUSTERS = 5;
export const RSI_DIGEST_MAX_EVIDENCE_PER_CLUSTER = 8;
/** 槽位文件 / 名额文件读取上限(R20-16.13、R20-16.15 第 4 步) */
export const RSI_DIGEST_FILE_MAX_BYTES = 64 * 1024;
/** digest 的 `reason`(R20-16.9) */
export const RSI_DIGEST_REASONS = Object.freeze([
  'ok',
  'no_project',
  'project_excluded',
  'attribution_unknown',
  'no_clusters',
] as const);
export type RsiDigestReason = (typeof RSI_DIGEST_REASONS)[number];
/**
 * 摘录的固定不可信标记(设计稿 §8a.5;R20-16.9)。摘录原样放在两个标记之间;含标记文本本身的摘录不会进入 digest(丢弃该条证据),
 * 所以标记之间的内容不可能伪造闭合标记。
 */
export const RSI_EXCERPT_MARK_OPEN = '<untrusted-excerpt>';
export const RSI_EXCERPT_MARK_CLOSE = '</untrusted-excerpt>';
/**
 * digest 组装时的路径中和占位(A4 订正 #8,R20-16.11-a):摘录里的 HOME 绝对路径前缀 → `~`,仓库根 → `<repo>`,状态目录 → `<state>`,`KIT_TMP` → `<kit_tmp>`。
 * 占位文本里不含任何绝对路径,不会再触发路径泄漏闸。
 */
export const RSI_DIGEST_PATH_PLACEHOLDERS = Object.freeze({
  home: '~',
  repo: '<repo>',
  state: '<state>',
  kit_tmp: '<kit_tmp>',
} as const);
export type RsiDigestPathLabel = keyof typeof RSI_DIGEST_PATH_PLACEHOLDERS;

export const RsiDigestIdSchema = z.string().regex(/^d_[0-9a-f]{16}$/);
export const RsiDigestAliasSchema = z.string().regex(/^e[1-9][0-9]{0,2}$/);
/** 槽位里的 digest 记录(R20-16.13);`project_key` 为 null = cwd 解析不出(`no_project`) */
export const RsiDigestRecordSchema = z.strictObject({
  digest_id: RsiDigestIdSchema,
  created_at: IsoTimestampSchema,
  expires_at: IsoTimestampSchema,
  agent: RsiAgentSchema,
  project_key: RsiProjectKeySchema.nullable(),
  aliases: z
    .record(RsiDigestAliasSchema, z.string().regex(/^sig_[0-9a-f]{16}$/))
    .refine(
      (r) => Object.keys(r).length <= RSI_DIGEST_MAX_CLUSTERS * RSI_DIGEST_MAX_EVIDENCE_PER_CLUSTER,
      '别名条数超过上限',
    ),
  session_policy_fp: Sha256Schema,
  snapshot_generation: NonNegInt,
});
export type RsiDigestRecord = z.infer<typeof RsiDigestRecordSchema>;
/** 槽位里的预留文件(R20-16.10 ①) */
export const RsiDigestReservationSchema = z.strictObject({
  reserved: z.string().regex(/^[0-9a-f]{16}$/),
  at: IsoTimestampSchema,
});
export type RsiDigestReservation = z.infer<typeof RsiDigestReservationSchema>;
/** 槽位文件名(R20-16.10:`digests/` 下只有这些合法文件名) */
export const RSI_DIGEST_SLOT_NAME_RE = /^s(0[0-9]|1[0-9])\.json$/;
export const slotName = (n: number): string => `s${String(n).padStart(2, '0')}.json`;

// --- ingest(R20-16.14 ~ R20-16.17) ---
export const RSI_INGEST_MAX_STDIN_BYTES = 64 * 1024;
export const RSI_INGEST_MAX_PROPOSALS = 5;
/** 每个声明的 agent 每 UTC 日 ≤ 5 次、全局 ≤ 10 次(R20-16.15 第 4 步;订正 #9 由 2 / 4 提到 5 / 10) */
export const RSI_INGEST_QUOTA_PER_AGENT = 5;
export const RSI_INGEST_QUOTA_GLOBAL = 10;
/** 名额日文件(R20-16.15 第 4 步):`.state/rsi/ingest-quota/<YYYY-MM-DD>.json` */
export const RsiIngestQuotaSchema = z.strictObject({
  schema_version: z.literal(1),
  /** 当日全局已预留次数(≤ {@link RSI_INGEST_QUOTA_GLOBAL}) */
  total: NonNegInt,
  agents: z.strictObject({
    claude: NonNegInt.optional(),
    codex: NonNegInt.optional(),
    pi: NonNegInt.optional(),
  }),
});
export type RsiIngestQuota = z.infer<typeof RsiIngestQuotaSchema>;

/**
 * R20-16.17:`g0_<子码>` 的封闭集合 = ingest 拒绝 `reason`(落实 R21-12.9「A4 落地时登记」)。
 * 顺序照契约;`RSI_INGEST_REJECTED reason=<子码>` 与 `--json` 的 `reason` 只取这个集合。
 */
export const RSI_INGEST_REJECT_REASONS = Object.freeze([
  'digest_invalid',
  'digest_expired',
  'digest_agent_mismatch',
  'digest_policy_changed',
  'too_many_proposals',
  'alias_unknown',
  'evidence_stale',
  'project_excluded',
  'attribution_unknown',
  'output_too_large',
  'not_json_object',
  'schema_invalid',
  'placeholder_in_output',
  'output_residual',
  'hidden_chars_in_output',
  'injection_suspected_local',
  'id_conflict',
  'pattern_unsafe',
  'echo_detected',
  'duplicate',
  'path_guard',
  'rescan_hit',
  'policy_changed',
] as const);
export type RsiIngestRejectReason = (typeof RSI_INGEST_REJECT_REASONS)[number];
/** `--json` 的 `result`(R20-16.16) */
export const RSI_INGEST_RESULTS = Object.freeze(['ok', 'rejected', 'not_run'] as const);

/**
 * validator(`src/reflect/validate.ts`)的拒绝 `code` → 子码的**显式映射表**(R20-16.17)。同名原样映射。
 * 单测钉死「validator 的全部拒绝 code 都在这里、映射值都属于 {@link RSI_INGEST_REJECT_REASONS}」;运行时遇到未登记的值映射为 `schema_invalid`(兜底,不替代静态覆盖)。
 */
export const VALIDATOR_CODE_TO_REJECT: Readonly<Record<string, RsiIngestRejectReason>> =
  Object.freeze({
    output_too_large: 'output_too_large',
    not_json_object: 'not_json_object',
    schema_invalid: 'schema_invalid',
    placeholder_in_output: 'placeholder_in_output',
    output_residual: 'output_residual',
    hidden_chars_in_output: 'hidden_chars_in_output',
    injection_suspected_local: 'injection_suspected_local',
  });
/** validator 的 `dropped` 类别 → 子码(严格批次下任一类别计数非零即整批拒;`evidence_alias_unknown → alias_unknown`) */
export const VALIDATOR_DROPPED_TO_REJECT: Readonly<Record<string, RsiIngestRejectReason>> =
  Object.freeze({
    evidence_alias_unknown: 'alias_unknown',
    id_conflict: 'id_conflict',
    pattern_unsafe: 'pattern_unsafe',
    echo_detected: 'echo_detected',
  });

/** 暂存区容量(R20-6.7 / R20-16.15 第 2、11 步):50 个 run / 50MiB(按现有 `.state/reflect/` 计) */
export const RSI_STAGING_MAX_RUNS = 50;
export const RSI_STAGING_MAX_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// A6(待审判定、提醒一次、`rsi dismiss`;docs/contracts.md §20.17)
// ---------------------------------------------------------------------------
/** R20-17.4:`reflect/` 直接子项上限与单次扫描总读取上限、单个 `report.json` 上限 */
export const RSI_SCAN_MAX_ENTRIES = 1000;
export const RSI_SCAN_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const RSI_SCAN_MAX_REPORT_BYTES = 1024 * 1024;
/** R20-17.8 / R20-17.14:`dismissed.json` 与 `notice.json` 的条数上限、读取字节上限 */
export const RSI_DISMISSED_MAX = 1000;
export const RSI_NOTICE_MAX = 1000;
/** 读取字节上限须容得下写出的最大合法形状(1000 条 × 最长 64 字符 run_id + 时间戳 + canonical 缩进 < 400 KiB) */
export const RSI_ACCOUNT_FILE_MAX_BYTES = 1024 * 1024;
/** `notice.json` 读取形状可超过写出上限(R20-17.14a:原文件 > 1000 条但清理后不超限不是 full),读取侧条数上限 */
export const RSI_NOTICE_READ_MAX = 20000;
/** R20-17.15:提醒的尽力预算 */
export const RSI_NOTICE_BUDGET_MS = 200;
/** R20-17.17:暂存区达到 run 上限时 hint 的单行输出(不暗示 dismiss 能释放容量) */
export const RSI_HINT_STAGING_FULL_LINE = `agent-kit RSI: 暂存区已达 ${RSI_STAGING_MAX_RUNS} 个 run 上限,新提案会被拒收;详情见 agent-kit rsi status`;
/** R20-17.10 `rsi dismiss --json` 的 `result` */
export const RSI_DISMISS_RESULTS = Object.freeze(['dry', 'dismissed', 'unchanged'] as const);

const sortedUniqueIds = (a: readonly string[]): boolean =>
  a.every((x, i) => i === 0 || (a[i - 1] as string) < x);

/** `.state/rsi/dismissed.json`(R20-17.8):按 run_id 升序、唯一、≤ 1000 */
export const RsiDismissedSchema = z
  .strictObject({
    schema_version: z.literal(1),
    runs: z
      .array(z.strictObject({ run_id: RunIdSchema, at: IsoTimestampSchema }))
      .max(RSI_DISMISSED_MAX),
  })
  .refine((d) => sortedUniqueIds(d.runs.map((r) => r.run_id)), 'runs 须按 run_id 升序且唯一');
export type RsiDismissed = z.infer<typeof RsiDismissedSchema>;

/** `.state/rsi/notice.json`(R20-17.14) */
export const RsiNoticeSchema = z
  .strictObject({
    schema_version: z.literal(1),
    proposals_notified: z.array(RunIdSchema).max(RSI_NOTICE_MAX),
    collection_started_for: z.string().min(1).max(64).nullable(),
  })
  .refine((d) => sortedUniqueIds(d.proposals_notified), 'proposals_notified 须升序且唯一');
export type RsiNotice = z.infer<typeof RsiNoticeSchema>;
/** 读取形状:条数上限放宽到 {@link RSI_NOTICE_READ_MAX}(其余同写出形状);提交前由写入方清理为 ≤ 1000 */
export const RsiNoticeReadSchema = z
  .strictObject({
    schema_version: z.literal(1),
    proposals_notified: z.array(RunIdSchema).max(RSI_NOTICE_READ_MAX),
    collection_started_for: z.string().min(1).max(64).nullable(),
  })
  .refine((d) => sortedUniqueIds(d.proposals_notified), 'proposals_notified 须升序且唯一');

// ---------------------------------------------------------------------------
// §21 W0:常量、枚举与码表(docs/contracts.md §21.24;统计常量 / 闸词表 / 上限 / 保留期全部是代码常量,不可配置)
// ---------------------------------------------------------------------------
/** 判定开关(R21-7.9):V1a / V1b / V1.5 恒为假;V2 的契约修订才置真。为假时 canary 只会经回滚走向 `rolled_back` 或 `expired` */
export const RSI_DECIDE_BETTER_ENABLED = false;

/** 相位名 → 整数(R21-0.1) */
export function phaseIndex(name: RsiAutoPhaseName): number {
  return RSI_AUTO_PHASE_ORDER.indexOf(name);
}
/** 所有阶段判断经此函数(W0-1);`phase` 缺省取当前 {@link RSI_AUTO_PHASE},测试可注入 */
export function phaseAtLeast(name: RsiAutoPhaseName, phase: number = RSI_AUTO_PHASE): boolean {
  return phase >= phaseIndex(name);
}

/**
 * 能力的最早可用期(W0-1 表 (2);默认拒绝:不在表里 = 尚未到期)。`docs/contracts.md` §21.24 的同名表与本常量由测试双向比对。
 */
export const RSI_CAPABILITY_PHASE: Readonly<Record<string, RsiAutoPhaseName>> = Object.freeze({
  repo_bootstrap: 'V1a',
  candidate_create: 'V1a',
  gates_g0_g7: 'V1a',
  shadow_count: 'V1a',
  transition_proposed_to_shadow: 'V1a',
  transition_to_rejected: 'V1a',
  transition_shadow_to_expired: 'V1a',
  revocation_credentials: 'V1a',
  cmd_auto_status: 'V1a',
  cmd_auto_pause: 'V1a',
  cmd_auto_resume: 'V1a',
  cmd_auto_clear: 'V1a',
  cmd_auto_rebase_baseline: 'V1a',
  cmd_veto: 'V1a',
  cmd_report: 'V1a',
  cmd_show: 'V1a',
  hint_weekly_line: 'V1a',
  transition_shadow_to_canary: 'V1b',
  transition_canary_to_rolling_back: 'V1b',
  transition_rolling_back_to_terminal: 'V1b',
  deploy_none_to_injected: 'V1b',
  deploy_removal_pending: 'V1b',
  hint_canary: 'V1b',
  admission_probe: 'V1b',
  canary_ledger: 'V1b',
  harm_test: 'V1b',
  rollback_four_phase: 'V1b',
  revocation_reconcile_grants: 'V1b',
  cmd_rollback_to: 'V1b',
  transition_canary_to_adopted: 'V2',
  decide_better: 'V2',
  local_payload: 'V2',
});
/** 能力是否已到期;表里没有的能力(含原型链上的键)一律 false(默认拒绝) */
export function capabilityAvailable(key: string, phase: number = RSI_AUTO_PHASE): boolean {
  // 普通对象有原型链(`toString` / `constructor` / `__proto__` 不是 undefined):只认自有键,阶段解析失败(-1)也拒绝
  if (!Object.hasOwn(RSI_CAPABILITY_PHASE, key)) return false;
  const need = RSI_CAPABILITY_PHASE[key];
  if (need === undefined || phaseIndex(need) < 0) return false;
  return phaseAtLeast(need, phase);
}

/** 熔断码的最早期(R21-10.2 的「期」列经 W0-1 订正:`rollback_storm` 属 V1b) */
export const RSI_AUTO_PAUSE_REASON_PHASE: Readonly<Record<RsiAutoPauseReason, RsiAutoPhaseName>> =
  Object.freeze({
    rollback_storm: 'V1b',
    gate_internal: 'V1a',
    apply_failed: 'V2',
    personal_repo_invalid: 'V1a',
    budget_high_legacy: 'V1a',
    cost_high_legacy: 'V1a',
    no_observation: 'V1a',
    redaction_changed: 'V1a',
    user_vetoes: 'V1a',
    kit_major_changed: 'V1a',
    user_paused: 'V1a',
    isolation_unverified: 'V6b',
  });

/** 顶层(4)码:`rsi exec-run` / `exec-prepare` 未运行(R21-12.9;V6a 起发码) */
export const RSI_EXEC_NOT_RUN = 'RSI_EXEC_NOT_RUN';

/** R21-1.9 展示标签 */
export const RSI_AUTO_LABEL = '自动产出、未经人工核验';
/** R21-6.3 关联标记行前缀(标记行 = 前缀 + 空格 + `rsm_` + 16 位十六进制,≤ 64 字节) */
export const RSI_MARK_PREFIX = 'agent-kit RSI 关联标记:';
export const RsiMarkerSchema = z.string().regex(/^rsm_[0-9a-f]{16}$/);

// --- R21-7.1 统计常量 ---
export const RSI_MIN_SESSIONS_PER_ARM = Object.freeze({ lite: 20, medium: 20, heavy: 30 } as const);
export const RSI_MIN_CONTROL_EVENTS = 15;
/** 待 V1.5 校准 */
export const RSI_MIN_CONTROL_EVENTS_C3 = 30;
export const RSI_MAX_RR_CI_WIDTH = 0.6;
export const RSI_MAX_SESSIONS_PER_ARM = 120;
export const RSI_MAX_CANARY_DAYS = 90;
export const RSI_PERMUTATIONS = 2000;
export const RSI_ALPHA_BETTER = 0.05;
export const RSI_RR_BETTER_UPPER = 0.7;
export const RSI_ALPHA_WORSE_TOTAL = 0.1;
export const RSI_ALPHA_BETTER_LOOK = 0.025;
export const RSI_LOOK_EVERY = 10;
export const RSI_TOOLCALL_DROP_SUSPECT = 0.4;
export const RSI_ANALYSIS_PLAN_VERSION = 1;
/** 保护指标界限(待 V1.5 校准;边界一律:非劣效 = 上界严格小于界限) */
export const RSI_PROTECT_BOUNDS = Object.freeze({
  c1_rr: 1.15,
  c2_gmr: 1.15,
  c3_rr: 1.25,
  c4_canary_bytes: 1536,
  c5_rr: 1.15,
  c6_pp: 5,
} as const);
/** canary 期随机概率(R21-6.2);adopted 期 0.8 / 0.2 属 V2 */
export const RSI_CANARY_P = 0.5;
/** R21-6.3 / M11:标记行 + treat 追加部分 ≤ 1536 字节;hint 总输出(计数行 200 + 1536)≤ 1736 */
export const RSI_CANARY_INJECT_MAX_BYTES = 1536;
export const RSI_HINT_CANARY_TOTAL_MAX_BYTES = 1736;

// --- W0-2 / W0-3 / W0-9 常量 ---
/** 教训类签名的 token Jaccard 下限(= `src/reflect/cluster.ts` 的 `DEFAULT_LESSON_JACCARD`,测试钉住两者相等) */
export const RSI_LESSON_JACCARD = 0.5;
export const RSI_SIGNATURE_MAX_TOKENS = 32;
/** 自动探针准入(W0-3) */
export const RSI_PROBE_SESSIONS = 3;
export const RSI_PROBE_WINDOW_DAYS = 7;
export const RSI_PROBE_QUIET_MINUTES = 60;
export const RSI_PROBE_WAIT_HOURS = 48;
/** W0-18:准入 `failed` 后满 N 个 UTC 日(日期差口径,W0-16),worker 自动重新 armed 下一代 */
export const RSI_PROBE_RETRY_DAYS = 7;
/** `revocations.jsonl` 上限(W0-9):超出按读取失败处理;> 一半时 `rsi auto status` 提示 */
export const RSI_REVOCATIONS_MAX_BYTES = 1024 * 1024;
export const RSI_REVOCATIONS_WARN_BYTES = 512 * 1024;
/** shadow 因名额被占排队的上限(V1i-9):30 个 UTC 日 */
export const RSI_SHADOW_QUEUE_MAX_DAYS = 30;
/** 候选 `transitions[]` 保留条数上限(R21-3.7) */
export const RSI_TRANSITIONS_MAX = 256;
/** shadow:有观测会话数与命中门槛(R21-4.1) */
export const RSI_SHADOW_MIN_SESSIONS = 20;
export const RSI_SHADOW_MIN_HITS = 2;
/** R21-11.1 冷却(UTC 日) */
export const RSI_COOLDOWN_DAYS = Object.freeze({
  auto_rollback: 90,
  expired: 30,
  rejected_streak: 7,
} as const);
export const RSI_COOLDOWN_REJECT_STREAK = 5;
/** R21-12.10 审计保留 */
export const RSI_AUDIT_RETENTION_DAYS = 365;
export const RSI_AUDIT_MAX_LINES = 20000;
/** R21-5.1 G5:规则 / 踩坑单条上限(字节) */
export const RSI_ATOM_MAX_BYTES = 600;

// --- 候选状态机枚举(R21-3.7 / R21-4.1 / R21-4.2 / R21-4.6) ---
export const RsiCandidateIdSchema = z.string().regex(/^ra_[0-9a-f]{12}$/);
export const RSI_CANDIDATE_CATEGORIES = Object.freeze([
  'rule',
  'pitfall',
  'method',
  'subagent',
  'capability_note',
  'exec',
] as const);
export const RSI_LIFECYCLE_STATES = Object.freeze([
  'proposed',
  'shadow',
  'blocked',
  'canary',
  'adopted',
  'stable',
  'retiring',
  'rolling_back',
  'rejected',
  'expired',
  'rolled_back',
  'retired',
] as const);
export type RsiLifecycleState = (typeof RSI_LIFECYCLE_STATES)[number];
export const RSI_DEPLOY_STATES = Object.freeze([
  'none',
  'injected',
  'static_pending',
  'static',
  'withdraw_pending',
  'removal_pending',
] as const);
export type RsiDeployState = (typeof RSI_DEPLOY_STATES)[number];
/** R21-6.8 `watch.result` 唯一封闭枚举 */
export const RSI_WATCH_RESULTS = Object.freeze([
  'not_started',
  'pending',
  'passed',
  'withdrawn_residual',
  'withdrawn_ended',
  'skipped',
  'harm',
] as const);
/** R21-4.6 终态理由(含 N4-2 的 `judge_rejected`);数组顺序即 R21-4.4a 的优先级(靠前者高) */
export const RSI_TERMINAL_REASONS = Object.freeze([
  'vetoed',
  'tainted',
  'cleared',
  'judge_rejected',
  'auto_rollback',
  'static_sync_timeout',
  'auto_expired',
  'no_hit',
  'rejected_gate',
] as const);
/** R21-4.4a `target_terminal` 优先级(靠前者高;只升不降) */
export const RSI_TARGET_TERMINALS = Object.freeze([
  'rolled_back',
  'retired',
  'expired',
  'shadow',
] as const);
/** R21-4.6 ① 正常转移原因码 */
export const RSI_TRANSITION_REASONS_NORMAL = Object.freeze([
  'ingested',
  'gates_passed',
  'shadow_hits_met',
  'evidence_ready',
  'decided_better',
  'holdout_passed',
  'deploy_injected',
  'static_released',
  'sync_ok',
  'withdraw_done',
  'residual_ended',
  'exec_enabled',
  'exec_unrestricted',
  'compensation_done',
  'revocation_reconciled',
  'retire_done',
] as const);
/** R21-5.1 G1–G8 原因码(G0 = `g0_<ingest 拒绝子码>`,见 {@link rsiG0Reasons}) */
export const RSI_GATE_REASONS = Object.freeze([
  'g1_phrase',
  'g1_invisible',
  'g1_redact',
  'g1_ctrl',
  'g1_skill',
  'g2_risky',
  'g2_kit_ref',
  'g2_project_feature',
  'g2_safety_atom',
  'g3_sessions',
  'g3_days',
  'g3_trigger',
  'g3_attribution',
  'g4_conflict',
  'g4_override',
  'g4_strength',
  'g4_near_dup',
  'g4_tombstone',
  'g4_cooldown',
  'g4_framework_path',
  'g4_tools_expanded',
  'g4_field_not_editable',
  'g4_skill_size',
  'g5_budget',
  'g5_quota',
  'g5_atom_bytes',
  'g5_inject_bytes',
  'g6_too_few',
  'g6_too_broad',
  'g7_queued',
  'g8_worse',
  'g8_dominated',
  'g8_timeout',
] as const);
/** G0 原因码 = `g0_` + ingest 拒绝子码(A4-1:封闭集合即 {@link RSI_INGEST_REJECT_REASONS}) */
export const rsiG0Reasons = (): string[] => RSI_INGEST_REJECT_REASONS.map((r) => `g0_${r}`);
/** R21-4.6 ② 终止 / 异常原因码(不含 G 码;`harm_<指标>` 只取 c1|c2|c3|c4|c6) */
export const RSI_HARM_METRICS = Object.freeze(['c1', 'c2', 'c3', 'c4', 'c6'] as const);
export const RSI_TRANSITION_REASONS_TERMINATING = Object.freeze([
  'harm_c1',
  'harm_c2',
  'harm_c3',
  'harm_c4',
  'harm_c6',
  'limit_reached',
  'vetoed',
  'tainted',
  'cleared',
  'identity_changed',
  'exec_post_check_failed',
  'exec_timeout_unclean',
  'static_sync_timeout',
  'withdraw_120',
  'no_hit',
  'judge_reject',
  'judge_injection',
] as const);

// --- 私有仓库 / journal / 回滚 / 撤销(R21-3.6a / R21-9.1 / R21-9.5) ---
/** R21-3.6a `kind`;W0-5 追加 `bootstrap` */
export const RSI_COMMIT_KINDS = Object.freeze([
  'transition',
  'rollback',
  'clear',
  'purge_rewrite',
  'reconcile',
  'identity_change',
  'bootstrap',
] as const);
/** R21-3.6a 五个 phase */
export const RSI_COMMIT_PHASES = Object.freeze([
  'planned',
  'objects_written',
  'ref_updated',
  'worktree_synced',
  'recorded',
] as const);
/** W0-5 bootstrap 四个 phase */
export const RSI_BOOTSTRAP_PHASES = Object.freeze([
  'planned',
  'initialized',
  'committed',
  'recorded',
] as const);
/** R21-9.1 回滚子状态 */
export const RSI_ROLLBACK_PHASES = Object.freeze([
  'rollback_requested',
  'injection_disabled',
  'static_removal_pending',
  'rollback_complete',
] as const);
export const RSI_REVOCATION_BY = Object.freeze([
  'worker',
  'clear',
  'rollback_to',
  'veto',
  'exec_event',
] as const);
/**
 * W0-17:撤销凭据 `reason` 按写入方 `by` 约束(只取终止 / 异常原因码;正常转移码、G 码一律拒绝;
 * `identity_changed` 不写凭据,R21-9.1)。`rollback_to` 的专属原因码契约未定(归 W7),暂允许全部回滚原因。
 */
const RSI_ROLLBACK_REVOCATION_REASONS = RSI_TRANSITION_REASONS_TERMINATING.filter(
  (r) => r !== 'identity_changed',
);
export const RSI_REVOCATION_REASONS_BY: Readonly<
  Record<(typeof RSI_REVOCATION_BY)[number], readonly string[]>
> = Object.freeze({
  clear: Object.freeze(['cleared']),
  veto: Object.freeze(['vetoed']),
  exec_event: Object.freeze(['exec_post_check_failed', 'exec_timeout_unclean']),
  worker: Object.freeze(
    RSI_ROLLBACK_REVOCATION_REASONS.filter(
      (r) => !['cleared', 'vetoed', 'exec_post_check_failed', 'exec_timeout_unclean'].includes(r),
    ),
  ),
  rollback_to: Object.freeze([...RSI_ROLLBACK_REVOCATION_REASONS]),
});

// --- 分组账 / 准入(R21-6.4 / W0-3) ---
export const RSI_LEDGER_ARMS = Object.freeze(['treat', 'control', 'excluded'] as const);
/** `excluded` 行的 `reason`;W0-3 追加 `admission_probe` */
export const RSI_LEDGER_EXCLUDED_REASONS = Object.freeze([
  'paused',
  'not_admitted',
  'policy_mismatch',
  'agent_not_injected',
  'revoked',
  'rng_error',
  'permit_unreadable',
  'admission_probe',
] as const);
export const RSI_ADMISSION_STATES = Object.freeze(['probing', 'admitted', 'failed'] as const);
export const RSI_ADMISSION_FAIL_REASONS = Object.freeze([
  'marker_not_retrieved',
  'multi_marker',
  'probe_expired',
] as const);

// --- 审计(R21-12.10) ---
export const RSI_AUDIT_KINDS = Object.freeze([
  'transition',
  'sync',
  'evaluation',
  'exec_run',
  'contrib_result',
  'judge_signal',
  'reconcile',
  'pause',
  'bootstrap',
] as const);

// --- 配置(R21-2.1) ---
export const RSI_AUTO_PROFILES = Object.freeze(['lite', 'medium', 'heavy'] as const);
export const RSI_AUTO_EXEC_VALUES = Object.freeze(['off', 'host_after_trial'] as const);
/**
 * `[rsi.auto]`(L-auto 层,R21-2.1 / W0-9):`strictObject`;`enabled` 只接受布尔(字符串 `"true"` 失败);失败只禁自动生效(`auto: invalid`),
 * 不影响 `[rsi]` 本身(L-base 只验「表或缺省」)。`exec` 取值 V6a 之前可解析、无效果。
 */
export const RsiAutoSchema = z.strictObject({
  enabled: z.boolean().optional(),
  profile: z.enum(RSI_AUTO_PROFILES).optional(),
  exec: z.enum(RSI_AUTO_EXEC_VALUES).optional(),
});
export type RsiAuto = z.infer<typeof RsiAutoSchema>;

/** R21-12 子命令 → 能力键:对应能力未到期的子命令注册为命令桩(退出 64) */
export const RSI_AUTO_SUBCOMMAND_CAPS = Object.freeze({
  'auto status': 'cmd_auto_status',
  'auto pause': 'cmd_auto_pause',
  'auto resume': 'cmd_auto_resume',
  'auto clear': 'cmd_auto_clear',
  'auto rebase-baseline': 'cmd_auto_rebase_baseline',
  veto: 'cmd_veto',
  report: 'cmd_report',
  show: 'cmd_show',
  'rollback --to': 'cmd_rollback_to',
} as const);
