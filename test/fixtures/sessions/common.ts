/**
 * 合成会话生成器的公共部分(B10b)。
 *
 * 铁律(A10):仓库里没有任何 `.jsonl` 字面量,也没有完整的假密钥。会话文件在测试运行时
 * 由本目录的 gen-*.ts 写到 `$KIT_TMP`(或 `.state/test-tmp`);秘密由 `src/redact/seeds.ts`
 * 现场拼装(调用方把 seed.input 当作用户消息文本传进来)。
 *
 * 每个生成器返回按**构造**得出的期望计数(口径见 docs/reader-counting-spec.md),
 * 供 B11–B14 的 reader 测试直接对拍;字段位置以口径文档的映射表为准,
 * 口径文档没有给出的文本载荷字段(如 Codex UserMessage 的文本在哪)是**合成约定**,B12 以真实样本核实为准。
 */
import * as path from 'node:path';
import { mkdirp, writeFile } from '../../../src/io/safe-fs.js';
import type { IoContext } from '../../../src/io/paths.js';

export interface SessionSpec {
  /** 会话目录树的根(即 `--source`);须在 ctx 的写入根内 */
  root: string;
  /** 会话声明的工作目录(用于 project_key 与排除判定) */
  cwd: string;
  /** 会话标识(决定文件名),同一 root 内唯一 */
  id: string;
  /** 每个元素产生一条用户消息,按顺序 */
  userTexts: readonly string[];
  /** 工具调用数 */
  toolCalls: number;
  /** 其中失败的结果数(≤ toolCalls);其余结果为成功 */
  failedResults: number;
  /** 会话里的 agent 版本;undefined = 该格式不写版本 */
  version?: string;
  /** 工具名;缺省 `Bash`。用 `WebFetch` 之类可触发外部内容判定 */
  toolName?: string;
  /** 工具调用输入的文本(会经脱敏);缺省固定无害串 */
  toolInput?: string;
  /** 插入一条未知类型事件 */
  unknownEvent?: boolean;
  /** 插入一行畸形 JSON(截断的 JSON) */
  malformedLine?: boolean;
  /** 插入各家的「重复/侧链」行(应被忽略且不影响三个计数) */
  duplicates?: boolean;
  /** 行分隔符,缺省 `\n` */
  eol?: '\n' | '\r\n';
  /** 文件开头加 UTF-8 BOM */
  bom?: boolean;
  /** 末行是否带换行,缺省 true */
  finalNewline?: boolean;
  /** 基准时间(毫秒),缺省 2026-10-01T00:00:00Z */
  baseMs?: number;
  /** 去掉所有行的时间戳(测 mtime 回退) */
  noTimestamps?: boolean;
}

export interface ExpectedCounts {
  user_messages: number;
  tool_calls: number;
  tool_failures: number;
  unknown_event_types: Record<string, number>;
  ignored_duplicate_kinds?: Record<string, number>;
  branch_count?: number;
}

export interface GeneratedSession {
  /** 会话主文件的绝对路径 */
  file: string;
  cwd: string;
  expected: ExpectedCounts;
}

export const BASE_MS = Date.UTC(2026, 9, 1, 0, 0, 0);

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function fakeUuid(id: string): string {
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let n = 0; n < 4; n++) {
    for (const ch of `${id}:${n}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out.push(h.toString(16).padStart(8, '0'));
  }
  const hex = out.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function chk(spec: SessionSpec): void {
  if (spec.failedResults > spec.toolCalls) throw new Error('failedResults 不能大于 toolCalls');
}

/** 把行序列化成文件内容:BOM / CRLF / 末行换行都可调。 */
export function serialize(lines: readonly string[], spec: SessionSpec): string {
  const eol = spec.eol ?? '\n';
  const body = lines.join(eol) + (spec.finalNewline === false ? '' : eol);
  return (spec.bom ? '\uFEFF' : '') + body;
}

export async function writeSession(ctx: IoContext, file: string, content: string): Promise<void> {
  await mkdirp(ctx, path.dirname(file));
  await writeFile(ctx, file, content);
}

export const MALFORMED_LINE = '{"type":"user","message":{"role":"user","content":"trunc';
