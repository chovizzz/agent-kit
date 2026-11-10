/**
 * RSI 注入块识别(R21-6.9;`docs/reader-counting-spec.md` §12.3)与标记归并(R21-6.6)。纯函数 + 一个每会话的追踪器,无 I/O。
 *
 * 块:某个字符串值里**以 `RSI_MARK_PREFIX` 开头的行**(行首允许空格 / 制表符)起,到下一个这样的行(或该字符串结尾)为止;
 * 该行之后的行 = 块的「标签 / 哈希 / 正文」。标记行恰为 `RSI_MARK_PREFIX + 空格 + rsm_<16 位十六进制>`(行尾允许空白)时才取回标记;
 * 以前缀开头但形状不对的行仍算块(照常排除),只是取不到标记。行只按 `\n` 切(U+2028 / 孤立 `\r` 不是行分隔,同 reader 的 C2)。
 *
 * 复述:事件文本与某个**已取回的块**的正文(标记行之后的各行,以 `\n` 连接)有**连续 {@link RECITAL_MIN_CHARS} 个码点**以上相同的片段 → 排除。
 * 码点、不做空白 / 大小写归一;只和此前已见的块比(前缀稳定:第 k 个事件的判定只依赖 ≤ k 的行)。
 */
import type { SessionRead } from '../contracts/reader.js';
import { RSI_MARK_PREFIX } from '../contracts/rsi.js';
import { SESSION_MARKERS_MAX } from '../contracts/session-stat.js';

/** 复述阈值(码点):连续重合 ≥ 此值判为复述;15 个不判。 */
export const RECITAL_MIN_CHARS = 16;
/** 参与复述比对的块正文上限(码点);正文本身 ≤ 1536 字节,更长的只可能是病态输入。 */
export const INJECTION_BODY_MAX_CHARS = 4096;
/** 复述比对时每个事件文本最多扫的码元数。 */
export const RECITAL_SCAN_MAX_UNITS = 1 << 20;
/** 遍历一行 JSON 找字符串值时最多访问的节点数(防病态宽对象)。 */
export const INJECTION_WALK_MAX_NODES = 200_000;

/** 前缀之后必须恰是 `空格 + rsm_<16 位十六进制>`(行尾允许空白)。 */
const MARKER_TAIL_RE = /^ (rsm_[0-9a-f]{16})[ \t]*$/;

export interface InjectionBlock {
  /** 取回的标记;标记行形状不对时为 undefined */
  marker: string | undefined;
  /** 标记行之后的各行(`\n` 连接) */
  body: string;
}

function trimLeadBlank(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

/** 一个字符串值里的全部块。 */
export function blocksInString(s: string): InjectionBlock[] {
  if (!s.includes(RSI_MARK_PREFIX)) return [];
  const out: { marker: string | undefined; lines: string[] }[] = [];
  for (const raw of s.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const lead = trimLeadBlank(line);
    if (lead.startsWith(RSI_MARK_PREFIX)) {
      out.push({ marker: MARKER_TAIL_RE.exec(lead.slice(RSI_MARK_PREFIX.length))?.[1], lines: [] });
    } else if (out.length > 0) {
      (out[out.length - 1] as { lines: string[] }).lines.push(line);
    }
  }
  return out.map((b) => ({ marker: b.marker, body: b.lines.join('\n') }));
}

/** 一行已解析 JSON 里全部字符串值(任意深度,含数组)里的块。 */
export function findInjectionBlocks(root: unknown): InjectionBlock[] {
  const out: InjectionBlock[] = [];
  let visited = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0 && visited < INJECTION_WALK_MAX_NODES) {
    const v = stack.pop();
    visited++;
    if (typeof v === 'string') out.push(...blocksInString(v));
    else if (Array.isArray(v)) for (const x of v) stack.push(x);
    else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) stack.push(x);
  }
  return out;
}

export interface InjectionReport {
  /** 去重、升序、≤ {@link SESSION_MARKERS_MAX} */
  markers: readonly string[];
  /** 因注入块或其复述被改成 meta 的事件数 */
  excluded: number;
}

/** `read()` 的返回值若带 `injection()`,就是识别过注入的 reader(claude / pi);codex / kimi 没有。 */
export interface InjectionAwareRead extends SessionRead {
  injection(): InjectionReport;
}
export function isInjectionAware(r: SessionRead): r is InjectionAwareRead {
  return typeof (r as { injection?: unknown }).injection === 'function';
}

/** 每会话一份。 */
export class InjectionTracker {
  private readonly markerSet = new Set<string>();
  private readonly windows = new Set<string>();
  private excludedCount = 0;

  /** 登记「可取回」的块:取标记、并把正文的 16 码点窗口放进复述比对集合。 */
  addBlocks(blocks: readonly InjectionBlock[]): void {
    for (const b of blocks) {
      if (b.marker !== undefined) this.markerSet.add(b.marker);
      const cps = Array.from(b.body).slice(0, INJECTION_BODY_MAX_CHARS);
      for (let i = 0; i + RECITAL_MIN_CHARS <= cps.length; i++) {
        this.windows.add(cps.slice(i, i + RECITAL_MIN_CHARS).join(''));
      }
    }
  }

  /** 文本里是否有与已登记正文连续 ≥ 16 码点相同的片段。 */
  isRecital(text: string): boolean {
    if (this.windows.size === 0) return false;
    const src = text.length > RECITAL_SCAN_MAX_UNITS ? text.slice(0, RECITAL_SCAN_MAX_UNITS) : text;
    const cps = Array.from(src);
    for (let i = 0; i + RECITAL_MIN_CHARS <= cps.length; i++) {
      if (this.windows.has(cps.slice(i, i + RECITAL_MIN_CHARS).join(''))) return true;
    }
    return false;
  }

  noteExcluded(): void {
    this.excludedCount++;
  }

  report(): InjectionReport {
    return {
      markers: [...this.markerSet].sort().slice(0, SESSION_MARKERS_MAX),
      excluded: this.excludedCount,
    };
  }
}

export type MarkerRetrieval = 'ok' | 'multi_marker' | 'correlation_failed' | 'not_collected';

/**
 * R21-6.6 会话归并:0 个标记 → 「关联失败」;≥ 2 个不同标记 → 「多标记」;恰 1 个 → ok。
 * `undefined`(旧行缺键)= 未采集,不是 0。
 */
export function classifyMarkerRetrieval(markers: readonly string[] | undefined): MarkerRetrieval {
  if (markers === undefined) return 'not_collected';
  const distinct = new Set(markers).size;
  if (distinct === 0) return 'correlation_failed';
  return distinct >= 2 ? 'multi_marker' : 'ok';
}
