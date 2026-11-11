/**
 * 自动探针准入的 worker 侧**纯判定**(docs/contracts.md §21.24 W0-3、R21-6.5、R21-6.6)。读与写分开:本文件不做 I/O;
 * `canary-admission.json` 的唯一写入方是 `admission-write.ts`(持 `rsi/lock` 与 `personal/lock`)。
 *
 * 每个 agent(claude / pi)一项,状态机:
 *   (无) ─arm→ probing ─判定→ admitted | failed(marker_not_retrieved | multi_marker | probe_expired)
 *   admitted ─(此后经准入的会话被判多标记)→ failed(multi_marker)(撤销准入,走更少影响方向)
 *   admitted / failed ─(shape_version 或 agent_version 变化 且 满足 arm 条件)→ probing(`generation + 1`)
 * **arm 条件**:自动循环有效(R21-2.2)、`RSI_AUTO_PHASE ≥ 2`、该 agent 的钩子装了 canary 变体、无 `AUTO_PAUSE`、当前 `agent_version` 可知
 * (不可知则 hint 永远不会消费票,arm 没有意义)。`failed` 在版本变化之前**不自动重探**(契约 W0-3 两处表述:「failed 在 shape_version 或 agent_version
 * 变化前不自动重探」与「②之后崩溃…重新 armed 下一代」不一致,本块取前者——输出更少;重新 arm 由前台命令经 `rearm` 参数显式触发,见汇报「问题」)。
 *
 * **判定(probing)**:取本代探针行 = 账里 `agent` 相同、`reason=admission_probe`、`at ≥ armed_at`(秒精度,账行无 generation 字段,按时间归代)的 assign 行。
 *  - 任一标记被某个会话与另外的标记同取(取回 ≥ 2 个不同标记)→ `failed(multi_marker)`(取回即判,不等静止);
 *  - 探针行数恰为 `tickets`,**每个标记被恰好一个会话取回,且该会话取回的不同标记恰为 1 个**,且该会话已静止 ≥ `RSI_PROBE_QUIET_MINUTES` → `admitted`
 *    (静止时长未知 = 不满足,fail-closed);
 *  - 任一标记在其账行 `at` 之后 `RSI_PROBE_WAIT_HOURS` 内仍未被任何会话取回 → `failed(marker_not_retrieved)`
 *    (契约写「静止后 48 小时」,但未取回的标记没有会话可测静止,这里以账行时间为起点;列入汇报「问题」);
 *  - `probe_expires_at` 到期仍未凑齐 → `failed(probe_expired)`;否则继续 probing。
 *  `admitted` 只在自动循环有效且无暂停时给出(它是授予影响的前置);失败判定任何时候都可以给出(只收紧)。
 */
import {
  RSI_PROBE_QUIET_MINUTES,
  RSI_PROBE_SESSIONS,
  RSI_PROBE_WAIT_HOURS,
  RSI_PROBE_WINDOW_DAYS,
  phaseAtLeast,
} from '../../contracts/rsi.js';
import type { CanaryAdmission, RsiCanaryLedgerLine } from '../../contracts/rsi-personal.js';

export type AdmAgent = 'claude' | 'pi';
export type AdmEntry = NonNullable<CanaryAdmission['agents'][AdmAgent]>;
type FailReason = NonNullable<AdmEntry['reason']>;

/** 一个标记被哪些会话取回(由会话计数库的 `rsi_markers` 建立;见 `marker-view.ts`) */
export interface MarkerSighting {
  session_ref: string;
  /** 该会话取回的不同标记数 */
  distinct_markers: number;
  /** 会话文件已静止的分钟数;`null` = 不可知 */
  quiet_minutes: number | null;
}
export type MarkerView = (marker: string) => readonly MarkerSighting[];

export interface AgentFacts {
  /** 钩子是否装了 canary 变体 */
  hookCanaryInstalled: boolean;
  shapeVersion: string;
  /** 当前 agent 版本;`null` = 不可知 */
  agentVersion: string | null;
  /** 磁盘上已出现过的最大探针代数(`canary-probe/<agent>/<g>-<i>.used`);保证新代不与遗留占用文件撞名 */
  maxUsedGeneration: number;
  /** 当前条目所在代(`entry.generation`)已被占用的探针票文件数;用来识别账里属于旧代的迟到探针行(账行无 generation 字段) */
  usedTickets: number;
}

export interface AdmissionPlanInput {
  now: Date;
  autoLoopEffective: boolean;
  phase: number;
  autoPaused: boolean;
  current: CanaryAdmission | null;
  agents: Readonly<Record<AdmAgent, AgentFacts | undefined>>;
  ledger: readonly RsiCanaryLedgerLine[];
  markers: MarkerView;
  /** 准入之后是否有经准入的会话被判「多标记」(由调用方按会话计数库与账算出) */
  postAdmissionMultiMarker: Readonly<Record<AdmAgent, boolean>>;
  /** 前台命令显式要求重新 arm 的 agent(`failed` 且版本未变时才需要) */
  rearm?: readonly AdmAgent[];
}

export interface AdmissionChange {
  agent: AdmAgent;
  from: AdmEntry['state'] | 'none';
  to: AdmEntry['state'];
  reason: string;
}

export interface AdmissionPlan {
  next: CanaryAdmission;
  changes: AdmissionChange[];
  /** `next` 与输入的 `current` 是否不同(调用方据此决定是否写) */
  changed: boolean;
}

const AGENTS: readonly AdmAgent[] = ['claude', 'pi'];
const HOUR = 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
/** 账 `at` 只到秒:与 `armed_at` 比较时把 armed 截到秒 */
const floorSec = (ms: number): number => Math.floor(ms / 1000) * 1000;

export type ProbeVerdict =
  { kind: 'admitted' } | { kind: 'pending' } | { kind: 'failed'; reason: FailReason };

/** 本代探针行(按 `at` 升序;同一标记只取第一行) */
export function probeLinesOf(
  agent: AdmAgent,
  entry: Pick<AdmEntry, 'armed_at'>,
  ledger: readonly RsiCanaryLedgerLine[],
): { marker: string; atMs: number }[] {
  const since = floorSec(Date.parse(entry.armed_at));
  const seen = new Set<string>();
  const out: { marker: string; atMs: number }[] = [];
  for (const l of ledger) {
    if (l.kind !== 'assign' || l.agent !== agent || l.reason !== 'admission_probe') continue;
    if (l.marker === null || seen.has(l.marker)) continue;
    const atMs = Date.parse(l.at);
    if (atMs < since) continue;
    seen.add(l.marker);
    out.push({ marker: l.marker, atMs });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export function judgeProbe(
  agent: AdmAgent,
  entry: AdmEntry,
  ledger: readonly RsiCanaryLedgerLine[],
  markers: MarkerView,
  nowMs: number,
  usedTickets: number,
): ProbeVerdict {
  const lines = probeLinesOf(agent, entry, ledger);
  const views = lines.map((l) => ({ ...l, sightings: markers(l.marker) }));
  if (views.some((v) => v.sightings.some((s) => s.distinct_markers >= 2))) {
    return { kind: 'failed', reason: 'multi_marker' };
  }
  // 到期先于成功:取回时间不在视图里,到期时没有「已凑齐」的证据 → 一律 probe_expired(走更少影响)
  if (nowMs >= Date.parse(entry.probe_expires_at)) {
    return { kind: 'failed', reason: 'probe_expired' };
  }
  // 本代恰好占满全部票、且账里自 armed_at 起恰好这么多探针行:旧代 hint 迟到落的行会让行数多于本代票数 → 不满足(只会阻止准入,不会放行)
  const complete =
    usedTickets >= entry.tickets &&
    lines.length === entry.tickets &&
    views.every(
      (v) =>
        v.sightings.length === 1 &&
        v.sightings.every(
          (s) =>
            s.distinct_markers === 1 &&
            s.quiet_minutes !== null &&
            s.quiet_minutes >= RSI_PROBE_QUIET_MINUTES,
        ),
    );
  if (complete) return { kind: 'admitted' };
  if (
    views.some((v) => v.sightings.length === 0 && nowMs >= v.atMs + RSI_PROBE_WAIT_HOURS * HOUR)
  ) {
    return { kind: 'failed', reason: 'marker_not_retrieved' };
  }
  return { kind: 'pending' };
}

const versionsChanged = (e: AdmEntry, f: AgentFacts): boolean =>
  e.shape_version !== f.shapeVersion || e.agent_version !== f.agentVersion;

export function planAdmission(i: AdmissionPlanInput): AdmissionPlan {
  const nowMs = i.now.getTime();
  const next: CanaryAdmission = {
    schema_version: 1,
    agents: { ...(i.current?.agents ?? {}) },
  };
  const changes: AdmissionChange[] = [];
  const set = (
    agent: AdmAgent,
    e: AdmEntry,
    from: AdmissionChange['from'],
    reason: string,
  ): void => {
    next.agents[agent] = e;
    changes.push({ agent, from, to: e.state, reason });
  };
  const mayArm = i.autoLoopEffective && phaseAtLeast('V1b', i.phase) && !i.autoPaused;

  for (const agent of AGENTS) {
    const facts = i.agents[agent];
    const e = i.current?.agents[agent];
    const arm = (reason: string): void => {
      if (facts === undefined || !facts.hookCanaryInstalled || facts.agentVersion === null) return;
      const prevGen = Math.max(e?.generation ?? 0, facts.maxUsedGeneration);
      set(
        agent,
        {
          state: 'probing',
          shape_version: facts.shapeVersion,
          agent_version: facts.agentVersion,
          generation: prevGen + 1,
          armed_at: iso(floorSec(nowMs)),
          probe_expires_at: iso(floorSec(nowMs) + RSI_PROBE_WINDOW_DAYS * 24 * HOUR),
          tickets: RSI_PROBE_SESSIONS,
          decided_at: null,
          reason: null,
        },
        e?.state ?? 'none',
        reason,
      );
    };

    if (e === undefined) {
      if (mayArm) arm('armed');
      continue;
    }
    if (e.state === 'probing') {
      const v = judgeProbe(agent, e, i.ledger, i.markers, nowMs, facts?.usedTickets ?? 0);
      if (v.kind === 'failed') {
        set(
          agent,
          { ...e, state: 'failed', decided_at: iso(nowMs), reason: v.reason },
          'probing',
          v.reason,
        );
      } else if (facts !== undefined && versionsChanged(e, facts)) {
        // probing 期间 shape_version / agent_version 变了:旧版本的证据不能判 admitted;允许时重新 arm(generation + 1),否则原地等待
        if (mayArm) arm('version_changed');
      } else if (v.kind === 'admitted' && mayArm && facts !== undefined) {
        set(
          agent,
          { ...e, state: 'admitted', decided_at: iso(nowMs), reason: null },
          'probing',
          'admitted',
        );
      }
      continue;
    }
    if (e.state === 'admitted') {
      if (i.postAdmissionMultiMarker[agent]) {
        set(
          agent,
          { ...e, state: 'failed', decided_at: iso(nowMs), reason: 'multi_marker' },
          'admitted',
          'multi_marker',
        );
      } else if (mayArm && facts !== undefined && versionsChanged(e, facts)) {
        arm('version_changed');
      }
      continue;
    }
    // failed:版本变化或前台显式 rearm 才重探
    if (
      mayArm &&
      facts !== undefined &&
      (versionsChanged(e, facts) || i.rearm?.includes(agent) === true)
    ) {
      arm(versionsChanged(e, facts) ? 'version_changed' : 'rearm');
    }
  }
  const changed = changes.length > 0;
  return { next, changes, changed };
}
