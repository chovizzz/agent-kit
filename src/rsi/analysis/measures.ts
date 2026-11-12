/**
 * 信号 → 会话度量(R21-7.2 / §21.24 W0-7;纯函数,无 I/O)。
 *
 *  - C1:`event_kind = tool_result_failed` 的信号数。
 *  - C3:显式教训 ∪ 用户纠正:`type ∈ {explicit_lesson, user_correction}` 的信号,与反思器确定性分类 `classifySignals().lessons` 的并集(按 `sig_id` 去重)。
 *  - 主判据:命中候选签名的事件数(`tool`:同名工具「失败后重试」对,签名带 `tool_error_class` 时失败信号的错误类须相同;`lesson`:token Jaccard ≥ `RSI_LESSON_JACCARD` 的教训数)。
 *    与 `sessionHitsSignature`(shadow 计数的命中判定)同口径:有命中 ⇔ 计数 > 0。
 *  - 资格(R21-6.7):{@link makeEligibility} 由「命中信号」的 (项目, 该信号自己的 ts) 列表建立,只看会话开始之前的数据。
 *    残余:信号读取下限处被截断的重试配对(原调用 / 失败在下限之前、重试在下限之后)配不成对,只会少判资格,不会多判。
 * 信号里没有 `event_kind` / `event_index` 的旧行没有结构,不参与计数(与 reflect 的 unknown 排除一致)。
 */
import { RSI_LESSON_JACCARD } from '../../contracts/rsi.js';
import type { Signal } from '../../contracts/signal.js';
import { classifySignals } from '../../reflect/classify.js';
import { jaccard, tokenSet } from '../../reflect/text.js';
import type { LoadedSignal } from '../../reflect/types.js';
import type { ClusterSignature } from '../personal/gate-types.js';
import type { SessionMeasures } from './assemble.js';
import { ELIGIBILITY_DAYS } from './types.js';

export function toLoaded(s: Signal): LoadedSignal | null {
  if (s.event_kind === undefined || s.event_index === undefined) return null;
  return { ...s, event_kind: s.event_kind, event_index: s.event_index };
}

/**
 * 命中签名的「命中信号」:tool 签名 = 失败后重试对里的**重试调用**(模式在它出现时才完成),lesson 签名 = 命中的教训信号。
 * 资格(R21-6.7)按命中信号自己的 `ts` 归时,不按它所在会话的开始时刻。
 */
export function signatureHitSignals(
  signature: ClusterSignature,
  signals: readonly LoadedSignal[],
): LoadedSignal[] {
  const cls = classifySignals(signals);
  if (signature.kind === 'tool') {
    return cls.retryPairs
      .filter(
        (p) =>
          p.tool === signature.tool_name &&
          (signature.tool_error_class === undefined ||
            p.failure.tool_error_class === signature.tool_error_class),
      )
      .map((p) => p.retry);
  }
  const rep = new Set(signature.rep_tokens);
  return cls.lessons.filter(
    (l) => jaccard(tokenSet(l.excerpt_redacted), rep) >= RSI_LESSON_JACCARD,
  );
}

export function signatureHitCount(
  signature: ClusterSignature,
  signals: readonly LoadedSignal[],
): number {
  return signatureHitSignals(signature, signals).length;
}

export function sessionMeasures(
  signature: ClusterSignature,
  signals: readonly Signal[],
): SessionMeasures {
  const loaded = signals.map(toLoaded).filter((s): s is LoadedSignal => s !== null);
  const c1 = loaded.filter((s) => s.event_kind === 'tool_result_failed').length;
  const c3ids = new Set<string>();
  for (const s of loaded) {
    if (s.type === 'explicit_lesson' || s.type === 'user_correction') c3ids.add(s.sig_id);
  }
  for (const l of classifySignals(loaded).lessons) c3ids.add(l.sig_id);
  return { c1, c3: c3ids.size, primary: signatureHitCount(signature, loaded) };
}

const DAY_MS = 86_400_000;
const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** 一个命中信号:`tsMs` 是命中信号自己的时刻(不是所在会话的开始时刻) */
export interface HitSession {
  project_key: string;
  tsMs: number;
}

/**
 * 资格(R21-6.7):会话所属项目在**会话开始之前**30 个 UTC 日内出现过目标签名。
 * 一条 {@link HitSession} = 一个命中信号(项目, 该信号自己的 ts);命中信号须严格早于本会话开始(`tsMs < ts`),且其 UTC 日 ≥ 本会话 UTC 日 − 30 天。
 */
export function makeEligibility(
  hits: readonly HitSession[],
): (projectKey: string, tsMs: number) => boolean {
  const byProject = new Map<string, number[]>();
  for (const h of hits) {
    const l = byProject.get(h.project_key) ?? [];
    l.push(h.tsMs);
    byProject.set(h.project_key, l);
  }
  return (projectKey, tsMs) => {
    const from = utcDayStart(tsMs) - ELIGIBILITY_DAYS * DAY_MS;
    return (byProject.get(projectKey) ?? []).some((h) => h < tsMs && utcDayStart(h) >= from);
  };
}
