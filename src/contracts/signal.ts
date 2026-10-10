import { z } from 'zod';
import { AgentIdSchema, IsoTimestampSchema, SessionRefIdSchema, Sha256Schema } from './common.js';

export const SignalTypeSchema = z.enum([
  'memory_write',
  'explicit_lesson',
  'user_correction',
  'hook_deny',
  'tool_fail_retry',
  'revert',
  'pi_hermes_entry',
  /** P0 reader 只产出归一化事件,不做信号分类(分类是 P1 反思器的输入工作) */
  'event',
]);
export type SignalType = z.infer<typeof SignalTypeSchema>;

// D2 落地(P1):`unknown` = 连 CLI 版本兜底都取不到;`collector_fallback` = 用 CLI 版本兜底成功。
export const AgentVersionSourceSchema = z.enum(['session_meta', 'collector_fallback', 'unknown']);

export const MAX_EXCERPT_CHARS = 300;

/** 设计 §6.2 的信号结构。 */
export const SignalSchema = z.strictObject({
  /** 稳定哈希(同一输入同一值);不含原文 */
  sig_id: z.string().regex(/^sig_[0-9a-f]{16}$/),
  agent: AgentIdSchema,
  agent_version: z.string().min(1),
  agent_version_source: AgentVersionSourceSchema,
  /** 会话路径哈希(加盐策略见 docs/contracts.md Q-N7) */
  session_ref: SessionRefIdSchema,
  /** 项目哈希;覆盖层允许名单内可用明文 */
  project_key: z.string().min(1),
  ts: IsoTimestampSchema,
  type: SignalTypeSchema,
  /** 已脱敏摘录,≤300 字;涉及外部内容的会话为空串(只保留结构化计数) */
  excerpt_redacted: z.string().refine((s) => Array.from(s).length <= MAX_EXCERPT_CHARS, {
    message: `excerpt_redacted 超过 ${MAX_EXCERPT_CHARS} 字`,
  }),
  external_content: z.boolean(),
  confidence: z.number().min(0).max(1),
  loaded_rule_ids: z.array(z.string()),
});
export type Signal = z.infer<typeof SignalSchema>;

/** `signals collect --dry` 的报告(只含计数与哈希,不含会话正文)。 */
export const CollectReportSchema = z.strictObject({
  agent: AgentIdSchema,
  sessions_read: z.number().int().nonnegative(),
  sessions_skipped_excluded: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  signals_emitted: z.number().int().nonnegative(),
  /** 脱敏第二遍命中或扫描失败而丢弃的信号数 */
  signals_dropped_redaction: z.number().int().nonnegative(),
  unknown_event_types: z.record(z.string(), z.number().int().nonnegative()),
  oversized_lines: z.number().int().nonnegative().optional(),
  agent_version_fallback_ratio: z.number().min(0).max(1),
  /**
   * D1 落地(P1,方案 A):codex 的 `tool_failures` 是下界口径——只数 5 种工具类 item 上
   * 结构化的 `status === "failed"`,0.149 之前的 shell 失败不可见。该标记声明本次报告的
   * 适用性:`full` = 全部会话 cli_version >= 0.149;`codex_pre_0149_limited` = 任一会话
   * 版本更老或版本未知(取不到就不能证明可见性,按受限口径归档)。仅 codex 报告携带;
   * 其他 agent 的 `tool_failures` 恒为全量,不带此字段。
   */
  tool_failures_scope: z.enum(['full', 'codex_pre_0149_limited']).optional(),
  input_sha256: Sha256Schema.optional(),
});
export type CollectReport = z.infer<typeof CollectReportSchema>;
