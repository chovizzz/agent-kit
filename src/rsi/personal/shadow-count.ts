/**
 * shadow 计数:有观测会话数与签名命中数(docs/contracts.md R21-1.7、R21-4.1、§21.24 W0-2 / W0-13)。**纯函数 + 窄端口,无 I/O**:
 * 会话与信号的读取在 `shadow-observe.ts`(适配器),`FactsProvider` / `ReadySinceRecovery` 的装配在 `shadow-facts.ts`。
 *
 * 口径:
 *  - 窗口:进入 `shadow` 的那条转移之后(`ts > entered_at`)的会话;转移已被 256 条窗口挤掉(`shadowEnteredAt` 返回 `null`)= **事实不可得**,
 *    调用方按 fail-closed 处理(不推进、清零排队),**不**退化成「从纪元起算」。
 *  - 「有观测会话」(R21-1.7)的资格(会话被完整读完、属「采集中」项目、被随机的会话能经标记关联且不属多标记)由适配器在产出会话列表时判定;
 *    本函数只对已通过资格的会话计数,按 `session_ref` 去重。
 *  - **命中**(W0-2 的签名定义,与 `candidate-source.ts` 的 `deriveClusterSignature` 对偶、复用反思器的确定性分类 `classifySignals`):
 *      · `kind=tool`:会话里存在「工具失败后重试」对(失败 → 同名工具再次调用),其工具 = `tool_name`;签名带 `tool_error_class` 时失败信号的错误类须相同(只收窄不放宽);
 *        旧信号无 `tool_error_class` 时,带 `tool_error_class` 的签名不命中(不能证明)。
 *      · `kind=lesson`:会话里存在显式教训,其 token 集与签名代表集的 Jaccard ≥ `RSI_LESSON_JACCARD`。
 *    每个会话至多记一次命中(`hits` 是**命中会话数**,与门槛「签名命中 ≥ 2」同口径)。
 *  - `firstReadyDay`:按会话 UTC 日累计,第一个同时满足 `sessions ≥ RSI_SHADOW_MIN_SESSIONS` 且 `hits ≥ RSI_SHADOW_MIN_HITS` 的日子(取当日全部会话之后的累计值);
 *    从未满足 = `null`。
 */
import {
  RSI_LESSON_JACCARD,
  RSI_SHADOW_MIN_HITS,
  RSI_SHADOW_MIN_SESSIONS,
} from '../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';
import { classifySignals } from '../../reflect/classify.js';
import { jaccard, tokenSet } from '../../reflect/text.js';
import type { LoadedSignal } from '../../reflect/types.js';
import type { ClusterSignature } from './gate-types.js';

export interface ObservedSession {
  session_ref: string;
  /** 会话开始时间(计数库的 `ts`,首写钉死) */
  ts: string;
}

export interface ShadowObservation {
  /** 已通过「有观测会话」资格的会话(ts 在窗口内) */
  sessions: readonly ObservedSession[];
  /** 这些会话(及更多)的信号;只有 `session_ref` 属于上面会话的才会被用 */
  signals: readonly LoadedSignal[];
}

export interface ShadowCounts {
  sessions: number;
  hits: number;
}

/** 观测端口:读取窗口(`sinceIso` 之后)内的有观测会话与信号。读失败抛错(从不返回「空结果」冒充成功) */
export interface ShadowObserver {
  observe(sinceIso: string): Promise<ShadowObservation>;
}

/** 计数端口(给 `runPersonalStep` 重建工作副本用):`null` = 事实不可得 */
export interface ShadowCountPort {
  count(rec: PersonalLifecycleRecord): Promise<ShadowCounts | null>;
}

/** 进入 `shadow` 的时间:最后一条 `dim=lifecycle`、`to=shadow` 的转移;找不到(被 256 条窗口挤掉)= `null` */
export function shadowEnteredAt(rec: Pick<PersonalLifecycleRecord, 'transitions'>): string | null {
  for (let i = rec.transitions.length - 1; i >= 0; i--) {
    const t = rec.transitions[i];
    if (t !== undefined && t.dim === 'lifecycle' && t.to === 'shadow') return t.at;
  }
  return null;
}

/** 一个会话的信号是否命中签名 */
export function sessionHitsSignature(
  signature: ClusterSignature,
  signals: readonly LoadedSignal[],
): boolean {
  const cls = classifySignals(signals);
  if (signature.kind === 'tool') {
    return cls.retryPairs.some(
      (p) =>
        p.tool === signature.tool_name &&
        (signature.tool_error_class === undefined ||
          p.failure.tool_error_class === signature.tool_error_class),
    );
  }
  const rep = new Set(signature.rep_tokens);
  return cls.lessons.some((l) => jaccard(tokenSet(l.excerpt_redacted), rep) >= RSI_LESSON_JACCARD);
}

interface PerSession {
  day: string;
  hit: boolean;
}

function perSession(signature: ClusterSignature, obs: ShadowObservation): PerSession[] {
  const bySession = new Map<string, LoadedSignal[]>();
  for (const s of obs.signals) {
    const l = bySession.get(s.session_ref);
    if (l === undefined) bySession.set(s.session_ref, [s]);
    else l.push(s);
  }
  const seen = new Set<string>();
  const out: PerSession[] = [];
  for (const s of obs.sessions) {
    if (seen.has(s.session_ref)) continue;
    seen.add(s.session_ref);
    out.push({
      day: s.ts.slice(0, 10),
      hit: sessionHitsSignature(signature, bySession.get(s.session_ref) ?? []),
    });
  }
  return out;
}

export function countShadow(signature: ClusterSignature, obs: ShadowObservation): ShadowCounts {
  const ps = perSession(signature, obs);
  return { sessions: ps.length, hits: ps.filter((p) => p.hit).length };
}

/** 首次达标的 UTC 日;从未达标 = `null` */
export function firstReadyDay(signature: ClusterSignature, obs: ShadowObservation): string | null {
  const ps = perSession(signature, obs);
  const days = [...new Set(ps.map((p) => p.day))].sort();
  for (const d of days) {
    const upTo = ps.filter((p) => p.day <= d);
    if (
      upTo.length >= RSI_SHADOW_MIN_SESSIONS &&
      upTo.filter((p) => p.hit).length >= RSI_SHADOW_MIN_HITS
    ) {
      return d;
    }
  }
  return null;
}
