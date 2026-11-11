/**
 * `canary.json` 的语义校验与注入文本渲染(docs/contracts.md R21-6.3 / R21-6.10)。**纯函数、无 I/O**:hint(读侧)与 worker 写入方(写侧)共用同一份判据,
 * 所以「写得出来的一定读得进去、读不进去的一定写不出来」。
 *
 * schema(`CanaryDocSchema`)只管形状;下面这些是跨字段的语义约束,schema 表达不了:
 *  - `content_sha12` 必须是 `content_sha256` 的前 12 位;
 *  - `agents_inject` 升序不重复,且每个在列的 agent 都有 `0 < p ≤ 1` 的 `p_by_agent` 项;`p_by_agent` 不得有不在 `agents_inject` 里的项(多余的概率项是不一致的缓存);
 *  - `body` 不得含 `RSI_MARK_PREFIX`(否则 reader 会把正文里的那一行当成又一个注入块,R21-6.9);
 *  - treat 组完整输出(标记行 + 标签行 + 哈希行 + 正文 + 末尾换行)≤ `RSI_CANARY_INJECT_MAX_BYTES`(M11)。**按最长的标记行**估算:标记行长度固定,
 *    所以这里用真实形状的占位标记算,不会出现「写入时过、输出时超」。
 */
import {
  RSI_AUTO_LABEL,
  RSI_CANARY_INJECT_MAX_BYTES,
  RSI_MARK_PREFIX,
} from '../../contracts/rsi.js';
import type { CanaryDoc } from '../../contracts/rsi-personal.js';
import { sha12Of } from './files.js';

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/** R21-6.3:一行 `RSI_MARK_PREFIX` + 空格 + 随机会话标记 */
export const markerLine = (marker: string): string => `${RSI_MARK_PREFIX} ${marker}`;

/** control 组输出:只有标记行(末尾换行) */
export const controlText = (marker: string): string => `${markerLine(marker)}\n`;

/** treat 组输出:标记行、R21-1.9 标签行、候选内容哈希前 12 位一行、候选正文(末尾换行) */
export function treatText(marker: string, doc: Pick<CanaryDoc, 'content_sha12' | 'body'>): string {
  const body = doc.body.endsWith('\n') ? doc.body.slice(0, -1) : doc.body;
  return `${markerLine(marker)}\n${RSI_AUTO_LABEL}\n${doc.content_sha12}\n${body}\n`;
}

const PLACEHOLDER_MARKER = 'rsm_0000000000000000';

/** 返回 `null` = 语义上可用;否则是第一个问题的短码(不含正文) */
export function canaryDocProblem(doc: CanaryDoc): string | null {
  if (doc.content_sha12 !== sha12Of(doc.content_sha256)) return 'sha12_mismatch';
  const inj = doc.agents_inject;
  if (!inj.every((a, i) => i === 0 || (inj[i - 1] as string) < a)) return 'agents_not_sorted';
  for (const a of inj) {
    const p = doc.p_by_agent[a];
    if (p === undefined || !(p > 0)) return 'p_missing';
  }
  for (const a of ['claude', 'pi'] as const) {
    if (doc.p_by_agent[a] !== undefined && !inj.includes(a)) return 'p_without_inject';
  }
  if (doc.body.includes(RSI_MARK_PREFIX)) return 'body_has_marker_prefix';
  if (byteLen(treatText(PLACEHOLDER_MARKER, doc)) > RSI_CANARY_INJECT_MAX_BYTES) {
    return 'treat_over_budget';
  }
  return null;
}
