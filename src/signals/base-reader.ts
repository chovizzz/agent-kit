/**
 * reader 公共层(B10b)。B11–B14 的四个 reader 继承 `JsonlTraceReader`,只写「一行 JSON → 事件」。
 *
 * 基类统一负责(口径见 docs/reader-counting-spec.md C1–C8):
 *  - 经 open-readonly.ts 只读、流式逐行读取;首行 BOM 去除;CRLF / 末行无换行同结果;
 *  - 空白行忽略;非法 JSON、合法但非对象的行 → 不产出事件,计入 unknown_event_types["<malformed>"];
 *  - 超长行(UTF-8 字节 > maxEventBytes):**仍整行解析并分类**,只丢事件 text 并累加 oversized_lines,
 *    所以计数不随 maxEventBytes 改变(C8);
 *  - ts 规范化与回退(事件/行自带 → 会话内第一个有效时间戳 → 文件 mtime),非空率 100%;
 *  - Counts 只由事件流派生(C5 恒等式),子类没有办法「计了数却没产出事件」;
 *  - SessionMeta:agent_version / cwd_hint / started_at 首值优先,external_content OR,loaded_rule_paths 去重累积。
 *
 * 基类**不**判断 `<no-type>`、侧链、重复等各家语义——那是子类 classifyLine 的事。
 */
import * as path from 'node:path';
import type { AgentId } from '../contracts/common.js';
import { MAX_LINE_BYTES, TOO_LONG_LINE, readDir, realpath, lstat } from '../io/read-fs.js';
import type {
  Counts,
  NormEvent,
  NormEventKind,
  ReadOpts,
  SessionMeta,
  SessionRead,
  SessionRef,
  TraceReader,
} from '../contracts/reader.js';
import { RSI_MAX_JSON_DEPTH } from '../contracts/rsi.js';
import { addCount, newCountRecord, toCountRecord } from '../contracts/count-record.js';
import type { CountRecord } from '../contracts/count-record.js';
import { provisionalSessionRef, sessionRefFor } from './ids.js';
import { openReadonlyLines, statReadonly } from './open-readonly.js';

export type JsonObject = Record<string, unknown>;

/**
 * 单行超过此字节数的事件 text 被丢弃(行本身照常分类计数)。
 * 8 MiB:本机最大行约 1.3 MB(Claude)/2.5 MB(Kimi)/4.0 MB(Pi),取小了会无谓触发 oversized_lines;
 * 摘录只取前 4096 字符,调大不增加泄露面。默认值待主代理确认(spec §8 D3)。
 */
export const DEFAULT_MAX_EVENT_BYTES = 8 * 1024 * 1024;

export const MALFORMED_KEY = '<malformed>';
/** 单行超过硬上限(MAX_LINE_BYTES)而被丢弃正文的行;不产出事件,同时计入 oversized_lines(C8)。 */
export const LINE_TOO_LARGE_KEY = '<line-too-large>';
/**
 * 单行 JSON 嵌套深度超过 {@link RSI_MAX_JSON_DEPTH} 的行(R20-A0,contracts §13 / §20.9 第 14 条 / R20-6.7,Q16-A):
 * 解析前按括号计数预扫,超限的行不交给 `JSON.parse`、不产出事件,计入 `oversized_lines` 与本键;会话其余行照常读取。
 */
export const LINE_TOO_DEEP_KEY = '<line-too-deep>';
export const NO_TYPE_KEY = '<no-type>';

/**
 * 括号计数预扫:`text` 里 `{` / `[` 的嵌套层数是否超过 `max`(字符串字面量内的括号与转义不计;多余的闭括号不让层数变负)。
 * 只数括号、不校验 JSON 合法性:非法文本照常交给解析器去判 `<malformed>`;超限时提前返回,不必扫完整行。
 */
export function exceedsJsonDepth(text: string, max: number = RSI_MAX_JSON_DEPTH): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c)
        i++; // 反斜杠:跳过下一个码元(\" 不结束字符串)
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > max) return true;
    } else if ((c === 0x7d || c === 0x5d) && depth > 0) depth--;
  }
  return false;
}

export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 非空字符串或 undefined。 */
const AGENT_VERSION_RE = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(?:[-+][0-9A-Za-z.+-]{1,40})?$/;

/** 版本号形状(`X.Y.Z[-+后缀]`,总长 ≤ 64);不符合的值不得进入 Signal。 */
export function isVersionShape(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && AGENT_VERSION_RE.test(v);
}

export function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

const TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;
const TZ_SUFFIX_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * 规范成 ISO-8601 UTC 毫秒串;无效返回 undefined。
 * 字符串:须以 `YYYY-MM-DDT` 开头且 Date.parse 非 NaN;没有时区的按 UTC 解释(不随 TZ 抖动)。
 * 数字:仅当 acceptEpochMs 且 1e12 <= v < 4e12(毫秒)。
 */
export function normalizeTs(raw: unknown, acceptEpochMs = false): string | undefined {
  if (typeof raw === 'string') {
    if (!TS_PREFIX_RE.test(raw)) return undefined;
    const ms = Date.parse(TZ_SUFFIX_RE.test(raw) ? raw : `${raw}Z`);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  if (acceptEpochMs && typeof raw === 'number' && raw >= 1e12 && raw < 4e12) {
    return new Date(raw).toISOString();
  }
  return undefined;
}

/**
 * 与 jq(Oniguruma)`test("\\S")` 对齐的「整行只有空白」判定(R2):Unicode White_Space,含 U+0085、不含 U+FEFF。
 * 已用本机 jq 1.7.1 对全部 Unicode 码位逐个核对(JS 的 `\s` 恰好相反:含 FEFF、不含 0085)。
 */
const BLANK_LINE_RE = new RegExp(
  '^[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*$',
  'u',
);
export const isBlankLine = (line: string): boolean => BLANK_LINE_RE.test(line);

/**
 * 每一行(不只是首行)的待解析文本:先按原始行判空白(只含 U+FEFF 的行不是空白,会计 `<malformed>`,与 jq 一致),
 * 再去掉行首恰好一个 U+FEFF(jq 的 fromjson 会跳过它,如 `cat a b` 拼出来的文件)。空白行返回 undefined。
 */
export function lineText(raw: string): string | undefined {
  return isBlankLine(raw) ? undefined : stripBom(raw);
}

/** 去掉行首一个 UTF-8 BOM(U+FEFF)。 */
export function stripBom(line: string): string {
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
}

/** 按 UTF-8 字节截断,不留半个字符。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return cut.endsWith('�') ? cut.slice(0, -1) : cut;
}

/** reader 子类产出的事件(尚未补 ts / session_ref)。 */
export interface ParsedEvent {
  kind: NormEventKind;
  /** 源文件里的原始事件类型名;未知事件即未知键(C6) */
  raw_type: string;
  /** 事件自带的原始时间戳(字符串/毫秒数);缺省则用 lineTimestamp(obj),再回退 */
  ts?: unknown;
  tool_name?: string;
  tool_failed?: boolean;
  text?: string;
  external_content?: boolean;
}

export interface MetaUpdate {
  agent_version?: string;
  cwd_hint?: string;
  /** 原始值;基类规范化。优先于预扫得到的会话起始时间 */
  started_at?: unknown;
  external_content?: boolean;
  loaded_rule_paths?: readonly string[];
}

export interface LineOutcome {
  events?: readonly ParsedEvent[];
  /** 未知键,每个 +1(`<no-type>` 等由子类给;`<malformed>` 由基类给) */
  unknownKeys?: readonly string[];
  /** 被忽略的重复记录的键,每个 +1(C7) */
  ignoredDuplicateKinds?: readonly string[];
  meta?: MetaUpdate;
}

/** 便捷构造:未知键 → 一个 kind=unknown 事件 + 计数。 */
export function unknownOutcome(key: string, ts?: unknown): LineOutcome {
  return {
    events: [{ kind: 'unknown', raw_type: key, ...(ts !== undefined ? { ts } : {}) }],
    unknownKeys: [key],
  };
}

export interface FileWalkOptions {
  /** 相对 source 的最大目录深度(source 本身为 0);缺省 8 */
  maxDepth?: number;
  /** 文件过滤:收到绝对路径与相对 source 的路径(`/` 分隔) */
  match(absPath: string, relPath: string): boolean;
}

/**
 * 只读递归枚举 source 下的文件。source 是文件时直接返回它(显式传入的文件不过滤)。
 * 不跟随符号链接(目录、文件都跳过),防止环与越界;结果按绝对路径排序,保证确定性。
 */
export async function walkFiles(source: string, opts: FileWalkOptions): Promise<string[]> {
  const root = await realpath(source);
  const st = await lstat(root);
  if (st.isFile()) return [root];
  const maxDepth = opts.maxDepth ?? 8;
  const out: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const e of await readDir(dir)) {
      if (e.isSymbolicLink) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory) {
        if (depth < maxDepth) await visit(abs, depth + 1);
      } else if (e.isFile) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (opts.match(abs, rel)) out.push(abs);
      }
    }
  };
  await visit(root, 0);
  return out.sort();
}

export abstract class JsonlTraceReader<S = undefined> implements TraceReader {
  abstract readonly agent: AgentId;
  /** 数字时间戳是否按毫秒接受(Kimi 为 true,口径 C3) */
  protected readonly acceptEpochMs: boolean = false;

  /** 只读枚举 source 下的主会话文件(绝对路径);子代理/侧链文件不得返回(C1)。 */
  protected abstract listSessionFiles(source: string): Promise<string[]>;
  /** 每次 read() 一份状态(Pi 的树、Codex 的去重集合等放这里)。 */
  protected abstract newState(ref: SessionRef): S;
  /** 一行(已确认是 JSON 对象)→ 事件与计数增量。不抛错;不认识的一律走 unknownKeys。 */
  protected abstract classifyLine(obj: JsonObject, state: S, lineNo: number): LineOutcome;

  /** 行自带的时间戳原始值。须是纯函数(预扫会反复调用)。 */
  protected lineTimestamp(obj: JsonObject): unknown {
    return obj['timestamp'];
  }

  /**
   * 读行之前的异步准备:返回的 meta 先于任何行应用(首值优先)。
   * 例:Kimi 的 cwd_hint 在同级 state.json,经 `readCompanionText` 读取(同样走只读入口)。
   */
  protected prepare(ref: SessionRef): Promise<MetaUpdate | undefined> {
    void ref;
    return Promise.resolve(undefined);
  }

  /** 全部行读完后补充 Counts(例如 Pi 的 branch_count)。 */
  protected finishCounts(state: S): Partial<Pick<Counts, 'branch_count'>> {
    void state;
    return {};
  }

  async discover(source: string): Promise<SessionRef[]> {
    const files = await this.listSessionFiles(source);
    const refs: SessionRef[] = [];
    for (const file of files) {
      const abs = path.resolve(file);
      const st = await statReadonly(abs);
      refs.push({
        agent: this.agent,
        path: abs,
        // discover 拿不到盐:这里只放无盐临时值,collector 与 read() 都会用本机盐重算
        session_ref: provisionalSessionRef(abs),
        bytes: st.size,
      });
    }
    return refs;
  }

  read(ref: SessionRef, opts: ReadOpts): SessionRead {
    const maxEventBytes = opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    if (maxEventBytes > MAX_LINE_BYTES) {
      throw new Error(`maxEventBytes(${maxEventBytes})不得超过单行硬上限 ${MAX_LINE_BYTES}`);
    }
    const sessionRef = sessionRefFor(opts.salt, ref.path);
    const state = this.newState(ref);

    let userMessages = 0;
    let toolCalls = 0;
    let toolFailures = 0;
    let oversized = 0;
    const unknown = newCountRecord();
    const ignored = newCountRecord();
    let extra: Partial<Pick<Counts, 'branch_count'>> = {};

    let agentVersion: string | null = null;
    let cwdHint: string | null = null;
    let startedAtMeta: string | null = null;
    let startedAtScan: string | null = null;
    let external = false;
    const rulePaths: string[] = [];
    let started = false;

    const bump = (rec: CountRecord, key: string): void => addCount(rec, key);

    const applyMeta = (m: MetaUpdate): void => {
      // R1:agent_version 是唯一原样来自 trace 的字符串,必须是版本号形状且有长度上限,否则当取不到
      if (agentVersion === null && isVersionShape(m.agent_version)) agentVersion = m.agent_version;
      if (cwdHint === null && nonEmptyString(m.cwd_hint)) cwdHint = m.cwd_hint as string;
      if (startedAtMeta === null) {
        const t = normalizeTs(m.started_at, this.acceptEpochMs);
        if (t !== undefined) startedAtMeta = t;
      }
      if (m.external_content === true) external = true;
      for (const p of m.loaded_rule_paths ?? []) if (!rulePaths.includes(p)) rulePaths.push(p);
    };

    /** 预扫:按行序第一个有效时间戳,读到即停(C3 第 2 级) */
    const prescan = async (): Promise<void> => {
      for await (const raw of openReadonlyLines(ref.path)) {
        const line = raw === TOO_LONG_LINE ? undefined : lineText(raw);
        if (line === undefined || exceedsJsonDepth(line)) continue;
        const obj = parseObject(line);
        if (obj === undefined) continue;
        const t = normalizeTs(this.lineTimestamp(obj), this.acceptEpochMs);
        if (t !== undefined) {
          startedAtScan = t;
          return;
        }
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 生成器内要访问受保护成员
    const self = this;
    async function* generate(): AsyncGenerator<NormEvent, void, undefined> {
      const pre = await self.prepare(ref);
      if (pre) applyMeta(pre);
      await prescan();
      let mtimeIso: string | undefined;
      const fallbackTs = async (): Promise<string> => {
        if (startedAtScan !== null) return startedAtScan;
        if (mtimeIso === undefined) {
          mtimeIso = (await statReadonly(ref.path)).mtime.toISOString();
        }
        return mtimeIso;
      };

      let lineNo = 0;
      for await (const rawLine of openReadonlyLines(ref.path)) {
        lineNo++;
        if (rawLine === TOO_LONG_LINE) {
          // 超过硬上限:正文已丢弃,无法分类。计 oversized,不进 <malformed>(jq 能解析它),不产出事件
          oversized++;
          bump(unknown, LINE_TOO_LARGE_KEY);
          continue;
        }
        const line = lineText(rawLine);
        if (line === undefined) continue; // 空白行(含 CRLF 残留的 \r)忽略
        const lineBytes = Buffer.byteLength(line, 'utf8');
        const isOversized = lineBytes > maxEventBytes;
        if (isOversized) oversized++;
        if (exceedsJsonDepth(line)) {
          // 嵌套过深:不交给 JSON.parse(病态行可打爆调用栈),按超大行记账;已因字节数计过 oversized 的不重复计
          if (!isOversized) oversized++;
          bump(unknown, LINE_TOO_DEEP_KEY);
          continue;
        }

        const obj = parseObject(line);
        if (obj === undefined) {
          bump(unknown, MALFORMED_KEY);
          continue;
        }
        const outcome = self.classifyLine(obj, state, lineNo);
        for (const k of outcome.unknownKeys ?? []) bump(unknown, k);
        for (const k of outcome.ignoredDuplicateKinds ?? []) bump(ignored, k);
        if (outcome.meta) applyMeta(outcome.meta);

        const lineTs = self.lineTimestamp(obj);
        for (const ev of outcome.events ?? []) {
          const ts =
            normalizeTs(ev.ts, self.acceptEpochMs) ??
            normalizeTs(lineTs, self.acceptEpochMs) ??
            (await fallbackTs());
          if (ev.kind === 'user_message') userMessages++;
          else if (ev.kind === 'tool_call') toolCalls++;
          if (ev.tool_failed === true) toolFailures++;
          if (ev.external_content === true) external = true;
          const out: NormEvent = {
            agent: self.agent,
            session_ref: sessionRef,
            ts,
            kind: ev.kind,
            raw_type: ev.raw_type,
            ...(ev.tool_name !== undefined ? { tool_name: ev.tool_name } : {}),
            ...(ev.tool_failed !== undefined ? { tool_failed: ev.tool_failed } : {}),
            ...(ev.external_content !== undefined ? { external_content: ev.external_content } : {}),
          };
          // 超长行只丢 text,不丢事件、不改分类(C8)
          if (ev.text !== undefined && !isOversized) {
            out.text = truncateUtf8(ev.text, maxEventBytes);
          }
          yield out;
        }
      }
      extra = self.finishCounts(state);
    }

    return {
      events: {
        [Symbol.asyncIterator]() {
          if (started) throw new Error('SessionRead.events 只能迭代一次');
          started = true;
          return generate();
        },
      },
      counts: (): Counts => ({
        user_messages: userMessages,
        tool_calls: toolCalls,
        tool_failures: toolFailures,
        unknown_event_types: toCountRecord(unknown),
        oversized_lines: oversized,
        ...(Object.keys(ignored).length > 0
          ? { ignored_duplicate_kinds: toCountRecord(ignored) }
          : {}),
        ...(extra.branch_count !== undefined ? { branch_count: extra.branch_count } : {}),
      }),
      meta: (): SessionMeta => ({
        agent_version: agentVersion,
        cwd_hint: cwdHint,
        started_at: startedAtMeta ?? startedAtScan,
        external_content: external,
        loaded_rule_paths: [...rulePaths],
      }),
    };
  }
}

function parseObject(line: string): JsonObject | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return isJsonObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
