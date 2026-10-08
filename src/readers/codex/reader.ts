/**
 * Codex CLI 会话 reader(B12)。口径:docs/reader-counting-spec.md §2.2、C1–C12。
 *
 * 读取/BOM/CRLF/畸形行/超长行/ts 回退/计数恒等式都在基类 JsonlTraceReader;这里只回答
 *  - 哪些文件是主会话(listSessionFiles:首行 payload.source 含 subagent 键的是侧链,整体排除);
 *  - 一行 JSON 对应什么事件、算不算计数、是不是未知/重复(classifyLine,与 §7.2 的 jq oracle 同构)。
 *
 * tool_failures 是**下界口径**(§2.2.5,§8.1 D1):只数 5 种工具类 item 上结构化的 `status === "failed"`。
 * 不读 output 文本、不看 exit_code;0.149 以前的 shell 失败因此不可见。这是设计选择,不是漏数。
 */
import * as path from 'node:path';
import type { AgentId } from '../../contracts/common.js';
import { openReadonlyLines } from '../../signals/open-readonly.js';
import {
  JsonlTraceReader,
  NO_TYPE_KEY,
  isJsonObject,
  nonEmptyString,
  stripBom,
  unknownOutcome,
  walkFiles,
} from '../../signals/base-reader.js';
import type {
  JsonObject,
  LineOutcome,
  MetaUpdate,
  ParsedEvent,
} from '../../signals/base-reader.js';
import {
  CALL_TYPES,
  DUPLICATE_ITEM_TYPES,
  KNOWN_EVENT_MSG,
  KNOWN_ITEM,
  KNOWN_RESPONSE_ITEM,
  KNOWN_TOP,
  META_ITEM_TYPES,
  TOOL_ITEM_TYPES,
} from './known.js';

/**
 * 会话文件名 `rollout-*.jsonl`(§2.2.1 的正式布局是 `<source>/YYYY/MM/DD/`,这里只认文件名、
 * 不要求目录形状:验收会把样本复制到别的目录布局里,oracle 的 `find -name 'rollout-*.jsonl'` 也只看文件名)。
 */
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/;

const NONE = '(none)';

function objectOf(v: unknown): JsonObject {
  return isJsonObject(v) ? v : {};
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * 首行判定(§2.2.1):等价于 `head -1 FILE | jq -e '((.payload.source | objects | has("subagent")) // false) | not'`
 * 退出码 0 = 主会话。首行解析不出对象(空文件、空白首行、畸形首行、非对象)jq 的退出码非 0,
 * 所以这样的文件不是会话。
 */
export async function isMainSessionFile(file: string): Promise<boolean> {
  let first: string | undefined;
  for await (const line of openReadonlyLines(file)) {
    first = line;
    break;
  }
  if (first === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(first));
  } catch {
    return false;
  }
  // 首行 JSON null:jq 的 `null.payload.source` 为 null,退出码 0,即主会话;其余非对象标量/数组 jq 报错
  if (parsed === null) return true;
  if (!isJsonObject(parsed)) return false;
  // payload 存在却不是对象(字符串、数组等):jq 的 `.payload.source` 会报错、退出码非 0,所以也不是会话
  const payload = parsed['payload'];
  if (payload !== undefined && payload !== null && !isJsonObject(payload)) return false;
  const source = objectOf(payload)['source'];
  return !(isJsonObject(source) && Object.hasOwn(source, 'subagent'));
}

/**
 * UserMessage 的文本:`item.content[]` 里 `type=="text"` 的 `text` 用换行连接。口径文档不规定文本位置(C12);
 * 结构由本机真实样本的键名核实(jq 只看键名与类型:`item` 键为 content/id/type,`content` 是数组,元素含 type/text)。
 * content 缺失或形态不符时不设 text,事件照常产出(计数不依赖文本)。
 */
function userText(item: JsonObject): string | undefined {
  const content = item['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const b of content) {
    if (isJsonObject(b) && b['type'] === 'text' && typeof b['text'] === 'string')
      parts.push(b['text']);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function callEvent(payloadType: string, p: JsonObject): ParsedEvent {
  const base = { kind: 'tool_call' as const, raw_type: `response_item.${payloadType}` };
  switch (payloadType) {
    case 'function_call': {
      const name = stringOf(p['name']);
      const args = stringOf(p['arguments']);
      return {
        ...base,
        ...(name !== undefined ? { tool_name: name } : {}),
        ...(args !== undefined ? { text: args } : {}),
      };
    }
    case 'custom_tool_call': {
      const name = stringOf(p['name']);
      const input = stringOf(p['input']);
      return {
        ...base,
        ...(name !== undefined ? { tool_name: name } : {}),
        ...(input !== undefined ? { text: input } : {}),
      };
    }
    case 'web_search_call':
      return {
        ...base,
        tool_name: 'web_search',
        ...(p['action'] !== undefined ? { text: JSON.stringify(p['action']) } : {}),
      };
    default: // tool_search_call
      return {
        ...base,
        tool_name: 'tool_search',
        ...(p['arguments'] !== undefined ? { text: JSON.stringify(p['arguments']) } : {}),
      };
  }
}

/** 未知键(§2.2.3 的「未知键格式」,与 oracle 的 key_of 同构);已知返回 undefined。 */
function unknownKeyOf(type: string, p: JsonObject, item: JsonObject): string | undefined {
  if (!KNOWN_TOP.has(type)) return type;
  if (type === 'response_item') {
    const x = stringOf(p['type']) ?? NONE;
    return KNOWN_RESPONSE_ITEM.has(x) ? undefined : `response_item.${x}`;
  }
  if (type === 'event_msg') {
    const x = stringOf(p['type']) ?? NONE;
    if (!KNOWN_EVENT_MSG.has(x)) return `event_msg.${x}`;
    if (x === 'item_completed') {
      const i = stringOf(item['type']) ?? NONE;
      return KNOWN_ITEM.has(i) ? undefined : `event_msg.item_completed.${i}`;
    }
  }
  return undefined;
}

function metaFor(type: string, p: JsonObject): MetaUpdate | undefined {
  if (type === 'session_meta') {
    return {
      ...(nonEmptyString(p['cli_version']) ? { agent_version: p['cli_version'] as string } : {}),
      ...(nonEmptyString(p['cwd']) ? { cwd_hint: p['cwd'] as string } : {}),
      ...(p['timestamp'] !== undefined ? { started_at: p['timestamp'] } : {}),
    };
  }
  // turn_context.cwd 口径文档未列(C11 由 reader 自定);键存在性已用 jq 在本机样本核对,只作 cwd_hint 次选
  if (type === 'turn_context' && nonEmptyString(p['cwd'])) return { cwd_hint: p['cwd'] as string };
  return undefined;
}

export class CodexReader extends JsonlTraceReader {
  readonly agent: AgentId = 'codex';

  protected async listSessionFiles(source: string): Promise<string[]> {
    const candidates = await walkFiles(source, {
      match: (abs) => ROLLOUT_NAME.test(path.basename(abs)),
    });
    const out: string[] = [];
    // 显式传入的单个文件(walkFiles 不按文件名过滤它,与基类约定一致)也要过首行判定:侧链文件不是会话(C1)
    for (const f of candidates) if (await isMainSessionFile(f)) out.push(f);
    return out;
  }

  protected newState(): undefined {
    return undefined;
  }

  protected classifyLine(obj: JsonObject): LineOutcome {
    const type = obj['type'];
    if (typeof type !== 'string') return { unknownKeys: [NO_TYPE_KEY] };
    const p = objectOf(obj['payload']);
    const item = objectOf(p['item']);
    const meta = metaFor(type, p);

    const unknownKey = unknownKeyOf(type, p, item);
    if (unknownKey !== undefined) return unknownOutcome(unknownKey);

    if (type === 'event_msg' && p['type'] === 'item_completed') {
      const it = item['type'] as string; // 已知集合内,必是字符串
      if (it === 'UserMessage') {
        const text = userText(item);
        return {
          events: [
            {
              kind: 'user_message',
              raw_type: 'event_msg.item_completed.UserMessage',
              ...(text !== undefined ? { text } : {}),
            },
          ],
        };
      }
      if (TOOL_ITEM_TYPES.has(it)) {
        return {
          events: [
            {
              kind: 'tool_result',
              raw_type: `event_msg.item_completed.${it}`,
              tool_failed: item['status'] === 'failed',
            },
          ],
        };
      }
      if (DUPLICATE_ITEM_TYPES.has(it)) {
        return { ignoredDuplicateKinds: [`event_msg.item_completed.${it}`] };
      }
      if (META_ITEM_TYPES.has(it)) {
        return { events: [{ kind: 'meta', raw_type: `event_msg.item_completed.${it}` }] };
      }
    }

    if (type === 'response_item') {
      const pt = p['type'] as string; // 已知集合内,必是字符串
      if (CALL_TYPES.has(pt)) return { events: [callEvent(pt, p)] };
      if (pt === 'message') {
        const role = p['role'];
        if (role === 'assistant') {
          return { events: [{ kind: 'assistant_message', raw_type: 'response_item.message' }] };
        }
        return {
          events: [{ kind: 'meta', raw_type: 'response_item.message' }],
          ...(role === 'user' ? { ignoredDuplicateKinds: ['response_item.message.user'] } : {}),
        };
      }
    }

    // 其余已知行(session_meta、turn_context、各 *_output、token_count 等)
    const raw =
      type === 'response_item' || type === 'event_msg'
        ? `${type}.${stringOf(p['type']) ?? NONE}`
        : type;
    return { events: [{ kind: 'meta', raw_type: raw }], ...(meta ? { meta } : {}) };
  }
}
