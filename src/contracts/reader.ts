import { z } from 'zod';
import { countRecordSchema } from './count-record.js';
import { AgentIdSchema, IsoTimestampSchema, SessionRefIdSchema } from './common.js';

/** 一个会话文件。`path` 是本机绝对路径,只在内存中使用,不得写入任何落盘产物。 */
export const SessionRefSchema = z.strictObject({
  agent: AgentIdSchema,
  path: z.string().min(1),
  /** 路径哈希,见 Signal.session_ref */
  session_ref: SessionRefIdSchema,
  bytes: z.number().int().nonnegative(),
});
export type SessionRef = z.infer<typeof SessionRefSchema>;

export const NormEventKindSchema = z.enum([
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'meta',
  /** 未知事件类型落到这里,并计入 Counts.unknown_event_types;绝不抛错 */
  'unknown',
]);
export type NormEventKind = z.infer<typeof NormEventKindSchema>;

/**
 * 归一化事件。`text` 是原始文本(未脱敏),只在 reader→redactor 之间流动,
 * 不得进入日志、报告、fixture。计数口径以 docs/reader-counting-spec.md(B10a)为准。
 */
export const NormEventSchema = z.strictObject({
  agent: AgentIdSchema,
  session_ref: SessionRefIdSchema,
  /** 事件自带时间戳;缺失时由 reader 回退(会话起始/文件 mtime),并在 B10a 文档写明 */
  ts: IsoTimestampSchema,
  kind: NormEventKindSchema,
  /** 源文件里的原始事件类型名,用于未知类型计数 */
  raw_type: z.string(),
  tool_name: z.string().optional(),
  /** kind=tool_result(或带结果的 tool_call)时是否失败 */
  tool_failed: z.boolean().optional(),
  text: z.string().optional(),
  /** 该事件是否来自外部内容(WebFetch/浏览器/MCP 外部文本) */
  external_content: z.boolean().optional(),
});
export type NormEvent = z.infer<typeof NormEventSchema>;

export const CountsSchema = z.strictObject({
  user_messages: z.number().int().nonnegative(),
  tool_calls: z.number().int().nonnegative(),
  tool_failures: z.number().int().nonnegative(),
  unknown_event_types: countRecordSchema(),
  /** 单行超过 maxEventBytes 而被丢弃的行数(B10b) */
  oversized_lines: z.number().int().nonnegative().optional(),
  /** Pi v3 树结构:非活动分支条目数(Q-N10;其它 agent 缺省) */
  branch_count: z.number().int().nonnegative().optional(),
  /** Codex 等同一事件被两种记录重复时,被忽略的那一种的计数(Q-N11) */
  ignored_duplicate_kinds: countRecordSchema().optional(),
});
export type Counts = z.infer<typeof CountsSchema>;

export const SessionMetaSchema = z.strictObject({
  /** 会话元数据里的版本;取不到为 null(由 collector 用 CLI 版本兜底并标 collector_fallback) */
  agent_version: z.string().nullable(),
  /** 会话声明的工作目录(用于 project_key 与 exclude_dirs 判定);只在内存中使用 */
  cwd_hint: z.string().nullable(),
  started_at: IsoTimestampSchema.nullable(),
  external_content: z.boolean(),
  /** 会话里已有的「已加载规则文件路径」字段(Pi project_context / Kimi agentsMdPaths 等),没有则空 */
  loaded_rule_paths: z.array(z.string()),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export interface ReadOpts {
  /** 哈希盐(Q-N7:本机随机盐,不入仓);测试里传固定值 */
  salt: string;
  /** 单个事件文本的最大字节,超出截断(防超大载荷) */
  maxEventBytes?: number;
}

export interface SessionRead {
  /** 流式事件;迭代结束后 counts()/meta() 才是完整值 */
  events: AsyncIterable<NormEvent>;
  counts(): Counts;
  meta(): SessionMeta;
}

export interface TraceReader {
  agent: z.infer<typeof AgentIdSchema>;
  /** 只读枚举 source 下的会话文件;source 由 --source 显式传入,reader 不得自行找 HOME */
  discover(source: string): Promise<SessionRef[]>;
  read(ref: SessionRef, opts: ReadOpts): SessionRead;
}
