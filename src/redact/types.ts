import type { RedactFailReason, RedactionConfig } from '../contracts/redact.js';

/**
 * 合法占位符类型的长度上限(契约正则 `[a-z_]+` 的子集)。更长的、大小写不对的、嵌套的"占位符"
 * 都不剥离,按普通文本继续扫:伪造形态拿不到任何豁免,里面藏的秘密照样被抓。
 */
export const MAX_PLACEHOLDER_TYPE = 24;

/** 扫描器内部失败:apply 把它翻成 {ok:false, reason}。 */
export class RedactError extends Error {
  readonly reason: RedactFailReason;
  constructor(reason: RedactFailReason, message: string) {
    super(message);
    this.name = 'RedactError';
    this.reason = reason;
  }
}

/** 时间预算。单条正则不可中断,所以检查点放在规则之间与循环内;规则本身必须是线性写法。 */
export class Deadline {
  private readonly limit: number;
  private ticks = 0;
  constructor(
    budgetMs: number,
    private readonly now: () => number,
  ) {
    this.limit = now() + budgetMs;
  }
  check(): void {
    if (this.now() > this.limit) throw new RedactError('timeout', '超出时间预算');
  }
  /** 热循环里用:每 64 次才真正读一次时钟。 */
  tick(): void {
    if ((++this.ticks & 63) === 0) this.check();
  }
}

export interface Span {
  /** 半开区间 [start, end),坐标系由产生者约定(规则:视图;引擎输出:原文) */
  start: number;
  end: number;
  type: string;
  rule: string;
  prio: number;
}

export interface ResolvedConfig extends RedactionConfig {
  internal_domains: readonly string[];
}

export interface ScanEnv {
  readonly cfg: ResolvedConfig;
  readonly deadline: Deadline;
  /** 视图区间对应的"原始字节"(未做归一化)。允许名单等信任判断必须看它,不能看折叠后的文本。 */
  rawSlice(start: number, end: number): string;
  /** 当前扫描的是压缩视图 */
  readonly compactView: boolean;
}

export interface Rule {
  readonly id: string;
  /** 占位符类型,[a-z_]+ */
  readonly type: string;
  /** 重叠区间合并时类型取优先级高者 */
  readonly prio: number;
  /** 结构化规则:也在"压缩视图"(去空白/引号/加号)上跑,抓分行与字符串拼接 */
  readonly compact: boolean;
  /** 廉价预筛:小写文本不含其中任何一个子串就不跑这条规则 */
  readonly quick?: readonly string[];
  /** 在视图文本上扫描,用 push 登记视图坐标的区间 */
  scan(text: string, lower: string, push: (start: number, end: number) => void, env: ScanEnv): void;
}
