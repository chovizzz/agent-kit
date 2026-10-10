import { z } from 'zod';
import { AgentIdSchema, IsoDateSchema, IsoTimestampSchema, RenderAgentIdSchema } from './common.js';
import { ModelTierSchema } from './agent-def.js';

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

/** `kit.toml`(core 仓库根)。 */
export const KitConfigSchema = z.strictObject({
  kit: z.strictObject({
    name: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
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
});
export type Overlay = z.infer<typeof OverlaySchema>;
