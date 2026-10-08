/**
 * `signals collect` 的编排:discover → 逐会话处理 → 聚合 CollectReport →(非 dry)写 `.state/signals/`。
 */
import type { TraceReader } from '../contracts/reader.js';
import type { Counts } from '../contracts/reader.js';
import { CollectReportSchema } from '../contracts/signal.js';
import type { CollectReport, Signal } from '../contracts/signal.js';
import type { RedactFailReason } from '../contracts/redact.js';
import type { IoContext } from '../io/paths.js';
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
  write: WriteResult | undefined;
}

export async function collect(input: CollectInput): Promise<CollectOutput> {
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
    write,
  };
}
