import { z } from 'zod';

/** 受支持的 agent 标识。`openclaw` 默认不渲染(设计 §4.2),但可作为 applies_to 取值。 */
export const AGENT_IDS = ['claude', 'codex', 'pi', 'kimi', 'opencode', 'openclaw'] as const;
export const AgentIdSchema = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentIdSchema>;

/** 有预算/渲染目标的 agent(P0:openclaw 不渲染)。 */
export const RENDER_AGENT_IDS = ['claude', 'codex', 'pi', 'kimi', 'opencode'] as const;
export const RenderAgentIdSchema = z.enum(RENDER_AGENT_IDS);
export type RenderAgentId = z.infer<typeof RenderAgentIdSchema>;

/** kebab-case:原子 id、技能 name、子代理 name 共用。 */
export const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const KebabIdSchema = z.string().min(1).max(100).regex(KEBAB_RE);

/** YYYY-MM-DD,且必须是真实存在的日历日(拒绝 2026-02-30)。 */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, '不是真实存在的日期');
export type IsoDate = z.infer<typeof IsoDateSchema>;

/** 带毫秒或不带均可的 UTC 时间戳(如 2026-10-08T12:00:00Z);不接受无时区写法,避免 TZ 抖动。 */
export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** 会话哈希引用:`s_` + 16 位十六进制(加盐哈希,见 docs/contracts.md §9)。 */
export const SessionRefIdSchema = z.string().regex(/^s_[0-9a-f]{16}$/);

/** 运行 id:出现在文件名里,所以限定为文件名安全字符。 */
export const RunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** 字符数按 Unicode 码点计(中文一字算 1),不按 UTF-16 单元。 */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

export const MAX_TITLE_CHARS = 60;
export const MAX_EVIDENCE_EXCERPT_CHARS = 300;
export const MAX_SKILL_DESCRIPTION_CHARS = 1024;
export const DEFAULT_ATOM_MAX_BYTES = 600;
