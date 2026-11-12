/**
 * 分层(R21-7.2 / R21-7.4a)。纯函数。
 *
 *  - 层 = agent × 项目。任一组会话数 < {@link MIN_ARM_PER_STRATUM} 的层并入**该 agent** 的「其它」层(claude 与 pi 的「其它」绝不合并)。
 *  - 并层之后「其它」层仍有任一组 < 2 → 该层剔除出检验,剔除的会话数写进审计(R21-7.4a);没有任何层可用 → 调用方本次不判定、不消耗 α。
 *  - C6 的关联失败会话拿不到项目,调用方给每个 unit 同一个占位项目,结果就是按 agent 分层。
 */
import { MIN_ARM_PER_STRATUM, type Unit } from './types.js';

export interface Stratum {
  agent: string;
  /** `null` = 该 agent 的「其它」层 */
  project: string | null;
  treat: readonly number[];
  control: readonly number[];
}

export interface StrataResult {
  strata: readonly Stratum[];
  /** 并入「其它」层(且「其它」层可用)的会话数 */
  pooled_sessions: number;
  /** 被剔除的层数 / 会话数(R21-7.4a 的审计) */
  dropped_strata: number;
  dropped_sessions: number;
}

interface Acc {
  treat: number[];
  control: number[];
}

const usable = (a: Acc): boolean =>
  a.treat.length >= MIN_ARM_PER_STRATUM && a.control.length >= MIN_ARM_PER_STRATUM;

export function buildStrata(units: readonly Unit[]): StrataResult {
  const byAgent = new Map<string, Map<string, Acc>>();
  for (const u of units) {
    let projects = byAgent.get(u.agent);
    if (projects === undefined) byAgent.set(u.agent, (projects = new Map()));
    let acc = projects.get(u.project);
    if (acc === undefined) projects.set(u.project, (acc = { treat: [], control: [] }));
    (u.arm === 'treat' ? acc.treat : acc.control).push(u.v);
  }
  const strata: Stratum[] = [];
  let pooledSessions = 0;
  let droppedStrata = 0;
  let droppedSessions = 0;
  for (const agent of [...byAgent.keys()].sort()) {
    const projects = byAgent.get(agent) as Map<string, Acc>;
    const other: Acc = { treat: [], control: [] };
    for (const project of [...projects.keys()].sort()) {
      const acc = projects.get(project) as Acc;
      if (usable(acc)) strata.push({ agent, project, treat: acc.treat, control: acc.control });
      else {
        other.treat.push(...acc.treat);
        other.control.push(...acc.control);
      }
    }
    const n = other.treat.length + other.control.length;
    if (n === 0) continue;
    if (usable(other)) {
      strata.push({ agent, project: null, treat: other.treat, control: other.control });
      pooledSessions += n;
    } else {
      droppedStrata += 1;
      droppedSessions += n;
    }
  }
  return {
    strata,
    pooled_sessions: pooledSessions,
    dropped_strata: droppedStrata,
    dropped_sessions: droppedSessions,
  };
}
