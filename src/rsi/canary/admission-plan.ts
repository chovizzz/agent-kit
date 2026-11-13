/**
 * 自动探针准入的 worker 侧**纯判定**(docs/contracts.md §21.24 W0-3、R21-6.5、R21-6.6)。读与写分开:本文件不做 I/O;
 * `canary-admission.json` 的唯一写入方是 `admission-write.ts`(持 `rsi/lock` 与 `personal/lock`)。
 *
 * 每个 agent(claude / pi)一项,状态机:
 *   (无) ─arm→ probing ─判定→ admitted | failed(marker_not_retrieved | multi_marker | probe_expired)
 *   admitted ─(此后经准入的会话被判多标记)→ failed(multi_marker)(撤销准入,走更少影响方向)
 *   admitted / failed ─(shape_version 或 agent_version 变化 且 满足 arm 条件)→ probing(`generation + 1`)
 *   failed ─(满 `RSI_PROBE_RETRY_DAYS` 个 UTC 日,起点 `decided_at`;W0-18)→ probing(`generation + 1`,自动重探)
 * **arm 条件**:自动循环有效(R21-2.2)、`RSI_AUTO_PHASE ≥ 2`、该 agent 的钩子装了 canary 变体、无 `AUTO_PAUSE` / `AUTO_PAUSE_BREAKER`(W0-21)、当前 `agent_version` 可知
 * (不可知则 hint 永远不会消费票,arm 没有意义)。`failed` 的重探(W0-18 取代 W0-3「版本变化前不自动重探」):`shape_version` / `agent_version` 变化立即重探;
 * 否则满 `RSI_PROBE_RETRY_DAYS` 个 UTC 日(日期差口径 W0-16,起点 `decided_at`)后自动重探;前台显式 `rearm`(W8)不受天数限制。
 *
 * **判定(probing)**:取本代探针行 = 账里 `agent` 相同、`reason=admission_probe`、`probe_generation` 等于本条目 `generation`、`probe_ticket` 在 1..`tickets` 内的 assign 行
 * (W0-18:按代号与票号认行,不按时间归代;旧代 / 越界行不计入本代)。
 *  - 同一 `probe_ticket`(或同一标记)出现在多行 → `failed(multi_marker)`(按更少影响方向);
 *  - 任一标记被某个会话与另外的标记同取(取回 ≥ 2 个不同标记)→ `failed(multi_marker)`(取回即判,不等静止);
 *  - 票号 1..`tickets` 各恰一行,**每个标记被恰好一个会话取回,且该会话取回的不同标记恰为 1 个**,且该会话已静止 ≥ `RSI_PROBE_QUIET_MINUTES` → `admitted`
 *    (静止时长未知 = 不满足,fail-closed);
 *  - 任一标记在其账行 `at` 之后 `RSI_PROBE_WAIT_HOURS` 内仍未被任何会话取回 → `failed(marker_not_retrieved)`
 *    (W0-18:无人取回的标记没有会话可测静止,起点即该探针账行的 `at`);
 *  - `probe_expires_at` 到期仍未凑齐 → `failed(probe_expired)`;否则继续 probing。
 *  `admitted` 只在自动循环有效且无暂停时给出(它是授予影响的前置);失败判定任何时候都可以给出(只收紧)。
 */
import {
  RSI_PROBE_QUIET_MINUTES,
  RSI_PROBE_RETRY_DAYS,
  RSI_PROBE_SESSIONS,
  RSI_PROBE_WAIT_HOURS,
  RSI_PROBE_WINDOW_DAYS,
  phaseAtLeast,
} from '../../contracts/rsi.js';
import type { CanaryAdmission, RsiCanaryLedgerLine } from '../../contracts/rsi-personal.js';
import { utcDayDiff } from '../personal/transition-table.js';

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
/** 取整到秒(`armed_at` / `probe_expires_at` 与账 `at` 同精度) */
const floorSec = (ms: number): number => Math.floor(ms / 1000) * 1000;

export type ProbeVerdict =
  { kind: 'admitted' } | { kind: 'pending' } | { kind: 'failed'; reason: FailReason };

/**
 * 本代探针行(按 `at` 升序):`probe_generation` 等于本条目代号、`probe_ticket` 在 1..`tickets` 内(W0-18)。
 * 不去重:重复票号 / 重复标记由 {@link judgeProbe} 判 `multi_marker`。
 */
export function probeLinesOf(
  agent: AdmAgent,
  entry: Pick<AdmEntry, 'generation' | 'tickets'>,
  ledger: readonly RsiCanaryLedgerLine[],
): { marker: string; ticket: number; atMs: number }[] {
  const out: { marker: string; ticket: number; atMs: number }[] = [];
  for (const l of ledger) {
    if (l.kind !== 'assign' || l.agent !== agent || l.reason !== 'admission_probe') continue;
    if (l.marker === null || l.probe_generation !== entry.generation) continue;
    if (l.probe_ticket === null || l.probe_ticket < 1 || l.probe_ticket > entry.tickets) continue;
    out.push({ marker: l.marker, ticket: l.probe_ticket, atMs: Date.parse(l.at) });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** W0-18:同一票号或同一标记出现在多行(证据结构被破坏;与「探针是否凑齐 / 到期」无关,probing 与 admitted 都要查) */
export function hasDuplicateProbeEvidence(
  lines: readonly { marker: string; ticket: number }[],
): boolean {
  return (
    new Set(lines.map((l) => l.ticket)).size !== lines.length ||
    new Set(lines.map((l) => l.marker)).size !== lines.length
  );
}

export function judgeProbe(
  agent: AdmAgent,
  entry: AdmEntry,
  ledger: readonly RsiCanaryLedgerLine[],
  markers: MarkerView,
  nowMs: number,
): ProbeVerdict {
  const lines = probeLinesOf(agent, entry, ledger);
  // W0-18:同一票号或同一标记出现在多行 → 本代 multi_marker(只收紧)
  if (hasDuplicateProbeEvidence(lines)) return { kind: 'failed', reason: 'multi_marker' };
  const views = lines.map((l) => ({ ...l, sightings: markers(l.marker) }));
  if (views.some((v) => v.sightings.some((s) => s.distinct_markers >= 2))) {
    return { kind: 'failed', reason: 'multi_marker' };
  }
  // 到期先于成功:取回时间不在视图里,到期时没有「已凑齐」的证据 → 一律 probe_expired(走更少影响)
  if (nowMs >= Date.parse(entry.probe_expires_at)) {
    return { kind: 'failed', reason: 'probe_expired' };
  }
  // 票号 1..tickets 各恰一行(上面已排除重复,越界 / 旧代行在 probeLinesOf 里就没进来)
  const complete =
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

/** W0-18:`failed` 满 `RSI_PROBE_RETRY_DAYS` 个 UTC 日(日期差,起点 `decided_at`);`decided_at` 缺失 / 不可解析 = 不自动重探(fail-closed) */
export function retryDue(e: AdmEntry, nowMs: number): boolean {
  if (e.decided_at === null) return false;
  const at = Date.parse(e.decided_at);
  if (!Number.isFinite(at)) return false;
  return utcDayDiff(iso(nowMs).slice(0, 10), iso(at).slice(0, 10)) >= RSI_PROBE_RETRY_DAYS;
}

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
      const v = judgeProbe(agent, e, i.ledger, i.markers, nowMs);
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
      // 已准入之后才出现本代重复探针行:同样撤销(W0-18);不重跑 judgeProbe,否则探针窗口到期会误撤已完成的准入
      if (
        i.postAdmissionMultiMarker[agent] ||
        hasDuplicateProbeEvidence(probeLinesOf(agent, e, i.ledger))
      ) {
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
    // failed:版本变化立即重探;满 RSI_PROBE_RETRY_DAYS 个 UTC 日自动重探(W0-18);前台显式 rearm
    if (mayArm && facts !== undefined) {
      if (versionsChanged(e, facts)) arm('version_changed');
      else if (retryDue(e, nowMs)) arm('retry');
      else if (i.rearm?.includes(agent) === true) arm('rearm');
    }
  }
  const changed = changes.length > 0;
  return { next, changes, changed };
}
