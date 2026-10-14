import { z } from 'zod';
import {
  KebabIdSchema,
  IsoTimestampSchema,
  RelPathSchema,
  RENDER_AGENT_IDS,
  RenderAgentIdSchema,
  SemverSchema,
  Sha256Schema,
} from './common.js';

/**
 * S0 追加(sync / doctor / update,docs/contracts.md §19)。
 * 本文件:HOME 写入表、sync 登记表(ledger)与事务(txn)的 schema、稳定码常量。
 */

// ---------------------------------------------------------------------------
// HOME_WRITE_TABLE:sync / update 经 `src/io/home-fs.ts`(S1)可写的 HOME 相对路径,写死,没有任何运行期扩展口。
// ---------------------------------------------------------------------------

export interface HomeWriteEntry {
  /** HOME 相对;`dir` 以 `/` 结尾(目录本身不可写,只能写计划里点名的、其内部的文件) */
  readonly path: string;
  readonly kind: 'file' | 'dir';
  /** adapter = 渲染产物落点(= `adapters/*\/managed-targets.json` 的并集);kit = 本套件自己的状态/安装目录 */
  readonly owner: 'adapter' | 'kit';
  /** 声明该落点的 adapter(owner=kit 为空) */
  readonly agents: readonly (typeof RENDER_AGENT_IDS)[number][];
}

/**
 * 与 `adapters/*\/managed-targets.json` 的并集一一对应(test/contracts/sync-update.test.ts 逐项核对,
 * 并集多一条或少一条都红),外加两个本套件目录。按 `path` 字节序升序。
 * 不在表内的一律不可写:`~/.claude/CLAUDE.md`、`settings*.json`、hooks、`~/.codex/config.toml`、
 * `~/.config/agent-kit/`(用户配置,只读)等。
 */
export const HOME_WRITE_TABLE: readonly HomeWriteEntry[] = [
  { path: '.agents/skills/', kind: 'dir', owner: 'adapter', agents: ['codex', 'kimi', 'pi'] },
  { path: '.claude/agents/', kind: 'dir', owner: 'adapter', agents: ['claude'] },
  { path: '.claude/rules/agent-kit/', kind: 'dir', owner: 'adapter', agents: ['claude'] },
  { path: '.claude/skills/', kind: 'dir', owner: 'adapter', agents: ['claude'] },
  { path: '.codex/AGENTS.md', kind: 'file', owner: 'adapter', agents: ['codex'] },
  { path: '.codex/agents/', kind: 'dir', owner: 'adapter', agents: ['codex'] },
  { path: '.config/opencode/AGENTS.md', kind: 'file', owner: 'adapter', agents: ['opencode'] },
  { path: '.kimi-code/AGENTS.md', kind: 'file', owner: 'adapter', agents: ['kimi'] },
  { path: '.kimi-code/agents/', kind: 'dir', owner: 'adapter', agents: ['kimi'] },
  { path: '.local/share/agent-kit/', kind: 'dir', owner: 'kit', agents: [] },
  { path: '.local/state/agent-kit/', kind: 'dir', owner: 'kit', agents: [] },
  { path: '.pi/agent/AGENTS.md', kind: 'file', owner: 'adapter', agents: ['pi'] },
];

/**
 * `rel`(HOME 相对)是否落在表内:`file` 条目要求完全相等;`dir` 条目要求严格位于其内部(目录本身不算);
 * adapter 的 `dir` 条目内部另禁点开头的路径段与 `.json` 结尾的文件。
 * 路径先过 `RelPathSchema`(拒绝 `..`、绝对路径、`~`、空段);`owner` 缺省时两类都算。
 * 纯字符串判断,不碰文件系统;符号链接、硬链接等由 home-fs 另行处理。
 */
export function isHomeWritePath(rel: string, owner?: HomeWriteEntry['owner']): boolean {
  if (!RelPathSchema.safeParse(rel).success) return false;
  return HOME_WRITE_TABLE.some((e) => {
    if (owner !== undefined && e.owner !== owner) return false;
    if (e.kind === 'file') return rel === e.path;
    if (!rel.startsWith(e.path) || rel.length <= e.path.length) return false;
    // adapter 目录内部:不碰点开头的条目(别的管理器的清单如 `.social-hub-skills.json`)与 `.json` 文件(没有注释语法,不能放托管块)。
    // 只检查目录以下的路径段,所以 `.claude/…` 这种 HOME 根下的点目录不受影响;kit 自己的状态目录(含 ledger.json)不适用。
    if (e.owner === 'adapter') {
      const rest = rel.slice(e.path.length);
      if (rest.split('/').some((seg) => seg.startsWith('.')) || rest.endsWith('.json'))
        return false;
    }
    return true;
  });
}

/** HOME 相对、且落在 HOME_WRITE_TABLE 的 adapter 条目内的受管路径(登记表 / 事务用)。 */
export const ManagedPathSchema = RelPathSchema.refine((p) => isHomeWritePath(p, 'adapter'), {
  message: '路径不在 HOME_WRITE_TABLE 的 adapter 条目内',
});

// ---------------------------------------------------------------------------
// 常量(§19)
// ---------------------------------------------------------------------------

/** `sync` 缺省的 agent 集合;kimi / opencode 要 `--agent` 显式指定(决策 ⑧)。 */
export const DEFAULT_SYNC_AGENTS = ['claude', 'codex', 'pi'] as const;
/** `sync` 的 `--agent` 可取值 = 有渲染目标的 agent;openclaw 不可取。 */
export const SYNC_AGENT_CHOICES = RENDER_AGENT_IDS;
/** 备份保留的最近事务个数 */
export const SYNC_BACKUPS_KEPT = 5;
/** 状态目录(HOME 相对) */
export const KIT_STATE_HOME_DIR = '.local/state/agent-kit/';
/** 安装目录(HOME 相对) */
export const KIT_SHARE_HOME_DIR = '.local/share/agent-kit/';

/** 事务 id:`txn-<UTC 时间戳>-<6 位十六进制>`,出现在文件名里。 */
export const TXN_ID_RE = /^txn-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const SyncTxnIdSchema = z.string().regex(TXN_ID_RE);

// ---------------------------------------------------------------------------
// SyncLedger:`~/.local/state/agent-kit/sync/ledger.json`
// ---------------------------------------------------------------------------

export const LEDGER_ENTRY_KINDS = ['owned', 'block'] as const;

export const SyncLedgerEntrySchema = z
  .strictObject({
    /** HOME 相对受管路径 */
    path: ManagedPathSchema,
    kind: z.enum(LEDGER_ENTRY_KINDS),
    /** owned:文件全文的哈希;block:块体的哈希 */
    sha256: Sha256Schema,
    /** kind=block 时必填,owned 时不得出现 */
    block_id: KebabIdSchema.optional(),
    /** 该文件是否由 sync 新建(卸载时据此决定删块后文件空了要不要删) */
    created_file: z.boolean(),
    /** 请求过该路径的 agent(共用路径如 `.agents/skills/…` 会有多个);非空、无重复 */
    agents: z.array(RenderAgentIdSchema).min(1),
    /** 最近一次写入这一条的事务 */
    txn: SyncTxnIdSchema,
  })
  .superRefine((e, ctx) => {
    if ((e.kind === 'block') !== (e.block_id !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['block_id'],
        message: 'block_id 必须且只能出现在 kind=block 的条目上',
      });
    }
    if (new Set(e.agents).size !== e.agents.length) {
      ctx.addIssue({ code: 'custom', path: ['agents'], message: 'agents 不得重复' });
    }
  });
export type SyncLedgerEntry = z.infer<typeof SyncLedgerEntrySchema>;

const entryKey = (e: { path: string; block_id?: string | undefined }): string =>
  `${e.path}\u0000${e.block_id ?? ''}`;

export const SyncLedgerSchema = z
  .strictObject({
    schema_version: z.literal(1),
    kit_version: SemverSchema,
    /** 上次成功 sync 的 payload manifest 哈希(`canonicalJson(PayloadManifest)` 的 sha256) */
    payload_sha256: Sha256Schema,
    /** 按 (path, block_id) 字节序严格升序,键唯一 */
    entries: z.array(SyncLedgerEntrySchema),
  })
  .superRefine((l, ctx) => {
    for (let i = 1; i < l.entries.length; i++) {
      const prev = entryKey(l.entries[i - 1] as SyncLedgerEntry);
      const cur = entryKey(l.entries[i] as SyncLedgerEntry);
      if (!(prev < cur)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i],
          message: 'entries 必须按 (path, block_id) 严格升序(排序且键唯一)',
        });
        break;
      }
    }
  });
export type SyncLedger = z.infer<typeof SyncLedgerSchema>;

// ---------------------------------------------------------------------------
// SyncTxn:`~/.local/state/agent-kit/sync/txn/<txn_id>.json`(存在即表示事务未收尾)
// ---------------------------------------------------------------------------

export const SYNC_OPS = ['create', 'update', 'remove', 'block_upsert', 'block_remove'] as const;
export const SyncOpSchema = z.enum(SYNC_OPS);
export type SyncOp = z.infer<typeof SyncOpSchema>;

export const SYNC_TXN_ACTIONS = ['sync', 'uninstall', 'adopt', 'rollback'] as const;
/** planned → backed_up(备份已落盘)→ writing(逐文件写)→ ledger_written(登记表已写,待删 txn 文件) */
export const SYNC_TXN_PHASES = ['planned', 'backed_up', 'writing', 'ledger_written'] as const;

export const SyncTxnOpSchema = z
  .strictObject({
    op: SyncOpSchema,
    path: ManagedPathSchema,
    block_id: KebabIdSchema.optional(),
    /** 整个文件写前 / 写后的哈希;null = 文件不存在 */
    file_sha256_before: Sha256Schema.nullable(),
    file_sha256_after: Sha256Schema.nullable(),
    /** 写前全文是否已备份到 `backups/<txn_id>/` */
    backup: z.boolean(),
    /** 本条是否覆盖了漂移文件(`--overwrite-drifted`) */
    overwrote_drifted: z.boolean().default(false),
    agents: z.array(RenderAgentIdSchema).min(1),
  })
  .superRefine((o, ctx) => {
    const bad = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const isBlock = o.op === 'block_upsert' || o.op === 'block_remove';
    if (isBlock !== (o.block_id !== undefined)) bad('block_id', '仅 block_* 操作带 block_id');
    const { file_sha256_before: before, file_sha256_after: after } = o;
    switch (o.op) {
      case 'create':
        if (before !== null) bad('file_sha256_before', 'create 的写前必须是 null');
        if (after === null) bad('file_sha256_after', 'create 的写后不得为 null');
        break;
      case 'update':
        if (before === null || after === null) bad('op', 'update 的写前写后都不得为 null');
        else if (before === after) bad('file_sha256_after', 'update 必须真的改变内容');
        break;
      case 'remove':
        if (before === null) bad('file_sha256_before', 'remove 的写前不得为 null');
        if (after !== null) bad('file_sha256_after', 'remove 的写后必须是 null');
        break;
      case 'block_upsert':
        if (after === null) bad('file_sha256_after', 'block_upsert 的写后不得为 null');
        else if (before === after) bad('file_sha256_after', 'block_upsert 必须真的改变内容');
        break;
      case 'block_remove':
        if (before === null) bad('file_sha256_before', 'block_remove 的写前不得为 null');
        break;
    }
    if (o.backup !== (before !== null)) {
      bad('backup', '写前文件存在(file_sha256_before 非 null)时必须备份,不存在时不得备份');
    }
    if (new Set(o.agents).size !== o.agents.length) bad('agents', 'agents 不得重复');
  });
export type SyncTxnOp = z.infer<typeof SyncTxnOpSchema>;

export const SyncTxnSchema = z
  .strictObject({
    schema_version: z.literal(1),
    txn_id: SyncTxnIdSchema,
    action: z.enum(SYNC_TXN_ACTIONS),
    /** action=rollback 时必填:被回滚的事务;其它动作不得出现 */
    rollback_of: SyncTxnIdSchema.optional(),
    kit_version: SemverSchema,
    /** action=sync / adopt 时必填(`--resume` 据此确认 payload 没变) */
    payload_sha256: Sha256Schema.optional(),
    /**
     * 写前登记表的整文件哈希;null = 写前没有登记表。写前登记表全文必须与 txn 描述一并保存在
     * `backups/<txn_id>/`(`ledger.before.json` 或「不存在」标记),成功后只删 active journal、不删这份备份,
     * 回滚才能同时恢复文件与所有权记录(§19.2)。
     */
    ledger_sha256_before: Sha256Schema.nullable(),
    started_at: IsoTimestampSchema,
    phase: z.enum(SYNC_TXN_PHASES),
    /** 按 (path, block_id) 字节序严格升序,键唯一;空事务不落盘 */
    ops: z.array(SyncTxnOpSchema).min(1).max(1000),
  })
  .superRefine((t, ctx) => {
    if ((t.action === 'rollback') !== (t.rollback_of !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['rollback_of'],
        message: 'rollback_of 必须且只能出现在 action=rollback 上',
      });
    }
    if ((t.action === 'sync' || t.action === 'adopt') && t.payload_sha256 === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload_sha256'],
        message: 'action=sync|adopt 必须带 payload_sha256',
      });
    }
    for (let i = 1; i < t.ops.length; i++) {
      const prev = entryKey(t.ops[i - 1] as SyncTxnOp);
      const cur = entryKey(t.ops[i] as SyncTxnOp);
      if (!(prev < cur)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ops', i],
          message: 'ops 必须按 (path, block_id) 严格升序(排序且键唯一)',
        });
        break;
      }
    }
  });
export type SyncTxn = z.infer<typeof SyncTxnSchema>;

// ---------------------------------------------------------------------------
// 稳定码(stderr 只含这些;§19.2)。形如 `SYNC_<类别> reason=<码>`,类别 = USAGE | CHECK_FAILED | NOT_RUN | FAIL_CLOSED。
// ---------------------------------------------------------------------------

/** 退出 2 */
export const SYNC_USAGE_REASONS = [
  'mode_conflict',
  'missing:--rollback',
  'bad_txn_id',
  'bad_agent',
  'home_not_allowed',
  'overwrite_requires_write',
  'unknown_arg',
] as const;
/** 退出 1:被跳过的条目(其余条目照常处理) */
export const SYNC_CHECK_FAILED_REASONS = [
  'SYNC_DRIFTED',
  'SYNC_TARGET_FOREIGN',
  'SYNC_UNMANAGED_IN_OWNED_DIR',
] as const;
/** 退出 4 */
export const SYNC_NOT_RUN_REASONS = ['SYNC_NO_PAYLOAD', 'SYNC_LOCKED'] as const;
/** 退出 3:整次不写 */
export const SYNC_FAIL_CLOSED_REASONS = [
  'SYNC_TXN_INCOMPLETE',
  'SYNC_PATH_SYMLINK',
  'SYNC_PATH_HARDLINK',
  'SYNC_PATH_NOT_REGULAR',
  'SYNC_BLOCK_CORRUPT',
  'SYNC_SHARED_PATH_CONFLICT',
  'SYNC_LEDGER_INVALID',
  'SYNC_PAYLOAD_INVALID',
  'SYNC_ROLLBACK_MISMATCH',
  'SYNC_WRITE_DENIED',
] as const;
