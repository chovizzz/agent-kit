/**
 * 自动 RSI 的契约常量(docs/contracts.md §20;R20-A0 起)。本节的数值全部是**不可配置的常量**(§20 开头)。
 * R20-A0 只落地与 RSI 状态无关、且先于其它块的那一个:单行 JSON 嵌套深度上限(§20.9 第 14 条 / R20-6.7)。
 * 稳定码枚举、其余上限常量由后续块(A1 起)在本文件追加,不要在别处另起一份。
 */
import { z } from 'zod';
import { IsoTimestampSchema, Sha256Schema } from './common.js';

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
