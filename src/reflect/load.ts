/**
 * 装载 `.state/signals/<agent>/<yyyymm>.jsonl`,再校验并清洗。
 *  1. 坏行(不是 JSON)→ SignalStoreError(库带病,fail-closed);JSON 但不合 SignalSchema → 计数丢弃。
 *  2. 缺 event_kind/event_index 的旧信号按 unknown 排除并计数(contracts #22:不回填、不猜)。
 *  3. external_content=true 的信号:摘录**一律**清空(不管库里写了什么),并计数。
 *  4. tool_result_failed 的摘录清空(工具输出就是外来文本,只计数,永不进提示/证据)。
 *  5. 其余非空摘录过当前覆盖层 Redactor 的 pass2:命中(或扫描失败)→ 丢整条信号并计数,不替换。
 */
import * as path from 'node:path';
import { AGENT_IDS, type AgentId } from '../contracts/common.js';
import type { Redactor } from '../contracts/redact.js';
import { SignalSchema } from '../contracts/signal.js';
import type { IoContext } from '../io/paths.js';
import { exists, readDir, readLines, TOO_LONG_LINE } from '../io/read-fs.js';
import { hasStructureFields } from '../signals/structure.js';
import { SignalStoreError } from '../signals/state-store.js';
import { hasInvisible } from './text.js';
import type { LoadedSignal, LoadResult, LoadStats } from './types.js';

export interface LoadOptions {
  /** 只要 ts ≥ 该日期(YYYY-MM-DD,UTC 0 点)的信号 */
  since?: string | undefined;
  agents?: readonly AgentId[] | undefined;
  /** 引导窗口上界(ISO 时间戳,不含):ts ≥ until 的信号丢弃并计入 filtered_future */
  until?: string | undefined;
}

/** 单行上限:信号行是扁平小对象,远小于此。 */
const MAX_SIGNAL_LINE_BYTES = 64 * 1024;

export function emptyStats(): LoadStats {
  return {
    loaded: 0,
    dropped_schema: 0,
    dropped_residual: 0,
    external_excerpt_forced: 0,
    structure_unknown: 0,
    failed_excerpt_dropped: 0,
    filtered_out: 0,
    filtered_future: 0,
  };
}

function monthOfSince(since: string): string {
  return since.slice(0, 7).replace('-', '');
}

export async function loadSignals(
  io: IoContext,
  redactor: Pick<Redactor, 'pass2'>,
  opts: LoadOptions = {},
): Promise<LoadResult> {
  const stats = emptyStats();
  const signals: LoadedSignal[] = [];
  const candidates: LoadedSignal[] = [];
  const root = path.join(io.stateDir, 'signals');
  const sinceMs = opts.since === undefined ? undefined : Date.parse(`${opts.since}T00:00:00Z`);
  if (opts.since !== undefined && Number.isNaN(sinceMs)) {
    throw new RangeError('since 必须是 YYYY-MM-DD');
  }
  const untilMs = opts.until === undefined ? undefined : Date.parse(opts.until);
  if (opts.until !== undefined && Number.isNaN(untilMs)) {
    throw new RangeError('until 必须是 ISO 时间戳');
  }
  const wanted = opts.agents === undefined ? AGENT_IDS : opts.agents;
  if (!(await exists(root))) return { signals, stats };

  for (const agentEntry of await readDir(root)) {
    if (!agentEntry.isDirectory) continue;
    const agent = agentEntry.name as AgentId;
    if (!(AGENT_IDS as readonly string[]).includes(agent)) continue;
    if (!wanted.includes(agent)) continue;
    const dir = path.join(root, agent);
    for (const f of await readDir(dir)) {
      if (!f.isFile || !/^\d{6}\.jsonl$/.test(f.name)) continue;
      // 月份文件按事件 ts 的 UTC 月份分,早于 since 所在月的整文件跳过(只是优化,逐行仍会再判)
      if (opts.since !== undefined && f.name.slice(0, 6) < monthOfSince(opts.since)) continue;
      for await (const line of readLines(path.join(dir, f.name), MAX_SIGNAL_LINE_BYTES)) {
        if (line === '') continue;
        if (line === TOO_LONG_LINE) throw new SignalStoreError('信号库含超长行');
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          throw new SignalStoreError('信号库含无法解析的行');
        }
        const parsed = SignalSchema.safeParse(raw);
        if (!parsed.success) {
          stats.dropped_schema++;
          continue;
        }
        const s = parsed.data;
        if (sinceMs !== undefined && Date.parse(s.ts) < sinceMs) {
          stats.filtered_out++;
          continue;
        }
        if (untilMs !== undefined && Date.parse(s.ts) >= untilMs) {
          stats.filtered_future++;
          continue;
        }
        if (!hasStructureFields(s)) {
          stats.structure_unknown++;
          continue;
        }
        candidates.push(s);
      }
    }
  }
  // 会话级外部内容:同一会话里只要有一条信号是外部的,整个会话的摘录都视为外部(后来才发生的 WebFetch 不能让先前行逃过)
  const externalSessions = new Set(
    candidates.filter((c) => c.external_content).map((c) => c.session_ref),
  );
  for (const s of candidates) {
    let excerpt = s.excerpt_redacted;
    if (s.external_content || externalSessions.has(s.session_ref)) {
      if (excerpt !== '') stats.external_excerpt_forced++;
      excerpt = '';
    } else if (s.event_kind === 'tool_result_failed') {
      if (excerpt !== '') stats.failed_excerpt_dropped++;
      excerpt = '';
    }
    if (excerpt !== '' && hasInvisible(excerpt)) {
      stats.dropped_residual++;
      continue;
    }
    if (excerpt !== '') {
      let clean = false;
      try {
        clean = redactor.pass2(excerpt).clean;
      } catch {
        clean = false; // 扫描抛错按 fail-closed:丢弃
      }
      if (!clean) {
        stats.dropped_residual++;
        continue;
      }
    }
    signals.push({ ...s, excerpt_redacted: excerpt });
    stats.loaded++;
  }
  // 确定性顺序:会话内按序号,其余按 sig_id
  signals.sort((a, b) =>
    a.session_ref !== b.session_ref
      ? a.session_ref < b.session_ref
        ? -1
        : 1
      : a.event_index !== b.event_index
        ? a.event_index - b.event_index
        : a.sig_id < b.sig_id
          ? -1
          : a.sig_id > b.sig_id
            ? 1
            : 0,
  );
  return { signals, stats };
}
