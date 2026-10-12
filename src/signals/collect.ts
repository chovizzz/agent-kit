/**
 * `signals collect` 的编排:discover → 逐会话处理 → 聚合 CollectReport →(非 dry)写 `.state/signals/`。
 */
import type { TraceReader } from '../contracts/reader.js';
import type { Counts } from '../contracts/reader.js';
import { CollectReportSchema } from '../contracts/signal.js';
import type { CollectReport, Signal } from '../contracts/signal.js';
import type { RedactFailReason } from '../contracts/redact.js';
import type { IoContext } from '../io/paths.js';
import { MAX_LINE_BYTES } from '../io/read-fs.js';
import { processSession } from './pipeline.js';
import type { PipelineDeps, SessionResult } from './pipeline.js';
import { writeSignals } from './state-store.js';
import type { WriteResult } from './state-store.js';

export const SAMPLE_LIMIT = 5;

export interface CollectInput extends PipelineDeps {
  reader: TraceReader;
  source: string;
  io: IoContext;
  dry: boolean;
}

export interface SessionStat {
  session_ref: string;
  counts: Counts;
}

export interface CollectOutput {
  report: CollectReport;
  /** 每个已处理会话的计数(只含哈希,供 oracle 对照) */
  sessions: SessionStat[];
  /** dry 模式下展示的脱敏摘录样例 */
  samples: string[];
  dropReasons: Partial<Record<RedactFailReason, number>>;
  readErrors: number;
  /** read_error 的异常类名计数(只类名,不含 message / 路径) */
  readErrorClasses: Record<string, number>;
  write: WriteResult | undefined;
}

export async function collect(input: CollectInput): Promise<CollectOutput> {
  // 配置错误在库入口就拒绝,不让它被逐会话的 read_error 吞成「每个会话都读失败」
  const mx = input.maxEventBytes;
  if (mx !== undefined && (!Number.isInteger(mx) || mx <= 0 || mx > MAX_LINE_BYTES)) {
    throw new RangeError(`maxEventBytes 须为 1..${MAX_LINE_BYTES} 的整数`);
  }
  const refs = await input.reader.discover(input.source);
  const results: SessionResult[] = [];
  for (const ref of [...refs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    results.push(await processSession(input.reader, ref, input));
  }

  const processed = results.filter((r) => r.status === 'processed');
  const signals: Signal[] = processed.flatMap((r) => r.signals);
  const unknown: Record<string, number> = {};
  let oversized = 0;
  let events = 0;
  let fallback = 0;
  const dropReasons: Partial<Record<RedactFailReason, number>> = {};
  for (const r of processed) {
    events += r.eventsSeen;
    oversized += r.counts?.oversized_lines ?? 0;
    for (const [k, v] of Object.entries(r.counts?.unknown_event_types ?? {})) {
      unknown[k] = (unknown[k] ?? 0) + v;
    }
    if (r.version?.source === 'collector_fallback') fallback++;
    for (const [k, v] of Object.entries(r.dropReasons)) {
      dropReasons[k as RedactFailReason] = (dropReasons[k as RedactFailReason] ?? 0) + v;
    }
  }

  // D1(方案 A):codex 报告带 tool_failures 适用性标记。任一会话版本 < 0.149 或版本未知
  // (不能证明可见性)→ limited;全部 >= 0.149 → full。比较用数值元组,不引 semver 依赖。
  const toolFailuresScope = (() => {
    if (input.reader.agent !== 'codex') return undefined;
    const parse = (v: string | undefined): [number, number, number] | null => {
      const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(v ?? '');
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const limited = processed.some((r) => {
      const t = parse(r.version?.version);
      return t === null || t < [0, 149, 0];
    });
    return limited ? ('codex_pre_0149_limited' as const) : ('full' as const);
  })();

  const readErrorClasses: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const r of results) {
    if (r.status !== 'read_error') continue;
    const k = r.errorClass ?? 'Error';
    readErrorClasses[k] = (readErrorClasses[k] ?? 0) + 1;
  }

  const report = CollectReportSchema.parse({
    agent: input.reader.agent,
    sessions_read: processed.length,
    sessions_skipped_excluded: results.filter((r) => r.status === 'excluded').length,
    events,
    signals_emitted: signals.length,
    signals_dropped_redaction: processed.reduce((n, r) => n + r.dropped, 0),
    unknown_event_types: unknown,
    oversized_lines: oversized,
    agent_version_fallback_ratio: processed.length === 0 ? 0 : fallback / processed.length,
    ...(toolFailuresScope !== undefined ? { tool_failures_scope: toolFailuresScope } : {}),
  } satisfies CollectReport);

  const write = input.dry ? undefined : await writeSignals(input.io, input.reader.agent, signals);

  return {
    report,
    sessions: processed.flatMap((r) =>
      r.counts ? [{ session_ref: r.sessionRef, counts: r.counts }] : [],
    ),
    samples: input.dry
      ? signals
          .filter((s) => s.excerpt_redacted !== '')
          .slice(0, SAMPLE_LIMIT)
          .map((s) => s.excerpt_redacted)
      : [],
    dropReasons,
    readErrors: results.filter((r) => r.status === 'read_error').length,
    readErrorClasses,
    write,
  };
}
