import { z } from 'zod';
import { IsoTimestampSchema, SEMVER_SOURCE, SemverSchema, Sha256Schema } from './common.js';
import { SyncTxnIdSchema } from './sync.js';

/**
 * S0 追加(sync / doctor / update,docs/contracts.md §19):自动更新的用户配置与状态文件。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认官方 registry(含尾斜杠)。attestations 与 provenance 只认这个主机,不可配置(决策 ⑭B)。 */
export const NPMJS_REGISTRY = 'https://registry.npmjs.org/';
/** 包名(scope 在 URL 里写作 `@chovizzz%2fagent-kit`) */
export const PACKAGE_NAME = '@chovizzz/agent-kit';
/** 检查节流 */
export const UPDATE_CHECK_INTERVAL_HOURS = 24;
/** 版本冷却期默认值(决策 ⑤A):发布满该小时数才自动安装;`time[<v>]` 取自 registry,不取本机时钟 */
export const UPDATE_COOLDOWN_HOURS_DEFAULT = 24;
export const UPDATE_COOLDOWN_HOURS_MIN = 1;
export const UPDATE_COOLDOWN_HOURS_MAX = 720;
/** `versions/` 下保留的版本数(含 current) */
export const UPDATE_KEEP_VERSIONS = 2;
/** 锁 TTL(分钟) */
export const UPDATE_LOCK_TTL_MINUTES = 15;
/** 网络参数 */
export const UPDATE_REQUEST_TIMEOUT_MS = 5000;
export const UPDATE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
/** `auto_sync=safe` 单次最多应用的操作数,超过则回退为提示 */
export const AUTO_SYNC_MAX_OPS = 20;

export const AUTO_SYNC_MODES = ['off', 'safe'] as const;
export const AutoSyncModeSchema = z.enum(AUTO_SYNC_MODES);
export type AutoSyncMode = z.infer<typeof AutoSyncModeSchema>;

/** 通道 = npm dist-tag 名:稳定 `latest`,预发布 `rc`(release.yml 发布到 dist-tag rc;设计稿旧称 next 作废) */
export const UPDATE_CHANNELS = ['latest', 'rc'] as const;

/**
 * `auto_sync=safe` 拒绝自动应用的原因(§19.6 的机器可判条件,逐条对应)。
 * 任一命中 → 整次不应用,退回成 `SYNC_PENDING` 提示;不存在「部分应用」。
 */
export const AUTO_SYNC_DECLINE_REASONS = [
  'not_installed',
  'ledger_invalid',
  'txn_incomplete',
  'major_changed',
  'drifted',
  'foreign_conflict',
  'shared_path_conflict',
  'executable_in_payload',
  'must_atom',
  'rescan_dirty',
  'integrity_unverified',
  'agent_set_expanded',
  'too_many_ops',
  'precheck_refused',
  'locked',
] as const;
export const AutoSyncDeclineReasonSchema = z.enum(AUTO_SYNC_DECLINE_REASONS);

/** 更新检查 / 安装的结果枚举(`last_result`);网络类原因不得被合并成一个码。 */
export const UPDATE_RESULT_CODES = [
  'ok',
  'up_to_date',
  'installed',
  'pinned',
  'cooldown',
  'major_available',
  'downgrade_refused',
  'not_ready',
  'verify_failed',
  'skipped_locked',
  'attestations_unreachable',
  'trust_root_stale',
  'tuf_unreachable',
  'deprecated',
  'internal',
  'rolled_back',
  'timeout',
  'dns',
  'connect',
  'tls',
  'too_large',
  'parse',
  'proxy',
] as const;
export const UpdateResultSchema = z.union([
  z.enum(UPDATE_RESULT_CODES),
  /** `http_<状态码>` */
  z.string().regex(/^http_[1-5][0-9]{2}$/),
]);

export const UPDATE_VERIFY_REASONS = [
  'integrity',
  'provenance_missing',
  'provenance_identity',
  'bundle',
  'attestations_unreachable',
  /** 以下为 S7c-A 追加:不进 bad_versions 的另有 trust_root_stale / tuf_unreachable / attestations_unreachable / internal */
  'trust_root_stale',
  'tuf_unreachable',
  /** 签名通过的 tarball 解包失败(`TAR_*` 细分在 detail) */
  'tar',
  /** 包内 integrity.json / package.json 与已验签 tarball 不一致 */
  'package',
  /** 解包后的静态冒烟不过(bin 入口缺失 / 非普通文件 / 无 shebang) */
  'smoke',
  /** 目标版本已在 bad_versions(dry-run 的策略结果) */
  'bad_version',
  /** mirror 给的 tarball 地址不在允许主机内 */
  'host_denied',
  /** 不认识的异常(我们自己的 bug / 库升级):不拉黑该版本 */
  'internal',
] as const;

/** update 命令 / 后台 worker 的 stderr 稳定码(§19.4) */
export const UPDATE_STABLE_CODES = [
  'UPDATE_USAGE',
  'UPDATE_CHECK_FAILED',
  'UPDATE_VERIFY_FAILED',
  'UPDATE_DOWNGRADE_REFUSED',
  'UPDATE_MAJOR_AVAILABLE',
  'UPDATE_CURRENT_BROKEN',
  'UPDATE_NOT_READY',
  'UPDATE_FAIL_CLOSED',
  'UPDATE_NOT_RUN',
  'SYNC_PENDING',
  'AUTO_SYNC_DECLINED',
] as const;
export const UPDATE_USAGE_REASONS = [
  'mode_conflict',
  'major_requires_write',
  'rollback_requires_write',
  'bad_registry',
  'registry_fixture_outside_tmp',
  'home_not_allowed',
  'unknown_arg',
] as const;

// ---------------------------------------------------------------------------
// UserConfig:`~/.config/agent-kit/config.toml`(用户级,不进仓库;与覆盖层分开)
// ---------------------------------------------------------------------------

/** `X.Y.Z[-pre]` 精确钉住,或 `~X.Y[.Z]` 只在该 minor 内升 */
export const UPDATE_PIN_RE = new RegExp(
  `^(${SEMVER_SOURCE}|~(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(\\.(0|[1-9]\\d*))?)$`,
);

/** https、无用户信息 / 查询 / 片段的 registry 根地址。不接受 file:(假 registry 只经环境变量,且只在 KIT_TMP 内生效)。 */
const RegistryUrlSchema = z
  .string()
  .max(512)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (
        u.protocol === 'https:' &&
        u.username === '' &&
        u.password === '' &&
        u.search === '' &&
        u.hash === '' &&
        u.hostname !== ''
      );
    } catch {
      return false;
    }
  }, 'registry 必须是 https 地址,且不含用户信息、查询与片段');

export const UpdateConfigSchema = z.strictObject({
  /** 同 major 内、过冷却期、校验通过后自动安装新版本(决策 ③A:默认开) */
  auto_install: z.boolean().default(true),
  /** 新版本带来的规则变化是否自动同步(决策 ②B:默认 safe;条件见 §19.6)。KIT_AUTO_SYNC=0 恒优先 */
  auto_sync: AutoSyncModeSchema.default('safe'),
  /** 取 `dist-tags.<channel>` */
  channel: z.enum(UPDATE_CHANNELS).default('latest'),
  /** 钉版本 / minor;缺省不钉。KIT_UPDATE_PIN 优先 */
  pin: z.string().regex(UPDATE_PIN_RE).optional(),
  /** 版本发布满该小时数才自动安装(决策 ⑤A:默认 24) */
  cooldown_hours: z
    .number()
    .int()
    .min(UPDATE_COOLDOWN_HOURS_MIN)
    .max(UPDATE_COOLDOWN_HOURS_MAX)
    .default(UPDATE_COOLDOWN_HOURS_DEFAULT),
  /**
   * packument 与 tarball 取自哪个 registry(决策 ⑭B:允许镜像)。attestations 与 provenance **永远到 npmjs 取**,
   * 不随本项变化;取不到则不自动安装(`attestations_unreachable`)。缺省 = npmjs。
   */
  registry: RegistryUrlSchema.default(NPMJS_REGISTRY),
});
export type UpdateConfig = z.infer<typeof UpdateConfigSchema>;

export const UserConfigSchema = z.strictObject({
  schema_version: z.literal(1).optional(),
  /** 缺省 = 全部取默认值(`prefault` 会让内部默认值生效) */
  update: UpdateConfigSchema.prefault({}),
  /**
   * 自动 RSI 的 `[rsi]` 段(contracts §20.9 第 1 条 / §20.12 Q1-A,R20-A0)。这里**故意**只收 `unknown`:
   * 内容由 `src/rsi/config.ts` 按 R20-2.6 分层校验,`[rsi]` 写错只让 rsi 自己 `off`,不连累 update / doctor(否则用户一写 `[rsi]`,
   * 本 strictObject 校验失败,update 退出 3 `config_invalid`,后台自动更新停摆)。未知的**其它**顶层段仍被 strictObject 拒绝。
   */
  rsi: z.unknown().optional(),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

// ---------------------------------------------------------------------------
// UpdateState:`~/.local/state/agent-kit/update/state.json`
// ---------------------------------------------------------------------------

const InstalledVersionSchema = z.strictObject({
  version: SemverSchema,
  /** 该版本 `integrity.json` 的 sha256——外部锚点,记在包外,防「自洽损坏」 */
  anchor: Sha256Schema,
  installed_at: IsoTimestampSchema,
});

export const LastAutoSyncSchema = z
  .strictObject({
    at: IsoTimestampSchema,
    outcome: z.enum(['applied', 'declined', 'failed']),
    /** outcome=applied 时必填 */
    txn_id: SyncTxnIdSchema.optional(),
    /** outcome=declined 时非空 */
    reasons: z.array(AutoSyncDeclineReasonSchema).max(AUTO_SYNC_DECLINE_REASONS.length).default([]),
    add: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    remove: z.number().int().nonnegative(),
  })
  .superRefine((r, ctx) => {
    if (r.outcome === 'applied' && (r.txn_id === undefined || r.reasons.length > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'applied 必须带 txn_id 且不得带 reasons',
      });
    }
    if (r.outcome === 'declined' && r.reasons.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['reasons'], message: 'declined 必须给出原因' });
    }
    if (new Set(r.reasons).size !== r.reasons.length) {
      ctx.addIssue({ code: 'custom', path: ['reasons'], message: 'reasons 不得重复' });
    }
  });
export type LastAutoSync = z.infer<typeof LastAutoSyncSchema>;

export const UpdateStateSchema = z.strictObject({
  schema_version: z.literal(1),
  last_check_at: IsoTimestampSchema.optional(),
  last_result: UpdateResultSchema.optional(),
  /** 最近一次看到的目标版本及其在 registry 的发布时间(`time[<v>]`) */
  latest_seen: SemverSchema.optional(),
  latest_seen_published_at: IsoTimestampSchema.optional(),
  /** 只增不减:registry 给出更低的 latest → `UPDATE_DOWNGRADE_REFUSED` */
  max_seen_version: SemverSchema.optional(),
  installed: InstalledVersionSchema.optional(),
  /** 回滚目标(最近保留的上一版本) */
  previous: InstalledVersionSchema.optional(),
  /** 校验失败 / 被回滚的版本,不再自动安装 */
  bad_versions: z.array(SemverSchema).max(64).default([]),
  /** 每天最多在 stderr 提示一次失败原因 */
  last_notice_at: IsoTimestampSchema.optional(),
  /** 最近一次自动同步的记录(doctor D16 显示) */
  last_auto_sync: LastAutoSyncSchema.optional(),
});
export type UpdateState = z.infer<typeof UpdateStateSchema>;
