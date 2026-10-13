/**
 * attest 的计数库(L5,设计 §3.3 / §6,⑤A):纯本地、零网络;不 import 任何 LLM 后端。
 *
 * 口径 `signature_proxy_v1`(曝光与命中在代理口径下无法区分):
 *  - 当前 pipeline 产出的 Signal 里 `loaded_rule_ids` 恒为空,没有「规则已加载」的事实,
 *    所以按原子的 `signature` 去匹配窗口内的信号:`tool` 型匹配 `tool_call` 信号的 `tool_name`,
 *    `phrase` 型匹配 `user_message` 信号的 `excerpt_redacted`,`always` 型 = 窗口内每个会话都算曝光;
 *    `path` 型信号里没有文件路径 → 无法计数(命令层退出 4)。
 *  - 被匹配串先截到 4KiB(UTF-8 字节),pattern 先过 checkPatternSafety + 量词上限。
 *  - 外部内容会话与 tool_result_failed 的摘录一律视为空(同 reflect 装载器的口径)。
 *  - D4 去重:窗口内带相同 `event_key` 的信号只算一次(排序后第一条胜出)。全部信号都被去重掉的会话视为
 *    重复文件,不计入 `sessions_total`。
 *  - `fired` = 命中的(去重后)事件数;`always` 型没有事件可数,取 `exposure_sessions`。
 *  - `harmful` = 曝光会话内、该会话首次命中之后出现的 `user_correction` / `revert` 类型信号数。
 *    当前 pipeline 只产出 `type: 'event'`,所以在分类信号入库前恒为 0(口径待定,见汇报)。
 *  - `recurrence` 需要原提案证据所在聚类,代理口径下无数据源,恒为 0。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { z } from 'zod';
import type { SignatureSchema } from '../contracts/atom.js';
import { AGENT_IDS } from '../contracts/common.js';
import type { AgentId } from '../contracts/common.js';
import { checkPatternSafety, SIGNATURE_REGEX_FLAGS } from '../contracts/reflect.js';
import { SESSION_STAT_DIR, SessionStatSchema } from '../contracts/session-stat.js';
import type { SessionStat } from '../contracts/session-stat.js';
import { SignalSchema } from '../contracts/signal.js';
import type { Signal } from '../contracts/signal.js';
import { canonicalText } from '../io/canonical-text.js';
import type { IoContext } from '../io/paths.js';
import { gitBlobOid } from '../reflect/stage.js';
import { exists, readDir, readLines, TOO_LONG_LINE } from '../io/read-fs.js';
import { patternQuantifiersOk } from '../reflect/validate.js';
import { SignalStoreError } from '../signals/state-store.js';

/** 单个事件文本参与匹配前的字节上限。 */
export const MATCH_TEXT_LIMIT_BYTES = 4096;
const MAX_LINE_BYTES = 64 * 1024;
/** 会让一次曝光之后的相同会话记为「有害」的信号类型。 */
export const HARMFUL_SIGNAL_TYPES: ReadonlySet<string> = new Set(['user_correction', 'revert']);

type Signature = z.infer<typeof SignatureSchema>;

/** 数字段按数值比、其余按字典序的版本比较(只用于挑 collector_versions 里的最大值,确定性即可)。 */
function versionOrder(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** 截到 ≤ MATCH_TEXT_LIMIT_BYTES 个 UTF-8 字节,不切断码点。 */
export function clipForMatch(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MATCH_TEXT_LIMIT_BYTES) return text;
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > MATCH_TEXT_LIMIT_BYTES) break;
    bytes += n;
    out += ch;
  }
  return out;
}

export type SignatureMatcher =
  | { kind: 'always' }
  | { kind: 'path' }
  | { kind: 'none' }
  | { kind: 'unsafe' }
  | { kind: 'match'; sigType: 'tool' | 'phrase'; test(text: string): boolean };

export function buildMatcher(sig: Signature | undefined): SignatureMatcher {
  if (sig === undefined) return { kind: 'none' };
  if (sig.type === 'always') return { kind: 'always' };
  if (sig.type === 'path') return { kind: 'path' };
  const pattern = sig.pattern ?? '';
  if (!checkPatternSafety(pattern).ok || !patternQuantifiersOk(pattern)) return { kind: 'unsafe' };
  const re = new RegExp(pattern, SIGNATURE_REGEX_FLAGS);
  return { kind: 'match', sigType: sig.type, test: (text) => re.test(clipForMatch(text)) };
}

/** 一条(已清洗的)信号是否命中 `tool` / `phrase` 匹配器。 */
export function signalMatches(
  m: Extract<SignatureMatcher, { kind: 'match' }>,
  s: { event_kind?: string | undefined; tool_name?: string | undefined; excerpt: string },
): boolean {
  if (m.sigType === 'tool') {
    return s.event_kind === 'tool_call' && s.tool_name !== undefined && m.test(s.tool_name);
  }
  return s.event_kind === 'user_message' && s.excerpt !== '' && m.test(s.excerpt);
}

/** 窗口 = [start 00:00:00Z, end+1 天 00:00:00Z)。 */
export function windowBounds(start: string, end: string): { fromMs: number; toMs: number } {
  const fromMs = Date.parse(`${start}T00:00:00Z`);
  const toMs = Date.parse(`${end}T00:00:00Z`) + 24 * 3600 * 1000;
  return { fromMs, toMs };
}

export interface CountInput {
  signals: readonly Signal[];
  sessionStats: readonly (Pick<SessionStat, 'session_ref' | 'ts'> & { project_key?: string })[];
  matcher: Extract<SignatureMatcher, { kind: 'match' | 'always' }>;
  from: number;
  to: number;
  /** 空 = 不过滤 */
  agents: readonly AgentId[];
}

export interface CountResult {
  sessions_total: number;
  exposure_sessions: number;
  exposure_projects: number;
  fired: number;
  harmful: number;
  recurrence: number;
  signal_ids: string[];
  collector_versions: Partial<Record<AgentId, string>>;
  /** 窗口内(过滤 agent 后)的信号数 / 会话计数行数,命令层据此判「窗口内没有数据」 */
  window_signals: number;
  window_stat_rows: number;
  /** D4 去重掉的信号数 */
  deduplicated: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function countWindow(input: CountInput): CountResult {
  const inAgents = (a: AgentId): boolean => input.agents.length === 0 || input.agents.includes(a);
  const inWin = (ts: string): boolean => {
    const t = Date.parse(ts);
    return t >= input.from && t < input.to;
  };

  const inWindow = input.signals
    .filter((s) => inAgents(s.agent) && inWin(s.ts))
    .sort(
      (a, b) =>
        Date.parse(a.ts) - Date.parse(b.ts) ||
        cmp(a.session_ref, b.session_ref) ||
        (a.event_index ?? 0) - (b.event_index ?? 0) ||
        cmp(a.sig_id, b.sig_id),
    );
  const stats = input.sessionStats.filter((r) => inWin(r.ts));

  // 会话级外部内容:同一会话只要有一条是外部的,整个会话的摘录都视为空
  const externalSessions = new Set(
    inWindow.filter((s) => s.external_content).map((s) => s.session_ref),
  );

  // D4:同一 event_key 只留第一条;全部信号都被去掉的会话 = 重复文件
  const seenKeys = new Set<string>();
  const kept: Signal[] = [];
  const keyedSessions = new Set<string>();
  const keptSessions = new Set<string>();
  let deduplicated = 0;
  for (const s of inWindow) {
    if (s.event_key !== undefined) {
      keyedSessions.add(s.session_ref);
      if (seenKeys.has(s.event_key)) {
        deduplicated++;
        continue;
      }
      seenKeys.add(s.event_key);
    }
    kept.push(s);
    keptSessions.add(s.session_ref);
  }
  const duplicateSessions = new Set([...keyedSessions].filter((r) => !keptSessions.has(r)));

  const sessionSet = new Set<string>();
  for (const r of stats) if (!duplicateSessions.has(r.session_ref)) sessionSet.add(r.session_ref);
  for (const r of keptSessions) sessionSet.add(r);

  const matched: Signal[] = [];
  const exposed = new Map<string, Signal>(); // session_ref → 首次命中信号
  if (input.matcher.kind === 'match') {
    const m = input.matcher;
    for (const s of kept) {
      const excerpt =
        s.external_content ||
        externalSessions.has(s.session_ref) ||
        s.event_kind === 'tool_result_failed'
          ? ''
          : s.excerpt_redacted;
      const hit = signalMatches(m, {
        event_kind: s.event_kind,
        tool_name: s.tool_name,
        excerpt,
      });
      if (!hit) continue;
      matched.push(s);
      if (!exposed.has(s.session_ref)) exposed.set(s.session_ref, s);
    }
  }

  let exposureSessions: number;
  let exposureProjects: number;
  let fired: number;
  const projectOf = new Map<string, string>();
  for (const r of stats)
    if (r.project_key !== undefined) projectOf.set(r.session_ref, r.project_key);
  for (const s of kept) projectOf.set(s.session_ref, s.project_key);
  if (input.matcher.kind === 'always') {
    exposureSessions = sessionSet.size;
    exposureProjects = new Set([...sessionSet].map((r) => projectOf.get(r)).filter((x) => x)).size;
    fired = exposureSessions;
  } else {
    exposureSessions = exposed.size;
    exposureProjects = new Set([...exposed.values()].map((s) => s.project_key)).size;
    fired = matched.length;
  }

  // harmful:`match` 型 = 曝光会话内、首次命中之后的纠正/回退类信号;
  // `always` 型规则从会话开头就在上下文里,所以窗口内全部纠正/回退类信号都算
  let harmful = 0;
  if (input.matcher.kind === 'always') {
    harmful = kept.filter((s) => HARMFUL_SIGNAL_TYPES.has(s.type)).length;
  } else {
    const firstIdx = new Map<string, number>();
    kept.forEach((s, i) => {
      if (exposed.get(s.session_ref) === s) firstIdx.set(s.session_ref, i);
    });
    kept.forEach((s, i) => {
      const f = firstIdx.get(s.session_ref);
      if (f !== undefined && i > f && HARMFUL_SIGNAL_TYPES.has(s.type)) harmful++;
    });
  }

  const versions: Partial<Record<AgentId, string>> = {};
  for (const s of kept) {
    const cur = versions[s.agent];
    if (cur === undefined || versionOrder(cur, s.agent_version) < 0) {
      versions[s.agent] = s.agent_version;
    }
  }

  const ids = (input.matcher.kind === 'match' ? matched : []).map((s) => s.sig_id).sort(cmp);
  return {
    sessions_total: sessionSet.size,
    exposure_sessions: exposureSessions,
    exposure_projects: exposureProjects,
    fired,
    harmful,
    recurrence: 0,
    signal_ids: ids,
    collector_versions: versions,
    window_signals: inWindow.length,
    window_stat_rows: stats.length,
    deduplicated,
  };
}

/** `sha256:` + 排序后 sig_id 列表(换行拼接)的哈希。 */
export function signalIdsDigest(sortedIds: readonly string[]): string {
  return `sha256:${createHash('sha256').update(sortedIds.join('\n')).digest('hex')}`;
}

/**
 * Attest.rule_sha256:规范化源文本哈希。把 frontmatter 里的 `status:` / `review_by:` 行归一化为占位后,
 * 对 canonicalText(整个文件)取 sha256。口径目前只在本文件定义;L1 的 C6 哈希函数合并后须统一到同一处。
 */
export function normalizedRuleSha256(source: string): string {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let end = -1;
  if (lines[0] === '---') end = lines.indexOf('---', 1);
  const out = lines.map((l, i) => {
    if (end === -1 || i === 0 || i >= end) return l;
    if (/^status:/.test(l)) return 'status: <normalized>';
    if (/^review_by:/.test(l)) return 'review_by: <normalized>';
    return l;
  });
  return createHash('sha256')
    .update(canonicalText(out.join('\n')))
    .digest('hex');
}

async function* jsonlRows(file: string, what: string): AsyncGenerator<unknown, void, undefined> {
  for await (const line of readLines(file, MAX_LINE_BYTES)) {
    if (line === '') continue;
    if (line === TOO_LONG_LINE) throw new SignalStoreError(`${what}含超长行`);
    try {
      yield JSON.parse(line);
    } catch {
      throw new SignalStoreError(`${what}含无法解析的行`);
    }
  }
}

function monthsOf(fromMs: number, toMs: number): { min: string; max: string } {
  const f = new Date(fromMs);
  const t = new Date(toMs - 1);
  const m = (d: Date): string =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return { min: m(f), max: m(t) };
}

async function* monthFiles(
  root: string,
  fromMs: number,
  toMs: number,
  agents: readonly AgentId[],
): AsyncGenerator<string, void, undefined> {
  if (!(await exists(root))) return;
  const { min, max } = monthsOf(fromMs, toMs);
  const names = (await readDir(root))
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    if (!(AGENT_IDS as readonly string[]).includes(name)) continue;
    if (agents.length > 0 && !agents.includes(name as AgentId)) continue;
    const dir = path.join(root, name);
    const files = (await readDir(dir)).filter((f) => f.isFile && /^\d{6}\.jsonl$/.test(f.name));
    for (const f of files.sort((a, b) => cmp(a.name, b.name))) {
      const month = f.name.slice(0, 6);
      if (month < min || month > max) continue;
      yield path.join(dir, f.name);
    }
  }
}

export interface LoadedWindow {
  signals: Signal[];
  sessionStats: SessionStat[];
  /** 窗口内(或时间不可判)却不符合 schema 的行数;命令层按 fail-closed 处理 */
  droppedSchema: number;
  /** 窗口外且不符合 schema 的行数,忽略 */
  ignoredOutOfWindow: number;
}

/** 读窗口涉及月份的信号库与会话计数库(只读)。坏行(非 JSON)→ SignalStoreError;不合 schema 的行计数丢弃。 */
export async function loadWindowData(
  io: IoContext,
  fromMs: number,
  toMs: number,
  agents: readonly AgentId[],
): Promise<LoadedWindow> {
  const signals: Signal[] = [];
  const sessionStats: SessionStat[] = [];
  let droppedSchema = 0;
  let ignoredOutOfWindow = 0;
  const invalid = (raw: unknown): void => {
    const ts = (raw as { ts?: unknown } | null)?.ts;
    const t = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
    if (!Number.isNaN(t) && (t < fromMs || t >= toMs)) ignoredOutOfWindow++;
    else droppedSchema++;
  };
  for await (const file of monthFiles(path.join(io.stateDir, 'signals'), fromMs, toMs, agents)) {
    for await (const raw of jsonlRows(file, '信号库')) {
      const p = SignalSchema.safeParse(raw);
      if (p.success) signals.push(p.data);
      else invalid(raw);
    }
  }
  for await (const file of monthFiles(
    path.join(io.stateDir, SESSION_STAT_DIR),
    fromMs,
    toMs,
    agents,
  )) {
    for await (const raw of jsonlRows(file, '会话计数库')) {
      const p = SessionStatSchema.safeParse(raw);
      if (p.success) sessionStats.push(p.data);
      else invalid(raw);
    }
  }
  return { signals, sessionStats, droppedSchema, ignoredOutOfWindow };
}

/** attest 路径白名单:允许大写(run_id 含 `T` / `Z`,成员 handle 可含大写),不含 `..`、空段。 */
const ATTEST_PATCH_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * 单个新文件的 git unified diff(格式同反思器的 apply.patch,但路径白名单放宽到大小写字母:
 * reflect 的 `buildApplyPatch` 只收小写路径,而 attest 文件名里有 run_id)。内容须先过 patchUnsafe。
 */
export function buildNewFilePatch(filePath: string, content: string): string {
  if (!ATTEST_PATCH_PATH_RE.test(filePath)) throw new RangeError('补丁路径不安全');
  if (content === '' || !content.endsWith('\n') || content.includes('\r')) {
    throw new RangeError('补丁内容不安全');
  }
  const lines = content.slice(0, -1).split('\n');
  return (
    `diff --git a/${filePath} b/${filePath}\n` +
    `new file mode 100644\n` +
    `index ${'0'.repeat(12)}..${gitBlobOid(content).slice(0, 12)}\n` +
    `--- /dev/null\n` +
    `+++ b/${filePath}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((l) => `+${l}`).join('\n') +
    '\n'
  );
}
