import { z } from 'zod';
import { AgentIdSchema, KebabIdSchema, RunIdSchema, Sha256Schema } from './common.js';

/** `reports/<case-id>/<rule_set_sha>-<run_id>.json`(设计 §6.5)。只增不改。 */
export const ReplayReportSchema = z
  .strictObject({
    case_id: KebabIdSchema,
    /** 对 cases/<case-id>/ 目录内容的哈希 */
    case_sha: Sha256Schema,
    /** 对 PR head 规则集 build 后的哈希,所有原子的 status 与 review_by 先归一化掉 */
    rule_set_sha: Sha256Schema,
    harness_sha: Sha256Schema,
    runner_id: z.string().min(1),
    run_id: RunIdSchema,
    /** 决策 ⑤A(自托管 CI)时必填 */
    ci_run_url: z.url().optional(),
    /** 决策 ⑤B(自报)时为 true,PR 自动加 kit:self-reported-replay */
    self_reported: z.boolean().optional(),
    runs: z
      .array(
        z.strictObject({
          agent: AgentIdSchema,
          agent_version: z.string().min(1),
          passed: z.boolean(),
          transcript_sha256: Sha256Schema,
        }),
      )
      .min(1),
  })
  .superRefine((r, ctx) => {
    const hasUrl = r.ci_run_url !== undefined;
    const selfReported = r.self_reported === true;
    if (hasUrl === selfReported) {
      ctx.addIssue({
        code: 'custom',
        path: ['ci_run_url'],
        message: 'ci_run_url 与 self_reported:true 必须二选一(有 CI 运行链接,或明确自报)',
      });
    }
  });
export type ReplayReport = z.infer<typeof ReplayReportSchema>;

export function reportFileName(r: Pick<ReplayReport, 'rule_set_sha' | 'run_id'>): string {
  return `${r.rule_set_sha}-${r.run_id}.json`;
}
