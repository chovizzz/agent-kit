/**
 * 按 agent 区分的头部解析(R20-1.4,B4 方案 §2.3;B4-0 冻结签名,B4a 实现)。入参 `lines` 是 `readHeadLines` 返回的窗口内完整行。
 *  - pi(K=1):首行是对象且 `type === 'session'` 取 `cwd`;首行是对象、`type` 是字符串但不是 `session` → `notASession`;
 *  - codex(K=1):首行 `type === 'session_meta'` 取 `payload.cwd`(reader 还会用后面 `turn_context` 的 cwd;armed 下这种文件记 U);
 *  - claude(D1,K=`RSI_ARMED_CLAUDE_MAX_LINES`):按顺序找第一个「对象、`isSidechain !== true`、`cwd` 是非空字符串」的行,取它的 cwd 后立刻停止,后面的行不交给解析。
 * 逐行预处理复用 base-reader 的 `lineText`(去行首一个 BOM、判空白)/ `exceedsJsonDepth` / `parseObject`;空白行、太深的行、非对象的行跳过,不终止扫描。
 * 只返回 {@link HeadMeta},不保存、不输出行内容。
 */
import { RSI_ARMED_CLAUDE_MAX_LINES, type RsiAgentId } from '../../contracts/rsi.js';
import {
  exceedsJsonDepth,
  isJsonObject,
  lineText,
  nonEmptyString,
  parseObject,
  type JsonObject,
} from '../../signals/base-reader.js';
import type { HeadMeta } from './types.js';

/** 一行的待解析对象:空白行 / 过深 / 非对象 / 非法 JSON 一律 undefined(跳过,不终止扫描) */
function objectOfLine(raw: Buffer): JsonObject | undefined {
  const text = lineText(raw.toString('utf8'));
  if (text === undefined || exceedsJsonDepth(text)) return undefined;
  return parseObject(text);
}

const NONE: HeadMeta = { cwd: null, notASession: false, linesSeen: 0 };

function parsePi(lines: readonly Buffer[]): HeadMeta {
  const first = lines[0];
  if (first === undefined) return NONE;
  const obj = objectOfLine(first);
  const base = { cwd: null, notASession: false, linesSeen: 1 };
  if (obj === undefined) return base;
  const type = obj['type'];
  if (type === 'session') return { ...base, cwd: nonEmptyString(obj['cwd']) ?? null };
  // isClearlyNotPiSession 口径:type 是字符串但不是 session
  return { ...base, notASession: typeof type === 'string' };
}

function parseCodex(lines: readonly Buffer[]): HeadMeta {
  const first = lines[0];
  if (first === undefined) return NONE;
  const obj = objectOfLine(first);
  const base = { cwd: null, notASession: false, linesSeen: 1 };
  if (obj === undefined) return base;
  const payload = obj['payload'];
  // reader 的 isMainSessionFile 口径:子代理会话(payload.source.subagent)不是会话
  if (isJsonObject(payload)) {
    const source = payload['source'];
    if (isJsonObject(source) && Object.hasOwn(source, 'subagent')) {
      return { ...base, notASession: true };
    }
  }
  // 只取 session_meta 的 payload.cwd;reader 还会用后面 turn_context 的 cwd,armed 下这种文件记 U(cwd = null)
  if (obj['type'] === 'session_meta' && isJsonObject(payload)) {
    return { ...base, cwd: nonEmptyString(payload['cwd']) ?? null };
  }
  return base;
}

function parseClaude(lines: readonly Buffer[]): HeadMeta {
  const n = Math.min(lines.length, RSI_ARMED_CLAUDE_MAX_LINES);
  for (let i = 0; i < n; i++) {
    const obj = objectOfLine(lines[i] as Buffer);
    if (obj === undefined) continue;
    if (obj['isSidechain'] === true) continue; // reader:侧链行整行跳过,cwd 也不取
    const cwd = nonEmptyString(obj['cwd']);
    if (cwd !== undefined) return { cwd, notASession: false, linesSeen: i + 1 };
  }
  return { cwd: null, notASession: false, linesSeen: n };
}

export function parseHead(agent: RsiAgentId, lines: readonly Buffer[]): HeadMeta {
  switch (agent) {
    case 'pi':
      return parsePi(lines);
    case 'codex':
      return parseCodex(lines);
    case 'claude':
      return parseClaude(lines);
  }
}
