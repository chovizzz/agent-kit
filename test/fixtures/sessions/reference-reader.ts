/**
 * 参考实现(测试夹具):一个按 Claude 口径(docs/reader-counting-spec.md §2.1)写的**简化** reader,
 * 演示如何继承 `JsonlTraceReader`:B11–B14 照这个骨架写 `classifyLine` 即可,不必碰读取/BOM/CRLF/
 * 畸形行/超长行/ts 回退/计数恒等式——那些全在基类。
 *
 * 它不是 B11(真实 Claude reader):U0–U9 只实现了与 gen-claude.ts 相关的部分,
 * 不得被 src/ 引用,也不得当作口径的权威实现。
 */
import {
  JsonlTraceReader,
  NO_TYPE_KEY,
  isJsonObject,
  nonEmptyString,
  unknownOutcome,
  walkFiles,
} from '../../../src/signals/base-reader.js';
import type { JsonObject, LineOutcome, ParsedEvent } from '../../../src/signals/base-reader.js';

const KNOWN_META_TYPES = new Set(['permission-mode', 'mode', 'system', 'attachment', 'ai-title']);
const UUID_FILE = /^[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

function blocks(content: unknown): JsonObject[] {
  return Array.isArray(content) ? content.filter(isJsonObject) : [];
}

export class ReferenceClaudeReader extends JsonlTraceReader {
  readonly agent = 'claude' as const;

  protected listSessionFiles(source: string): Promise<string[]> {
    // 深度恰为 2:<项目目录>/<UUID>.jsonl;子代理(<UUID>/subagents/…)与其它文件不收
    return walkFiles(source, { maxDepth: 1, match: (_abs, rel) => UUID_FILE.test(rel) });
  }

  protected newState(): undefined {
    return undefined;
  }

  protected classifyLine(obj: JsonObject): LineOutcome {
    const type = obj['type'];
    if (obj['isSidechain'] === true) return { ignoredDuplicateKinds: ['claude.sidechain_line'] };
    if (typeof type !== 'string') return { unknownKeys: [NO_TYPE_KEY] };
    const meta = {
      ...(nonEmptyString(obj['version']) ? { agent_version: obj['version'] as string } : {}),
      ...(nonEmptyString(obj['cwd']) ? { cwd_hint: obj['cwd'] as string } : {}),
    };

    if (type === 'assistant') {
      const message = obj['message'];
      const events: ParsedEvent[] = [];
      for (const b of blocks(isJsonObject(message) ? message['content'] : undefined)) {
        if (b['type'] === 'text') events.push({ kind: 'assistant_message', raw_type: 'assistant' });
        else if (b['type'] === 'tool_use') {
          events.push({
            kind: 'tool_call',
            raw_type: 'assistant.tool_use',
            ...(typeof b['name'] === 'string' ? { tool_name: b['name'] } : {}),
            text: JSON.stringify(b['input'] ?? null),
          });
        } else events.push({ kind: 'unknown', raw_type: `assistant.${String(b['type'])}` });
      }
      return { events, meta };
    }

    if (type === 'user') {
      const message = obj['message'];
      const content = isJsonObject(message) ? message['content'] : undefined;
      const results = blocks(content).filter((b) => b['type'] === 'tool_result');
      if (results.length > 0) {
        return {
          events: results.map((b): ParsedEvent => ({
            kind: 'tool_result',
            raw_type: 'user.tool_result',
            tool_failed: b['is_error'] === true,
            ...(typeof b['content'] === 'string' ? { text: b['content'] } : {}),
          })),
          meta,
        };
      }
      if (typeof content === 'string' || Array.isArray(content)) {
        const text =
          typeof content === 'string'
            ? content
            : blocks(content)
                .filter((b) => b['type'] === 'text')
                .map((b) => String(b['text'] ?? ''))
                .join('\n');
        return { events: [{ kind: 'user_message', raw_type: 'user', text }], meta };
      }
      return { events: [{ kind: 'meta', raw_type: 'user' }], meta };
    }

    if (KNOWN_META_TYPES.has(type)) return { events: [{ kind: 'meta', raw_type: type }], meta };
    return unknownOutcome(type);
  }
}
