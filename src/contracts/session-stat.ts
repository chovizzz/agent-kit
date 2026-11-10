import { z } from 'zod';
import { countRecordSchema } from './count-record.js';
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

const countRecord = countRecordSchema(z.string().regex(COUNT_KEY_RE)).refine(
  (r) => Object.keys(r).length <= MAX_COUNT_KEYS,
  {
    message: `计数键最多 ${MAX_COUNT_KEYS} 个`,
  },
);

export const SessionStatCountsSchema = CountsSchema.extend({
  unknown_event_types: countRecord,
  ignored_duplicate_kinds: countRecord.optional(),
});
export type SessionStatCounts = z.infer<typeof SessionStatCountsSchema>;

/** W4(R21-6.6):一个会话记录里至多存几个取回的标记(去重后;≥ 2 个不同标记 = 「多标记」,存 4 个足以判定)。 */
export const SESSION_MARKERS_MAX = 4;
/** 随机会话标记的形状(R21-6.3):`rsm_` + 16 位十六进制。 */
export const SESSION_MARKER_RE = /^rsm_[0-9a-f]{16}$/;

export const SessionStatSchema = z
  .strictObject({
    session_ref: SessionRefIdSchema,
    project_key: z.string().min(1),
    ts: IsoTimestampSchema,
    external_content: z.boolean(),
    counts: SessionStatCountsSchema,
    /**
     * W4 追加(R21-6.6 / R21-6.9 / V1i-4),全部可选;旧行缺键照常通过。**缺键 = 未测(不是 0)**:
     * 只有经 W4 reader(claude / pi)采集的行才写这三个键,codex / kimi 不写。
     * `rsi_markers`:取回的随机会话标记,去重、升序、≤ 4;0 个 = 「关联失败」,≥ 2 个 = 「多标记」(`classifyMarkerRetrieval`)。
     */
    rsi_markers: z
      .array(z.string().regex(SESSION_MARKER_RE))
      .max(SESSION_MARKERS_MAX)
      .refine((a) => a.every((m, i) => i === 0 || (a[i - 1] as string) < m), {
        message: 'rsi_markers 必须严格升序(即去重且有序)',
      })
      .optional(),
    /** 每会话最大重试链长(整数 ≥ 0;无失败 = 0);C2 的会话标量(§21.24 W0-7)。 */
    retry_chain_max: z.number().int().nonnegative().optional(),
    /** 被识别为 RSI 注入块或其复述、因而排除出计数的事件数(R21-6.9)。 */
    injection_excluded: z.number().int().nonnegative().optional(),
  })
  .superRefine((s, ctx) => {
    // W4 字段间约束:rsi_markers 与 injection_excluded 同由识别注入的 reader 写,成组(全有或全无);
    // retry_chain_max 独立可选(按 agent 能力:codex / kimi 没有工具名,缺键 = 不可比 / 未测)
    if ((s.rsi_markers === undefined) !== (s.injection_excluded === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'rsi_markers 与 injection_excluded 必须成组(全有或全无)',
      });
    }
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
