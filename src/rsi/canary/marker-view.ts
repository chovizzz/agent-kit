/**
 * 会话计数库 → 标记取回视图(R21-6.6 会话归并;W0-3 判定的输入)。**纯函数、无 I/O**:读会话计数库由调用方做(`SessionStat.rsi_markers` 由 W4 的 reader 写)。
 *
 * - {@link buildMarkerView}:标记 → 取回它的会话列表。每个会话给出它取回的**不同标记数**(`distinct_markers`)与静止分钟数(`quiet`,调用方的端口;
 *   不可知 = `null`)。缺 `rsi_markers`(旧行 / codex / kimi 未采集)的会话不在任何标记的取回列表里——缺键是「未测」,不是「0 个标记」。
 * - {@link postAdmissionMultiMarker}:准入之后是否有**经准入的**会话被判「多标记」:会话取回 ≥ 2 个不同标记、且其中至少一个是准入之后(`at ≥ decided_at`)
 *   本 agent 在账里发出的 treat / control 标记 → `true`(该 agent 回到 `failed(multi_marker)`,W0-3)。
 */
import type { RsiCanaryLedgerLine } from '../../contracts/rsi-personal.js';
import type { SessionStat } from '../../contracts/session-stat.js';
import { classifyMarkerRetrieval } from '../../signals/injection.js';
import type { AdmAgent, MarkerSighting, MarkerView } from './admission-plan.js';

export interface StatItem {
  /** 计数行所在目录的 agent(`SessionStat` 本身不带 agent) */
  agent: 'claude' | 'codex' | 'pi';
  stat: SessionStat;
}

export function buildMarkerView(
  items: readonly StatItem[],
  quietMinutes: (sessionRef: string) => number | null,
): MarkerView {
  const byMarker = new Map<string, MarkerSighting[]>();
  const seen = new Set<string>();
  for (const it of items) {
    const ms = it.stat.rsi_markers;
    if (ms === undefined) continue;
    // 同一 session_ref 至多一行(计数库规则);重复行只取第一行(防御)
    if (seen.has(it.stat.session_ref)) continue;
    seen.add(it.stat.session_ref);
    const sighting: MarkerSighting = {
      session_ref: it.stat.session_ref,
      distinct_markers: new Set(ms).size,
      quiet_minutes: quietMinutes(it.stat.session_ref),
    };
    for (const m of new Set(ms)) {
      const list = byMarker.get(m) ?? [];
      list.push(sighting);
      byMarker.set(m, list);
    }
  }
  return (marker) => byMarker.get(marker) ?? [];
}

export function postAdmissionMultiMarker(
  agent: AdmAgent,
  decidedAtMs: number,
  ledger: readonly RsiCanaryLedgerLine[],
  items: readonly StatItem[],
): boolean {
  const issued = new Set<string>();
  for (const l of ledger) {
    if (l.kind !== 'assign' || l.agent !== agent || l.marker === null) continue;
    if (l.arm === 'excluded') continue; // 探针行属于准入之前
    if (Date.parse(l.at) >= Math.floor(decidedAtMs / 1000) * 1000) issued.add(l.marker);
  }
  return items.some(
    (it) =>
      it.agent === agent &&
      classifyMarkerRetrieval(it.stat.rsi_markers) === 'multi_marker' &&
      (it.stat.rsi_markers ?? []).some((m) => issued.has(m)),
  );
}
