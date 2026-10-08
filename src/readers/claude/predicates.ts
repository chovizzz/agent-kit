/**
 * 用户消息谓词 U0–U9(docs/reader-counting-spec.md §2.1.3)。
 * 每个谓词一个具名函数,便于测试一一对应;`isUserMessage` 是它们的合取。
 * 与 §7.1 的 jq 程序逐项同义:`== null` 在 jq 里同时覆盖「缺失」与 `null`,这里用 `isNil`。
 */
import { isJsonObject } from '../../signals/base-reader.js';
import type { JsonObject } from '../../signals/base-reader.js';

const isNil = (v: unknown): boolean => v === undefined || v === null;

/**
 * 与 jq(Oniguruma,UTF-8)的 `\s` 对齐:Unicode White_Space,不含 U+FEFF(JS 的 `\s` 含它、不含 U+0085)。
 * `^` 只锚整串开头(jq 的 Perl_NT 语法是单行模式),所以这里也不带 `m` 标志。
 */
const WS =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const NOT_USER_TEXT_RE = new RegExp(
  `^[${WS}]*(?:<local-command-stdout|<local-command-caveat|\\[Request interrupted)`,
  'u',
);

/** `message.content`;`message` 不是对象时为 undefined。 */
export function messageContent(line: JsonObject): unknown {
  const m = line['message'];
  return isJsonObject(m) ? m['content'] : undefined;
}

/** `message.content` 里的对象块(非对象元素忽略);不是数组时空。 */
export function contentBlocks(line: JsonObject): JsonObject[] {
  const c = messageContent(line);
  return Array.isArray(c) ? c.filter(isJsonObject) : [];
}

/** U0 `message` 是对象且 `message.content` 是字符串或数组。 */
export function u0ContentShape(line: JsonObject): boolean {
  const c = messageContent(line);
  return typeof c === 'string' || Array.isArray(c);
}

/** U1 `content` 里没有 `tool_result` 块(字符串内容视为没有)。 */
export function u1NoToolResult(line: JsonObject): boolean {
  return !contentBlocks(line).some((b) => b['type'] === 'tool_result');
}

/** U2 `isMeta != true`。 */
export const u2NotMeta = (line: JsonObject): boolean => line['isMeta'] !== true;
/** U3 `isCompactSummary != true`。 */
export const u3NotCompactSummary = (line: JsonObject): boolean => line['isCompactSummary'] !== true;
/** U4 `isVisibleInTranscriptOnly != true`。 */
export const u4NotTranscriptOnly = (line: JsonObject): boolean =>
  line['isVisibleInTranscriptOnly'] !== true;
/** U5 没有 `interruptedMessageId`(缺失或 null)。 */
export const u5NotInterrupted = (line: JsonObject): boolean => isNil(line['interruptedMessageId']);
/** U6 没有 `scheduledTaskId`(缺失或 null)。 */
export const u6NotScheduled = (line: JsonObject): boolean => isNil(line['scheduledTaskId']);

/** U7 `origin.kind`:`origin` 非对象或 `kind` 缺失/null 视为 human;否则必须严格等于 "human"。 */
export function u7HumanOrigin(line: JsonObject): boolean {
  const origin = line['origin'];
  const kind = isJsonObject(origin) ? origin['kind'] : undefined;
  return isNil(kind) || kind === 'human';
}

/** U8 `turnOrigin` 缺失/null 视为 human;否则必须严格等于 "human"。 */
export function u8HumanTurn(line: JsonObject): boolean {
  const t = line['turnOrigin'];
  return isNil(t) || t === 'human';
}

/** 字符串内容取原串;数组取 `type=="text"` 且 `text` 为字符串的块文本,以 `\n` 拼接;其它为空串。 */
export function userText(line: JsonObject): string {
  const c = messageContent(line);
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const parts: string[] = [];
  for (const b of c) {
    if (isJsonObject(b) && b['type'] === 'text' && typeof b['text'] === 'string')
      parts.push(b['text']);
  }
  return parts.join('\n');
}

/** U9 拼接后的整串(允许前导空白)不以命令输出 / 中断提示开头。 */
export function u9NotCommandOutput(line: JsonObject): boolean {
  return !NOT_USER_TEXT_RE.test(userText(line));
}

/** U0–U9 的合取。调用方保证 `line.type === "user"`。 */
export function isUserMessage(line: JsonObject): boolean {
  return (
    u0ContentShape(line) &&
    u1NoToolResult(line) &&
    u2NotMeta(line) &&
    u3NotCompactSummary(line) &&
    u4NotTranscriptOnly(line) &&
    u5NotInterrupted(line) &&
    u6NotScheduled(line) &&
    u7HumanOrigin(line) &&
    u8HumanTurn(line) &&
    u9NotCommandOutput(line)
  );
}
