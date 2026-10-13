/**
 * LLM 原始输出 → 通过校验的提案草稿。**不做修复重试**(把不可信文本再喂回模型等于再送一次)。
 *
 * 整批拒(任何一条触发,这批输出全部作废):
 *   output_too_large / not_json_object / schema_invalid / output_residual / placeholder_in_output / injection_suspected_local
 * 单条丢(其余提案保留):
 *   evidence_alias_unknown / id_conflict / echo_detected / pattern_unsafe
 *
 * 危险话术分两张表(opus 咨询采纳):硬拒表(治理自改/权限升级/外泄/指令层级)命中即整批拒;
 * 极性表(--no-verify、skip tests、rm -rf …)命中时,若同一子句里有否定词(「不要用 --no-verify」),
 * 视为护栏类规则放行并计 guardrail_mention,否则整批拒。双重否定(「别忘了…」)先剔除再判。
 */
import type { Redactor } from '../contracts/redact.js';
import {
  SIGNATURE_REGEX_FLAGS,
  checkPatternSafety,
  makeReflectorOutputSchema,
  type ReflectorOutput,
  type ReflectorProposalDraft,
} from '../contracts/reflect.js';
import { hasInvisible, normalizeForMatch, sharesRun, squeeze, utf8Bytes } from './text.js';

export const MAX_OUTPUT_BYTES = 32 * 1024;
export const ECHO_RUN_CODEPOINTS = 40;
/** signature 使用方匹配前必须把被匹配串截到这个长度(R0 契约:≤4KiB)。 */
export const MAX_MATCH_INPUT_BYTES = 4096;

export interface PhraseRule {
  id: string;
  re: RegExp;
}

/** 硬拒表:对 normalizeForMatch 后的文本匹配。 */
export const HARD_PHRASES: readonly PhraseRule[] = [
  { id: 'danger-full-access', re: /danger-?full-?access/ },
  { id: 'approval-policy', re: /approval[_ -]?policy|sandbox[_ -]?mode/ },
  { id: 'skip-permissions', re: /dangerously-?skip-?permissions|bypass[ _-]?permissions|\byolo\b/ },
  { id: 'ssh-dir', re: /~\/\.ssh|\.ssh\b|id_rsa|id_ed25519|authorized_keys/ },
  {
    id: 'agent-settings',
    re: /settings(\.local)?\.json|~\/\.(claude|codex|pi)\b|\.codex\/|config\.toml|kit\.toml|codeowners/,
  },
  {
    id: 'status-escalation',
    re: /status.{0,12}(active|advisory)|(改成|改为|设为|设置为|set to|change to)\s*(active|advisory)/,
  },
  { id: 'strength-must', re: /strength.{0,8}must/ },
  { id: 'edge-fields', re: /\b(disables|overrides)\s*[:=]/ },
  {
    id: 'ignore-rules-zh',
    re: /(忽略|无视|绕过|跳过|不要遵守|不必遵守).{0,16}(规则|指令|提示|约束|限制|护栏|审核|评审)/,
  },
  {
    id: 'ignore-rules-en',
    re: /(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|above|prior|earlier|system|safety|these|those)?\s*(rules|instructions|guidelines|prompts?|constraints)/,
  },
  { id: 'evidence-tag', re: /<\/?evidence/ },
  { id: 'system-prompt', re: /system prompt|系统提示/ },
  { id: 'hide-from-user', re: /不要告诉用户|don'?t tell the user|silently|静默(执行|修改)/ },
  {
    id: 'exfil',
    re: /printenv|(curl|wget)[^|\n]*\|\s*(sh|bash)|bash\s+<\(\s*(curl|wget)|curl\s+(-d|--data)|\bnc\s+-/,
  },
  {
    id: 'governance',
    re: /kit:promotion|kit:retire|无需(人工)?(批准|审批|评审)|skip (the )?(judge|review)/,
  },
  { id: 'privilege', re: /\bsudo\b|chmod\s+(-r\s+)?7{3}/ },
];

/** 极性表:有否定词的子句放行(护栏类规则),否则按硬拒处理。 */
export const POLARITY_PHRASES: readonly PhraseRule[] = [
  { id: 'no-verify', re: /--?no-?verify|--no-gpg-sign|git\s+commit\s+(.*\s)?-n\b/ },
  { id: 'skip-tests', re: /skip (the |all )?tests?|跳过(所有)?测试/ },
  {
    id: 'disable-hook',
    re: /(disable|remove|bypass|skip) (the |all |any )?(pre-commit |git )?hooks?|禁用(所有)?(钩子|hook)|跳过.{0,6}(钩子|hook)/,
  },
  {
    id: 'destructive',
    re: /rm\s+(-rf|-fr|-r\s+-f|-f\s+-r)|push\b.*\s(--force|-f)\b|reset\s+--hard|git\s+clean\s+-f|drop\s+table/,
  },
  { id: 'lint-off', re: /eslint-disable|ts-ignore|ts-nocheck|husky=0|\.only\(|\.skip\(/ },
];

/** 压缩形(去空白/连字符/下划线)的硬拒子串:抵抗 `no - verify`、`danger_full_access` 之类的拆写。 */
const SQUEEZED_HARD: readonly { id: string; needle: string }[] = [
  { id: 'danger-full-access', needle: 'dangerfullaccess' },
  { id: 'approval-policy', needle: 'approvalpolicy' },
  { id: 'skip-permissions', needle: 'dangerouslyskippermissions' },
];
const SQUEEZED_POLARITY: readonly { id: string; needle: string }[] = [
  { id: 'no-verify', needle: 'noverify' },
  { id: 'skip-tests', needle: 'skiptests' },
  { id: 'disable-hook', needle: 'disablehook' },
];

const NEGATION_RE =
  /不要|不得|不可|不许|不能|禁止|切勿|别(?!忘)|勿|never|do not|don'?t|must not|mustn'?t|avoid|without|no longer/;
/** 「别忘了/不要忘记/don't forget」是双重否定,不算否定 */
const DOUBLE_NEG_RE =
  /别忘了?|不要忘记?|不可忘记?|切勿忘记?|(never|don'?t|do not|avoid) (forget|forgetting)|别(犹豫|等)|不要(犹豫|等)|(do not|don'?t) (hesitate|wait)|without fail/g;
const CLAUSE_SPLIT_RE = /[.。;；!！?？,，、\n]/;

export interface PhraseVerdict {
  /** 命中的硬拒/未被否定豁免的极性规则 id;空 = 通过 */
  blocked: string[];
  /** 被否定词豁免的极性命中数(护栏类规则提及) */
  guardrailMentions: number;
}

export function scanDangerousPhrases(text: string): PhraseVerdict {
  const norm = normalizeForMatch(text);
  const sq = squeeze(text);
  const blocked = new Set<string>();
  let guardrailMentions = 0;
  for (const r of HARD_PHRASES) if (r.re.test(norm)) blocked.add(r.id);
  for (const r of SQUEEZED_HARD) if (sq.includes(r.needle)) blocked.add(r.id);
  const clauses = norm.split(CLAUSE_SPLIT_RE);
  const polarityHit = (id: string, re: RegExp | undefined, needle: string | undefined): void => {
    let hit = false;
    let negated = false;
    for (const clause of clauses) {
      const m = re?.exec(clause);
      if (m !== null && m !== undefined) {
        hit = true;
        const before = clause.slice(0, m.index).replace(DOUBLE_NEG_RE, ' ');
        if (NEGATION_RE.test(before)) negated = true;
        else {
          negated = false;
          break;
        }
      }
    }
    if (!hit && needle !== undefined && sq.includes(needle)) {
      // 只在压缩形才能看到的拆写:无法定位子句,一律按未否定处理(fail-closed)
      blocked.add(id);
      return;
    }
    if (hit && negated) guardrailMentions++;
    else if (hit) blocked.add(id);
  };
  for (const r of POLARITY_PHRASES) {
    const needle = SQUEEZED_POLARITY.find((x) => x.id === r.id)?.needle;
    polarityHit(r.id, r.re, needle);
  }
  return { blocked: [...blocked].sort(), guardrailMentions };
}

export interface ValidateContext {
  /** 本次输入里出现过的证据别名 */
  allowedAliases: ReadonlySet<string>;
  /** 本次输入里所有证据摘录(原文,用于回显检测) */
  excerpts: readonly string[];
  /** 已有原子 id ∪ 暂存区 id */
  existingIds: ReadonlySet<string>;
  redactor: Pick<Redactor, 'pass2'>;
  atomMaxBytes?: number;
  maxProposals?: number;
}

export type ValidationResult =
  | { ok: false; code: string; detail: string }
  | {
      ok: true;
      proposals: ReflectorProposalDraft[];
      observations: NonNullable<ReflectorOutput['observations']>;
      /** 单条丢弃的原因码 → 次数 */
      dropped: Record<string, number>;
      guardrailMentions: number;
    };

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v !== null && typeof v === 'object')
    for (const x of Object.values(v)) collectStrings(x, out);
}

const bump = (r: Record<string, number>, k: string): void => {
  r[k] = (r[k] ?? 0) + 1;
};

function proposalStrings(p: ReflectorProposalDraft): string[] {
  const s = [p.title, p.do, p.why, p.verify, p.rationale, p.signature.pattern];
  return s;
}

/** 额外的保守检查:相邻量词叠乘(`a*a*a*b`、`a{0,100}` 连用)能通过 checkPatternSafety,这里限制可重复量词总数 ≤2。 */
export function patternQuantifiersOk(pattern: string): boolean {
  const n = (pattern.match(/[*+]|\{\d*,\d*\}/g) ?? []).length;
  return n <= 2;
}

/** 被引用证据的摘录(机械复制进原子/提案)也不得带注入话术或不可见字符。 */
export function evidenceExcerptSuspicious(excerpt: string): boolean {
  return hasInvisible(excerpt) || scanDangerousPhrases(excerpt).blocked.length > 0;
}

/** signature 的统一匹配入口:旗标固定,被匹配串先截到 ≤4KiB。pattern 不安全返回 false。 */
export function matchSignature(sig: { pattern: string }, text: string): boolean {
  if (!checkPatternSafety(sig.pattern).ok || !patternQuantifiersOk(sig.pattern)) return false;
  let clipped = text;
  while (utf8Bytes(clipped) > MAX_MATCH_INPUT_BYTES)
    clipped = clipped.slice(0, clipped.length >> 1);
  return new RegExp(sig.pattern, SIGNATURE_REGEX_FLAGS).test(clipped);
}

export function validateReflectorOutput(raw: string, ctx: ValidateContext): ValidationResult {
  if (utf8Bytes(raw) > MAX_OUTPUT_BYTES) {
    return { ok: false, code: 'output_too_large', detail: '输出超过 32KiB' };
  }
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return { ok: false, code: 'not_json_object', detail: '输出不是单个 JSON 对象' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: 'not_json_object', detail: '输出无法解析为 JSON' };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, code: 'not_json_object', detail: '输出不是 JSON 对象' };
  }
  const schema = makeReflectorOutputSchema({
    ...(ctx.atomMaxBytes !== undefined ? { atomMaxBytes: ctx.atomMaxBytes } : {}),
    ...(ctx.maxProposals !== undefined ? { maxProposals: ctx.maxProposals } : {}),
  });
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'schema_invalid',
      detail: `${parsed.error.issues.length} 处不符合 schema`,
    };
  }
  const out = parsed.data;

  const strings: string[] = [];
  collectStrings(out, strings);
  for (const s of strings) {
    if (s.includes('[[REDACTED')) {
      return { ok: false, code: 'placeholder_in_output', detail: '输出含脱敏占位符' };
    }
  }
  for (const s of strings) {
    let clean = false;
    try {
      clean = ctx.redactor.pass2(s).clean;
    } catch {
      clean = false;
    }
    if (!clean) return { ok: false, code: 'output_residual', detail: '输出未通过脱敏复扫' };
  }
  // 不可见/格式字符:归一化会把它们抹掉,话术扫描就看不到藏在里面的载荷,所以必须在归一前整批拒
  if (strings.some((s) => hasInvisible(s))) {
    return { ok: false, code: 'hidden_chars_in_output', detail: '输出含不可见/格式字符' };
  }
  let guardrailMentions = 0;
  for (const s of strings) {
    const v = scanDangerousPhrases(s);
    if (v.blocked.length > 0) {
      return {
        ok: false,
        code: 'injection_suspected_local',
        detail: `命中危险话术:${v.blocked.join(',')}`,
      };
    }
    guardrailMentions += v.guardrailMentions;
  }

  const dropped: Record<string, number> = {};
  const kept: ReflectorProposalDraft[] = [];
  for (const p of out.proposals) {
    if (p.evidence.some((a) => !ctx.allowedAliases.has(a))) {
      bump(dropped, 'evidence_alias_unknown');
      continue;
    }
    if (ctx.existingIds.has(p.id)) {
      bump(dropped, 'id_conflict');
      continue;
    }
    if (!checkPatternSafety(p.signature.pattern).ok || !patternQuantifiersOk(p.signature.pattern)) {
      bump(dropped, 'pattern_unsafe');
      continue;
    }
    const mine = proposalStrings(p);
    if (ctx.excerpts.some((ex) => mine.some((m) => sharesRun(ex, m, ECHO_RUN_CODEPOINTS)))) {
      bump(dropped, 'echo_detected');
      continue;
    }
    kept.push(p);
  }
  return {
    ok: true,
    proposals: kept,
    observations: out.observations ?? [],
    dropped,
    guardrailMentions,
  };
}
