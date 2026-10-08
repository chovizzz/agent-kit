import { z } from 'zod';
import {
  AgentIdSchema,
  IsoDateSchema,
  KebabIdSchema,
  RunIdSchema,
  Sha256Schema,
} from './common.js';
import { ChannelNameSchema } from './config.js';

/** `attest/<rule-id>/<member>-<window_end>-<run_id>.json`(设计 §6.6)。只增不改。 */
export const AttestSchema = z
  .strictObject({
    schema_version: z.literal(1),
    rule_id: KebabIdSchema,
    /** 该原子渲染内容的哈希 */
    rule_sha256: Sha256Schema,
    channel: ChannelNameSchema,
    /** 成员 handle(含 @) */
    member: z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9_-]*$/),
    window_start: IsoDateSchema,
    window_end: IsoDateSchema,
    kit_version: z.string().min(1),
    collector_versions: z.partialRecord(AgentIdSchema, z.string().min(1)),
    sessions_total: z.number().int().nonnegative(),
    exposure_sessions: z.number().int().nonnegative(),
    exposure_projects: z.number().int().nonnegative(),
    fired: z.number().int().nonnegative(),
    harmful: z.number().int().nonnegative(),
    recurrence: z.number().int().nonnegative(),
    /** `sha256:` + 排序后 sig_id 列表的哈希,供本人复核 */
    signal_ids_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** 同一窗口重跑用不同 run_id,聚合时取最新一份;本字段与文件名里的 run_id 一致(由 CI 比对) */
    run_id: RunIdSchema,
  })
  .superRefine((a, ctx) => {
    if (a.window_end < a.window_start) {
      ctx.addIssue({
        code: 'custom',
        path: ['window_end'],
        message: 'window_end 不得早于 window_start',
      });
    }
    if (a.exposure_sessions > a.sessions_total) {
      ctx.addIssue({
        code: 'custom',
        path: ['exposure_sessions'],
        message: 'exposure_sessions 不得大于 sessions_total',
      });
    }
  });
export type Attest = z.infer<typeof AttestSchema>;

/** 文件名:`<member 去掉 @>-<window_end>-<run_id>.json`。 */
export function attestFileName(a: Pick<Attest, 'member' | 'window_end' | 'run_id'>): string {
  return `${a.member.slice(1)}-${a.window_end}-${a.run_id}.json`;
}
