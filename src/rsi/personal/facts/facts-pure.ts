/**
 * `FactsProvider` 的**纯计算**部分(D1a;设计稿 v4 §2.1):输入全是已读出的数据,无 I/O、无时钟(时间由调用方给)。
 *  - {@link parseHead}:HEAD 原子文件 → `current_content_sha256` 与正文;
 *  - {@link evidenceItemsOf} / {@link evidenceValidOf}:证据条目(提案摘录 ↔ 信号库)与有效性;
 *  - {@link taintedOf}:来源 run 标记 ∨ 证据项目被排除 ∨ purge journal 在场;
 *  - {@link blacklistedOf}:未解除的黑名单项按 `fp_hmac` / `content_sha256` / `candidate_id` 精确匹配,近似指纹给了才匹配(`[]` 只精确);
 *  - {@link tombstonedOf} / {@link cooldownActiveOf}:墓碑与冷却(冷却到期用契约的 `cooldownActive` 谓词,不另写);
 *  - {@link currentClusterSignature}:证据信号不全时返回 `null`(无法重新派生,不用残缺信号凑一个)。
 */
import { parseAtom } from '../../../atoms/parse.js';
import type { Proposal } from '../../../contracts/proposal.js';
import type { RsiEffectsLedger } from '../../../contracts/rsi-store.js';
import { cooldownActive, utcDay } from '../../../contracts/rsi-store.js';
import type { Signal } from '../../../contracts/signal.js';
import { nearMatches, type NearHasher } from '../fp/near-algo.js';
import { deriveClusterSignature, rewriteOrigin, type StagedProposal } from '../candidate-source.js';
import { candidateId } from '../ids.js';
import type { ClusterSignature, EvidenceAttribution, GateEvidenceItem } from '../gate-types.js';
import type { HoldFacts } from './facts-ports.js';

export const holdFactsLegacy = (): HoldFacts => ({
  budget_high_legacy: 'unavailable',
  cost_high_legacy: 'unavailable',
});

export interface ParsedHead {
  sha256: string;
  /** `do\nwhy\nverify`(同 `buildDraft` 的指纹输入) */
  body: string;
}

export function parseHead(text: string, relPath: string): ParsedHead | null {
  const a = parseAtom(text, relPath).atom;
  if (a === undefined) return null;
  return { sha256: a.sha256, body: `${a.body.do}\n${a.body.why}\n${a.body.verify}` };
}

/**
 * 暂存提案的**规则文件**是否就是权威记录创建时的那一份(**不含证据列表**,见 `facts-provider.ts` 的已知缺口):按 `buildDraft` 同口径(改写 origin → 解析 → 正文 sha256)重算候选 id 与 content_sha256,
 * 与记录的**不可变**字段比较。不依赖信号与指纹(所以 `promoteFacts` 也能用);解析不了 = 不匹配。
 */
export function stagedMatchesRecord(
  sp: StagedProposal,
  rec: { id: string; content_sha256: string },
): boolean {
  const content = rewriteOrigin(sp.ruleText);
  if (content === undefined) return false;
  const stored = parseAtom(content, 'personal/candidate.md').atom;
  if (stored === undefined) return false;
  return (
    stored.sha256 === rec.content_sha256 &&
    candidateId(sp.runId, sp.proposal.id, stored.sha256) === rec.id
  );
}

export interface SignalVerdict {
  excluded: boolean;
  attribution: EvidenceAttribution;
}

export function evidenceItemsOf(
  proposal: Pick<Proposal, 'evidence'>,
  signals: readonly Signal[],
  verdictOf: (s: Signal) => SignalVerdict,
): GateEvidenceItem[] {
  const bySig = new Map(signals.map((s) => [s.sig_id, s]));
  return proposal.evidence.map((e) => {
    const s = bySig.get(e.sig);
    if (s === undefined) return { sig: e.sig, excerpt: e.excerpt, signal: null };
    const v = verdictOf(s);
    return {
      sig: e.sig,
      excerpt: e.excerpt,
      signal: {
        excerpt: s.excerpt_redacted,
        sessionRef: s.session_ref,
        day: utcDay(s.ts),
        excluded: v.excluded,
        attribution: v.attribution,
      },
    };
  });
}

/** 全部证据:信号在库、摘录逐字一致、项目未被排除、归属已知。空列表 = 无效 */
export function evidenceValidOf(items: readonly GateEvidenceItem[]): boolean {
  return (
    items.length > 0 &&
    items.every(
      (e) =>
        e.signal !== null &&
        !e.signal.excluded &&
        e.signal.attribution !== 'unknown' &&
        e.excerpt === e.signal.excerpt,
    )
  );
}

export function taintedOf(i: {
  runTainted: boolean;
  anyEvidenceExcluded: boolean;
  purgeJournalPresent: boolean;
}): boolean {
  return i.runTainted || i.anyEvidenceExcluded || i.purgeJournalPresent;
}

export function currentClusterSignature(
  proposal: Pick<Proposal, 'evidence'>,
  signals: readonly Signal[],
): ClusterSignature | null {
  const have = new Set(signals.map((s) => s.sig_id));
  if (!proposal.evidence.every((e) => have.has(e.sig))) return null;
  const want = new Set(proposal.evidence.map((e) => e.sig));
  return deriveClusterSignature(signals.filter((s) => want.has(s.sig_id)));
}

export const tombstonedOf = (ledger: RsiEffectsLedger, id: string): boolean =>
  ledger.tombstones.some((t) => t.id === id);

export const cooldownActiveOf = (
  ledger: RsiEffectsLedger,
  clusterId: string,
  now: Date,
): boolean => {
  const today = now.toISOString().slice(0, 10);
  return ledger.cooldowns.some((c) => c.cluster_id === clusterId && cooldownActive(c, today));
};

export function blacklistedOf(
  ledger: RsiEffectsLedger,
  target: { id: string; content_sha256: string; fp_hmac: string; text: string },
  near: { hasher: NearHasher; threshold: number } | undefined,
): boolean {
  let cand: ReadonlySet<string> | undefined;
  for (const item of ledger.blacklist) {
    if (item.lifted_gen !== undefined) continue;
    if (
      item.candidate_id === target.id ||
      item.content_sha256 === target.content_sha256 ||
      item.fp_hmac === target.fp_hmac
    ) {
      return true;
    }
    if (near !== undefined && item.near_fp.length > 0) {
      cand ??= near.hasher.hashes(target.text);
      if (nearMatches(item.near_fp, cand, near.threshold)) return true;
    }
  }
  return false;
}
