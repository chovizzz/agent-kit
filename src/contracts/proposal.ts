import { z } from 'zod';
import {
  KebabIdSchema,
  MAX_EVIDENCE_EXCERPT_CHARS,
  Sha256Schema,
  codePointLength,
} from './common.js';
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
    /**
     * L0 追加(⑨A):评审时规则文本的哈希(`Atom.sha256` 先把 `status` / `review_by` 归一化掉再算)。
     * 可选:旧记录没有它仍合法;晋升判据(L1+)要求必填且与当前文本一致,这里只管形状。
     */
    rule_sha256: Sha256Schema.optional(),
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

/** 厂商 id 比较前归一化(大小写、首尾空白不能用来绕过同厂商检查) */
function normVendor(v: string): string {
  return v.trim().toLowerCase();
}

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
      /**
       * R0 追加(#24),以下全部可选。`backend` = 实际调用的 CLI;CI 用它(加 provider、model)重算
       * `deriveVendor()`,与 `vendor` 不一致就拒——否则手改 yaml 的 `vendor` 就能绕过 contracts #18。
       */
      backend: z.enum(['claude', 'codex', 'pi']).optional(),
      /** 提示模板 id,如 `reflect-v1` */
      prompt_id: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
        .optional(),
      /** 提示模板原文(不含数据)的哈希 */
      prompt_sha256: Sha256Schema.optional(),
      /** 规范化后输入 JSON 的哈希,`sha256:<hex>` */
      input_digest: z
        .string()
        .regex(/^sha256:[0-9a-f]{64}$/)
        .optional(),
      /** 产出该提案的 reflect 所属 kit 版本(semver) */
      kit_version: z
        .string()
        .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
        .optional(),
      /**
       * 由假 LLM(stub)产出的提案。只允许 `true`(`false` 与缺省同义,所以不收)。
       * **CI 必须拒收 stub=true 的提案**:它只用于本机测试,不得进入合并流程(拒收逻辑属于 CI 校验,不在本 schema)。
       */
      stub: z.literal(true).optional(),
    }),
    /** 由运行裁判的一方写入;裁判运行前缺省 */
    judge: JudgeRecordSchema.optional(),
    /**
     * R0 追加(#25):裁判链上每一跳的记账。**只在 `judge` 缺省时允许**——
     * `JudgeRecord` 要求最后一跳 ok,全链都跳过或失败时没处记账,由本字段承接。
     * 不允许 `ok`(成功的一跳应写进 `judge`);必须**记满整条兜底链**(hop 顺序 = JUDGE_HOP_CHAIN):
     * 没配置的槽位记 `error:not_configured` 并用哨兵 `vendor:"unknown", model:"-"`,预算耗尽未尝试的跳记
     * `error:budget_exhausted`——只要求前缀的话,「有一家能评却没去评」会被藏掉;
     * 之后补跑成功时,judge 模块必须写 `judge` 并删除本字段;
     * 与反思器同厂商的跳必须是 `skipped:same-vendor`,反之亦然(不能给不同厂商的跳贴这个标签)。
     */
    judge_attempts: z.array(JudgeHopSchema).min(1).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.judge_attempts) {
      if (p.judge) {
        ctx.addIssue({
          code: 'custom',
          path: ['judge_attempts'],
          message: 'judge 已存在时不得同时有 judge_attempts(成功的一跳属于 judge.hops)',
        });
      }
      if (p.judge_attempts.length !== JUDGE_HOP_CHAIN.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['judge_attempts'],
          message: `judge_attempts 必须记满整条兜底链(${JUDGE_HOP_CHAIN.length} 跳),实际 ${p.judge_attempts.length}`,
        });
      }
      const mine = normVendor(p.reflector.vendor);
      p.judge_attempts.forEach((h, i) => {
        if (h.hop !== JUDGE_HOP_CHAIN[i]) {
          ctx.addIssue({
            code: 'custom',
            path: ['judge_attempts', i, 'hop'],
            message: `judge_attempts 必须是兜底链 ${JUDGE_HOP_CHAIN.join('→')} 的前缀,第 ${i + 1} 跳应为 ${JUDGE_HOP_CHAIN[i]}`,
          });
        }
        if (h.result === 'ok') {
          ctx.addIssue({
            code: 'custom',
            path: ['judge_attempts', i, 'result'],
            message: 'judge_attempts 不记 ok(成功的一跳应写进 judge)',
          });
        }
        const same = normVendor(h.vendor) === mine;
        if (same && h.result !== 'skipped:same-vendor') {
          ctx.addIssue({
            code: 'custom',
            path: ['judge_attempts', i, 'result'],
            message: '与反思器同厂商的跳必须记为 skipped:same-vendor',
          });
        }
        if (!same && h.result === 'skipped:same-vendor') {
          ctx.addIssue({
            code: 'custom',
            path: ['judge_attempts', i, 'result'],
            message: '厂商不同的跳不得记为 skipped:same-vendor',
          });
        }
      });
    }
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
