/**
 * `rsi hooks` 与 kit 钩子写入的契约常量、形状表与 schema(docs/contracts.md §20.15,N1;A5)。
 *
 * 本文件是**纯契约**:不 import 任何写出口,`rsi hint` 会 import 它(`formatHintOutput`),所以保持轻量。
 * 形状表(R20-15.8)是唯一的「钩子长什么样」的来源;证据级别(R20-15.9)决定是否开放 `--write`。
 *
 * 生产形状表的证据级别(契约 §20.15-12 N1 订正 #3):**pi = `实测运行`**(2026-11-04,pi 1.5.0,用户在真实会话里观察:`session_start` 调 hint、`session_shutdown` 调 poke、
 * 会话 jsonl 里有 `customType:"agent-kit-rsi"` 的隐藏消息),适用版本 `min: '1.5.0'`,写闸需要本机 pi 版本(`src/rsi/hooks/agent-version.ts` 探测,探测不到即拒);
 * **claude / codex 仍是 `假设`**:形状核实要用户在场观察真实会话(设计稿 §14 A5 行),在那之前它们的 `--install --write` 一律 `RSI_HOOKS_NOT_RUN reason=shape_unverified`。
 * 核实通过后只改下面表里的 `evidence` 与 `agent_versions`,不要改判定函数 {@link isShapeWritable}(它是「是否已核实」的唯一实现,`--json` 的 `verified` 与写闸共用它)。
 */
import { z } from 'zod';
import { IsoTimestampSchema, Sha256Schema } from './common.js';
import { RsiAgentSchema, type RsiAgentId } from './rsi.js';

// ---------------------------------------------------------------------------
// 模式、稳定码、写入承诺等级(R20-15.1、15.24a、15.25、15.28)
// ---------------------------------------------------------------------------
export const RSI_HOOKS_MODES = [
  'print',
  'install',
  'uninstall',
  'restore',
  'discard_residue',
  'prune_backups',
] as const;
export type RsiHooksMode = (typeof RSI_HOOKS_MODES)[number];

/** 模式 ↔ 命令行开关(六个互斥) */
export const RSI_HOOKS_MODE_FLAGS: Readonly<Record<RsiHooksMode, string>> = Object.freeze({
  print: '--print',
  install: '--install',
  uninstall: '--uninstall',
  restore: '--restore',
  discard_residue: '--discard-residue',
  prune_backups: '--prune-backups',
});

/** 顶层码(R20-15.28) */
export const RSI_HOOKS_DECLINED = 'RSI_HOOKS_DECLINED';
export const RSI_HOOKS_NOT_RUN = 'RSI_HOOKS_NOT_RUN';
/** 退出 0 的警告行(R20-15.24a:目标事务已完成而顺带修剪失败) */
export const RSI_HOOKS_WARN = 'RSI_HOOKS_WARN';

/** `RSI_HOOKS_NOT_RUN reason=`(退出 4;R20-15.28) */
export const RSI_HOOKS_NOT_RUN_REASONS = Object.freeze([
  'locked',
  'agent_not_installed',
  'restore_not_latest',
  'shape_unverified',
  'config_unparsable',
  'config_shape_unsupported',
  'config_not_canonical',
  'foreign_kit_entry',
  'ambiguous_entry',
  'conflicting_shape_unowned',
  'stale_plan',
  'config_changed_during_write',
  'config_changed_since_install',
  'txn_residue_unknown',
  'duplicate_in_local',
  'duplicate_check_failed',
  // A5 订正 #2(用户 2026-11-03 拍板):取代 A5 实装时暂借的 agent_not_installed / txn_residue_unknown
  'agent_dir_overridden',
  'residue_not_discardable',
] as const);
export type RsiHooksNotRunReason = (typeof RSI_HOOKS_NOT_RUN_REASONS)[number];

/** `RSI_FAIL_CLOSED reason=`(退出 3;R20-15.28)。`lock_lost` / `internal` 与 R20-3.0 总表共用同名项 */
export const RSI_HOOKS_FAIL_CLOSED_REASONS = Object.freeze([
  'hooks_target_unsafe',
  'hooks_backup_invalid',
  'hooks_ledger_invalid',
  'lock_lost',
  'internal',
] as const);
export type RsiHooksFailClosedReason = (typeof RSI_HOOKS_FAIL_CLOSED_REASONS)[number];

/** `RSI_HOOKS_WARN reason=` */
export const RSI_HOOKS_WARN_REASONS = Object.freeze(['prune_incomplete'] as const);

/**
 * 写入承诺等级(R20-15.24a),按**实际到达的执行阶段**取值。`--json` 的 `write_level` 为下列之一或 `null`(纯维护操作 / `--print` / 干跑)。
 *  ① zero_write:确认与拿锁之前判出的一切拒绝与 `RSI_HOOKS_DECLINED`;
 *  ② lock_only:仅锁基础设施(拿锁失败 `locked`,或拿锁后残留处理没写任何东西时的拒绝);
 *  ③ recovery_only:拿锁后处理残留 journal 写过东西,随后本次计划被拒;
 *  ④ target_unwritten:本次 journal / 备份已写、目标未改;
 *  ⑤ target_written_pending:目标 rename 已完成、账本或 journal 清理未完成(下一次 `--write` 补完);
 *  committed:目标事务完整完成。
 */
export const RSI_HOOKS_WRITE_LEVELS = Object.freeze([
  'zero_write',
  'lock_only',
  'recovery_only',
  'target_unwritten',
  'target_written_pending',
  'committed',
] as const);
export type RsiHooksWriteLevel = (typeof RSI_HOOKS_WRITE_LEVELS)[number];

export const RSI_HOOKS_MAINTENANCE = Object.freeze(['none', 'done', 'partial'] as const);
export const RSI_HOOKS_MAINTENANCE_KINDS = Object.freeze(['prune', 'discard'] as const);

/** `--json` 的 `result` 取值 */
export const RSI_HOOKS_RESULTS = Object.freeze([
  'printed',
  'dry_run',
  'unchanged',
  'committed',
  'declined',
  'not_run',
  'fail_closed',
  'maintenance_done',
] as const);
export type RsiHooksResult = (typeof RSI_HOOKS_RESULTS)[number];

/** `--json` 固定键集(R20-15.25) */
export const RSI_HOOKS_JSON_KEYS = Object.freeze([
  'mode',
  'agent',
  'shape_version',
  'verified',
  'plan',
  'result',
  'txn_id',
  'write_level',
  'maintenance',
  'maintenance_kind',
] as const);

// ---------------------------------------------------------------------------
// 事务 id、路径常量、上限
// ---------------------------------------------------------------------------
/** UTC 时间戳 + `-` + 16 位随机十六进制(R20-15.21);路径一律由它与固定 agent 在内部推导 */
export const HOOKS_TXN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;
export const HooksTxnIdSchema = z.string().regex(HOOKS_TXN_ID_RE);

/** 私有状态区(HOME 相对;R20-15.21) */
export const HOOKS_STATE_REL = '.local/state/agent-kit/hooks';
/** 备份保留(R20-15.24):非受保护备份最多 10 份且不超过 30 个 UTC 日 */
export const HOOKS_BACKUPS_KEPT = 10;
export const HOOKS_BACKUP_MAX_DAYS = 30;
/** 读上限(R20-15.14 / 15.21a) */
export const HOOKS_TARGET_MAX_BYTES = 1024 * 1024;
export const HOOKS_BACKUP_MAX_BYTES = 1024 * 1024;
export const HOOKS_STATE_DOC_MAX_BYTES = 256 * 1024;
/** 账本归属条目与事务记录数的 schema 上限(超出 = 账本不合规;事务记录由 `src/rsi/hooks/ledger.ts` 的 `compactTxns` 按规则压缩) */
export const HOOKS_LEDGER_MAX_ENTRIES = 64;
export const HOOKS_LEDGER_MAX_TXNS = 512;

// ---------------------------------------------------------------------------
// 形状表(R20-15.8)
// ---------------------------------------------------------------------------
export const HOOK_EVIDENCE_LEVELS = ['公开文档', '实测运行', '实测结构', '假设'] as const;
export type HookEvidence = (typeof HOOK_EVIDENCE_LEVELS)[number];
/** 只有这两级开放 `--write`(R20-15.9) */
export const HOOK_EVIDENCE_WRITABLE: readonly HookEvidence[] = ['公开文档', '实测运行'];

export const HINT_FORMATS = ['claude-json', 'codex-json'] as const;
export type HintFormat = (typeof HINT_FORMATS)[number];

export const HOOK_VARIANTS = ['plain', 'canary'] as const;
export type HookVariant = (typeof HOOK_VARIANTS)[number];

export interface HookCommandSpec {
  readonly type: 'command';
  readonly command: string;
  readonly timeout: number;
}
/** claude / codex 钩子配置里的包装对象:`{matcher?, hooks:[…]}` */
export interface HookWrapperSpec {
  readonly matcher?: string;
  readonly hooks: readonly HookCommandSpec[];
}
export interface HookEntrySpec {
  readonly event: string;
  readonly wrapper: HookWrapperSpec;
}

interface ShapeBase {
  readonly agent: RsiAgentId;
  readonly shape_version: string;
  readonly evidence: HookEvidence;
  /** 适用的 agent 版本范围;`null` = 形状表**显式**声明不限版本(不代表证据已核实,证据只看 `evidence`) */
  readonly agent_versions: { readonly min?: string; readonly max?: string } | null;
  /** agent 根目录(HOME 相对;kit 不替 agent 建根目录,R20-15.14) */
  readonly agent_root_rel: string;
  /** 写入目标(HOME 相对;固定、不可配置,R20-15.2) */
  readonly target_rel: string;
  /** hint 钩子要求的输出格式(`--format`);pi 无 */
  readonly hint_format: HintFormat | null;
  /** 失败与退出码处理(文档性字段,进 `--print` 输出) */
  readonly failure_handling: string;
  /** 信任步骤(codex 的钩子信任由用户自己做,kit 只提示) */
  readonly trust_step: string | null;
}

export interface JsonMergeShape extends ShapeBase {
  readonly kind: 'json-merge';
  /** 文件不存在时的空形态 */
  readonly empty_root: Readonly<Record<string, unknown>>;
  /** 安装前只读检查的「本地覆盖」文件(R20-15.27);无则 `null` */
  readonly local_duplicate_rel: string | null;
  readonly variants: {
    readonly plain: readonly HookEntrySpec[];
    readonly canary: readonly HookEntrySpec[] | null;
  };
}
export interface FileShape extends ShapeBase {
  readonly kind: 'file';
  /** 目标父目录里要(在 agent 根已存在的前提下)建的缺失段 */
  readonly parent_dirs: readonly string[];
  readonly variants: { readonly plain: string; readonly canary: string | null };
}
export type HookShape = JsonMergeShape | FileShape;
export type ShapeTable = Readonly<Record<RsiAgentId, HookShape>>;

const KIT_CMD = 'agent-kit rsi';
/** 命令前缀:任何以它开头的钩子命令都归 kit 管(R20-15.13 的「前缀」判据) */
export const HOOKS_KIT_COMMAND_PREFIX = KIT_CMD;

function hintCommand(agent: RsiAgentId, format: HintFormat, canary: boolean): string {
  return `${KIT_CMD} hint --agent ${agent} --format ${format}${canary ? ' --canary' : ''}`;
}
function pokeCommand(agent: RsiAgentId): string {
  return `${KIT_CMD} poke --agent ${agent}`;
}

function sessionHooks(
  agent: RsiAgentId,
  format: HintFormat,
  canary: boolean,
): readonly HookEntrySpec[] {
  return [
    {
      event: 'SessionStart',
      wrapper: {
        matcher: 'startup',
        hooks: [{ type: 'command', command: hintCommand(agent, format, canary), timeout: 5 }],
      },
    },
    {
      event: 'SessionEnd',
      wrapper: { hooks: [{ type: 'command', command: pokeCommand(agent), timeout: 5 }] },
    },
  ];
}

/** pi 扩展源码(shape pi-1)。普通 hint 与 poke;不传路径与 cwd(R20-1.9)。证据级别 `假设`,核实前只能 `--print` */
export const PI_EXTENSION_SOURCE_PLAIN = `// agent-kit rsi hooks — shape pi-1 (generated by \`agent-kit rsi hooks --install --agent pi\`; do not edit)
import { spawnSync } from "node:child_process";

function run(args) {
  try {
    const r = spawnSync("agent-kit", args, { encoding: "utf8", timeout: 5000 });
    return typeof r.stdout === "string" ? r.stdout : "";
  } catch {
    return "";
  }
}

export default function (pi) {
  let pending = "";
  pi.on("session_start", () => {
    pending = run(["rsi", "hint", "--agent", "pi"]).trim();
  });
  pi.on("before_agent_start", () => {
    const text = pending;
    pending = "";
    if (text === "") return undefined;
    return { message: { customType: "agent-kit-rsi", content: text, display: false } };
  });
  pi.on("session_shutdown", (event) => {
    if (event && event.reason === "reload") return;
    run(["rsi", "poke", "--agent", "pi"]);
  });
}
`;

/**
 * 生产形状表(冻结)。claude / codex 的 `evidence` 是 `假设`,pi 是 `实测运行`(`>=1.5.0`),见文件头。
 * codex 的 `hooks.json` 结构与信任步骤同样未核实;这里的 JSON 形状沿用 claude 的包装对象写法,仅供 `--print`。
 */
export const PRODUCTION_SHAPES: ShapeTable = deepFreeze({
  claude: {
    agent: 'claude',
    kind: 'json-merge',
    shape_version: 'claude-1',
    evidence: '假设',
    agent_versions: null,
    agent_root_rel: '.claude',
    target_rel: '.claude/settings.json',
    hint_format: 'claude-json',
    failure_handling:
      '钩子命令退出码恒为 0、失败输出空串,不阻断会话;SessionStart 的 stdout JSON 经 hookSpecificOutput.additionalContext 注入',
    trust_step: null,
    empty_root: {},
    local_duplicate_rel: '.claude/settings.local.json',
    variants: {
      plain: sessionHooks('claude', 'claude-json', false),
      canary: sessionHooks('claude', 'claude-json', true),
    },
  },
  codex: {
    agent: 'codex',
    kind: 'json-merge',
    shape_version: 'codex-1',
    evidence: '假设',
    agent_versions: null,
    agent_root_rel: '.codex',
    target_rel: '.codex/hooks.json',
    hint_format: 'codex-json',
    failure_handling:
      '钩子命令退出码恒为 0、失败输出空串;SessionStart 是否真派发、additionalContext 是否真注入均未运行验证',
    trust_step:
      '钩子配置需要你自己在 codex 里信任(kit 不写 ~/.codex/config.toml);核实前只开放 --print',
    empty_root: {},
    local_duplicate_rel: null,
    variants: { plain: sessionHooks('codex', 'codex-json', false), canary: null },
  },
  pi: {
    agent: 'pi',
    kind: 'file',
    shape_version: 'pi-1',
    evidence: '实测运行',
    agent_versions: { min: '1.5.0' },
    agent_root_rel: '.pi/agent',
    target_rel: '.pi/agent/extensions/agent-kit-rsi.ts',
    hint_format: null,
    failure_handling: '扩展内任何失败都吞掉、不抛错;session_shutdown 为 reload 时不 poke',
    trust_step: null,
    parent_dirs: ['extensions'],
    variants: { plain: PI_EXTENSION_SOURCE_PLAIN, canary: null },
  },
} satisfies Record<RsiAgentId, HookShape>);

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** 形状的某个变体的 json 条目;`null` = 该变体不存在 */
export function entriesOf(
  shape: JsonMergeShape,
  variant: HookVariant,
): readonly HookEntrySpec[] | null {
  return variant === 'plain' ? shape.variants.plain : shape.variants.canary;
}
export function sourceOf(shape: FileShape, variant: HookVariant): string | null {
  return variant === 'plain' ? shape.variants.plain : shape.variants.canary;
}

function parseVer(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmpVer(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** 本机 agent 版本是否在形状表适用范围内。范围为 `null` = 不限;范围非空而版本未知 / 无法解析 → `false`(fail closed) */
export function shapeVersionOk(shape: HookShape, agentVersion: string | undefined): boolean {
  const range = shape.agent_versions;
  if (range === null) return true;
  if (agentVersion === undefined) return false;
  const v = parseVer(agentVersion);
  if (v === null) return false;
  if (range.min !== undefined) {
    const lo = parseVer(range.min);
    if (lo === null || cmpVer(v, lo) < 0) return false;
  }
  if (range.max !== undefined) {
    const hi = parseVer(range.max);
    if (hi === null || cmpVer(v, hi) > 0) return false;
  }
  return true;
}

/** 「是否已核实」的唯一实现(R20-15.9):证据 ∈ {公开文档, 实测运行} 且版本适用。`--json` 的 `verified` 与 `--write` 闸共用它 */
export function isShapeWritable(shape: HookShape, agentVersion: string | undefined): boolean {
  return HOOK_EVIDENCE_WRITABLE.includes(shape.evidence) && shapeVersionOk(shape, agentVersion);
}

// ---------------------------------------------------------------------------
// hint --format(R20-3.3.5)
// ---------------------------------------------------------------------------
/**
 * 钩子要求的 JSON 输出形状:`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<文本>}}` + `\n`。
 * 文本内容与字节上限同 R20-3.3.2(调用方已用 `finalizeHint` 把文本限在 200 字节内);JSON 只是包装,不放宽上限。空文本 → 空串。
 */
export function formatHintOutput(format: HintFormat, text: string): string {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body === '') return '';
  // claude-json 与 codex-json 目前同形;分开命名是因为形状表里的核实状态各自独立
  void format;
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body } })}\n`;
}

export function isHintFormat(v: string): v is HintFormat {
  return (HINT_FORMATS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// 账本 / journal / 计划 schema(R20-15.12、15.18、15.21、15.23)
// ---------------------------------------------------------------------------
const EventSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const NonNegInt = z.number().int().nonnegative();

/** 账本的归属条目:事件位置 + 完整条目指纹 + 写入事务(R20-15.12) */
export const HooksLedgerEntrySchema = z.strictObject({
  agent: RsiAgentSchema,
  event: EventSchema,
  fingerprint: Sha256Schema,
  shape_version: z.string().min(1).max(32),
  variant: z.enum(HOOK_VARIANTS),
  txn_id: HooksTxnIdSchema,
});
export type HooksLedgerEntry = z.infer<typeof HooksLedgerEntrySchema>;

export const HOOKS_TXN_OPS = ['install', 'uninstall', 'restore'] as const;
export const HOOKS_TXN_STATUSES = ['applied', 'restored', 'discarded', 'aborted'] as const;
export type HooksTxnStatus = (typeof HOOKS_TXN_STATUSES)[number];

/** `applied_txns` 里的一条事务记录(同一 `txn_id` 只生效一次,R20-15.21) */
export const HooksTxnRecordSchema = z.strictObject({
  txn_id: HooksTxnIdSchema,
  agent: RsiAgentSchema,
  op: z.enum(HOOKS_TXN_OPS),
  status: z.enum(HOOKS_TXN_STATUSES),
  added: z.array(HooksLedgerEntrySchema).max(16),
  removed: z.array(HooksLedgerEntrySchema).max(16),
  before_exists: z.boolean(),
  before_sha256: Sha256Schema.nullable(),
  after_exists: z.boolean(),
  after_sha256: Sha256Schema.nullable(),
  /** 备份状态:present = 备份目录存在;none = 写前不存在(无备份文件);pruned = 已修剪(R20-15.24 先记账本后删目录) */
  backup: z.enum(['present', 'none', 'pruned']),
  restore_of: HooksTxnIdSchema.optional(),
  at: IsoTimestampSchema,
});
export type HooksTxnRecord = z.infer<typeof HooksTxnRecordSchema>;

export const HooksLedgerSchema = z
  .strictObject({
    schema_version: z.literal(1),
    /** 任何成功事务(含 restore、`--discard-residue`)后加 1;V5 安装票据绑定它(R20-15.29) */
    generation: NonNegInt,
    entries: z.array(HooksLedgerEntrySchema).max(HOOKS_LEDGER_MAX_ENTRIES),
    applied_txns: z.array(HooksTxnRecordSchema).max(HOOKS_LEDGER_MAX_TXNS),
  })
  .superRefine((l, ctx) => {
    const seen = new Set<string>();
    for (const [i, e] of l.entries.entries()) {
      const k = `${e.agent}\0${e.event}\0${e.fingerprint}`;
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['entries', i], message: '归属重复' });
      seen.add(k);
    }
    const ids = new Set<string>();
    for (const [i, t] of l.applied_txns.entries()) {
      if (ids.has(t.txn_id)) {
        ctx.addIssue({ code: 'custom', path: ['applied_txns', i], message: 'txn_id 重复' });
      }
      ids.add(t.txn_id);
    }
  });
export type HooksLedger = z.infer<typeof HooksLedgerSchema>;

export const HooksPlanOpSchema = z.strictObject({
  op: z.enum(['add', 'remove']),
  event: EventSchema,
  entry_fingerprint: Sha256Schema,
});
export type HooksPlanOp = z.infer<typeof HooksPlanOpSchema>;

/** 安装 / 卸载计划(R20-15.18) */
export const HooksEditPlanSchema = z.strictObject({
  kind: z.enum(['install', 'uninstall']),
  agent: RsiAgentSchema,
  /** `~/` 相对写法(R20-15.25) */
  path: z.string().min(1).max(128),
  before_exists: z.boolean(),
  before_sha256: Sha256Schema.nullable(),
  ops: z.array(HooksPlanOpSchema).max(32),
  shape_version: z.string().min(1).max(32),
  variant: z.enum(HOOK_VARIANTS),
});
export type HooksEditPlan = z.infer<typeof HooksEditPlanSchema>;

/** restore 专用计划(R20-15.23) */
export const HooksRestorePlanSchema = z.strictObject({
  kind: z.literal('restore'),
  agent: RsiAgentSchema,
  path: z.string().min(1).max(128),
  source_txn: HooksTxnIdSchema,
  ledger_generation: NonNegInt,
  target_exists_after: z.boolean(),
  target_sha256_after: Sha256Schema.nullable(),
  backup_sha256: Sha256Schema.nullable(),
});
export type HooksRestorePlan = z.infer<typeof HooksRestorePlanSchema>;

export const HooksPlanSchema = z.union([HooksEditPlanSchema, HooksRestorePlanSchema]);
export type HooksPlan = z.infer<typeof HooksPlanSchema>;

export const HOOKS_JOURNAL_STATES = ['in_progress', 'aborted', 'discarding'] as const;

/** 待提交的账本变更与预期代次(R20-15.21 ①) */
export const HooksLedgerChangeSchema = z.strictObject({
  expected_generation: NonNegInt,
  record: HooksTxnRecordSchema,
  /** restore 事务把源事务标 `restored` */
  set_status: z
    .strictObject({ txn_id: HooksTxnIdSchema, status: z.literal('restored') })
    .optional(),
});
export type HooksLedgerChange = z.infer<typeof HooksLedgerChangeSchema>;

export const HooksJournalSchema = z.strictObject({
  schema_version: z.literal(1),
  txn_id: HooksTxnIdSchema,
  agent: RsiAgentSchema,
  kind: z.enum(HOOKS_TXN_OPS),
  state: z.enum(HOOKS_JOURNAL_STATES),
  before_exists: z.boolean(),
  before_sha256: Sha256Schema.nullable(),
  after_exists: z.boolean(),
  after_sha256: Sha256Schema.nullable(),
  /** 写前文件的权限位;写前不存在 → null */
  original_mode: NonNegInt.max(0o777).nullable(),
  /** 目标的最终权限(原权限;写前不存在 → 0600) */
  final_mode: NonNegInt.max(0o777),
  plan: HooksPlanSchema,
  ledger_change: HooksLedgerChangeSchema,
  /** 本事务是首个需要建账本的事务(R20-15.21) */
  bootstraps_ledger: z.boolean(),
  created_at: IsoTimestampSchema,
});
export type HooksJournal = z.infer<typeof HooksJournalSchema>;
