import { z } from 'zod';
import {
  IsoDateSchema,
  IsoTimestampSchema,
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

/**
 * K1 追加(RSI 借鉴 §1.2):预测账。预测对象固定为验收窗口的曝光率比值
 * `r = 验收 exposure_rate / 基线 exposure_rate`;LLM 只给 direction / ratio_lo / ratio_hi / confidence 四个值,
 * 其余(metric、status、acceptance_sha256)由 kit 计算填写。
 *
 * 网格:JSON/YAML 都没有 Infinity,所以最后一格用字符串 `'inf'` 表示 +∞(不用 `null`:
 * 在 strictObject + optional 的语境里 `null` 与「缺省」语义冲突)。**所有位置/跨度比较一律按 `RATIO_GRID` 下标做,
 * 不做数值比较**,`'inf'` 因此不会产生 NaN。规范形(进哈希时):数字用 JS 数字(`4` 不是 `4.0`),+∞ 恒为字符串 `"inf"`。
 */
export const RATIO_GRID = [0, 0.1, 0.25, 0.5, 0.8, 1.25, 2, 4, 'inf'] as const;
export type RatioGridPoint = (typeof RATIO_GRID)[number];
export const RatioGridPointSchema = z.union([
  z.literal(0),
  z.literal(0.1),
  z.literal(0.25),
  z.literal(0.5),
  z.literal(0.8),
  z.literal(1.25),
  z.literal(2),
  z.literal(4),
  z.literal('inf'),
]);
/** 区间在网格上的最大下标差(锐度上限,防「永远报 [0,+inf] 必中」) */
export const PREDICTION_MAX_GRID_SPAN = 3;
/** 置信度 = 「实际 r 落在 [lo,hi] 的概率」,只能取这三档 */
export const PREDICTION_CONFIDENCES = [0.5, 0.7, 0.9] as const;
export type PredictionConfidence = (typeof PREDICTION_CONFIDENCES)[number];
export const PredictionConfidenceSchema = z.union([z.literal(0.5), z.literal(0.7), z.literal(0.9)]);
/** down / flat / up;flat = r ∈ [0.8, 1.25] */
export const PREDICTION_DIRECTIONS = ['down', 'flat', 'up'] as const;
export const PredictionDirectionSchema = z.enum(PREDICTION_DIRECTIONS);
export type PredictionDirection = z.infer<typeof PredictionDirectionSchema>;
/** 由 kit 决定,LLM 不参与 */
export const PREDICTION_STATUSES = [
  'predicted',
  'baseline_insufficient',
  'not_measurable',
] as const;
export const PredictionStatusSchema = z.enum(PREDICTION_STATUSES);
export type PredictionStatus = z.infer<typeof PredictionStatusSchema>;
/** 目前只有曝光率;日后加 harmful 预测用新枚举值 */
export const PREDICTION_METRICS = ['exposure_rate'] as const;
export const PredictionMetricSchema = z.enum(PREDICTION_METRICS);

/** `validatePredictionShape` 的原因码(稳定码 `prediction_invalid` 的细分,见 docs/contracts.md §18.8) */
export const PREDICTION_SHAPE_REASONS = [
  'lo_off_grid',
  'hi_off_grid',
  'lo_inf',
  'order',
  'span',
  'direction_down',
  'direction_up',
  'direction_flat',
  'direction_unknown',
  'confidence_off_grid',
] as const;
export type PredictionShapeReason = (typeof PREDICTION_SHAPE_REASONS)[number];

export interface PredictionShapeInput {
  direction?: unknown;
  ratio_lo?: unknown;
  ratio_hi?: unknown;
  confidence?: unknown;
}

/** 纯函数、不抛错:返回**全部**违反项(不提前返回);空数组 = 形状合法。judge 输出校验与 CI 复用。 */
export function validatePredictionShape(p: PredictionShapeInput): PredictionShapeReason[] {
  const out: PredictionShapeReason[] = [];
  // 直接在 zod 之外调用本函数的人(CI)也不能因为方向/置信度写错而整条放行
  if (!(PREDICTION_DIRECTIONS as readonly unknown[]).includes(p.direction)) {
    out.push('direction_unknown');
  }
  if (
    p.confidence !== undefined &&
    !(PREDICTION_CONFIDENCES as readonly unknown[]).includes(p.confidence)
  ) {
    out.push('confidence_off_grid');
  }
  const grid: readonly unknown[] = RATIO_GRID;
  const lo = grid.indexOf(p.ratio_lo);
  const hi = grid.indexOf(p.ratio_hi);
  const iInf = RATIO_GRID.length - 1;
  if (lo < 0) out.push('lo_off_grid');
  else if (lo === iInf) out.push('lo_inf');
  if (hi < 0) out.push('hi_off_grid');
  if (lo < 0 || hi < 0) return out; // 下标不可得,区间类检查无从谈起
  if (lo >= hi) out.push('order');
  else if (hi - lo > PREDICTION_MAX_GRID_SPAN) out.push('span');
  const iLow = RATIO_GRID.indexOf(0.8); // 0.8 的下标
  const iHigh = RATIO_GRID.indexOf(1.25); // 1.25 的下标
  // down ⇒ lo < 0.8;up ⇒ hi > 1.25;flat ⇒ 闭区间 [lo,hi] 与 [0.8,1.25] 相交
  if (p.direction === 'down' && !(lo < iLow)) out.push('direction_down');
  if (p.direction === 'up' && !(hi > iHigh)) out.push('direction_up');
  if (p.direction === 'flat' && !(lo <= iHigh && hi >= iLow)) out.push('direction_flat');
  return out;
}

/** 原因码 → 出问题的字段(order / span 同时涉及两端,约定记在 ratio_hi) */
function shapeReasonField(r: PredictionShapeReason): string {
  switch (r) {
    case 'lo_off_grid':
    case 'lo_inf':
      return 'ratio_lo';
    case 'hi_off_grid':
    case 'order':
    case 'span':
      return 'ratio_hi';
    case 'confidence_off_grid':
      return 'confidence';
    default:
      return 'direction';
  }
}

function refinePredictionShape(
  p: PredictionShapeInput,
  ctx: z.RefinementCtx,
  basePath: (string | number)[] = [],
): void {
  for (const reason of validatePredictionShape(p)) {
    ctx.addIssue({
      code: 'custom',
      path: [...basePath, shapeReasonField(reason)],
      message: `prediction_invalid:${reason}`,
    });
  }
}

/** LLM 给出的四个值(裁判输出里的 `prediction`) */
export const PredictionValuesSchema = z
  .strictObject({
    direction: PredictionDirectionSchema,
    ratio_lo: RatioGridPointSchema,
    ratio_hi: RatioGridPointSchema,
    confidence: PredictionConfidenceSchema,
  })
  .superRefine((p, ctx) => refinePredictionShape(p, ctx));
export type PredictionValues = z.infer<typeof PredictionValuesSchema>;

/**
 * 落进 `judge.prediction` 的记录。`status=predicted` 时四值必填且形状合法;其余 status 四值必须缺省
 * (LLM 给了也丢弃,所以落盘里不会有)。`acceptance_sha256` 绑定冻结的验收协议,**恒必填**
 * (与 `judge.acceptance.sha256` 是否相等由 G3 判,得到 `ACCEPTANCE_HASH_MISMATCH`,这里只管形状)。
 */
export const JudgePredictionSchema = z
  .strictObject({
    schema_version: z.literal(1),
    metric: PredictionMetricSchema,
    status: PredictionStatusSchema,
    direction: PredictionDirectionSchema.optional(),
    ratio_lo: RatioGridPointSchema.optional(),
    ratio_hi: RatioGridPointSchema.optional(),
    confidence: PredictionConfidenceSchema.optional(),
    acceptance_sha256: Sha256Schema,
  })
  .superRefine((p, ctx) => {
    const keys = ['direction', 'ratio_lo', 'ratio_hi', 'confidence'] as const;
    if (p.status === 'predicted') {
      for (const k of keys) {
        if (p[k] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [k],
            message: `prediction_invalid:missing_${k}`,
          });
        }
      }
      if (keys.every((k) => p[k] !== undefined)) refinePredictionShape(p, ctx);
    } else {
      for (const k of keys) {
        if (p[k] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [k],
            message: `prediction_invalid:unexpected_${k}`,
          });
        }
      }
    }
  });
export type JudgePrediction = z.infer<typeof JudgePredictionSchema>;

const GitOidSchema = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * K1 追加(RSI 借鉴 §2.3):冻结的验收协议,judge 写入评审记录时由 kit 确定性计算。
 * 本 schema 只管形状;`sha256` 自哈希、与 prediction/rule_sha256/签名的相等、`guidance_until ≤ frozen_at`、
 * git 锚点等全部由 G3(K4)核验,各有自己的稳定码(`ACCEPTANCE_*`)。
 * `method` 写成字面量而不 import `attest.ts`(attest → config → proposal 会成环);与 `ATTEST_METHODS` 的一致由测试钉住。
 */
export const AcceptanceProtocolSchema = z.strictObject({
  schema_version: z.literal(1),
  method: z.literal('signature_proxy_v1'),
  rule_sha256: Sha256Schema,
  /** 签名 `{type,pattern}` 的 canonical JSON 哈希 */
  signature_sha256: Sha256Schema,
  /** 引导窗口上界(ISO 时间戳) */
  guidance_until: IsoTimestampSchema,
  /** `reflector.guidance` canonical JSON 的哈希 */
  baseline_sha256: Sha256Schema,
  /** judge 运行时仓库 HEAD 的提交 oid(外部锚点;40 位小写 hex) */
  judged_at_head: GitOidSchema,
  /** judge 时钟(纸面时间,只作交叉核对) */
  frozen_at: IsoTimestampSchema,
  /** D0 的文件内下界(ISO 日期) */
  anchor_min: IsoDateSchema,
  tile_days: z.number().int().min(7),
  max_tiles: z.number().int().min(2).max(8),
  /** 对以上所有字段(不含本字段)canonical JSON 的 sha256 */
  sha256: Sha256Schema,
});
export type AcceptanceProtocol = z.infer<typeof AcceptanceProtocolSchema>;

/** K1 追加(§2.2):reflect 写入的引导窗口落账。基线只有计数。自洽性(exposure ≤ total 等)由 G3 判。 */
export const ReflectorGuidanceSchema = z.strictObject({
  /** `reflect --since`;null = 不设下界 */
  since: IsoDateSchema.nullable(),
  /** reflect 运行时钟(ISO 时间戳) */
  until: IsoTimestampSchema,
  baseline: z.strictObject({
    sessions_total: z.number().int().nonnegative(),
    exposure_sessions: z.number().int().nonnegative(),
    fired: z.number().int().nonnegative(),
  }),
});
export type ReflectorGuidance = z.infer<typeof ReflectorGuidanceSchema>;

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
    /** K1 追加:预测账(可选;旧记录没有它仍合法,晋升要求冻结见 G3 `ACCEPTANCE_MISSING`) */
    prediction: JudgePredictionSchema.optional(),
    /** K1 追加:冻结的验收协议 */
    acceptance: AcceptanceProtocolSchema.optional(),
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
  /** K1 追加:裁判 v2 提示要求时必填(由 output 解析层强制),schema 层可选以兼容 v1 输出 */
  prediction: PredictionValuesSchema.optional(),
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
      /** K1 追加:引导窗口落账(reflect 写,不可手填) */
      guidance: ReflectorGuidanceSchema.optional(),
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
