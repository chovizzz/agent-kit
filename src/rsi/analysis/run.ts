/**
 * 变差检验的编排(读 → 算 → 结论;docs/contracts.md R21-7.4 / R21-7.7)。依赖窄端口 {@link AnalysisSource},不直接 import 驱动 / 数据访问层
 * (生产适配器在 `read.ts`,由装配处注入)。
 *
 * 结果类型严格区分四种,读失败永远不会落成「无伤害」:
 *  - `unavailable`:任一端口抛错、输入非法(账里标记重复)、随机源越界、采集覆盖时刻不可得 → 不判定(fail-closed);
 *  - `paused`:本机 payload 漂移期间分析暂停,不计入任何组(R21-7.7);
 *  - `harm` / `no_harm` / `no_decision`:见 `SegmentAnalysis.kind`。
 * 判变差在 `RSI_DECIDE_BETTER_ENABLED = false` 时照常生效(R21-7.4):本模块不读这个常量。
 */
import type { RsiCanaryLedgerLine } from '../../contracts/rsi-personal.js';
import type { Signal } from '../../contracts/signal.js';
import type { StatItem } from '../canary/marker-view.js';
import type { ClusterSignature } from '../personal/gate-types.js';
import { assemble, type SessionMeasures } from './assemble.js';
import {
  analyzeSegment,
  DEFAULT_ANALYSIS_CONFIG,
  type AnalysisConfig,
  type SegmentAnalysis,
} from './analyze.js';
import {
  makeEligibility,
  sessionMeasures,
  signatureHitCount,
  toLoaded,
  type HitSession,
} from './measures.js';
import { defaultSeed, seededRandom, type AnalysisRandom } from './rng.js';
import { AnalysisInputError, ELIGIBILITY_DAYS, type AssembleAudit } from './types.js';
import type { LoadedSignal } from '../../reflect/types.js';

export interface AnalysisSource {
  /** 分组账全部行;账不存在 = `[]`;读不了 / 不合规 → 抛错 */
  ledger(): Promise<readonly RsiCanaryLedgerLine[]>;
  /** 会话计数行(带所在 agent),只要 `ts ≥ sinceIso` 的;任一行不合规 → 抛错 */
  stats(sinceIso: string): Promise<readonly StatItem[]>;
  /** 信号行(`ts ≥ sinceIso`);任一行不合规 → 抛错(不静默少计) */
  signals(sinceIso: string): Promise<readonly Signal[]>;
  /** 当前配置下的项目归属;`P` = 采集中 */
  classify(projectKey: string): Promise<'P' | 'X' | 'U'>;
  /** 本机 payload 是否漂移(登记表报告某托管块被用户改过);查不到 → 抛错 */
  payloadDrift(): Promise<'clean' | 'drifted'>;
  /** L0 采集已覆盖到的时刻;不可得 = `null` */
  collectedThrough(): Promise<string | null>;
  /** treat 会话注入的字节数;不可得 = `null` */
  c4Bytes(): Promise<number | null>;
}

export interface AnalysisRequest {
  candidateId: string;
  signature: ClusterSignature;
  /** 本评估期(canary / adopted)的起点 */
  windowStartIso: string;
  /** 缺省:由候选与当前背景段确定性派生的种子 */
  random?: AnalysisRandom;
  config?: AnalysisConfig;
}

export type AnalysisOutcome =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'paused'; reason: 'payload_drift' }
  | { kind: SegmentAnalysis['kind']; analysis: SegmentAnalysis; audit: AssembleAudit };

const DAY_MS = 86_400_000;

function reasonOf(e: unknown): string {
  if (e instanceof AnalysisInputError) return `input:${e.why}`;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z_]{1,48}$/.test(code)) return `error:${code}`;
  return `error:${e instanceof Error ? e.name : 'unknown'}`;
}

export async function runAnalysis(
  source: AnalysisSource,
  req: AnalysisRequest,
): Promise<AnalysisOutcome> {
  try {
    if ((await source.payloadDrift()) === 'drifted') {
      return { kind: 'paused', reason: 'payload_drift' };
    }
    const throughIso = await source.collectedThrough();
    if (throughIso === null) return { kind: 'unavailable', reason: 'collected_through_unknown' };
    const startMs = Date.parse(req.windowStartIso);
    if (!Number.isFinite(startMs)) throw new AnalysisInputError('window_start_unparseable');
    // 资格要看会话开始前 30 个 UTC 日(多取一天作余量)
    const sinceIso = new Date(startMs - (ELIGIBILITY_DAYS + 1) * DAY_MS).toISOString();
    const ledger = await source.ledger();
    const stats = await source.stats(sinceIso);
    const signals = await source.signals(sinceIso);

    const collecting = new Set<string>();
    for (const pk of new Set(stats.map((s) => s.stat.project_key))) {
      if ((await source.classify(pk)) === 'P') collecting.add(pk);
    }
    const bySession = new Map<string, Signal[]>();
    for (const s of signals) {
      const l = bySession.get(s.session_ref);
      if (l === undefined) bySession.set(s.session_ref, [s]);
      else l.push(s);
    }
    const hits: HitSession[] = [];
    const seen = new Set<string>();
    for (const it of stats) {
      if (seen.has(it.stat.session_ref)) continue;
      seen.add(it.stat.session_ref);
      if (!collecting.has(it.stat.project_key)) continue;
      const loaded = (bySession.get(it.stat.session_ref) ?? [])
        .map(toLoaded)
        .filter((s): s is LoadedSignal => s !== null);
      if (signatureHitCount(req.signature, loaded) > 0) {
        hits.push({ project_key: it.stat.project_key, tsMs: Date.parse(it.stat.ts) });
      }
    }
    const assembled = assemble({
      candidateId: req.candidateId,
      windowStartIso: req.windowStartIso,
      collectedThroughIso: throughIso,
      ledger,
      stats,
      collecting: (pk) => collecting.has(pk),
      measures: (ref): SessionMeasures => sessionMeasures(req.signature, bySession.get(ref) ?? []),
      eligible: makeEligibility(hits),
    });
    const last = assembled.lines[assembled.lines.length - 1];
    const random =
      req.random ?? seededRandom(defaultSeed(req.candidateId, last?.background_fp ?? 'none'));
    const analysis = analyzeSegment({
      assembled,
      random,
      c4Bytes: await source.c4Bytes(),
      config: req.config ?? DEFAULT_ANALYSIS_CONFIG,
    });
    return { kind: analysis.kind, analysis, audit: assembled.audit };
  } catch (e) {
    return { kind: 'unavailable', reason: reasonOf(e) };
  }
}
