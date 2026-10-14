import { z } from 'zod';
import { AgentIdSchema, IsoDateSchema, IsoTimestampSchema, RenderAgentIdSchema } from './common.js';
import { ModelTierSchema } from './agent-def.js';
import { JudgeHopIdSchema } from './proposal.js';
import { VendorOverrideDeniedError, assertVendorOverrides } from './vendor.js';

export const LimitSourceSchema = z.enum(['documented', 'probed', 'assumed']);
export type LimitSource = z.infer<typeof LimitSourceSchema>;
export const EnforceSchema = z.enum(['warn', 'block']);
export type Enforce = z.infer<typeof EnforceSchema>;
export const ChannelNameSchema = z.enum(['canary', 'stable']);
export type ChannelName = z.infer<typeof ChannelNameSchema>;

/**
 * 逐目标预算(设计 §3.6)。至少给 max_bytes 或 max_lines 之一。
 * hard_limit 是 agent 静默截断的硬上限,未知写 "unknown"。
 * limit_source=assumed 的目标只告警、不阻断,与 enforce 取值无关。
 */
export const BudgetTargetSchema = z
  .strictObject({
    max_bytes: z.number().int().positive().optional(),
    max_lines: z.number().int().positive().optional(),
    hard_limit: z.union([z.number().int().positive(), z.literal('unknown')]).optional(),
    limit_source: LimitSourceSchema,
    /** 阈值探针写回(P1-01):实测值、被测 agent 版本、时点。limit_source=probed 时三者必填。 */
    probed_value: z.number().int().positive().optional(),
    probed_agent_version: z.string().min(1).optional(),
    probed_at: IsoTimestampSchema.optional(),
  })
  .refine((t) => t.max_bytes !== undefined || t.max_lines !== undefined, {
    message: '预算目标至少要有 max_bytes 或 max_lines',
  })
  .refine(
    (t) =>
      t.limit_source !== 'probed' ||
      (t.probed_value !== undefined &&
        t.probed_agent_version !== undefined &&
        t.probed_at !== undefined),
    { message: 'limit_source=probed 必须同时有 probed_value / probed_agent_version / probed_at' },
  );
export type BudgetTarget = z.infer<typeof BudgetTargetSchema>;

export const BudgetConfigSchema = z.strictObject({
  /** P1 落地决策 ②:缺省 = block。assumed 目标恒只告警(与 enforce 无关,见 BudgetTargetSchema 注),
   *  因此缺省 block 实际只作用于 documented/probed 目标。真实仓库 kit.toml 显式写 warn(在探针定稿前不阻断)。 */
  enforce: EnforceSchema.default('block'),
  /** 单个原子正文字节上限 */
  atom_max_bytes: z.number().int().positive().default(600),
  /** 「一进一出」触发阈值,占 max 的百分比;比较符以 docs/contracts.md 为准 */
  threshold_percent: z.number().int().min(1).max(100).default(90),
  /** 项目层预算上限(Q-N3:P0 只用 fixture 验证机制) */
  project_max_bytes: z.number().int().positive().optional(),
  claude: BudgetTargetSchema.optional(),
  codex: BudgetTargetSchema.optional(),
  pi: BudgetTargetSchema.optional(),
  kimi: BudgetTargetSchema.optional(),
  opencode: BudgetTargetSchema.optional(),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

/** 渠道成员:handle → 元数据。P0 只做 schema 校验,不使用。 */
export const MemberSchema = z.strictObject({
  since: IsoDateSchema.optional(),
  note: z.string().optional(),
});
export const ChannelSchema = z.strictObject({
  members: z.record(z.string().min(1), MemberSchema).default({}),
});

/**
 * R0 追加(#27):反思器配置。全部可选且有默认值,旧 kit.toml / 覆盖层仍有效。
 * core(kit.toml)只能放与账号/渠道无关的通用上限;各后端槽位绑定、厂商覆盖、egress 只能在覆盖层。
 */
export const ReflectCoreConfigSchema = z.strictObject({
  /** 每批提案数上限(设计 §6.4 规定 ≤5) */
  max_proposals: z.number().int().min(1).max(5).default(5),
  /** 一次运行允许的 LLM 调用(spawn)次数;默认 1,上限 3 */
  max_calls: z.number().int().min(1).max(3).default(1),
  timeout_ms: z.number().int().min(1000).max(600_000).default(180_000),
});
export type ReflectCoreConfig = z.infer<typeof ReflectCoreConfigSchema>;

/** 进 argv 的 provider/model 字符集:不得以 `-` 开头(防被当成 flag)。 */
const ARG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/**
 * 后端槽位绑定。槽位 id 沿用 `JUDGE_HOP_CHAIN` 的固定枚举;没配置的槽位运行时记 `error:not_configured`。
 * **没有 vendor 字段**:厂商由 `deriveVendor()` 推导,用户不能自己声明(contracts #26)。
 */
export const ReflectBackendBindingSchema = z.strictObject({
  slot: JudgeHopIdSchema,
  cli: z.enum(['claude', 'codex', 'pi']),
  provider: z.string().regex(ARG_ID_RE).optional(),
  model: z.string().regex(ARG_ID_RE).optional(),
  /**
   * R5 追加(#29):为 true 时,命令层把该槽位 CLI 二进制的绝对路径加入后端的 `allowUnverified` 清单
   * (放行 `verified:false` 的参数集真跑)。缺省/false = 不放行。**只能由用户在覆盖层显式写**,core 不得默认放行。
   */
  allow_unverified: z.boolean().optional(),
});
export type ReflectBackendBinding = z.infer<typeof ReflectBackendBindingSchema>;

function isIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const ReflectOverlaySchema = ReflectCoreConfigSchema.extend({
  /** 冷却标记按该时区的日期换算(决策 ⑪A:默认 UTC,用户在覆盖层设自己的重置时区) */
  reset_tz: z
    .string()
    .min(1)
    .max(64)
    .refine(isIanaTimeZone, { message: 'reset_tz 不是有效的 IANA 时区' })
    .default('UTC'),
  backends: z
    .array(ReflectBackendBindingSchema)
    .default([])
    .refine((a) => new Set(a.map((b) => b.slot)).size === a.length, {
      message: 'backends 里 slot 不得重复',
    }),
  /** 模型族 token → 新厂商 id。只能追加,不能覆盖内置家族(违者 CFG_VENDOR_OVERRIDE_DENIED) */
  vendor_overrides: z
    .record(z.string(), z.string())
    .default({})
    .superRefine((o, ctx) => {
      try {
        assertVendorOverrides(o);
      } catch (e) {
        if (!(e instanceof VendorOverrideDeniedError)) throw e;
        ctx.addIssue({ code: 'custom', message: e.message });
      }
    }),
  /** 摘录能否离开本机(决策 ③A:每次运行还要 `--allow-egress`);默认 false */
  egress: z.boolean().default(false),
  /**
   * R5 追加(#29):允许进团队层的项目 key 白名单(取值 = 信号里的 `project_key`)。
   * 缺省为空 = 所有项目一律按 personal 层处理(fail-closed);只有列在这里的项目才可能进团队层。
   */
  team_project_keys: z.array(z.string().min(1).max(256)).default([]),
});
export type ReflectOverlay = z.infer<typeof ReflectOverlaySchema>;

/**
 * L0 追加(④A):晋升/退役判据的阈值段。只放在 core(`kit.toml` 的 `[lifecycle]`),**覆盖层不接受该段**
 * (`OverlaySchema` 是 strict,出现即错),所以个人/渠道配置不可能放宽它。
 * 每个字段的下界就是保守默认值:core 只能调严,不能调松(调松要改契约)。
 * 缺省不出现;出现时才套默认值。
 */
export const LifecycleCoreConfigSchema = z
  .strictObject({
    /** advisory→active:canary 窗口累计天数下界 */
    canary_window_days: z.number().int().min(14).default(14),
    /** advisory→active:有效 attest 的不同成员数下界 */
    min_members: z.number().int().min(2).default(2),
    /** 其中不是原子 owner 的成员数下界(⑥A 的本机结构检查) */
    min_non_owner_members: z.number().int().min(1).default(1),
    /** 窗口内 `exposure_sessions` 合计下界 */
    min_exposure_sessions: z.number().int().min(10).default(10),
    /** 有效 attest 里 `harmful` 的合计上限;只允许 0(固定,写出来是为了让 kit.toml 自述) */
    max_harmful: z.literal(0).default(0),
    /** `no_exposure` 退役理由要看的最近 canary 窗口数 K */
    no_exposure_windows: z.number().int().min(2).default(2),
  })
  .refine((c) => c.min_non_owner_members <= c.min_members, {
    path: ['min_non_owner_members'],
    message: 'min_non_owner_members 不得大于 min_members',
  });
export type LifecycleCoreConfig = z.infer<typeof LifecycleCoreConfigSchema>;

/** `kit.toml`(core 仓库根)。 */
export const KitConfigSchema = z.strictObject({
  kit: z.strictObject({
    name: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  }),
  agents: z.strictObject({
    /** 渲染目标;openclaw 默认不在内 */
    enabled: z.array(RenderAgentIdSchema).min(1),
  }),
  budget: BudgetConfigSchema,
  /** 成员表按渠道(设计 §5.3):[channels.canary.members] / [channels.stable.members] */
  channels: z.strictObject({
    canary: ChannelSchema.default({ members: {} }),
    stable: ChannelSchema.default({ members: {} }),
  }),
  /** provider 约束:P1(裁判链)才使用,P0 原样保留不解释 */
  provider: z.record(z.string(), z.unknown()).optional(),
  /** R0 追加(#27):缺省不出现;出现时才套默认值 */
  reflect: ReflectCoreConfigSchema.optional(),
  /** L0 追加(④A):缺省不出现;出现时才套默认值 */
  lifecycle: LifecycleCoreConfigSchema.optional(),
});
export type KitConfig = z.infer<typeof KitConfigSchema>;

/**
 * 覆盖层 `kit.overlay.toml`(不进 core)。P0 只经 `--overlay <path>` 显式传入。
 * model_tiers:agent → 档位 → 具体模型名(core 内不得出现具体模型名,只有这里可以)。
 */
export const OverlaySchema = z.strictObject({
  model_tiers: z
    .partialRecord(AgentIdSchema, z.partialRecord(ModelTierSchema, z.string().min(1)))
    .optional(),
  /** 脱敏敏感词表(客户名、项目名、内部域名、群 ID) */
  sensitive_words: z.array(z.string().min(1)).optional(),
  internal_domains: z.array(z.string().min(1)).optional(),
  channel: ChannelNameSchema.optional(),
  enabled_agents: z.array(AgentIdSchema).optional(),
  /** 其会话整条跳过(不只是脱敏)的项目目录 */
  exclude_dirs: z.array(z.string().min(1)).optional(),
  /** R0 追加(#27) */
  reflect: ReflectOverlaySchema.optional(),
});
export type Overlay = z.infer<typeof OverlaySchema>;
