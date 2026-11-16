/**
 * §21 V1 装配块 C1a——污染扫描的**类型**(C v1 §6;冻结):`TaintCandidate` / `TaintScanner` / `TaintScanResult`。只有类型,实现归 C2。
 * 扫描器**只读**、不写任何文件;事实源 = 暂存 run 的 `TAINTED` 标记 ∪ `purge-journal.json` 的 `taint_targets`。
 * 缺失 / 损坏一律 fail-closed:来源缺失(`source` 为 null / undefined)、run 目录不存在、标记读不出 → 逐候选 `unknown`,**不写 tainted 凭据**(无法断言被污染),
 * 但拒绝增影响(`source_unknown`);`unknown` 且 canary:只停注入、不转移,等 clear / veto / 90 日到期。
 */
import type { RsiLifecycleState } from '../../../contracts/rsi.js';
import type { BothRound } from './round.js';

export interface TaintCandidate {
  readonly id: string;
  readonly content_sha256: string;
  readonly lifecycle: RsiLifecycleState;
  /** `source_proposal`:null / undefined = 来源缺失(V1 创建路径恒写来源,缺失是异常) */
  readonly source: { readonly run_id: string; readonly proposal_id: string } | null | undefined;
}

export const TAINT_UNKNOWN_WHY = Object.freeze([
  'source_missing',
  'run_dir_missing',
  'mark_unreadable',
] as const);
export type TaintUnknownWhy = (typeof TAINT_UNKNOWN_WHY)[number];

export const TAINT_UNAVAILABLE_WHY = Object.freeze([
  'journal_invalid',
  'journal_unreadable',
  'staging_too_large',
  'rsi_dir_untrusted',
] as const);
export type TaintUnavailableWhy = (typeof TAINT_UNAVAILABLE_WHY)[number];

export type TaintScanResult =
  | {
      readonly kind: 'ok';
      readonly tainted: readonly TaintCandidate[];
      readonly unknown: readonly { readonly id: string; readonly why: TaintUnknownWhy }[];
    }
  | { readonly kind: 'unavailable'; readonly why: TaintUnavailableWhy };

export interface TaintScanner {
  /** 只读;每个方法必收 `round`(无参缓存读法不存在) */
  scan(round: BothRound, cands: readonly TaintCandidate[]): Promise<TaintScanResult>;
}
