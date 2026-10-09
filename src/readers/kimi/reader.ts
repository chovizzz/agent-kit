/**
 * Kimi Code 会话 reader(B14)。口径:docs/reader-counting-spec.md §2.4、§7.4 与共同规则 C1–C8。
 *
 * 对应关系(口径 → 实现):
 *  - §2.4.1 会话文件:只收 `agents/main/wire.jsonl`(`listSessionFiles`);`agents/agent-N/` 不收;
 *    行的 `agentId` 缺失/null 或 `"main"` 才收(`classifyLine` 第一步,侧链行整行跳过,不计任何键)。
 *  - §2.4.2 行 → 事件映射、未知键格式:`classifyLine`。
 *  - §2.4.3 三个计数:由事件流派生(基类 C5 恒等式);`origin` 异常/新值 → meta,不进 unknown。
 *  - §2.4.4 ts:`lineTimestamp`(行内 `time`,无则 `created_at`;毫秒数,`acceptEpochMs`);
 *    agent_version:会话里没有 → 不给(collector_fallback);`protocol_version` 不是 CLI 版本。
 *  - §4:`cwd_hint` = 同级 `state.json` 的 `cwd`(旧版 `workDir`),在 `prepare` 里读;
 *    `loaded_rule_paths` = `profile.bind` 行顶层 `agentsMdPaths`,只采集。
 *
 * 不做:不撤销 `context.undo` / 压缩影响的消息(口径 §2.4.3 末段,未核实,按出现过计)。
 * 不判 external_content:由管线按 tool_name 兜底(isExternalToolName)。
 */
import * as path from 'node:path';
import { lstat } from '../../io/read-fs.js';
import type {
  MetaUpdate,
  JsonObject,
  LineOutcome,
  ParsedEvent,
} from '../../signals/base-reader.js';
import {
  JsonlTraceReader,
  NO_TYPE_KEY,
  isJsonObject,
  nonEmptyString,
  unknownOutcome,
  walkFiles,
} from '../../signals/base-reader.js';
import { readCompanionText } from '../../signals/open-readonly.js';
import type { SessionRef } from '../../contracts/reader.js';
import { KNOWN_LOOP_EVENT_TYPES, KNOWN_TOP_TYPES } from './known.js';

const KNOWN_TOP = new Set(KNOWN_TOP_TYPES);
const KNOWN_LOOP = new Set(KNOWN_LOOP_EVENT_TYPES);

/** 允许 `--source` 指到会话根、wd 目录或单个会话目录:前缀 0–2 段 + `agents/main/wire.jsonl`。 */
const MAIN_WIRE_REL = /^(?:[^/]+\/){0,2}agents\/main\/wire\.jsonl$/;
const MAIN_WIRE_TAIL = `${path.sep}agents${path.sep}main${path.sep}wire.jsonl`;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** `content`(字符串或 [{type:'text',text}] 数组)里的文本,换行拼接。 */
function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const p of content) {
    if (isJsonObject(p) && p['type'] === 'text' && typeof p['text'] === 'string') {
      parts.push(p['text']);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function isUserOrigin(origin: unknown): boolean {
  return isJsonObject(origin) && origin['kind'] === 'user';
}

export class KimiReader extends JsonlTraceReader {
  readonly agent = 'kimi' as const;
  protected override readonly acceptEpochMs = true;

  protected async listSessionFiles(source: string): Promise<string[]> {
    const found = await walkFiles(source, {
      maxDepth: 4,
      match: (_abs, rel) => MAIN_WIRE_REL.test(rel),
    });
    // 显式传入的单个文件不经 match 过滤:这里再按路径尾部卡一遍,子代理 wire 永不返回(C1)
    return found.filter((f) => f.endsWith(MAIN_WIRE_TAIL));
  }

  protected newState(): undefined {
    return undefined;
  }

  protected override lineTimestamp(obj: JsonObject): unknown {
    // 与口径 §7.5 探针一致:`time` 非 null 就取它,否则取首行 metadata 的 `created_at`;
    // Kimi 只认毫秒**数字**(C3):字符串形式的时间戳无效,不交给基类的 ISO 字符串解析
    const t = obj['time'] ?? obj['created_at'];
    return typeof t === 'number' ? t : undefined;
  }

  /** `cwd_hint`:同级 `state.json`(`<session>/state.json`,wire 在 `<session>/agents/main/`)。 */
  protected override async prepare(ref: SessionRef): Promise<MetaUpdate | undefined> {
    const sessionDir = path.dirname(path.dirname(path.dirname(ref.path)));
    const stateFile = path.join(sessionDir, 'state.json');
    // R6:只读普通文件。符号链接会读到会话目录之外;命名管道/设备文件的 readFile 会永远阻塞 → 一律当 cwd 未知
    try {
      if (!(await lstat(stateFile)).isFile()) return undefined;
    } catch {
      return undefined;
    }
    const text = await readCompanionText(stateFile);
    if (text === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined; // state.json 损坏 → cwd 未知(cwd_hint=null),不影响计数
    }
    if (!isJsonObject(parsed)) return undefined;
    const cwd = nonEmptyString(parsed['cwd']) ?? nonEmptyString(parsed['workDir']);
    return cwd !== undefined ? { cwd_hint: cwd } : undefined;
  }

  protected classifyLine(obj: JsonObject): LineOutcome {
    // 侧链/子代理行:agentId 缺失或 null 视为 main;其它任何值(含非字符串)整行跳过,优先于 <no-type>(C2)
    const agentId = obj['agentId'];
    if (agentId !== undefined && agentId !== null && agentId !== 'main') return {};

    const type = obj['type'];
    if (typeof type !== 'string') return { unknownKeys: [NO_TYPE_KEY] };
    if (!KNOWN_TOP.has(type)) return unknownOutcome(type);

    switch (type) {
      case 'context.append_message':
        return this.appendMessage(obj);
      case 'context.append_loop_event':
        return this.loopEvent(obj);
      case 'turn.prompt':
      case 'turn.steer':
        // 与 append_message(user) 是同一次输入的两种记录:忽略并计 ignored_duplicate_kinds
        if (isUserOrigin(obj['origin'])) return { ignoredDuplicateKinds: [type] };
        return { events: [{ kind: 'meta', raw_type: type }] };
      case 'profile.bind': {
        const paths = obj['agentsMdPaths'];
        const rules = Array.isArray(paths)
          ? paths.filter((p): p is string => typeof p === 'string' && p !== '')
          : [];
        return {
          events: [{ kind: 'meta', raw_type: type }],
          ...(rules.length > 0 ? { meta: { loaded_rule_paths: rules } } : {}),
        };
      }
      default:
        return { events: [{ kind: 'meta', raw_type: type }] };
    }
  }

  private appendMessage(obj: JsonObject): LineOutcome {
    const raw_type = 'context.append_message';
    const message = obj['message'];
    if (isJsonObject(message) && message['role'] === 'user' && isUserOrigin(message['origin'])) {
      const text = contentText(message['content']);
      return {
        events: [{ kind: 'user_message', raw_type, ...(text !== undefined ? { text } : {}) }],
      };
    }
    // injection / system_trigger / background_task / task / skill_activation / 未来新来源 /
    // role 非 user / message 非对象:都是已知 type 下的值 → meta,不进 unknown(口径 §2.4.3)
    return { events: [{ kind: 'meta', raw_type }] };
  }

  private loopEvent(obj: JsonObject): LineOutcome {
    const type = 'context.append_loop_event';
    const event = obj['event'];
    const ev = isJsonObject(event) ? event : {};
    const et = str(ev['type']) ?? '(none)';
    if (!KNOWN_LOOP.has(et)) return unknownOutcome(`${type}.${et}`);
    const raw_type = type;

    if (et === 'tool.call') {
      const name = str(ev['name']);
      const args = ev['args'];
      const parsed: ParsedEvent = {
        kind: 'tool_call',
        raw_type,
        ...(name !== undefined ? { tool_name: name } : {}),
        ...(args !== undefined ? { text: JSON.stringify(args) } : {}),
      };
      return { events: [parsed] };
    }
    if (et === 'tool.result') {
      const result = ev['result'];
      const r = isJsonObject(result) ? result : {};
      const output = str(r['output']);
      return {
        events: [
          {
            kind: 'tool_result',
            raw_type,
            tool_failed: r['isError'] === true,
            ...(output !== undefined ? { text: output } : {}),
          },
        ],
      };
    }
    if (et === 'content.part') {
      const part = ev['part'];
      if (isJsonObject(part) && part['type'] === 'text') {
        const text = str(part['text']);
        return {
          events: [
            { kind: 'assistant_message', raw_type, ...(text !== undefined ? { text } : {}) },
          ],
        };
      }
    }
    // think 片段、其它 part 类型、step.begin / step.end:meta
    return { events: [{ kind: 'meta', raw_type }] };
  }
}
