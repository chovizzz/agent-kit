/**
 * shadow 计数在 W3 端口后面的装配(docs/contracts.md §21.24 W0-13「工作副本丢失后重算」、R21-3.8):
 *  - {@link makeShadowCountPort}:`ShadowCountPort`(`runPersonalStep` 重建工作副本后由计数重算 `sessions` / `hits`);
 *  - {@link makeReadySinceRecovery}:`ReadySinceRecovery`(用信号历史算保留期内能证明达标的最早 UTC 日;无法重算 = `null`,W3 记重建当日并审计 `ready_since_rebuilt`);
 *  - {@link withShadowCounts}:`FactsProvider` 的装饰器——`promoteFacts` 的 `sessions` / `hits` 取自真实计数,其余字段(配置、授权、taint、冷却 / 墓碑 / 黑名单、
 *    证据、签名)仍由被装饰的提供者给(它们的所有者是别的块);**任一事实不可得 → `null`**(W3 的步骤据此清零排队、不推进,fail-closed);
 *  - {@link syncShadowCounts}:把真实计数写回各 shadow 工作副本(展示与 `rsi show` 用;推进判定从不读工作副本里的计数,每次都经 `promoteFacts` 现算)。
 * 读取失败一律映射为「事实不可得」(`null`),从不当作「0 会话」——0 会让 shadow 走向 `expired`,而读失败不该改变候选命运。
 */
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
} from '../../contracts/rsi-personal.js';
import type { FactsProvider, ReadySinceRecovery, WorkingStore } from './candidate-ports.js';
import {
  countShadow,
  firstReadyDay,
  shadowEnteredAt,
  type ShadowCountPort,
  type ShadowCounts,
  type ShadowObservation,
  type ShadowObserver,
} from './shadow-count.js';

async function observeFor(
  observer: ShadowObserver,
  rec: PersonalLifecycleRecord,
): Promise<{
  sig: NonNullable<PersonalLifecycleRecord['cluster_signature']>;
  obs: ShadowObservation;
} | null> {
  const sig = rec.cluster_signature;
  const entered = shadowEnteredAt(rec);
  if (sig === undefined || entered === null) return null;
  try {
    return { sig, obs: await observer.observe(entered) };
  } catch {
    return null;
  }
}

export function makeShadowCountPort(observer: ShadowObserver): ShadowCountPort {
  return {
    async count(rec): Promise<ShadowCounts | null> {
      const o = await observeFor(observer, rec);
      return o === null ? null : countShadow(o.sig, o.obs);
    },
  };
}

export function makeReadySinceRecovery(observer: ShadowObserver): ReadySinceRecovery {
  return {
    async recover(rec): Promise<string | null> {
      const o = await observeFor(observer, rec);
      return o === null ? null : firstReadyDay(o.sig, o.obs);
    },
  };
}

export function withShadowCounts(base: FactsProvider, counts: ShadowCountPort): FactsProvider {
  return {
    gateFacts: (rec, wc) => base.gateFacts(rec, wc),
    async promoteFacts(rec, wc) {
      const pf = await base.promoteFacts(rec, wc);
      if (pf === null) return null;
      const c = await counts.count(rec);
      if (c === null) return null;
      return { ...pf, sessions: c.sessions, hits: c.hits };
    },
  };
}

/** 纯函数:把计数写进工作副本的 shadow 段(其余字段原样) */
export function withCounts(wc: CandidateWorkingCopy, c: ShadowCounts): CandidateWorkingCopy {
  return { ...wc, shadow: { ...wc.shadow, sessions: c.sessions, hits: c.hits } };
}

export interface SyncResult {
  updated: string[];
  unavailable: string[];
}

/** 调用方持 `rsi/lock`(工作副本的写入方)。只处理 `shadow` 的记录;计数不变的不写;事实不可得的不动 */
export async function syncShadowCounts(d: {
  working: WorkingStore;
  records: readonly PersonalLifecycleRecord[];
  counts: ShadowCountPort;
}): Promise<SyncResult> {
  const out: SyncResult = { updated: [], unavailable: [] };
  const byId = new Map((await d.working.list()).map((w) => [w.id, w]));
  for (const rec of d.records) {
    if (rec.lifecycle !== 'shadow') continue;
    const wc = byId.get(rec.id);
    if (wc === undefined) continue;
    const c = await d.counts.count(rec);
    if (c === null) {
      out.unavailable.push(rec.id);
      continue;
    }
    if (wc.shadow.sessions === c.sessions && wc.shadow.hits === c.hits) continue;
    await d.working.put(withCounts(wc, c));
    out.updated.push(rec.id);
  }
  return out;
}
