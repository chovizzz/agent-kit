/**
 * Claude Code 会话 reader(B11)。口径:docs/reader-counting-spec.md §2.1、§1、§7.1。
 *
 * 只写「一行 JSON → 事件」;读取/BOM/CRLF/空白行/畸形行/超长行/ts 回退/Counts 恒等式都在基类
 * (src/signals/base-reader.ts)。这里负责基类不管的 Claude 语义:
 *   侧链过滤(先于 <no-type>)→ <no-type> → 未知顶层类型 → user/assistant 的块级映射与 U0–U9。
 *
 * 不去重:同一文件里逐字节相同的两行算两行(C2);跨文件重复不处理(C9)。
 * 未核实的字段一律不当事实用:只读 spec 列出的键,其余忽略;不认识的类型/块走 unknown_event_types。
 */
import * as path from 'node:path';
import type { AgentId } from '../../contracts/common.js';
import { lstat, realpath } from '../../io/read-fs.js';
import type { TraceReader } from '../../contracts/reader.js';
import {
  JsonlTraceReader,
  NO_TYPE_KEY,
  isJsonObject,
  nonEmptyString,
  unknownOutcome,
  walkFiles,
} from '../../signals/base-reader.js';
import type {
  JsonObject,
  LineOutcome,
  MetaUpdate,
  ParsedEvent,
} from '../../signals/base-reader.js';
import { isExternalToolName } from '../../signals/external-content.js';
import { contentBlocks, isUserMessage, messageContent, userText } from './predicates.js';
import {
  KNOWN_BLOCK_TYPES,
  KNOWN_LINE_TYPES,
  SESSION_FILE_RE,
  SESSION_NAME_RE,
  SIDECHAIN_KEY,
} from './schema.js';

/** 每次 read() 一份:tool_use.id → 工具名,用来给 tool_result 回填 tool_name(可选信息,不影响计数)。 */
interface ClaudeState {
  toolNames: Map<string, string>;
}

/** 块级键 `<行type>.<块type>`;块 `type` 缺失或不是字符串记 `(none)`。 */
function blockKey(lineType: 'user' | 'assistant', block: JsonObject): string | undefined {
  const t = block['type'];
  const bt = typeof t === 'string' ? t : '(none)';
  return KNOWN_BLOCK_TYPES[lineType].has(bt) ? undefined : `${lineType}.${bt}`;
}

function metaOf(obj: JsonObject): MetaUpdate {
  return {
    ...(nonEmptyString(obj['version']) ? { agent_version: obj['version'] as string } : {}),
    ...(nonEmptyString(obj['cwd']) ? { cwd_hint: obj['cwd'] as string } : {}),
  };
}

/** tool_result.content:字符串原样;数组取 text 块文本;其它无文本。 */
function resultText(block: JsonObject): string | undefined {
  const c = block['content'];
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return undefined;
  const parts: string[] = [];
  for (const b of c) {
    if (isJsonObject(b) && b['type'] === 'text' && typeof b['text'] === 'string')
      parts.push(b['text']);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function classifyAssistant(
  obj: JsonObject,
  state: ClaudeState,
): Pick<LineOutcome, 'events' | 'unknownKeys'> {
  const content = messageContent(obj);
  if (typeof content === 'string') {
    return { events: [{ kind: 'assistant_message', raw_type: 'assistant', text: content }] };
  }
  if (!Array.isArray(content)) return { events: [{ kind: 'meta', raw_type: 'assistant' }] };
  const events: ParsedEvent[] = [];
  const unknownKeys: string[] = [];
  for (const b of contentBlocks(obj)) {
    const bt = b['type'];
    if (bt === 'text') {
      events.push({
        kind: 'assistant_message',
        raw_type: 'assistant.text',
        ...(typeof b['text'] === 'string' ? { text: b['text'] } : {}),
      });
    } else if (bt === 'tool_use') {
      const name = nonEmptyString(b['name']);
      const id = nonEmptyString(b['id']);
      if (name !== undefined && id !== undefined) state.toolNames.set(id, name);
      events.push({
        kind: 'tool_call',
        raw_type: 'assistant.tool_use',
        ...(name !== undefined ? { tool_name: name } : {}),
        ...(isExternalToolName(name) ? { external_content: true } : {}),
        text: JSON.stringify(b['input'] ?? null),
      });
    } else if (bt === 'thinking') {
      events.push({ kind: 'meta', raw_type: 'assistant.thinking' });
    } else {
      const key = blockKey('assistant', b) as string; // 非三种已知块 → 必为未知键
      events.push({ kind: 'unknown', raw_type: key });
      unknownKeys.push(key);
    }
  }
  return { events, unknownKeys };
}

function classifyUser(
  obj: JsonObject,
  state: ClaudeState,
): Pick<LineOutcome, 'events' | 'unknownKeys'> {
  const blocks = contentBlocks(obj);
  const results = blocks.filter((b) => b['type'] === 'tool_result');
  const events: ParsedEvent[] = [];
  const unknownKeys: string[] = [];

  if (results.length > 0) {
    // 带 tool_result 的行不是用户消息(U1);每个 tool_result 块一个事件,其余已知块各记 meta
    for (const b of blocks) {
      const bt = b['type'];
      if (bt === 'tool_result') {
        const id = nonEmptyString(b['tool_use_id']);
        const name = id !== undefined ? state.toolNames.get(id) : undefined;
        const text = resultText(b);
        events.push({
          kind: 'tool_result',
          raw_type: 'user.tool_result',
          tool_failed: b['is_error'] === true,
          ...(name !== undefined ? { tool_name: name } : {}),
          ...(isExternalToolName(name) ? { external_content: true } : {}),
          ...(text !== undefined ? { text } : {}),
        });
      } else if (bt === 'text' || bt === 'image') {
        events.push({ kind: 'meta', raw_type: `user.${bt}` });
      }
    }
  } else if (isUserMessage(obj)) {
    events.push({ kind: 'user_message', raw_type: 'user', text: userText(obj) });
  } else {
    events.push({ kind: 'meta', raw_type: 'user' });
  }

  // 块级未知键与行是否算用户消息无关(与 §7.1 的 unknown_event_types 程序一致)
  for (const b of blocks) {
    const key = blockKey('user', b);
    if (key !== undefined) {
      events.push({ kind: 'unknown', raw_type: key });
      unknownKeys.push(key);
    }
  }
  return { events, unknownKeys };
}

export class ClaudeReader extends JsonlTraceReader<ClaudeState> {
  readonly agent: AgentId = 'claude';

  protected async listSessionFiles(source: string): Promise<string[]> {
    // 深度恰为 2(<项目目录>/<UUID>.jsonl);<UUID>/subagents/… 等更深的目录根本不进入(C1)
    const files = await walkFiles(source, {
      maxDepth: 1,
      match: (_abs, rel) => SESSION_FILE_RE.test(rel),
    });
    // R5:显式传入单个文件时 walkFiles 不过滤;子代理文件(<UUID>/subagents/agent-*.jsonl)在这里剔除,
    // 与 Codex 一致(C1)。判据:文件名是 UUID 形状,且父目录不叫 subagents。
    const real = await realpath(source);
    if ((await lstat(real)).isFile()) {
      const base = path.basename(real);
      const parent = path.basename(path.dirname(real));
      return SESSION_NAME_RE.test(base) && parent !== 'subagents' ? files : [];
    }
    return files;
  }

  protected newState(): ClaudeState {
    return { toolNames: new Map() };
  }

  protected classifyLine(obj: JsonObject, state: ClaudeState): LineOutcome {
    // 1. 侧链先于 <no-type>:整行跳过,不产出事件、不进任何计数,只记 ignored(C1、C7)
    if (obj['isSidechain'] === true) return { ignoredDuplicateKinds: [SIDECHAIN_KEY] };

    const meta = metaOf(obj);
    const type = obj['type'];
    // 2. 缺 type(或不是字符串)
    if (typeof type !== 'string') return { unknownKeys: [NO_TYPE_KEY], meta };
    // 3. 未知顶层类型:不抛错、不影响其它计数
    if (!KNOWN_LINE_TYPES.has(type)) return { ...unknownOutcome(type), meta };

    if (type === 'assistant') return { ...classifyAssistant(obj, state), meta };
    if (type === 'user') return { ...classifyUser(obj, state), meta };
    return { events: [{ kind: 'meta', raw_type: type }], meta };
  }
}

export function createClaudeReader(): TraceReader {
  return new ClaudeReader();
}
