/**
 * 产出事件层(R21-7.4):把判变差的结论映射成 W1 转移引擎的 `harm` 事件(`rolling_back` / `harm_<指标>`)。**纯函数。**
 * 只产出一种事件(`harm`,`worse: true`),不新增事件种类;结论不是「变差」(无越界、无 C4 越限、暂停、不可得、不可判)一律不产出事件(返回 `null`)。
 * `evidence` 只含指标、查看序号、信息时间、p 与边界(≤ 128 字,无路径 / 项目 key);事件经 `TransitionEventSchema` 校验后才返回。
 * 到上限仍从未有效查看 / 证据不足(R21-7.4a / R21-7.6)走引擎已有的 `canary_limit → expired`,不在这里产出:结果里的 `max_arm_sessions` 与 `never_valid_look` 给装配处用。
 */
import { TransitionEventSchema, type TransitionEvent } from '../personal/transition-table.js';
import type { AnalysisOutcome } from './run.js';

const fixed = (x: number | null, digits: number): string => (x === null ? 'na' : x.toFixed(digits));

export function harmEvent(outcome: AnalysisOutcome): TransitionEvent | null {
  if (outcome.kind !== 'harm') return null;
  const h = outcome.analysis.harm;
  if (h === null) return null;
  const evidence =
    h.metric === 'c4'
      ? `analysis-v${outcome.analysis.plan_version}:c4:bytes=${fixed(outcome.analysis.c4.bytes, 0)}:limit=${outcome.analysis.c4.limit}`
      : `analysis-v${outcome.analysis.plan_version}:${h.metric}:look=${h.k}:t=${fixed(h.t, 3)}:p=${fixed(h.p, 4)}:bound=${fixed(h.boundary, 4)}`;
  return TransitionEventSchema.parse({ kind: 'harm', evidence, metric: h.metric, worse: true });
}
