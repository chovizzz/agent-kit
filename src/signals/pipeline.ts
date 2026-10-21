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
import { createHash } from 'node:crypto';
import type { AgentId } from '../contracts/common.js';
import type {
  Counts,
  NormEvent,
  SessionMeta,
  SessionRead,
  SessionRef,
  TraceReader,
} from '../contracts/reader.js';
import { MAX_EXCERPT_CHARS, SignalSchema } from '../contracts/signal.js';
import type { Signal, SignalEventKind } from '../contracts/signal.js';
import type { RedactFailReason, Redactor } from '../contracts/redact.js';
import type { ExcludePolicy, ProjectDecision } from './exclude.js';
import { isExternalToolName } from './external-content.js';
import { projectKeyFor, sessionRefFor, sigIdFor } from './ids.js';
import {
  neutralizePlaceholderMarkers,
  PLACEHOLDER_NEUTRALIZED,
  PLACEHOLDER_OPEN,
} from '../redact/placeholder.js';
import { addCount, newCountRecord } from '../contracts/count-record.js';
import { resolveAgentVersion } from './version.js';
import type { ResolvedVersion } from './version.js';

/** 内存里保留的事件文本上限(字符)。 */
export const TEXT_WINDOW = 4096;
export { PLACEHOLDER_OPEN };

export interface PipelineDeps {
  redactor: Redactor;
  policy: ExcludePolicy;
  salt: string;
  fallbackVersion: string | undefined;
  maxEventBytes: number | undefined;
}

export type SessionStatus = 'processed' | 'excluded' | 'read_error';

/** fail-closed 的阶段:policy = 排除判定;redact = 脱敏(摘录 / 计数键);schema = 信号落地前的契约校验。 */
export type PipelineStage = 'policy' | 'redact' | 'schema';

const CLASS_NAME_RE = /^[A-Za-z0-9_$]{1,64}$/;

/** 只取错误的类名(异常 message / cause 可能带会话内容,一律不保留);类名不规整时退回 `Error`。 */
export function errorClassOf(e: unknown): string {
  try {
    // 仓库禁止 `.constructor` 语法(constructor.constructor 可造出 Function);这里只读类名字符串,不调用它
    const ctor: unknown =
      e instanceof Error ? Reflect.get(Object.getPrototypeOf(e), 'constructor') : undefined;
    const n = typeof ctor === 'function' ? ctor.name : '';
    return CLASS_NAME_RE.test(n) ? n : 'Error';
  } catch {
    // 异常对象自己的 getter / Proxy 抛错:取类名失败不能让归类本身逃逸,否则 fail-closed 会降级成 read_error
    return 'Error';
  }
}

/**
 * 管线里「无法证明安全」的失败(排除判定、脱敏、信号校验抛错):整次运行 fail-closed,不是某个会话的读取失败。
 * 只带阶段与原异常的类名;message 固定,不挂 cause(原异常的 message 可能含会话内容 / 路径)。
 */
export class PipelineFailClosedError extends Error {
  readonly stage: PipelineStage;
  readonly errorClass: string;
  constructor(stage: PipelineStage, errorClass: string) {
    super(`signals 管线 fail-closed:阶段 ${stage},原异常类 ${errorClass}`);
    this.stage = stage;
    this.errorClass = errorClass;
  }
}

export interface SessionResult {
  status: SessionStatus;
  sessionRef: string;
  /** read_error 时:reader 侧抛出的异常类名(不含 message) */
  errorClass?: string;
  excludeReason?: ProjectDecision['reason'];
  eventsSeen: number;
  counts?: Counts;
  meta?: SessionMeta;
  version?: ResolvedVersion;
  /** 项目哈希(与信号的 project_key 同值);processed 时有 */
  projectKey?: string;
  /** 会话是否含外部内容(逐事件 / meta / 工具名兜底的并集);processed 时有 */
  external?: boolean;
  /** 会话时间:meta.started_at,取不到则首个事件的 ts,都没有则 undefined(此时不写计数行,见 buildSessionStat) */
  sessionTs?: string;
  /** 已脱敏且通过复扫的信号 */
  signals: Signal[];
  dropped: number;
  dropReasons: Partial<Record<RedactFailReason, number>>;
}

interface Candidate {
  index: number;
  ts: string;
  /** 由 reader 事件种类派生(不新增分类逻辑):wantsSignal 的三种命中 */
  eventKind: SignalEventKind;
  /** tool_call 的原始工具名(截断到 2×上限,仅用于 safeKey 判定;从不落盘) */
  rawToolName: string | undefined;
  /** 排除判定通过后(settle)才由 rawToolName 经 safeKey 算出;rawToolName 随即清空 */
  toolName?: string;
  /** 排除判定前暂存的原文窗口;判定通过后立刻脱敏并清空,内存里只留 ≤300 字的结果 */
  text: string | undefined;
  truncated: boolean;
  /** D4:跨文件去重键(仅 claude / pi 带);由事件指纹 + 同指纹出现序号加盐哈希而来,不含原文 */
  eventKey?: string;
  result?: ExcerptResult;
}

/** 会有「同一事件出现在多个会话文件」的 agent(Claude resume、Pi fork);其余 agent 不产出 event_key。 */
const EVENT_KEY_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'pi']);

/**
 * D4 去重键(docs/reader-counting-spec.md §8.1):`ek_` + 16 位十六进制(与 sig_id 同形;更长的十六进制串会被 A6 的脱敏复扫判成高熵)。
 * NormEvent 目前不携带源事件 id(Claude uuid / Pi 条目 id),所以用「历史链」代替:
 * 链 = 本会话里此前所有产信号事件的指纹依次哈希(指纹 = 事件时间 + 种类 + 工具名 + 文本窗口的 sha256),
 * 键 = 加盐 sha256(agent + 链)的前缀。resume / fork 复制出来的前缀事件历史完全相同,所以得到同一个键;
 * 两个各自独立的会话即使在同一秒做了同样的事,历史不同,键也不同。盐与 session_ref 同源,原文不会入库。
 * 代价:复制时丢了前缀里的某个事件 → 链从此分叉,不再去重(偏向多计,不会少计)。
 */
function eventKeyFor(salt: string, agent: AgentId, chain: string): string {
  const h = createHash('sha256').update([salt, 'event', agent, chain].join('\0')).digest('hex');
  return `ek_${h.slice(0, 16)}`;
}

/** 链的推进:chain' = sha256(chain ‖ 指纹)。 */
function nextChain(
  chain: string,
  parts: { ts: string; kind: SignalEventKind; toolName: string | undefined; textHash: string },
): string {
  return createHash('sha256')
    .update([chain, parts.ts, parts.kind, parts.toolName ?? '', parts.textHash].join('\0'))
    .digest('hex');
}

function wantsSignal(ev: NormEvent): boolean {
  if (ev.kind === 'user_message' || ev.kind === 'tool_call') return true;
  return ev.kind === 'tool_result' && ev.tool_failed === true;
}

/**
 * 信号的 event_kind:与 wantsSignal 同一个判据派生,不另设分类。
 * 注意它是**事件种类**:四个 reader 目前都只在 tool_result 事件上设 tool_failed(tool_call 从不带),
 * 所以 tool_result_failed 信号数与 counts.tool_failures 一一对应(脱敏丢弃的信号除外)。
 * 若将来某个 reader 在 tool_call 上带失败,这类信号 event_kind 仍是 tool_call,失败只体现在 counts 里。
 */
function eventKindOf(ev: NormEvent): SignalEventKind {
  return ev.kind === 'user_message'
    ? 'user_message'
    : ev.kind === 'tool_call'
      ? 'tool_call'
      : 'tool_result_failed';
}

/** 原始工具名只取前 192 码元参与判定:超过 96 本来就判 <unprintable>,不必保留更长的串。 */
const TOOL_NAME_WINDOW = 192;

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
  const out = newCountRecord();
  for (const [k, v] of Object.entries(rec)) addCount(out, safeKey(redactor, k), v);
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
  // 合法标记 `[[REDACTED:` 与中性化标记 `[[ REDACTED:` 两种前缀各处理一遍
  for (const marker of [PLACEHOLDER_OPEN, PLACEHOLDER_NEUTRALIZED]) {
    // 切点落在标记自身中间(`[[RED`):先退掉这段前缀
    for (let k = Math.min(marker.length - 1, cut.length); k >= 1; k--) {
      if (cut.endsWith(marker.slice(0, k))) {
        cut = cut.slice(0, -k);
        break;
      }
    }
    const open = cut.lastIndexOf(marker);
    if (open !== -1 && cut.indexOf(']]', open) === -1) cut = cut.slice(0, open);
  }
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
  src = neutralizePlaceholderMarkers(src);
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

  let read: SessionRead;
  try {
    read = reader.read(ref, {
      salt: deps.salt,
      ...(deps.maxEventBytes !== undefined ? { maxEventBytes: deps.maxEventBytes } : {}),
    });
  } catch (e) {
    // reader 同步抛错(参数越界、内部不变量):按读取失败处理,不输出任何半成品,也不回显异常内容(只留类名)
    return {
      ...base,
      status: 'read_error',
      errorClass: errorClassOf(e),
      eventsSeen: 0,
      signals: [],
    };
  }

  let decision: ProjectDecision | undefined;
  let sessionExternal = false;
  const candidates: Candidate[] = [];
  let eventChain = '';
  let index = 0;
  let settled = 0;
  let firstEventTs: string | undefined;
  /**
   * 非 reader 侧的阶段(policy / redact / schema)抛错 = 无法证明安全 → 就地包成 PipelineFailClosedError(只留阶段与类名);
   * 其余抛错(事件迭代、reader.meta()/counts())留给外层 catch,归为该会话的 read_error。
   */
  const inStage = async <T>(st: PipelineStage, fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new PipelineFailClosedError(st, errorClassOf(e));
    }
  };
  /** 排除判定通过后,把已暂存的候选依次脱敏(原文随即丢弃) */
  const toolNames = new Map<string, string>();
  const settle = (): void => {
    for (; settled < candidates.length; settled++) {
      const c = candidates[settled] as Candidate;
      c.result = makeExcerpt(deps.redactor, c.text, c.truncated);
      c.text = undefined;
      // 工具名同样只在排除判定通过后才处理:字符白名单 + 脱敏后不变,否则 <unprintable>
      if (c.rawToolName !== undefined) {
        let v = toolNames.get(c.rawToolName);
        if (v === undefined) {
          v = safeKey(deps.redactor, c.rawToolName);
          toolNames.set(c.rawToolName, v);
        }
        c.toolName = v;
        c.rawToolName = undefined;
      }
    }
  };

  try {
    for await (const ev of read.events) {
      const i = index++;
      base.eventsSeen++;
      firstEventTs ??= ev.ts;
      if (decision === undefined) {
        const cwd = read.meta().cwd_hint;
        if (cwd !== null) {
          decision = await inStage('policy', () => deps.policy.decide(cwd));
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
        let eventKey: string | undefined;
        if (EVENT_KEY_AGENTS.has(reader.agent)) {
          const textHash = createHash('sha256')
            .update(text === undefined ? '' : text.slice(0, TEXT_WINDOW))
            .digest('hex');
          eventChain = nextChain(eventChain, {
            ts: ev.ts,
            kind: eventKindOf(ev),
            toolName: ev.tool_name,
            textHash,
          });
          eventKey = eventKeyFor(deps.salt, reader.agent, eventChain);
        }
        candidates.push({
          index: i,
          ts: ev.ts,
          eventKind: eventKindOf(ev),
          rawToolName:
            ev.kind === 'tool_call' && ev.tool_name !== undefined && ev.tool_name !== ''
              ? ev.tool_name.slice(0, TOOL_NAME_WINDOW)
              : undefined,
          text: text === undefined ? undefined : text.slice(0, TEXT_WINDOW),
          truncated: text !== undefined && text.length > TEXT_WINDOW,
          ...(eventKey !== undefined ? { eventKey } : {}),
        });
      }
      if (decision !== undefined) await inStage('redact', settle);
    }

    const meta = read.meta();
    const rawCounts = read.counts();
    const counts = await inStage('redact', () => sanitizeCounts(deps.redactor, rawCounts));
    decision ??= await inStage('policy', () => deps.policy.decide(meta.cwd_hint));
    if (decision.action === 'skip') {
      return {
        ...base,
        status: 'excluded',
        eventsSeen: 0,
        ...(decision.reason !== undefined ? { excludeReason: decision.reason } : {}),
      };
    }
    const resolved = decision;

    const version = resolveAgentVersion(meta.agent_version, deps.fallbackVersion);
    const external = sessionExternal || meta.external_content;
    const projectKey = projectKeyFor(deps.salt, resolved.projectRoot ?? '');
    const agent: AgentId = reader.agent;

    await inStage('redact', settle);
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
      const sig = await inStage('schema', () =>
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
          event_kind: c.eventKind,
          // 与 sigIdFor 用的序号是同一个 c.index(会话事件流内的位置,含不产信号的事件)
          event_index: c.index,
          ...(c.eventKey !== undefined ? { event_key: c.eventKey } : {}),
          // 外部内容会话不落 tool_name:调用名是模型读完外部内容之后自己写的,宿主拒绝执行也照样进 trace,
          // 白名单字符足以拼出指令性标记(如 SYSTEM:xxx),而 contracts #8 要求外部会话只留结构化计数
          ...(c.toolName !== undefined && !external ? { tool_name: c.toolName } : {}),
        } satisfies Signal),
      );
      base.signals.push(sig);
    }
    const sessionTs = meta.started_at ?? firstEventTs;
    return {
      ...base,
      counts,
      meta,
      version,
      projectKey,
      external,
      ...(sessionTs !== undefined ? { sessionTs } : {}),
    };
  } catch (e) {
    candidates.length = 0; // 纵深防御:失败路径上不再持有任何暂存原文
    if (e instanceof PipelineFailClosedError) throw e;
    // 会话文件读取中途失败(被删除、权限)、reader 的 meta()/counts() 抛错:不输出任何半成品
    return {
      ...base,
      status: 'read_error',
      errorClass: errorClassOf(e),
      eventsSeen: 0,
      signals: [],
    };
  }
}
