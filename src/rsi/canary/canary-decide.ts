/**
 * hint `--canary` 的判定顺序(docs/contracts.md R21-6.11 结果矩阵 + §21.24 W0-3 订正的第 2 / 2a 行)。
 * **只判定、不写**:输出是一个 {@link CanaryDecision},票的占用、分组账、随机与输出由 `canary-hint.ts` 按决定执行。
 * 第 1 行(R20-1.6 跳过、状态 off / stopped / armed、配置不可用、停止采集)由 hint 的既有前置判定承担,不会走到这里。
 *
 * 顺序固定、先命中先用:
 *  2   自动循环未开启(R21-2.2)、`RSI_AUTO_PHASE < 2`、agent 为 codex → none(无输出、无写入)
 *  2a  探针行:`AUTO_PAUSE` 与 `AUTO_PAUSE_BREAKER` 都不存在(W0-21)、该 agent 准入为 `probing` 且未过期、`shape_version` / `agent_version` 现算一致 → probe(**先于候选存在性检查**)
 *  3   `canary.json` 不存在 / 读取失败 / schema 或语义不合法 → none(没有合法 `candidate_id`,不伪造账行)
 *  4   已知候选但 `AUTO_PAUSE` 或 `AUTO_PAUSE_BREAKER` 任一在(W0-21)、准入未过、`policy_fp` 不符、agent 不在 `agents_inject`、撤销凭据命中 → excluded + 原因码
 *  4a  上面任一输入「读不到 / 解析失败 / 超过 1MiB」且没有更早命中的第 4 行原因 → excluded(`permit_unreadable`)
 *  之后(随机、第 5–8 行)由调用方执行:返回 `randomize`。
 *
 * **第 4 行多个原因同时成立时**按固定顺序取第一个:`paused` → `not_admitted` → `policy_mismatch` → `agent_not_injected` → `revoked`
 * (契约列举顺序;契约未规定并列时的取舍,本块取此顺序并由测试钉住)。第 4 行的原因优先于第 4a 行(矩阵表内的行序):已确证的原因先用,
 * 只有没有任何确证原因而某个输入读不到时才是 `permit_unreadable`。不可读从不被当作「不存在」。
 *
 * `agent_version` 现算不出(`null`)时一律按「不一致」处理——不因条目里也是 `null` 而放行(fail-closed;契约未定未知版本的语义,见汇报「问题」)。
 */
import { phaseAtLeast, type RsiAgentId } from '../../contracts/rsi.js';
import type { CanaryAdmission, CanaryDoc } from '../../contracts/rsi-personal.js';
import { canaryDocProblem } from './canary-doc.js';
import type { PermitPort, Read3 } from './permit-port.js';

export type AdmissionEntry = NonNullable<
  CanaryAdmission['agents'][keyof CanaryAdmission['agents']]
>;
export type Row4Reason =
  'paused' | 'not_admitted' | 'policy_mismatch' | 'agent_not_injected' | 'revoked';
export type ExcludedReason = Row4Reason | 'permit_unreadable';
/** 第 4 行原因的判定顺序(固定) */
export const ROW4_ORDER: readonly Row4Reason[] = Object.freeze([
  'paused',
  'not_admitted',
  'policy_mismatch',
  'agent_not_injected',
  'revoked',
]);

export type CanaryDecision =
  | { kind: 'none'; row: 2 | 3 }
  | { kind: 'probe'; entry: AdmissionEntry }
  | { kind: 'excluded'; row: 4 | '4a'; reason: ExcludedReason; doc: CanaryDoc }
  | { kind: 'randomize'; doc: CanaryDoc; p: number };

export interface DecideInput {
  /** codex 也可能传入(第 2 行拦下);只有 claude / pi 会走到后面的行 */
  agent: RsiAgentId;
  /** R21-2.2:`confirmed ∧ enabled ∧ L-auto 通过 ∧ 相位 ≥ V1a` */
  autoLoopEffective: boolean;
  /** `RSI_AUTO_PHASE`(可注入) */
  phase: number;
  /** 用当前配置现算的排除策略指纹(R20-6.9) */
  policyFp: string;
  /** 当前钩子形状版本(形状表现算) */
  shapeVersion: string;
  /** 当前 agent 版本;`null` = 现算不出 */
  agentVersion: string | null;
  nowMs: number;
  port: PermitPort;
}

type Tri = 'yes' | 'no' | 'unknown';

/** 准入文件里该 agent 的条目与「现算」是否一致:`shape_version` 相等且 `agent_version` 非空相等 */
function versionsMatch(e: AdmissionEntry, i: DecideInput): boolean {
  return (
    i.agentVersion !== null &&
    e.shape_version === i.shapeVersion &&
    e.agent_version === i.agentVersion
  );
}

export async function decideCanary(i: DecideInput): Promise<CanaryDecision> {
  // 第 2 行
  if (!i.autoLoopEffective || !phaseAtLeast('V1b', i.phase) || i.agent === 'codex') {
    return { kind: 'none', row: 2 };
  }
  const agent: 'claude' | 'pi' = i.agent;

  const pause = await i.port.pause();
  let admission: Read3<CanaryAdmission> | undefined;
  const readAdmission = async (): Promise<Read3<CanaryAdmission>> => {
    admission ??= await i.port.admission();
    return admission;
  };

  // 第 2a 行(探针):先于候选存在性检查
  if (pause === 'absent') {
    const a = await readAdmission();
    if (a.kind === 'ok') {
      const e = a.value.agents[agent];
      if (
        e !== undefined &&
        e.state === 'probing' &&
        i.nowMs < Date.parse(e.probe_expires_at) &&
        versionsMatch(e, i)
      ) {
        return { kind: 'probe', entry: e };
      }
    }
  }

  // 第 3 行
  const c = await i.port.canary();
  if (c.kind !== 'ok' || canaryDocProblem(c.value) !== null) return { kind: 'none', row: 3 };
  const doc = c.value;

  // 第 4 / 4a 行:按固定顺序逐项判定,第一个确证的原因胜出;读不到记 unknown
  const state = async (r: Row4Reason): Promise<Tri> => {
    switch (r) {
      case 'paused':
        return pause === 'present' ? 'yes' : pause === 'unreadable' ? 'unknown' : 'no';
      case 'not_admitted': {
        const a = await readAdmission();
        if (a.kind === 'unreadable') return 'unknown';
        if (a.kind === 'absent') return 'yes';
        const e = a.value.agents[agent];
        return e !== undefined && e.state === 'admitted' && versionsMatch(e, i) ? 'no' : 'yes';
      }
      case 'policy_mismatch':
        return doc.policy_fp === i.policyFp ? 'no' : 'yes';
      case 'agent_not_injected':
        return doc.agents_inject.includes(agent) ? 'no' : 'yes';
      case 'revoked': {
        const v = await i.port.revocations();
        if (v.kind === 'unreadable') return 'unknown';
        if (v.kind === 'absent') return 'no';
        return v.value.some(
          (l) => l.candidate_id === doc.candidate_id && l.content_sha256 === doc.content_sha256,
        )
          ? 'yes'
          : 'no';
      }
    }
  };
  let unknown = false;
  for (const r of ROW4_ORDER) {
    const s = await state(r);
    if (s === 'yes') return { kind: 'excluded', row: 4, reason: r, doc };
    if (s === 'unknown') unknown = true;
  }
  if (unknown) return { kind: 'excluded', row: '4a', reason: 'permit_unreadable', doc };

  const p = doc.p_by_agent[agent];
  // canaryDocProblem 已保证在列的 agent 有 p > 0;这里再核一次(类型收窄,也防未来改动)
  if (p === undefined || !(p > 0)) return { kind: 'none', row: 3 };
  return { kind: 'randomize', doc, p };
}
