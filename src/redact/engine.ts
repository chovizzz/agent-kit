/**
 * 扫描引擎:第一遍与第二遍共用。输入原文,输出原文坐标的 Span 列表(未合并)。
 *
 * 流程(scanString):
 *   归一化视图 -> 剥合法占位符(伪造/残留的占位符形态本身就是命中)-> 规则
 *   -> 压缩视图(去空白/引号/加号,抓分行与拼接)上的结构化规则
 *   -> 解码:base64/hex 段 -> 嵌套 scanString;转义序列 -> 就地解码成新视图再扫
 * 嵌套深度有上限,解码总量有上限,超限一律 fail-closed(抛 RedactError)。
 */
import { PLACEHOLDER_SOURCE } from '../contracts/redact.js';
import {
  base32Candidates,
  base64Candidates,
  hasEscapes,
  hexCandidates,
  unescapeView,
} from './decode.js';
import { buildRules } from './rules.js';
import type { Candidate } from './decode.js';
import { Deadline, MAX_PLACEHOLDER_TYPE, RedactError } from './types.js';
import type { ResolvedConfig, Rule, ScanEnv, Span } from './types.js';
import {
  buildView,
  compactRanges,
  deriveRemoving,
  identityView,
  jsonWhitespaceView,
  mapSpan,
  maskView,
  safeLower,
} from './view.js';
import type { View } from './view.js';

export { MAX_PLACEHOLDER_TYPE };

const PROBES: ReadonlyArray<readonly [string, RegExp]> = [
  ['sk', /(?<![A-Za-z0-9])sk-(?=[A-Za-z_-]{0,200}[0-9])[A-Za-z0-9_-]{20,}/gi],
  ['soh', /(?<![A-Za-z0-9])soh_(?=[A-Za-z_]{0,100}[0-9])[A-Za-z0-9_]{16,}/gi],
  ['ghp', /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/gi],
  ['aws', /(?<![A-Za-z0-9])A[KS]IA[0-9A-Z]{16}/g],
  ['slack', /(?<![A-Za-z0-9])xox[abeprs]-[A-Za-z0-9-]{10,}/gi],
  ['pem', /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY-----\s{0,4}[A-Za-z0-9+/]{32,}/g],
];

/** 转义空白开头:反斜杠(任意个)后跟 n / r / t */
const ESC_WS_START = /^\\+[nrt]/;

const PLACEHOLDER_STRIP = new RegExp(
  PLACEHOLDER_SOURCE.replace('[a-z_]+', `[a-z_]{1,${MAX_PLACEHOLDER_TYPE}}`),
  'g',
);

export const STAGES = {
  normalize: 'view_normalize',
  compact: 'view_compact',
  base64: 'decode_base64',
  base32: 'decode_base32',
  hex: 'decode_hex',
  escape: 'decode_escape',
  jsonWs: 'view_json_ws',
  origUnion: 'view_orig_union',
  escTail: 'span_escape_tail',
} as const;

interface ScanCtx {
  deadline: Deadline;
  maxDepth: number;
  /** 剩余可解码字符数 */
  budget: number;
  candidates: number;
}

export interface EngineInit {
  cfg: ResolvedConfig;
  disabled: ReadonlySet<string>;
}

export class Engine {
  readonly rules: readonly Rule[];
  private readonly disabled: ReadonlySet<string>;
  private readonly cfg: ResolvedConfig;

  constructor(init: EngineInit) {
    this.cfg = init.cfg;
    this.disabled = init.disabled;
    this.rules = buildRules(init.cfg);
  }

  /** 顶层入口:返回原文坐标的 Span(未合并)。 */
  scan(text: string, maxDepth: number, deadline: Deadline): Span[] {
    const ctx: ScanCtx = {
      deadline,
      maxDepth,
      budget: text.length * 4 + 4096,
      candidates: 0,
    };
    return this.scanString(text, 0, ctx);
  }

  private scanString(text: string, depth: number, ctx: ScanCtx): Span[] {
    ctx.deadline.check();
    const out: Span[] = [];
    const base = this.disabled.has(STAGES.normalize) ? identityView(text) : buildView(text);
    const ws = this.disabled.has(STAGES.jsonWs) ? base : jsonWhitespaceView(base);
    const stripped = this.stripPlaceholders(ws);
    this.scanView(stripped, text, depth, ctx, out);
    // JSON 转义空白(`\t` `\n` `\r`)在口令里也可能是字面字符:ws 视图会把值从那里截断。
    // 值类规则在原视图上再跑一遍取并集(多脱敏是安全的方向);pass2 / --check 走同一条路径。
    if (ws !== base && !this.disabled.has(STAGES.origUnion)) {
      this.runRules(this.stripPlaceholders(base), text, false, ctx, out, true);
    }
    return out;
  }

  /**
   * 第二遍独立残留探测器:不依赖 rules.ts,也不受 disabled 影响。只覆盖最高价值的少数形态,
   * 且每条都不比 pass1 对应规则更宽,所以命中只可能说明 pass1 漏了。
   */
  probe(text: string, deadline: Deadline): Span[] {
    deadline.check();
    const base = buildView(text);
    const stripped = this.stripPlaceholders(base);
    const joined = deriveRemoving(stripped, compactRanges(stripped.text));
    const out: Span[] = [];
    for (const v of [stripped, joined]) {
      for (const [id, re] of PROBES) {
        re.lastIndex = 0;
        for (let m = re.exec(v.text); m !== null; m = re.exec(v.text)) {
          deadline.tick();
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          const [a, b] = mapSpan(v, m.index, m.index + m[0].length);
          out.push({ start: a, end: b, type: 'residual', rule: `probe_${id}`, prio: 1 });
        }
      }
    }
    return out;
  }

  private stripPlaceholders(base: View): View {
    if (!/\[\[redacted/i.test(base.text)) return base;
    const ranges: Array<[number, number]> = [];
    PLACEHOLDER_STRIP.lastIndex = 0;
    for (
      let m = PLACEHOLDER_STRIP.exec(base.text);
      m !== null;
      m = PLACEHOLDER_STRIP.exec(base.text)
    ) {
      ranges.push([m.index, m.index + m[0].length]);
    }
    return deriveRemoving(base, ranges);
  }

  private scanView(view: View, root: string, depth: number, ctx: ScanCtx, out: Span[]): void {
    this.runRules(view, root, false, ctx, out);

    let compact: View | null = null;
    if (!this.disabled.has(STAGES.compact)) {
      const joined = deriveRemoving(view, compactRanges(view.text));
      if (joined.text.length !== view.text.length) {
        // 原视图里已经识别出来的区间不再参与拼接,否则普通秘密后面的单词会被一并粘进去
        compact = maskView(joined, out);
        this.runRules(compact, root, true, ctx, out);
      }
    }

    if (depth >= ctx.maxDepth) return;
    this.runDecoders(view, view, depth, ctx, out);
    if (compact) this.runDecoders(compact, view, depth, ctx, out);

    if (!this.disabled.has(STAGES.escape) && hasEscapes(view.text)) {
      const u = unescapeView(view, () => ctx.deadline.tick());
      if (u) {
        ctx.budget -= u.text.length;
        if (ctx.budget < 0) throw new RedactError('error', '解码体量超限');
        // 转义解码后的文本可能还有下一层(双重编码),所以整体递归一次
        this.scanView(this.stripPlaceholders(u), root, depth + 1, ctx, out);
      }
    }
  }

  /**
   * valueOnly:原视图上的补扫——只跑值类规则;起点就是转义空白的命中丢弃(ws 视图里那是「值为空」,
   * 例如 `NAME=<占位符>\nnext` 剥掉占位符后值从 `\n` 开始,不是口令)。
   */
  private runRules(
    view: View,
    root: string,
    isCompact: boolean,
    ctx: ScanCtx,
    out: Span[],
    valueOnly = false,
  ): void {
    const text = view.text;
    if (text.length === 0) return;
    const lower = safeLower(text);
    const env: ScanEnv = {
      cfg: this.cfg,
      deadline: ctx.deadline,
      compactView: isCompact,
      disabled: this.disabled,
      origView: valueOnly,
      rawSlice: (s, e) => {
        const [a, b] = mapSpan(view, s, e);
        return root.slice(a, b);
      },
    };
    for (const rule of this.rules) {
      if (this.disabled.has(rule.id)) continue;
      if (isCompact && !rule.compact) continue;
      if (valueOnly && !rule.valueClass) continue;
      if (rule.quick && !rule.quick.some((q) => lower.includes(q))) continue;
      ctx.deadline.check();
      rule.scan(
        text,
        lower,
        (s, e) => {
          if (e <= s) return;
          if (valueOnly && ESC_WS_START.test(text.slice(s, s + 64))) return;
          const [a, b0] = mapSpan(view, s, e);
          const b = this.disabled.has(STAGES.escTail) ? b0 : trimEscapeTail(root, a, b0);
          if (b <= a) return;
          out.push({ start: a, end: b, type: rule.type, rule: rule.id, prio: rule.prio });
        },
        env,
      );
    }
  }

  private runDecoders(view: View, primary: View, depth: number, ctx: ScanCtx, out: Span[]): void {
    const tick = (): void => ctx.deadline.tick();
    const groups: Array<[string, Candidate[]]> = [];
    if (!this.disabled.has(STAGES.base64))
      groups.push([STAGES.base64, base64Candidates(view.text, tick)]);
    if (!this.disabled.has(STAGES.base32))
      groups.push([STAGES.base32, base32Candidates(view.text, tick)]);
    if (!this.disabled.has(STAGES.hex)) groups.push([STAGES.hex, hexCandidates(view.text, tick)]);
    for (const [stage, cands] of groups) {
      for (const c of cands) {
        ctx.deadline.tick();
        const [a, b] = mapSpan(view, c.start, c.end);
        // 压缩视图里与原视图完全重合的段已经在原视图上试过了
        if (view !== primary && b - a === c.end - c.start) continue;
        ctx.candidates++;
        if (ctx.candidates > 4096) throw new RedactError('error', '解码候选段过多');
        ctx.budget -= c.text.length;
        if (ctx.budget < 0) throw new RedactError('error', '解码体量超限');
        const nested = this.scanString(c.text, depth + 1, ctx);
        if (nested.length === 0) continue;
        const top = pickTop(nested);
        out.push({
          start: a,
          end: b,
          type: top.type,
          rule: `${stage}>${top.rule}`,
          prio: top.prio,
        });
      }
    }
  }
}

/**
 * 值的区间不许吞掉紧随其后的 JSON 转义换行的反斜杠(`\\n` `\\r` `\\t`)。
 * ws 视图把转义空白的反斜杠换成空格,值类规则会把这个空格当成值的一部分;区间连反斜杠一起替换成占位符,
 * 输出就成了 `[[..]]next`:转义丢了,上下两行粘成一行,第二遍把后一行当成值(两遍不一致)。
 * 只收缩换行 / 回车 / 制表符,**不收缩引号**:转义引号的反斜杠被吞掉后,后面的引号字面量会让第二遍
 * 在残留位置再次命中(fail-closed);保留反斜杠反而让 `Bearer 伪值\\"口令\\"` 一类写法的口令失去锚点而漏掉。
 * 代价:口令真以反斜杠结尾且后面紧跟 n / r / t 时多留 1 个字符。
 */
function trimEscapeTail(root: string, a: number, b: number): number {
  let k = b;
  while (k > a && root.charCodeAt(k - 1) === 92) k--;
  if (k === b) return b;
  const next = root[b];
  return next === 'n' || next === 'r' || next === 't' ? k : b;
}

function pickTop(spans: readonly Span[]): Span {
  let best = spans[0] as Span;
  for (const s of spans) {
    if (s.prio > best.prio || (s.prio === best.prio && s.rule < best.rule)) best = s;
  }
  return best;
}

/** 合并重叠区间:类型与规则取优先级最高者(同级取规则 id 字典序小者)。区间仅相邻(不重叠)不合并。 */
export function mergeSpans(spans: readonly Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((x, y) => x.start - y.start || y.end - x.end);
  const out: Span[] = [];
  let cur = { ...(sorted[0] as Span) };
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i] as Span;
    if (s.start < cur.end) {
      if (s.end > cur.end) cur.end = s.end;
      if (s.prio > cur.prio || (s.prio === cur.prio && s.rule < cur.rule)) {
        cur.prio = s.prio;
        cur.type = s.type;
        cur.rule = s.rule;
      }
    } else {
      out.push(cur);
      cur = { ...s };
    }
  }
  out.push(cur);
  return out;
}
