import { z } from 'zod';
import { AgentIdSchema, IsoTimestampSchema, SessionRefIdSchema } from './common.js';
import { CountsSchema } from './reader.js';

/**
 * 会话计数库(R0,contracts #23):`.state/sessions/<agent>/<yyyymm>.jsonl`,每行一个 `SessionStat`。
 * 只有计数,**没有任何文本**——这是「外部内容会话只进结构化计数」(contracts #8)的落点:
 * 外部内容会话的信号摘录为空,但它的计数仍要留给反思器做会话级统计。
 *
 * 唯一可能带文本的是 `unknown_event_types` / `ignored_duplicate_kinds` 的键(来自会话里的事件类型名),
 * 所以键限定为安全字符且最多 64 个;实现必须先过 collector 的 safeKey(不合格改记 `<unprintable>`)。
 */
export const SESSION_STAT_DIR = 'sessions';
export const MAX_COUNT_KEYS = 64;
const COUNT_KEY_RE = /^[A-Za-z0-9_.:()<>+-]{1,96}$/;

const countRecord = z
  .record(z.string().regex(COUNT_KEY_RE), z.number().int().nonnegative())
  .refine((r) => Object.keys(r).length <= MAX_COUNT_KEYS, {
    message: `计数键最多 ${MAX_COUNT_KEYS} 个`,
  });

export const SessionStatCountsSchema = CountsSchema.extend({
  unknown_event_types: countRecord,
  ignored_duplicate_kinds: countRecord.optional(),
});
export type SessionStatCounts = z.infer<typeof SessionStatCountsSchema>;

export const SessionStatSchema = z.strictObject({
  session_ref: SessionRefIdSchema,
  project_key: z.string().min(1),
  ts: IsoTimestampSchema,
  external_content: z.boolean(),
  counts: SessionStatCountsSchema,
});
export type SessionStat = z.infer<typeof SessionStatSchema>;

/** 月份文件名;`yyyymm` 的月份必须 01..12(防路径片段)。 */
export function sessionStatFileName(yyyymm: string): string {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(yyyymm)) {
    throw new RangeError('yyyymm 必须是 YYYYMM(月份 01..12)');
  }
  return `${yyyymm}.jsonl`;
}

/** 仓库 state 目录下的相对路径(不含 state 前缀)。agent 只接受 AgentId 枚举。 */
export function sessionStatRelPath(agent: string, yyyymm: string): string {
  const a = AgentIdSchema.parse(agent);
  return `${SESSION_STAT_DIR}/${a}/${sessionStatFileName(yyyymm)}`;
}
