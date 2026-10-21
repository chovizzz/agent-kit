/**
 * 会话计数库(R1,contracts #23):`.state/sessions/<agent>/<yyyymm>.jsonl`,每行一个 `SessionStat`。
 *
 * - **只有计数,没有任何文本**。外部内容会话的信号摘录为空,但它的计数照样落这里(contracts #8)。
 *   唯一可能源自会话文本的是 `unknown_event_types` / `ignored_duplicate_kinds` 的键,
 *   这里收到的是管线已经过 `safeKey` 的键(`sanitizeCounts`),再限量到 ≤64 个。
 * - 目录 0700、文件 0600,写入一律经 safe-fs;每个被改动的月份文件用「临时文件 + rename」原子重写,
 *   不会留下半行。月份取 `ts` 的 UTC。
 * - 以 `session_ref` 为键 upsert,而不是无条件追加:同一会话重采时
 *   (a) 行完全相同 → 不动(幂等,文件逐字节不变);
 *   (b) 会话增长、计数变了 → 就地替换那一行(否则信号库因新 sig_id 增长而计数库停在首次采集,两者不一致);
 *   (c) 没见过 → 追加到 `ts` 对应月份。
 *   **ts 首写钉死**:已有行的 `ts`(及所在月份文件)沿用库里的值,只更新 counts / external_content / project_key。
 *   事件不带时间戳时 reader 会回退到文件 mtime,它随会话增长而变;钉死后永远不需要跨文件搬行,
 *   也就不会出现「写新文件再删旧文件」中途崩溃留下的重复行。
 *   查找范围是该 agent 目录下**所有**月份文件,一个 session_ref 至多一行。
 * - 库里有坏行(JSON 非法 / 不符 SessionStatSchema / 同一 session_ref 重复)→ SignalStoreError(fail-closed),不再写入。
 *   单进程写入假设同 signals 库。
 */
import * as path from 'node:path';
import type { AgentId } from '../contracts/common.js';
import { MAX_COUNT_KEYS, SESSION_STAT_DIR, SessionStatSchema } from '../contracts/session-stat.js';
import type { SessionStat } from '../contracts/session-stat.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readDir, readText } from '../io/read-fs.js';
import { chmod, mkdirp, rename, writeFile } from '../io/safe-fs.js';
import { newCountRecord } from '../contracts/count-record.js';
import type { SessionResult } from './pipeline.js';
import { signalMonth, SignalStoreError } from './state-store.js';

/** 键数超限时的折叠桶;合法键(与 safeKey 同字符集)。 */
export const OTHER_KEY = '<other>';

function capKeys(rec: Record<string, number>): Record<string, number> {
  const keys = Object.keys(rec);
  if (keys.length <= MAX_COUNT_KEYS) return rec;
  // 计数降序、同数按键序:保留最有信息量的 63 个,其余折叠(确定性)
  const sorted = keys
    .filter((k) => k !== OTHER_KEY)
    .sort((a, b) => (rec[b] as number) - (rec[a] as number) || (a < b ? -1 : a > b ? 1 : 0));
  const out = newCountRecord();
  let other = rec[OTHER_KEY] ?? 0;
  sorted.forEach((k, i) => {
    const v = rec[k] as number;
    if (i < MAX_COUNT_KEYS - 1) out[k] = v;
    else other += v; // 折叠不丢计数
  });
  out[OTHER_KEY] = other;
  return out;
}

/**
 * 由一个 processed 会话结果生成计数行;非 processed 返回 undefined。
 * 会话时间取不到(无 started_at 且无任何事件)时也返回 undefined——不用当前时钟兜底;
 * 调用方单独计数(`statsSkippedNoTs`)。
 */
export function buildSessionStat(r: SessionResult): SessionStat | undefined {
  if (
    r.status !== 'processed' ||
    r.counts === undefined ||
    r.projectKey === undefined ||
    r.sessionTs === undefined
  )
    return undefined;
  const c = r.counts;
  const counts = {
    ...c,
    unknown_event_types: capKeys(c.unknown_event_types),
    ...(c.ignored_duplicate_kinds
      ? { ignored_duplicate_kinds: capKeys(c.ignored_duplicate_kinds) }
      : {}),
  };
  return SessionStatSchema.parse({
    session_ref: r.sessionRef,
    project_key: r.projectKey,
    ts: r.sessionTs,
    external_content: r.external === true,
    counts,
  } satisfies SessionStat);
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k]);
    return out;
  }
  return v;
}

/** 键递归按码元序排序的单行 JSON(同一内容恒得同一字节)。 */
export function statLine(stat: SessionStat): string {
  return JSON.stringify(sortDeep(stat));
}

export function sessionStatsDir(io: IoContext, agent: AgentId): string {
  return path.join(io.stateDir, SESSION_STAT_DIR, agent);
}

export interface StatWriteResult {
  written: number;
  updated: number;
  unchanged: number;
  files: string[];
}

const MONTH_FILE_RE = /^\d{6}\.jsonl$/;

interface Loaded {
  file: string;
  lines: string[];
  changed: boolean;
}

/** 已规划好的写入(内存里);`applySessionStats` 才真正落盘。 */
export interface StatPlan {
  dir: string;
  files: Map<string, Loaded>;
  result: StatWriteResult;
}

/**
 * 读入并校验现有计数库,在内存里算出要写什么——**不写任何东西**。
 * collect 先 plan(库内容带病、月份文件是目录/符号链接都在这里 fail-closed),再写信号库,最后 apply。
 * 这把「内容校验失败」挡在信号写入之前;apply 阶段的纯 I/O 失败(ENOSPC 等)仍可能留下「信号已写、计数未写」,
 * 重采会从会话文件重算而自愈。
 */
export async function planSessionStats(
  io: IoContext,
  agent: AgentId,
  stats: readonly SessionStat[],
): Promise<StatPlan> {
  const dir = sessionStatsDir(io, agent);
  const result: StatWriteResult = { written: 0, updated: 0, unchanged: 0, files: [] };
  const files = new Map<string, Loaded>();
  const where = new Map<string, { file: string; idx: number; stat: SessionStat }>();
  if (await fileExists(dir)) {
    for (const e of (await readDir(dir)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!MONTH_FILE_RE.test(e.name)) continue;
      // 名字像月份文件却不是普通文件(目录、符号链接):不能跳过——后面的 rename 会把它替换掉并丢行
      if (!e.isFile) throw new SignalStoreError('会话计数库的月份文件不是普通文件');
      const file = path.join(dir, e.name);
      const lines = (await readText(file)).split('\n').filter((l) => l !== '');
      files.set(file, { file, lines, changed: false });
      lines.forEach((line, idx) => {
        let parsed;
        try {
          parsed = SessionStatSchema.parse(JSON.parse(line));
        } catch {
          throw new SignalStoreError('会话计数库含无法解析或不合契约的行');
        }
        if (where.has(parsed.session_ref))
          throw new SignalStoreError('会话计数库含重复 session_ref');
        where.set(parsed.session_ref, { file, idx, stat: parsed });
      });
    }
  }

  const seen = new Set<string>();
  for (const incoming of stats) {
    SessionStatSchema.parse(incoming); // 落盘前最后一道结构校验
    if (seen.has(incoming.session_ref)) continue; // 同一批内重复(不应发生)以先到者为准
    seen.add(incoming.session_ref);
    const prev = where.get(incoming.session_ref);
    if (prev !== undefined) {
      // ts 首写钉死;external_content 只升不降(曾判为外部内容的会话不会因后续重采被「洗白」)
      const stat: SessionStat = {
        ...incoming,
        ts: prev.stat.ts,
        external_content: prev.stat.external_content || incoming.external_content,
      };
      const line = statLine(stat);
      if (line === statLine(prev.stat)) {
        result.unchanged++;
        continue;
      }
      const f = files.get(prev.file) as Loaded;
      f.lines[prev.idx] = line;
      f.changed = true;
      prev.stat = stat;
      result.updated++;
      continue;
    }
    const file = path.join(dir, `${signalMonth(incoming.ts)}.jsonl`);
    let f = files.get(file);
    if (f === undefined) {
      f = { file, lines: [], changed: false };
      files.set(file, f);
    }
    f.lines.push(statLine(incoming));
    f.changed = true;
    where.set(incoming.session_ref, { file, idx: f.lines.length - 1, stat: incoming });
    result.written++;
  }
  return { dir, files, result };
}

export async function applySessionStats(io: IoContext, plan: StatPlan): Promise<StatWriteResult> {
  const { dir, files, result } = plan;
  if (result.written === 0 && result.updated === 0 && result.unchanged === 0) return result;
  await mkdirp(io, dir, 0o700);
  for (const d of [io.stateDir, path.dirname(dir), dir]) await chmod(io, d, 0o700);
  for (const f of [...files.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    if (!f.changed) {
      if (await fileExists(f.file)) await chmod(io, f.file, 0o600); // 已有文件权限过宽时顺带收紧
      continue;
    }
    const tmp = `${f.file}.tmp`;
    await writeFile(io, tmp, `${f.lines.join('\n')}\n`, { mode: 0o600 });
    await chmod(io, tmp, 0o600);
    await rename(io, tmp, f.file);
    await chmod(io, f.file, 0o600);
    result.files.push(f.file);
  }
  return result;
}

export async function writeSessionStats(
  io: IoContext,
  agent: AgentId,
  stats: readonly SessionStat[],
): Promise<StatWriteResult> {
  return applySessionStats(io, await planSessionStats(io, agent, stats));
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}
