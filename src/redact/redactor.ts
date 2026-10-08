import { RedactionConfigSchema } from '../contracts/redact.js';
import type { Hit, RedactApply, RedactFailReason, Redactor } from '../contracts/redact.js';
import { Engine, mergeSpans } from './engine.js';
import { Deadline, RedactError } from './types.js';
import type { ResolvedConfig, Span } from './types.js';

/** 第一遍的解码深度 / 第二遍的解码深度。第二遍多一层,专门兜"嵌套编码"。 */
export const PASS1_DEPTH = 2;
export const PASS2_DEPTH = 3;

export interface RedactorOptions {
  /** 覆盖层 `internal_domains`:与 sensitive_words 同等处理,占位符类型为 domain */
  internalDomains?: readonly string[];
  /** 变异自检用:禁用的规则 / 阶段 id */
  disabledRules?: Iterable<string>;
  /** 注入时钟(毫秒),测试用 */
  now?: () => number;
}

export type RedactorInput = Partial<{
  extra_secret_prefixes: string[];
  sensitive_words: string[];
  allowed_url_hosts: string[];
  timeout_ms: number;
  max_input_chars: number;
}>;

/** 第二遍的结果,多带一个失败原因(异常/超时)。公开接口 `pass2` 把它压成 clean=false + 合成命中。 */
export interface Pass2Detail {
  clean: boolean;
  hits: Hit[];
  failure?: RedactFailReason;
}

export interface RedactorImpl extends Redactor {
  /** skipLengthGuard:apply 内部用——第一遍输出会因占位符变长,不能再套输入上限(时间预算仍然生效) */
  pass2Detail(text: string, skipLengthGuard?: boolean): Pass2Detail;
  readonly ruleIds: readonly string[];
}

export function placeholder(type: string): string {
  return `[[REDACTED:${type}]]`;
}

function toHits(spans: readonly Span[]): Hit[] {
  return spans.map((s) => ({ type: s.type, rule: s.rule, start: s.start, end: s.end }));
}

export function createRedactor(
  input: RedactorInput = {},
  opts: RedactorOptions = {},
): RedactorImpl {
  const parsed = RedactionConfigSchema.parse(input);
  const cfg: ResolvedConfig = { ...parsed, internal_domains: [...(opts.internalDomains ?? [])] };
  const disabled = new Set(opts.disabledRules ?? []);
  const now = opts.now ?? (() => performance.now());
  const engine = new Engine({ cfg, disabled });

  const guardLength = (text: string): void => {
    if (text.length > cfg.max_input_chars) {
      throw new RedactError('error', `输入超过 max_input_chars(${cfg.max_input_chars})`);
    }
  };

  const classify = (e: unknown): RedactFailReason =>
    e instanceof RedactError ? e.reason : 'error';

  const pass1 = (text: string): { text: string; hits: Hit[] } => {
    guardLength(text);
    const deadline = new Deadline(cfg.timeout_ms, now);
    const merged = mergeSpans(engine.scan(text, PASS1_DEPTH, deadline));
    deadline.check();
    if (merged.length === 0) return { text, hits: [] };
    const parts: string[] = [];
    let pos = 0;
    for (const s of merged) {
      parts.push(text.slice(pos, s.start), placeholder(s.type));
      pos = s.end;
    }
    parts.push(text.slice(pos));
    return { text: parts.join(''), hits: toHits(merged) };
  };

  const pass2Detail = (text: string, skipLengthGuard = false): Pass2Detail => {
    try {
      if (!skipLengthGuard) guardLength(text);
      const deadline = new Deadline(cfg.timeout_ms, now);
      const merged = mergeSpans([
        ...engine.scan(text, PASS2_DEPTH, deadline),
        ...engine.probe(text, deadline),
      ]);
      deadline.check();
      return { clean: merged.length === 0, hits: toHits(merged) };
    } catch (e) {
      const failure = classify(e);
      // 扫描器自己出问题 = 不能证明干净 = 不干净。合成命中不含任何文本。
      return {
        clean: false,
        hits: [{ type: 'scanner_error', rule: `scan_${failure}`, start: 0, end: 0 }],
        failure,
      };
    }
  };

  const apply = (text: string): RedactApply => {
    let r1: { text: string; hits: Hit[] };
    try {
      r1 = pass1(text);
    } catch (e) {
      return { ok: false, reason: classify(e) };
    }
    const r2 = pass2Detail(r1.text, true);
    if (!r2.clean) return { ok: false, reason: r2.failure ?? 'residual' };
    return { ok: true, text: r1.text };
  };

  return {
    pass1,
    pass2: (text) => {
      const d = pass2Detail(text);
      return { clean: d.clean, hits: d.hits };
    },
    pass2Detail,
    apply,
    ruleIds: engine.rules.map((r) => r.id),
  };
}
