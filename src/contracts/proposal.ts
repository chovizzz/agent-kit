import { z } from 'zod';
import { KebabIdSchema, MAX_EVIDENCE_EXCERPT_CHARS, codePointLength } from './common.js';
import { LayerSchema } from './atom.js';

/**
 * P1 的口子:`proposals/<id>.yaml`(设计 §5.5)与裁判输出(§6.5)。P0 只定义 schema,不实现任何命令。
 */

/** 兜底链顺序(设计 §6.5);hops 必须是它的前缀,中间不能缺跳。 */
export const JUDGE_HOP_CHAIN = [
  'codex',
  'maas-deepseek',
  'glm',
  'kimi',
  'official-deepseek',
] as const;
export const JudgeHopIdSchema = z.enum(JUDGE_HOP_CHAIN);
export type JudgeHopId = z.infer<typeof JudgeHopIdSchema>;

/** ok | skipped:cooldown | skipped:same-vendor | error:<码>。Q-N16 未决:不含 skipped:known-unavailable。 */
export const HopResultSchema = z
  .string()
  .regex(/^(ok|skipped:(cooldown|same-vendor)|error:[A-Za-z0-9_.-]+)$/);

export const JudgeHopSchema = z.strictObject({
  hop: JudgeHopIdSchema,
  vendor: z.string().min(1),
  model: z.string().min(1),
  result: HopResultSchema,
});

/** 提案 CI 校验用的结构化裁判记录。 */
export const JudgeRecordSchema = z
  .strictObject({
    hops: z.array(JudgeHopSchema).min(1),
    provider: z.string().min(1),
    /** 模型厂商,不是接入渠道:MaaS DeepSeek 与官方 DeepSeek 同属 deepseek */
    vendor: z.string().min(1),
    verdict: z.enum(['accept', 'revise', 'reject']),
    overfit_risk: z.enum(['low', 'medium', 'high']),
    injection_suspected: z.boolean(),
    conflicts: z.array(z.string()),
  })
  .superRefine((j, ctx) => {
    j.hops.forEach((h, i) => {
      if (h.hop !== JUDGE_HOP_CHAIN[i]) {
        ctx.addIssue({
          code: 'custom',
          path: ['hops', i, 'hop'],
          message: `hops 必须是兜底链 ${JUDGE_HOP_CHAIN.join('→')} 的前缀,第 ${i + 1} 跳应为 ${JUDGE_HOP_CHAIN[i]}`,
        });
      }
      const last = i === j.hops.length - 1;
      if (last && h.result !== 'ok') {
        ctx.addIssue({ code: 'custom', path: ['hops', i, 'result'], message: '最后一跳必须 ok' });
      }
      if (!last && h.result === 'ok') {
        ctx.addIssue({
          code: 'custom',
          path: ['hops', i, 'result'],
          message: 'ok 之后不应再有后续跳',
        });
      }
    });
  });
export type JudgeRecord = z.infer<typeof JudgeRecordSchema>;

/** 裁判的原始输出 schema(设计 §6.5)。generality / overfit_risk 的取值档是本契约的假设(设计只给了字段名)。 */
export const JudgeOutputSchema = z.strictObject({
  verdict: z.enum(['accept', 'revise', 'reject']),
  overfit_risk: z.enum(['low', 'medium', 'high']),
  generality: z.enum(['low', 'medium', 'high']),
  volatile: z.boolean(),
  conflicts: z.array(z.string()),
  injection_suspected: z.boolean(),
  notes: z.string(),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export const ProposalEvidenceSchema = z.strictObject({
  sig: z.string().min(1),
  project_key: z.string().min(1),
  excerpt: z.string().refine((s) => codePointLength(s) <= MAX_EVIDENCE_EXCERPT_CHARS, {
    message: `excerpt 超过 ${MAX_EVIDENCE_EXCERPT_CHARS} 字`,
  }),
});

export const ProposalSchema = z
  .strictObject({
    /** `YYYY-MM-DD-NNN` */
    id: z.string().regex(/^\d{4}-\d{2}-\d{2}-\d{3}$/),
    op: z.enum(['add', 'edit', 'merge', 'retire', 'escalate']),
    targets: z.array(KebabIdSchema).min(1),
    layer: LayerSchema,
    rationale: z.string().min(1),
    /** CI 无法访问提案人的本地信号库,所以必须内嵌脱敏摘录 */
    evidence: z.array(ProposalEvidenceSchema).min(1),
    budget_delta_bytes: z.number().int(),
    /** 目标预算 ≥90% 时必填(由 CI 判,空数组也合法) */
    paired_retirements: z.array(KebabIdSchema),
    cases: z.array(z.string()),
    /** 由 `reflect` 自动写入,不可手填 */
    reflector: z.strictObject({
      provider: z.string().min(1),
      /** 模型厂商,用于「裁判与反思器不同厂商」校验 */
      vendor: z.string().min(1),
      model: z.string().min(1),
      run_id: z.string().min(1),
    }),
    /** 由运行裁判的一方写入;裁判运行前缺省 */
    judge: JudgeRecordSchema.optional(),
  })
  .superRefine((p, ctx) => {
    if (!p.judge) return;
    if (p.judge.vendor === p.reflector.vendor) {
      ctx.addIssue({
        code: 'custom',
        path: ['judge', 'vendor'],
        message: '裁判厂商不得等于反思器厂商',
      });
    }
    p.judge.hops.forEach((h, i) => {
      if (h.vendor === p.reflector.vendor && h.result !== 'skipped:same-vendor') {
        ctx.addIssue({
          code: 'custom',
          path: ['judge', 'hops', i, 'result'],
          message: '与反思器同厂商的跳必须记为 skipped:same-vendor',
        });
      }
    });
  });
export type Proposal = z.infer<typeof ProposalSchema>;
