/**
 * 相似度去重(非 LLM,确定性)。比较对象:已有原子 ∪ 暂存区 ∪ 同批先出现的提案。
 *
 * 判重条件(任一成立):
 *  1. do+why 的 token Jaccard ≥ jaccard(默认 0.6);
 *  2. 仅 do 的 token Jaccard ≥ jaccard;
 *  3. do+why 的包含系数 ≥ containment(默认 0.9)且较小集合 ≥ minTokens(默认 6)——抵抗往里「塞词」稀释 Jaccard;
 *  4. signature(type + pattern 归一后)与对方完全相同。
 * 阈值依据:token = ASCII 词 + CJK 二元组,同一规则换说法后常见 Jaccard 0.4–0.7,而无关规则通常 <0.25;
 * 0.6 取保守侧(宁可漏判不误杀);漏判由 judge 与人工评审兜底。中英互译、纯同义改写本方法抓不到(已知边界)。
 * 与已退役(retired/deprecated)原子相似时同样判重,并标 resurrects——退役的规则不能当新规则放行。
 */
import { jaccard, containment, tokenSet } from './text.js';

/** signature 的比较形:NFKC + 去首尾空白,**不**小写(正则里 \\W 与 \\w 含义相反)。 */
const sigNorm = (p: string): string => p.normalize('NFKC').trim();

export interface DedupeThresholds {
  jaccard: number;
  containment: number;
  minTokens: number;
}
export const DEFAULT_DEDUPE: DedupeThresholds = { jaccard: 0.6, containment: 0.9, minTokens: 6 };

export interface DedupeTarget {
  id: string;
  do: string;
  why: string;
  status?: string | undefined;
  signature?: { type: string; pattern: string | undefined } | undefined;
}

export interface DuplicateHit {
  duplicateOf: string;
  reason: 'jaccard' | 'do_jaccard' | 'containment' | 'signature';
  resurrects: boolean;
}

const RETIRED = new Set(['retired', 'deprecated']);

export function findDuplicate(
  draft: DedupeTarget,
  targets: readonly DedupeTarget[],
  th: DedupeThresholds = DEFAULT_DEDUPE,
): DuplicateHit | undefined {
  const full = tokenSet(`${draft.do} ${draft.why}`);
  const doOnly = tokenSet(draft.do);
  const sigKey =
    draft.signature?.pattern === undefined
      ? undefined
      : `${draft.signature.type}\0${sigNorm(draft.signature.pattern)}`;
  for (const t of targets) {
    const hit = (reason: DuplicateHit['reason']): DuplicateHit => ({
      duplicateOf: t.id,
      reason,
      resurrects: t.status !== undefined && RETIRED.has(t.status),
    });
    if (sigKey !== undefined && t.signature?.pattern !== undefined) {
      if (sigKey === `${t.signature.type}\0${sigNorm(t.signature.pattern)}`) {
        return hit('signature');
      }
    }
    const tFull = tokenSet(`${t.do} ${t.why}`);
    if (jaccard(full, tFull) >= th.jaccard) return hit('jaccard');
    if (jaccard(doOnly, tokenSet(t.do)) >= th.jaccard) return hit('do_jaccard');
    if (
      Math.min(full.size, tFull.size) >= th.minTokens &&
      containment(full, tFull) >= th.containment
    ) {
      return hit('containment');
    }
  }
  return undefined;
}
