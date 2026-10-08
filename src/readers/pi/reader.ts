/**
 * Pi 会话 reader(B13)。口径:docs/reader-counting-spec.md §2.3、§6、§7.3。
 *
 * 只写「一行 JSON → 事件」;读取、BOM/CRLF、畸形行、超长行、ts 回退、Counts 恒等式都在 JsonlTraceReader。
 * 树结构(`branch_count`)见 tree.ts。
 */
import * as path from 'node:path';
import type { AgentId } from '../../contracts/common.js';
import type { SessionRef } from '../../contracts/reader.js';
import { lstat, realpath } from '../../io/read-fs.js';
import { openReadonlyLines } from '../../signals/open-readonly.js';
import {
  JsonlTraceReader,
  NO_TYPE_KEY,
  isJsonObject,
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
import { BLOCK_CHECKED_ROLES, KNOWN_BLOCK_TYPES, KNOWN_ENTRY_TYPES, KNOWN_ROLES } from './known.js';
import { PiTree } from './tree.js';

/** `--<路径>--/<文件>.jsonl`:深度恰为 1(§2.3.1);同目录树下的非 JSONL 文件不收 */
const SESSION_FILE = /^--[^/]+--\/[^/]+\.jsonl$/;

/**
 * 系统消息 `sections.project_context` 里的加载文件标记。
 * ❓ 结构只在本机一个样本上核实过(字符串里的 `<project_instructions path="…">` 标签),
 * 所以这里只**采集**成 `loaded_rule_paths`,P0 不据此做曝光结论。
 */
const PROJECT_FILE_TAG = /<project_instructions path="([^"\n]+)">/g;
// 上限与「必须绝对路径(POSIX)」是实现级自定的防御,超出静默丢弃;该字段只采集,P0 不据此做结论
const MAX_RULE_PATHS = 64;
const MAX_RULE_PATH_LEN = 1024;

interface PiState {
  tree: PiTree;
}

/** 非对象元素跳过且不记键:与口径 §7.3 的 `.[] | objects` 一致(有意为之,不是遗漏)。 */
function contentBlocks(content: unknown): JsonObject[] {
  return Array.isArray(content) ? content.filter(isJsonObject) : [];
}

/** 文本载荷:content 是字符串就取它;是数组就把 text 块拼起来。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return contentBlocks(content)
    .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
    .join('\n');
}

function loadedRulePaths(msg: JsonObject): string[] {
  const sections = msg['sections'];
  const pc = isJsonObject(sections) ? sections['project_context'] : undefined;
  if (typeof pc !== 'string') return [];
  const out: string[] = [];
  for (const m of pc.matchAll(PROJECT_FILE_TAG)) {
    const p = m[1];
    if (p === undefined || p.length > MAX_RULE_PATH_LEN || !path.isAbsolute(p)) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= MAX_RULE_PATHS) break;
  }
  return out;
}

/** 首个非空白行若是「type 为字符串且不是 session」的对象,说明这不是 Pi 会话文件。其余情况(空、畸形、头)都放行。 */
async function isClearlyNotPiSession(file: string): Promise<boolean> {
  let first = true;
  for await (const raw of openReadonlyLines(file)) {
    const line = first ? stripBom(raw) : raw;
    first = false;
    if (!/\S/.test(line)) continue;
    try {
      const v: unknown = JSON.parse(line);
      return isJsonObject(v) && typeof v['type'] === 'string' && v['type'] !== 'session';
    } catch {
      return false;
    }
  }
  return false;
}

export class PiReader extends JsonlTraceReader<PiState> {
  readonly agent: AgentId = 'pi';

  protected async listSessionFiles(source: string): Promise<string[]> {
    const files = await walkFiles(source, {
      maxDepth: 1,
      match: (_abs, rel) => SESSION_FILE.test(rel),
    });
    // 显式传入单个文件时不过滤(与 walkFiles 一致)
    if ((await lstat(await realpath(source))).isFile()) return files;
    const out: string[] = [];
    for (const f of files) if (!(await isClearlyNotPiSession(f))) out.push(f);
    return out;
  }

  protected newState(ref: SessionRef): PiState {
    void ref;
    return { tree: new PiTree() };
  }

  protected override finishCounts(state: PiState): { branch_count: number } {
    return { branch_count: state.tree.branchCount() };
  }

  protected classifyLine(obj: JsonObject, state: PiState): LineOutcome {
    const type = obj['type'];
    const id = obj['id'];
    // 树节点 = 非头且带字符串 id 的行,与其是否「已知类型」无关(§2.3.4)
    if (type !== 'session' && typeof id === 'string') state.tree.add(id, obj['parentId']);

    if (typeof type !== 'string') return { unknownKeys: [NO_TYPE_KEY] };

    if (type === 'session') {
      // 头:不是树节点,不产出事件;只提供 cwd_hint 与 started_at
      const meta: MetaUpdate = {
        ...(typeof obj['cwd'] === 'string' ? { cwd_hint: obj['cwd'] } : {}),
        started_at: obj['timestamp'],
      };
      return { meta };
    }
    if (!KNOWN_ENTRY_TYPES.has(type)) return unknownOutcome(type);
    if (type !== 'message') return { events: [{ kind: 'meta', raw_type: type }] };

    return this.classifyMessage(obj);
  }

  private classifyMessage(obj: JsonObject): LineOutcome {
    const msg = isJsonObject(obj['message']) ? obj['message'] : undefined;
    const roleRaw = msg?.['role'];
    const role = typeof roleRaw === 'string' ? roleRaw : '(none)';
    if (!KNOWN_ROLES.has(role)) return unknownOutcome(`message.${role}`);
    const message = msg as JsonObject; // 已知 role 蕴含 message 是对象

    if (!BLOCK_CHECKED_ROLES.has(role)) {
      // system / bashExecution / custom / branchSummary / compactionSummary → meta,不计数
      const rules = role === 'system' ? loadedRulePaths(message) : [];
      return {
        events: [{ kind: 'meta', raw_type: `message.${role}` }],
        ...(rules.length > 0 ? { meta: { loaded_rule_paths: rules } } : {}),
      };
    }

    const blocks = contentBlocks(message['content']);
    const events: ParsedEvent[] = [];
    const unknownKeys: string[] = [];

    if (role === 'user') {
      events.push({
        kind: 'user_message',
        raw_type: 'message.user',
        text: textOf(message['content']),
      });
    } else if (role === 'toolResult') {
      events.push({
        kind: 'tool_result',
        raw_type: 'message.toolResult',
        // 只有 isError === true 才算失败;缺失/非布尔一律 false
        tool_failed: message['isError'] === true,
        ...(typeof message['toolName'] === 'string' ? { tool_name: message['toolName'] } : {}),
        text: textOf(message['content']),
      });
    }

    for (const b of blocks) {
      const bt = typeof b['type'] === 'string' ? b['type'] : '(none)';
      const known = KNOWN_BLOCK_TYPES.has(bt);
      // 未知块只记键;「每块一个事件」只对 assistant 成立(§2.3.2 表):user / toolResult 每条目只产 1 个事件
      if (!known) unknownKeys.push(`message.${role}.${bt}`);
      if (role !== 'assistant') continue; // user / toolResult 的文本已在上面取走
      const raw = `message.assistant.${bt}`;
      if (bt === 'text') events.push({ kind: 'assistant_message', raw_type: raw });
      else if (bt === 'toolCall') {
        events.push({
          kind: 'tool_call',
          raw_type: raw,
          ...(typeof b['name'] === 'string' ? { tool_name: b['name'] } : {}),
          text: JSON.stringify(b['arguments'] ?? null),
        });
      } else if (bt === 'thinking') events.push({ kind: 'meta', raw_type: raw });
      // 其它(含已知的 image,与未知块)→ unknown 事件;只有真正未知的块才有键(口径表 §2.3.2)
      else events.push({ kind: 'unknown', raw_type: raw });
    }
    return { events, ...(unknownKeys.length > 0 ? { unknownKeys } : {}) };
  }
}
