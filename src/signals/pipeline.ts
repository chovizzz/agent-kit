/**
 * 单个会话的处理管线:读取 → 归一化事件 → 排除判定 → 脱敏(pass1 + pass2)→ Signal。
 *
 * 不变量:
 *  - 排除在 cwd_hint 一出现就判定,命中立即中止读取,该会话**不产出任何信号**;
 *  - 摘录文本在内存里最多保留 TEXT_WINDOW 字符,且若被截断,收在最后一个空白处
 *    (找不到空白 → 摘录置空),避免切断一个秘密后让半截漏过检测;
 *  - 脱敏用 Redactor.apply(pass1 + pass2);失败(residual/error/timeout)→ 丢弃该信号并计数,
 *    绝不输出其任何内容;最终摘录(截到 ≤300 码点后)再 pass2 一次;
 *  - 外部内容会话:摘录一律为空串(只保留结构化信息);
 *  - 只为 user_message、tool_call、失败的 tool_result 产出信号(P0 不分类,type 恒为 'event')。
 */
import type { AgentId } from '../contracts/common.js';
import type {
  Counts,
  NormEvent,
  SessionMeta,
  SessionRef,
  TraceReader,
} from '../contracts/reader.js';
import { MAX_EXCERPT_CHARS, SignalSchema } from '../contracts/signal.js';
import type { Signal } from '../contracts/signal.js';
import type { RedactFailReason, Redactor } from '../contracts/redact.js';
import type { ExcludePolicy, ProjectDecision } from './exclude.js';
import { isExternalToolName } from './external-content.js';
import { projectKeyFor, sessionRefFor, sigIdFor } from './ids.js';
import { resolveAgentVersion } from './version.js';
import type { ResolvedVersion } from './version.js';

/** 内存里保留的事件文本上限(字符)。 */
export const TEXT_WINDOW = 4096;
export const PLACEHOLDER_OPEN = '[[REDACTED:';
const PLACEHOLDER_NEUTRALIZED = '[[ REDACTED:';

export interface PipelineDeps {
  redactor: Redactor;
  policy: ExcludePolicy;
  salt: string;
  fallbackVersion: string | undefined;
  maxEventBytes: number | undefined;
}

export type SessionStatus = 'processed' | 'excluded' | 'read_error';

export interface SessionResult {
  status: SessionStatus;
  sessionRef: string;
  excludeReason?: ProjectDecision['reason'];
  eventsSeen: number;
  counts?: Counts;
  meta?: SessionMeta;
  version?: ResolvedVersion;
  /** 已脱敏且通过复扫的信号 */
  signals: Signal[];
  dropped: number;
  dropReasons: Partial<Record<RedactFailReason, number>>;
}

interface Candidate {
  index: number;
  ts: string;
  /** 排除判定前暂存的原文窗口;判定通过后立刻脱敏并清空,内存里只留 ≤300 字的结果 */
  text: string | undefined;
  truncated: boolean;
  result?: ExcerptResult;
}

function wantsSignal(ev: NormEvent): boolean {
  if (ev.kind === 'user_message' || ev.kind === 'tool_call') return true;
  return ev.kind === 'tool_result' && ev.tool_failed === true;
}

const SAFE_KEY_RE = /^[A-Za-z0-9_.:()<>+-]{1,96}$/;
export const UNPRINTABLE_KEY = '<unprintable>';

/**
 * 计数表的键来自 trace 原文(未知事件类型名),可能被塞进秘密。键必须过字符白名单、
 * 且经 Redactor.apply 后原样不变,否则归并到 `<unprintable>`(计数保留,不丢)。
 */
export function safeKey(redactor: Redactor, key: string): string {
  if (!SAFE_KEY_RE.test(key)) return UNPRINTABLE_KEY;
  const r = redactor.apply(key);
  return r.ok && r.text === key ? key : UNPRINTABLE_KEY;
}

function sanitizeRecord(redactor: Redactor, rec: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec)) {
    const sk = safeKey(redactor, k);
    out[sk] = (out[sk] ?? 0) + v;
  }
  return out;
}

export function sanitizeCounts(redactor: Redactor, counts: Counts): Counts {
  return {
    ...counts,
    unknown_event_types: sanitizeRecord(redactor, counts.unknown_event_types),
    ...(counts.ignored_duplicate_kinds
      ? { ignored_duplicate_kinds: sanitizeRecord(redactor, counts.ignored_duplicate_kinds) }
      : {}),
  };
}

/** 把已脱敏文本截到 ≤max 码点;切点落在占位符中间时退到占位符开头。 */
export function cutExcerpt(text: string, max = MAX_EXCERPT_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  let cut = chars.slice(0, max).join('');
  // 切点落在标记自身中间(`[[RED`):先退掉这段前缀
  for (let k = Math.min(PLACEHOLDER_OPEN.length - 1, cut.length); k >= 1; k--) {
    if (cut.endsWith(PLACEHOLDER_OPEN.slice(0, k))) {
      cut = cut.slice(0, -k);
      break;
    }
  }
  const open = cut.lastIndexOf(PLACEHOLDER_OPEN);
  if (open !== -1 && cut.indexOf(']]', open) === -1) cut = cut.slice(0, open);
  return cut;
}

type ExcerptResult = { ok: true; excerpt: string } | { ok: false; reason: RedactFailReason };

export function makeExcerpt(
  redactor: Redactor,
  text: string | undefined,
  truncated: boolean,
): ExcerptResult {
  if (text === undefined || text === '') return { ok: true, excerpt: '' };
  let src = text;
  if (truncated) {
    const ws = Math.max(src.lastIndexOf(' '), src.lastIndexOf('\n'), src.lastIndexOf('\t'));
    if (ws <= 0) return { ok: true, excerpt: '' };
    src = src.slice(0, ws);
  }
  // 原文里形如占位符的串(`[[REDACTED:xxx]]`)会被两遍扫描先剥掉再扫,等于给「藏在类型名里」的内容开了后门;
  // 进脱敏前先拆开标记,让它当普通文本被扫描(合法占位符只由第一遍产生)
  src = src.replaceAll(PLACEHOLDER_OPEN, PLACEHOLDER_NEUTRALIZED);
  const r = redactor.apply(src);
  if (!r.ok) return { ok: false, reason: r.reason };
  const excerpt = cutExcerpt(r.text);
  const again = redactor.pass2(excerpt);
  if (!again.clean) return { ok: false, reason: 'residual' };
  return { ok: true, excerpt };
}

export async function processSession(
  reader: TraceReader,
  discovered: SessionRef,
  deps: PipelineDeps,
): Promise<SessionResult> {
  const sessionRef = sessionRefFor(deps.salt, discovered.path);
  const ref: SessionRef = { ...discovered, session_ref: sessionRef };
  const base: SessionResult = {
    status: 'processed',
    sessionRef,
    eventsSeen: 0,
    signals: [],
    dropped: 0,
    dropReasons: {},
  };

  const read = reader.read(ref, {
    salt: deps.salt,
    ...(deps.maxEventBytes !== undefined ? { maxEventBytes: deps.maxEventBytes } : {}),
  });

  let decision: ProjectDecision | undefined;
  let sessionExternal = false;
  const candidates: Candidate[] = [];
  let index = 0;
  let settled = 0;
  /** 排除判定通过后,把已暂存的候选依次脱敏(原文随即丢弃) */
  const settle = (): void => {
    for (; settled < candidates.length; settled++) {
      const c = candidates[settled] as Candidate;
      c.result = makeExcerpt(deps.redactor, c.text, c.truncated);
      c.text = undefined;
    }
  };

  try {
    for await (const ev of read.events) {
      const i = index++;
      base.eventsSeen++;
      if (decision === undefined) {
        const cwd = read.meta().cwd_hint;
        if (cwd !== null) {
          decision = await deps.policy.decide(cwd);
          if (decision.action === 'skip') {
            return {
              ...base,
              status: 'excluded',
              eventsSeen: 0,
              ...(decision.reason !== undefined ? { excludeReason: decision.reason } : {}),
            };
          }
        }
      }
      if (ev.external_content === true || isExternalToolName(ev.tool_name)) sessionExternal = true;
      if (wantsSignal(ev)) {
        const text = ev.text;
        candidates.push({
          index: i,
          ts: ev.ts,
          text: text === undefined ? undefined : text.slice(0, TEXT_WINDOW),
          truncated: text !== undefined && text.length > TEXT_WINDOW,
        });
      }
      if (decision !== undefined) settle();
    }
  } catch {
    // 会话文件读取中途失败(被删除、权限):不输出任何半成品
    return { ...base, status: 'read_error', eventsSeen: 0, signals: [] };
  }

  const meta = read.meta();
  const counts = sanitizeCounts(deps.redactor, read.counts());
  decision ??= await deps.policy.decide(meta.cwd_hint);
  if (decision.action === 'skip') {
    return {
      ...base,
      status: 'excluded',
      eventsSeen: 0,
      ...(decision.reason !== undefined ? { excludeReason: decision.reason } : {}),
    };
  }

  const version = resolveAgentVersion(meta.agent_version, deps.fallbackVersion);
  const external = sessionExternal || meta.external_content;
  const projectKey = projectKeyFor(deps.salt, decision.projectRoot ?? '');
  const agent: AgentId = reader.agent;

  settle();
  for (const c of candidates) {
    // 外部内容会话:摘录一律置空,且脱敏失败不计(那条信号本来就不带任何文本)
    const ex: ExcerptResult = external
      ? { ok: true, excerpt: '' }
      : (c.result ?? { ok: true, excerpt: '' });
    if (!ex.ok) {
      base.dropped++;
      base.dropReasons[ex.reason] = (base.dropReasons[ex.reason] ?? 0) + 1;
      continue;
    }
    base.signals.push(
      SignalSchema.parse({
        sig_id: sigIdFor(deps.salt, sessionRef, c.index),
        agent,
        agent_version: version.version,
        agent_version_source: version.source,
        session_ref: sessionRef,
        project_key: projectKey,
        ts: c.ts,
        type: 'event',
        excerpt_redacted: ex.excerpt,
        external_content: external,
        confidence: 1,
        loaded_rule_ids: [],
      } satisfies Signal),
    );
  }
  return { ...base, counts, meta, version };
}
