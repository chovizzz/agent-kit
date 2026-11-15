/**
 * `rsi show`「关联提案裁决」段的读端口实现(contracts R20-18.37、W0-27):对同一份纯判定 `readJudgeVerdict`(R20-18.34 ①–⑤,与 worker 的 `evaluateJudgeSignal` 共用)只做展示映射,
 * 所以展示与消费不会分叉。**不接进 `deps.ts` 的生产缺省**(生产缺省恒 `unavailable`,待装配块 A 段的读侧组合根合并后再接,步骤见 W9a 状态文件)。
 *
 * 映射:`verified` → `ok`(`session_confirmed` 带 declared agent / vendor / model;`spawned`(`proven`)带 vendor / model);
 * `none` → 取判定给出的 `display`:确实无裁决(无 `judge` 键、`run_gone` / `run_excluded`)= `absent`(`judge=none`,不暴露原因);
 * 读 / 解析 / 校验失败、`rule_changed` = `invalid`(`judge=invalid`);⑥ 不适用于展示(`accept` 的已校验记录照常显示)。永不抛错。
 */
import {
  readJudgeVerdict,
  type JudgeEnv,
  type JudgeEvalOptions,
  type ProposalJudgeSource,
} from '../../personal/judge-signal.js';
import type { JudgeVerdictPort, JudgeVerdictRead } from './ports.js';

export function makeJudgeVerdictPort(
  source: ProposalJudgeSource | null,
  env: JudgeEnv,
  opts: JudgeEvalOptions = {},
): JudgeVerdictPort {
  return {
    async verdictFor(runId: string, proposalId: string): Promise<JudgeVerdictRead> {
      const v = await readJudgeVerdict(
        { run_id: runId, proposal_id: proposalId },
        source,
        env,
        opts,
      );
      if (v.kind === 'none') return { kind: v.display === 'none' ? 'absent' : 'invalid' };
      const { judge, side } = v;
      return {
        kind: 'ok',
        judge_provenance: judge.provenance,
        verdict: judge.verdict,
        overfit: judge.overfit_risk,
        injection: judge.injection_suspected ? 'true' : 'false',
        identity:
          judge.provenance === 'session_confirmed'
            ? {
                kind: 'declared',
                agent: judge.declared.agent,
                vendor: judge.declared.vendor,
                model: judge.declared.model,
              }
            : { kind: 'proven', vendor: side.vendor, model: side.model },
      };
    },
  };
}
