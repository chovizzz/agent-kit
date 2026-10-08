import { z } from 'zod';

/** 占位符:`[[REDACTED:<type>]]`,type 只取 [a-z_]+。第二遍用同一个精确正则先剥离占位符再扫。 */
export const PLACEHOLDER_SOURCE = String.raw`\[\[REDACTED:[a-z_]+\]\]`;
export const PlaceholderTypeSchema = z.string().regex(/^[a-z_]+$/);

/**
 * 命中记录:只含类型、规则名与偏移,**不含命中文本**——诊断输出不能泄露它要拦的东西。
 */
export const HitSchema = z.strictObject({
  type: PlaceholderTypeSchema,
  rule: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type Hit = z.infer<typeof HitSchema>;

export const RedactFailReasonSchema = z.enum(['residual', 'error', 'timeout']);
export type RedactFailReason = z.infer<typeof RedactFailReasonSchema>;

export const RedactionConfigSchema = z.strictObject({
  /** 额外的密钥前缀(与内置 sk- / soh_ / soh_svc_ 合并) */
  extra_secret_prefixes: z.array(z.string().min(1)).default([]),
  sensitive_words: z.array(z.string().min(1)).default([]),
  /** 公开允许名单内的 URL 主机不替换 */
  allowed_url_hosts: z.array(z.string().min(1)).default([]),
  /** 每条输入的时间预算(毫秒);超限视为失败,不是放行 */
  timeout_ms: z.number().int().positive().default(50),
  max_input_chars: z.number().int().positive().default(65536),
});
export type RedactionConfig = z.infer<typeof RedactionConfigSchema>;

export type RedactApply = { ok: true; text: string } | { ok: false; reason: RedactFailReason };

export interface Redactor {
  /** 第一遍:确定性替换 */
  pass1(text: string): { text: string; hits: Hit[] };
  /** 第二遍:复扫;clean=false 表示真秘密残留 */
  pass2(text: string): { clean: boolean; hits: Hit[] };
  /** 两遍合一;失败(残留/异常/超时)一律不返回文本,调用方丢弃整条信号,退出码 3 */
  apply(text: string): RedactApply;
}
