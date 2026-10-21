import { z } from 'zod';
import {
  DEFAULT_ATOM_MAX_BYTES,
  KebabIdSchema,
  MAX_TITLE_CHARS,
  RunIdSchema,
  Sha256Schema,
  codePointLength,
} from './common.js';
import { AppliesToSchema, KindSchema, VolatilitySchema } from './atom.js';
import { JudgeHopIdSchema } from './proposal.js';

/**
 * 反思器的 LLM 输出与运行报告(R0,contracts #27)。
 * LLM 的唯一合法输出形状是 `ReflectorOutputSchema`:**每一层对象都是 strictObject**,
 * 所以 `status` / `strength` / `disables` / `overrides` / `owner` / `layer` 等字段出现即拒——
 * 这些由合并器(非 LLM)决定:status 写死 proposed、strength 写死 should、layer 按证据机械判定、owner 由命令行给。
 */

export const MAX_PROPOSALS_PER_BATCH = 5;
export const MAX_OBSERVATIONS = 10;
export const MAX_SIGNATURE_PATTERN_CHARS = 200;
export const MAX_RATIONALE_CHARS = 300;
export const MAX_OBSERVATION_NOTE_CHARS = 200;
export const MAX_EVIDENCE_ALIASES = 20;
/** signature.pattern 的统一编译旗标。**使用方必须用同一旗标编译**,并在匹配前限制被匹配串长度(≤4KiB)。 */
export const SIGNATURE_REGEX_FLAGS = 'u';

// ---------------------------------------------------------------------------
// signature.pattern 的 ReDoS 保守检查
// ---------------------------------------------------------------------------

export type PatternSafety = { ok: true } | { ok: false; reason: string };

const MAX_REPEAT_BOUND = 100;
const MAX_UNBOUNDED_QUANTIFIERS = 3;
const MAX_REPEAT_QUANTIFIERS = 6;

interface Frame {
  /** 本组(含嵌套子组)内出现过可重复超过 1 次的量词 */
  quant: boolean;
  /** 本组(含嵌套子组)内出现过 `|` */
  alt: boolean;
}

/**
 * 保守的 ReDoS 检查(宁可误杀,不放过)。拒绝:
 * - 编译失败(旗标 `u`)、长度 >200、含控制字符;
 * - 能匹配空串的模式(等价于 always,而 always 不允许);
 * - 回溯引用(`\1`、`\k<n>`)与全部 lookaround(`(?=` `(?!` `(?<=` `(?<!`);
 * - 被「可重复多次」的量词(`* + {n,} {n,m>1}`)修饰、且内部含量词或 `|` 的分组:`(a+)+`、`(a|aa)*`、`((a|b)c)+`;
 * - 任何 `{n,m}` 的 n/m >100;未限界量词(`* + {n,}`)总数 >3。
 * 这不是证明,只是把已知的指数/高次多项式回溯形态挡在门外;真正的兜底是使用方限制被匹配串长度。
 */
export function checkPatternSafety(pattern: string): PatternSafety {
  const bad = (reason: string): PatternSafety => ({ ok: false, reason });
  if (pattern.length === 0) return bad('empty');
  if (codePointLength(pattern) > MAX_SIGNATURE_PATTERN_CHARS) return bad('too_long');
  if (HIDDEN_CHARS_RE.test(pattern) || NEWLINE_RE.test(pattern)) return bad('control_chars');
  let re: RegExp;
  try {
    re = new RegExp(pattern, SIGNATURE_REGEX_FLAGS);
  } catch {
    return bad('syntax');
  }
  if (re.test('')) return bad('matches_empty');

  const stack: Frame[] = [{ quant: false, alt: false }];
  let unbounded = 0;
  let repeats = 0;
  let literals = 0;
  /** 紧邻当前位置之前刚闭合的分组(下一个 token 若是量词则作用于它) */
  let closed: Frame | undefined;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    const top = stack[stack.length - 1] as Frame;
    if (c === '\\') {
      const n = pattern[i + 1] ?? '';
      if (/[1-9]/.test(n) || n === 'k') return bad('backreference');
      if ((n === 'p' || n === 'P' || n === 'u') && pattern[i + 2] === '{') {
        const end = pattern.indexOf('}', i + 3);
        i = end === -1 ? pattern.length : end + 1;
      } else {
        if (!/[A-Za-z0-9]/.test(n)) literals++;
        i += 2;
      }
      closed = undefined;
      continue;
    }
    if (c === '[') {
      i++;
      if (pattern[i] === '^') i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i++;
      closed = undefined;
      continue;
    }
    if (c === '(') {
      if (pattern[i + 1] === '?') {
        if (pattern.startsWith('(?:', i)) {
          i += 3;
        } else if (
          pattern.startsWith('(?<', i) &&
          pattern[i + 3] !== '=' &&
          pattern[i + 3] !== '!'
        ) {
          const end = pattern.indexOf('>', i);
          if (end === -1) return bad('syntax');
          i = end + 1;
        } else {
          return bad('lookaround_or_unsupported_group');
        }
      } else {
        i++;
      }
      stack.push({ quant: false, alt: false });
      closed = undefined;
      continue;
    }
    if (c === ')') {
      const f = stack.pop() as Frame;
      const parent = stack[stack.length - 1] as Frame;
      parent.quant = parent.quant || f.quant;
      parent.alt = parent.alt || f.alt;
      closed = f;
      i++;
      continue;
    }
    if (c === '|') {
      top.alt = true;
      closed = undefined;
      i++;
      continue;
    }
    if (c === '*' || c === '+' || c === '?' || c === '{') {
      let max: number;
      let len = 1;
      if (c === '*' || c === '+') {
        max = Infinity;
      } else if (c === '?') {
        max = 1;
      } else {
        const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i));
        if (!m) return bad('syntax');
        len = m[0].length;
        const lo = Number(m[1]);
        const hi = m[2] === undefined ? lo : m[3] === '' ? Infinity : Number(m[3]);
        if (lo > MAX_REPEAT_BOUND || (hi !== Infinity && hi > MAX_REPEAT_BOUND)) {
          return bad('repeat_bound_too_large');
        }
        max = hi;
      }
      if (max === Infinity) unbounded++;
      if (max > 1) {
        repeats++;
        if (closed && (closed.quant || closed.alt)) return bad('nested_quantifier_or_alternation');
      }
      // `?` 与有界量词同样让所在分组变成「内部有量词」:(a?a?)+ 是指数回溯
      top.quant = true;
      i += len;
      if (pattern[i] === '?') i++; // 惰性修饰符
      closed = undefined;
      continue;
    }
    if (c !== '.' && c !== '^' && c !== '$' && c !== '}') literals++;
    closed = undefined;
    i++;
  }
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) return bad('too_many_unbounded_quantifiers');
  if (repeats > MAX_REPEAT_QUANTIFIERS) return bad('too_many_repeat_quantifiers');
  // 至少要有一个字面量字符(类外),否则 `.` `\b` `\w+` 等价于 always
  if (literals < 1) return bad('no_literal');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 文本卫生
// ---------------------------------------------------------------------------

/**
 * 控制字符(含 DEL/C1)、零宽、bidi 控制(含 U+061C)、BOM、Unicode tag 段(U+E0000–E007F)、
 * 变体选择符(U+FE00–FE0F、U+E0100–E01EF)与 Hangul 填充(U+115F/1160/3164/FFA0):
 * 既不该进规则,也是常见的隐藏指令载体。TAB/LF/CR 不在此列。
 * 与命令层 `src/reflect/text.ts` 的 `hasInvisible` 同口径(含 FE0F:带 U+FE0F 的 emoji 呈现序列、ZWJ 序列会被拦,
 * 普通中文与无变体选择符的 emoji 不受影响)。
 */
const HIDDEN_CHARS_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u115f\u1160\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
const NEWLINE_RE = /[\n\r\t\u2028\u2029\u0085]/;
/** 伪造原子正文标签 / frontmatter 分隔线 */
const FORGED_LABEL_RE =
  /\*\*\s*(做|为什么|怎么验)\s*[:：]?\s*\*\*|^\s{0,3}#{1,6}\s*(做|为什么|怎么验)|^\s*```/m;
const FRONTMATTER_FENCE_RE = /^\s*---/m;

const nonBlank = (s: string): boolean => s.trim().length > 0;

function singleLine(max: number) {
  return z
    .string()
    .min(1)
    .refine((s) => codePointLength(s) <= max, { message: `超过 ${max} 字` })
    .refine(nonBlank, { message: '不能只有空白' })
    .refine((s) => !HIDDEN_CHARS_RE.test(s) && !NEWLINE_RE.test(s), {
      message: '含控制字符、零宽/bidi 字符或换行',
    });
}

const segment = z
  .string()
  .min(1)
  .refine(nonBlank, { message: '不能只有空白' })
  .refine((s) => !HIDDEN_CHARS_RE.test(s), { message: '含控制字符或零宽/bidi 字符' })
  .refine((s) => !FORGED_LABEL_RE.test(s.normalize('NFKC')), {
    message: '不得伪造 做/为什么/怎么验 段标签、标题或代码围栏',
  })
  .refine((s) => !FRONTMATTER_FENCE_RE.test(s), { message: '不得以 --- 开头(frontmatter 分隔线)' });

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------------------
// ReflectorOutput
// ---------------------------------------------------------------------------

export const EvidenceAliasSchema = z.string().regex(/^e\d{1,5}$/);

export const ReflectorSignatureSchema = z
  .strictObject({
    /** 不允许 `always`:反思器产出的原子必须能被命中计数 */
    type: z.enum(['tool', 'path', 'phrase']),
    pattern: z
      .string()
      .min(1)
      .max(MAX_SIGNATURE_PATTERN_CHARS * 4),
  })
  .superRefine((s, ctx) => {
    const r = checkPatternSafety(s.pattern);
    if (!r.ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: `signature.pattern 不安全:${r.reason}`,
      });
    }
  });

export interface ReflectorOutputOptions {
  /** 三段正文(UTF-8 字节)合计上限;缺省 = 预算默认的 `atom_max_bytes` */
  atomMaxBytes?: number;
  /** 每批提案数上限,≤5 */
  maxProposals?: number;
}

/**
 * 工厂:`atom_max_bytes` 来自配置,所以 schema 随配置生成。注意这里只数 do/why/verify 三段正文本身;
 * 合并器落地后的 `bodyBytes`(含段标签)仍以原子 lint 为准。
 */
export function makeReflectorOutputSchema(opts: ReflectorOutputOptions = {}) {
  const atomMaxBytes = opts.atomMaxBytes ?? DEFAULT_ATOM_MAX_BYTES;
  const maxProposals = Math.min(
    opts.maxProposals ?? MAX_PROPOSALS_PER_BATCH,
    MAX_PROPOSALS_PER_BATCH,
  );
  const Proposal = z
    .strictObject({
      /** P1 只做 add(决策 ⑧A);edit/retire/escalate 只能写进 observations */
      op: z.literal('add'),
      id: KebabIdSchema,
      title: singleLine(MAX_TITLE_CHARS),
      do: segment,
      why: segment,
      verify: segment,
      kind: KindSchema,
      volatility: VolatilitySchema,
      applies_to: AppliesToSchema.optional(),
      signature: ReflectorSignatureSchema,
      /** 证据别名(`e1`…),必须是输入集合的子集——「子集」由校验器对照输入判定,schema 只管形状 */
      evidence: z
        .array(EvidenceAliasSchema)
        .min(1)
        .max(MAX_EVIDENCE_ALIASES)
        .refine((a) => new Set(a).size === a.length, { message: '证据别名不得重复' }),
      rationale: singleLine(MAX_RATIONALE_CHARS),
    })
    .superRefine((p, ctx) => {
      const bytes = utf8Bytes(p.do) + utf8Bytes(p.why) + utf8Bytes(p.verify);
      if (bytes > atomMaxBytes) {
        ctx.addIssue({
          code: 'custom',
          path: ['do'],
          message: `do/why/verify 合计 ${bytes} 字节,超过上限 ${atomMaxBytes}`,
        });
      }
    });
  const Observation = z.strictObject({
    kind: z.enum(['edit', 'retire', 'escalate']),
    target_id: KebabIdSchema,
    note: singleLine(MAX_OBSERVATION_NOTE_CHARS),
  });
  return z.strictObject({
    proposals: z
      .array(Proposal)
      .max(maxProposals)
      .refine((a) => new Set(a.map((p) => p.id)).size === a.length, {
        message: '同一批内提案 id 不得重复',
      }),
    /** 只写进报告,不生成任何文件 */
    observations: z.array(Observation).max(MAX_OBSERVATIONS).optional(),
  });
}

export const ReflectorOutputSchema = makeReflectorOutputSchema();
export type ReflectorOutput = z.infer<typeof ReflectorOutputSchema>;
export type ReflectorProposalDraft = ReflectorOutput['proposals'][number];

// ---------------------------------------------------------------------------
// ReflectRunReport(只含计数与哈希,绝不含摘录/提示原文)
// ---------------------------------------------------------------------------

const count = z.number().int().nonnegative();
const REJECT_CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export const ReflectRunReportSchema = z
  .strictObject({
    run_id: RunIdSchema,
    /** dry = 干跑(零调用零写入);stub = 假 LLM;llm = 真调用 */
    mode: z.enum(['dry', 'stub', 'llm']),
    signals_loaded: count,
    signals_dropped: z.strictObject({
      schema: count,
      residual: count,
      external_excerpt_forced: count,
    }),
    clusters: count,
    evidence_sent: count,
    prompt_bytes: count,
    /** 提示模板+数据的哈希;提示没构造出来时为 null */
    prompt_sha256: Sha256Schema.nullable(),
    input_digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullable(),
    backend: z
      .strictObject({
        slot: JudgeHopIdSchema,
        vendor: z.string().min(1),
        model: z.string().min(1),
      })
      .nullable(),
    calls_made: count,
    calls_limit: z.number().int().min(1).max(3),
    outcome: z.enum(['staged', 'no_proposals', 'output_rejected', 'not_run']),
    /** 拒收原因码 → 次数 */
    rejected: z.record(z.string().regex(REJECT_CODE_RE), count),
    staged: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}-\d{3}$/)),
    observations_n: z.number().int().min(0).max(MAX_OBSERVATIONS),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (r.calls_made > r.calls_limit) issue('calls_made', 'calls_made 超过 calls_limit');
    if (r.mode === 'dry') {
      if (r.calls_made !== 0) issue('calls_made', '干跑不得有任何后端调用');
      if (r.outcome !== 'not_run') issue('outcome', '干跑的 outcome 必须是 not_run');
      if (r.staged.length !== 0) issue('staged', '干跑不得暂存任何提案');
    }
    if (r.outcome === 'staged' && r.staged.length === 0)
      issue('staged', 'outcome=staged 需要至少一条');
    if (r.outcome !== 'staged' && r.staged.length !== 0)
      issue('staged', '只有 outcome=staged 才有暂存提案');
  });
export type ReflectRunReport = z.infer<typeof ReflectRunReportSchema>;
