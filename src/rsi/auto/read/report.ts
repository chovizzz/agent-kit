/**
 * `rsi report [--week|--since D] [--json]`(contracts R21-13.3、§21.24 W0-22 第 8 条;只读命令,零写入,**不读私有仓库、不跑 git**)。
 *
 * 只读 `audit.jsonl`;coverage 只表示**已观察事件范围**,**不证明**保留策略(先按月汇总再删)是否截断:
 *   - (1)完整但前几天无事件 与 (2)真正被截断**明确不区分**,两者都输出 `request_before_observed=true` 与同样文案(输出逐字节相同);
 *   - (3)空文件:`audit_file=present`、`observed=null`、「观察到 0 行」,不报「0 次转移」为事实;账 / 状态显示曾有转移 → 退 3 `audit_invalid`;
 *   - (4)文件缺失:`audit_file=absent`;账 / 状态显示曾有转移 → 退 3 `audit_invalid`,否则退 0 并标「无审计文件(未观察到任何事件)」;
 *   - 任一行不合规 → `corrupt_lines=<n>`,退 3,不得跳过后退 0;读不出 → 退 3。
 * `--json` 键集合固定:`range` / `transitions` / `rollbacks` / `expired` / `cost` / `canary` / `audit_file` / `observed` / `request_before_observed` / `counts_scope`(恒为 `"observed"`);所有计数是「已观察」值。
 * cost / canary 的聚合口径(契约只列键名):`cost.injected_bytes` / `cost.s2_count` = 区间内审计行 `counts.injected_bytes` / `counts.s2_count` 之和;`canary` = 区间内进入 `canary` 的转移。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import { RsiAuditLineSchema, type RsiAuditLine } from '../../../contracts/rsi-personal.js';
import { canonicalJson } from '../../../io/canonical-json.js';
import { emitLines, jsonLines, type OutputSink } from '../../output.js';
import type { OutLine } from '../../sanitize.js';
import { parseUtcDate } from '../select-rollback.js';
import type { AutoReadPorts } from './ports.js';

export interface ReportRange {
  from: string;
  to: string;
}
export type ReportArgs =
  | { ok: true; json: boolean; range: ReportRange }
  | { ok: false; reason: 'unknown_arg' | 'mode_conflict' | 'bad_date' };

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** 当前 UTC 周的周一(ISO 周起点) */
export function weekStart(now: Date): string {
  const day = (now.getUTCDay() + 6) % 7; // 周一 = 0
  return utcDay(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day)),
  );
}

export function parseReportArgs(argv: readonly string[], now: Date): ReportArgs {
  let json = false;
  let week = false;
  let since: string | null = null;
  let sinceSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--json' && !json) json = true;
    else if (a === '--week' && !week) week = true;
    else if (a === '--since' && !sinceSeen) {
      sinceSeen = true;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { ok: false, reason: 'bad_date' };
      since = v;
      i += 1;
    } else return { ok: false, reason: 'unknown_arg' };
  }
  if (week && sinceSeen) return { ok: false, reason: 'mode_conflict' };
  const to = utcDay(now);
  if (sinceSeen) {
    const d = parseUtcDate(since as string);
    return d === null
      ? { ok: false, reason: 'bad_date' }
      : { ok: true, json, range: { from: d, to } };
  }
  return { ok: true, json, range: { from: weekStart(now), to } };
}

type Parsed =
  | { kind: 'ok'; lines: RsiAuditLine[]; corrupt: number }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

function parseAudit(raw: Awaited<ReturnType<AutoReadPorts['audit']>>): Parsed {
  if (raw.kind === 'absent') return { kind: 'absent' };
  if (raw.kind === 'unreadable') return { kind: 'unreadable' };
  const text = raw.text;
  const rows = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const lines: RsiAuditLine[] = [];
  let corrupt = 0;
  for (const row of rows) {
    try {
      const r = RsiAuditLineSchema.safeParse(JSON.parse(row));
      if (r.success) lines.push(r.data);
      else corrupt += 1;
    } catch {
      corrupt += 1;
    }
  }
  return { kind: 'ok', lines, corrupt };
}

interface IdCount {
  count: number;
  ids: string[];
}
const idCount = (ls: readonly RsiAuditLine[]): IdCount => ({
  count: ls.length,
  ids: [...new Set(ls.map((l) => l.id))].sort(),
});

export interface ReportDoc {
  range: ReportRange;
  transitions: IdCount & { by_to: Record<string, number> };
  rollbacks: IdCount;
  expired: IdCount;
  cost: { injected_bytes: number; s2_count: number };
  canary: IdCount;
  audit_file: 'present' | 'absent';
  observed: { from: string; to: string; lines: number } | null;
  request_before_observed: boolean;
  counts_scope: 'observed';
}

export type ReportResult = { kind: 'ok'; doc: ReportDoc } | { kind: 'fail'; lines: string[] };

export async function computeReport(p: AutoReadPorts, range: ReportRange): Promise<ReportResult> {
  const parsed = parseAudit(await p.audit());
  if (parsed.kind === 'unreadable') return { kind: 'fail', lines: [] };
  const empty = (file: 'present' | 'absent'): ReportDoc => ({
    range,
    transitions: { count: 0, ids: [], by_to: {} },
    rollbacks: { count: 0, ids: [] },
    expired: { count: 0, ids: [] },
    cost: { injected_bytes: 0, s2_count: 0 },
    canary: { count: 0, ids: [] },
    audit_file: file,
    observed: null,
    request_before_observed: false,
    counts_scope: 'observed',
  });
  if (
    parsed.kind === 'absent' ||
    (parsed.kind === 'ok' && parsed.lines.length === 0 && parsed.corrupt === 0)
  ) {
    if (await p.priorActivity()) return { kind: 'fail', lines: [] };
    return { kind: 'ok', doc: empty(parsed.kind === 'absent' ? 'absent' : 'present') };
  }
  if (parsed.corrupt > 0) return { kind: 'fail', lines: [`corrupt_lines=${parsed.corrupt}`] };
  const days = parsed.lines.map((l) => utcDay(new Date(Date.parse(l.at)))).sort();
  const observed = {
    from: days[0] as string,
    to: days[days.length - 1] as string,
    lines: parsed.lines.length,
  };
  const inRange = parsed.lines.filter((l) => {
    const d = utcDay(new Date(Date.parse(l.at)));
    return d >= range.from && d <= range.to;
  });
  const trans = inRange.filter((l) => l.kind === 'transition');
  const byTo: Record<string, number> = {};
  for (const t of trans) if (t.to !== undefined) byTo[t.to] = (byTo[t.to] ?? 0) + 1;
  const sum = (key: string): number => inRange.reduce((n, l) => n + (l.counts?.[key] ?? 0), 0);
  return {
    kind: 'ok',
    doc: {
      range,
      transitions: { ...idCount(trans), by_to: byTo },
      rollbacks: idCount(trans.filter((t) => t.dim === 'lifecycle' && t.to === 'rolling_back')),
      expired: idCount(trans.filter((t) => t.to === 'expired')),
      cost: { injected_bytes: sum('injected_bytes'), s2_count: sum('s2_count') },
      canary: idCount(trans.filter((t) => t.dim === 'lifecycle' && t.to === 'canary')),
      audit_file: 'present',
      observed,
      request_before_observed: range.from < observed.from,
      counts_scope: 'observed',
    },
  };
}

export function renderReportText(d: ReportDoc): OutLine[] {
  const lines: string[] = [`range: from=${d.range.from} to=${d.range.to}`];
  if (d.audit_file === 'absent') lines.push('无审计文件(未观察到任何事件)');
  else if (d.observed === null) lines.push('审计文件为空(观察到 0 行)');
  else {
    lines.push(
      `已观察事件范围 ${d.observed.from}..${d.observed.to}(${d.observed.lines} 行);不证明保留策略是否截断`,
    );
    if (d.request_before_observed) lines.push('request_before_observed=true');
  }
  if (d.observed !== null) {
    const ids = (x: IdCount): string => (x.ids.length === 0 ? '' : ` ids=${x.ids.join(',')}`);
    lines.push(`transitions(已观察): ${d.transitions.count}${ids(d.transitions)}`);
    lines.push(`rollbacks(已观察): ${d.rollbacks.count}${ids(d.rollbacks)}`);
    lines.push(`expired(已观察): ${d.expired.count}${ids(d.expired)}`);
    lines.push(`canary(已观察): ${d.canary.count}${ids(d.canary)}`);
    lines.push(`cost(已观察): injected_bytes=${d.cost.injected_bytes} s2_count=${d.cost.s2_count}`);
  }
  lines.push(`counts_scope=${d.counts_scope}`);
  return lines.map((head) => ({ head }));
}

export async function runReport(
  p: AutoReadPorts,
  o: { json: boolean; range: ReportRange; forbidden: readonly string[] },
  sink: OutputSink,
): Promise<number> {
  const r = await computeReport(p, o.range);
  if (r.kind === 'fail') {
    if (r.lines.length > 0) sink.stdout(r.lines.map((l) => `${l}\n`).join(''));
    sink.stderr('RSI_FAIL_CLOSED reason=audit_invalid\n');
    return ExitCode.FAIL_CLOSED;
  }
  const lines = o.json ? jsonLines(canonicalJson(r.doc)) : renderReportText(r.doc);
  return emitLines(sink, lines, o.forbidden);
}
