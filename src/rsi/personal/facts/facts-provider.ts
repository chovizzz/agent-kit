/**
 * `FactsProvider` 的组合层(D1a):在窄只读端口之上,用 `facts-pure.ts` 的纯计算拼出 `gateFacts` / `promoteFacts`,另给 `holdFacts()`。
 * 失败语义(同 `shadow-facts.ts`):任一端口读失败 / 来源提案已不在暂存 / 草稿与记录对不上 → **整体 `null`**(步骤据此 fail-closed:
 * 闸走 internal、推进清零排队),从不当作「干净」;**锁丢失(`RsiLockError`)原样传播**,不映射为 `null`。
 * `promoteFacts` 的 `sessions` / `hits` 恒 0(计数由 `withShadowCounts` 装饰器覆盖;未装饰时 0 会话 = 不推进)。
 * `clusterBusy` / `slot_occupied` 不在这里(锁内由步骤自己算,M13-4)。
 */
import { RsiLockError } from '../../lock-error.js';
import { assertNearThreshold } from '../fp/near-algo.js';
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
} from '../../../contracts/rsi-personal.js';
import type { Signal } from '../../../contracts/signal.js';
import { buildDraft, type StagedProposal } from '../candidate-source.js';
import type { CandidateDraft, GateFacts } from '../gate-types.js';
import type { PromoteBase } from '../transition-table.js';
import {
  blacklistedOf,
  cooldownActiveOf,
  currentClusterSignature,
  evidenceItemsOf,
  evidenceValidOf,
  holdFactsLegacy,
  parseHead,
  taintedOf,
  tombstonedOf,
  type SignalVerdict,
} from './facts-pure.js';
import type { FactsProviderD1a, FactsProviderDeps } from './facts-ports.js';

type GateOut = Omit<GateFacts, 'clusterBusy'>;
type PromoteOut = Omit<PromoteBase, 'slot_occupied'>;

/** 读失败 → `null`;锁丢失原样抛 */
async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RsiLockError) throw e;
    return null;
  }
}

export function makeFactsProvider(d: FactsProviderDeps): FactsProviderD1a {
  // 阈值是显式参数:构造时校验,畸形配置不能被读失败的 null 吞掉,也不能变成「全命中 / 全不命中」
  if (d.near !== undefined) assertNearThreshold(d.near.threshold);
  const r = d.readers;

  async function source(
    wc: CandidateWorkingCopy,
  ): Promise<{ sp: StagedProposal; signals: Signal[] } | null> {
    return guarded(async () => {
      const sp = (await r.staged.list()).find(
        (s) => s.runId === wc.source.run_id && s.proposal.id === wc.source.proposal_id,
      );
      if (sp === undefined) return null;
      const signals = await r.signals.getMany(sp.proposal.evidence.map((e) => e.sig));
      return { sp, signals };
    });
  }

  async function verdicts(signals: readonly Signal[]): Promise<(s: Signal) => SignalVerdict> {
    const m = new Map<string, SignalVerdict>();
    for (const s of signals) m.set(s.sig_id, await r.classifier.classify(s));
    // 分类结果里没有的信号(不可能:上面逐个分类过)按「被排除 + 归属未知」处理,不会放行
    return (s) => m.get(s.sig_id) ?? { excluded: true, attribution: 'unknown' };
  }

  async function gateFacts(
    rec: PersonalLifecycleRecord,
    wc: CandidateWorkingCopy,
  ): Promise<GateOut | null> {
    const src = await source(wc);
    if (src === null) return null;
    const dr = buildDraft(src.sp, src.signals, { fingerprint: d.fingerprint });
    if (dr.kind !== 'draft') return null;
    const draft: CandidateDraft = dr.draft;
    if (draft.id !== rec.id || draft.contentSha256 !== rec.content_sha256) return null;
    return guarded(async () => {
      const verdictOf = await verdicts(src.signals);
      const trigger = draft.atom.fm.trigger;
      const ledger = await r.ledger.read();
      return {
        draft,
        evidence: evidenceItemsOf(src.sp.proposal, src.signals, verdictOf),
        failureTriggerHits:
          draft.category === 'pitfall' && trigger !== undefined
            ? await r.context.failureTriggerHits(trigger)
            : 0,
        pass2Clean: await r.context.pass2Clean(draft.content),
        existing: { ...(await r.context.existing()), presets: await r.presets.presets() },
        tombstoned: tombstonedOf(ledger, draft.id),
        cooldownActive: cooldownActiveOf(ledger, draft.clusterId, d.now()),
        budget: await r.context.budget(draft),
        replay: await r.context.replay(draft.clusterSignature),
      };
    });
  }

  async function promoteFacts(
    rec: PersonalLifecycleRecord,
    wc: CandidateWorkingCopy,
  ): Promise<PromoteOut | null> {
    const src = await source(wc);
    if (src === null) return null;
    return guarded(async () => {
      const relPath = rec.target_paths[0];
      if (relPath === undefined) return null;
      const headText = await r.head.read(rec);
      if (headText === null) return null;
      const head = parseHead(headText, relPath);
      if (head === null) return null;
      const policy = await r.policy.read();
      const verdictOf = await verdicts(src.signals);
      const items = evidenceItemsOf(src.sp.proposal, src.signals, verdictOf);
      const ledger = await r.ledger.read();
      const runTainted = await r.taint.runTainted(wc.source.run_id);
      const purgeJournalPresent = await r.taint.purgeJournalPresent();
      return {
        config_valid: policy.config_valid,
        enabled: policy.enabled,
        authorized: policy.authorized,
        tainted: taintedOf({
          runTainted,
          anyEvidenceExcluded: items.some((e) => e.signal?.excluded === true),
          purgeJournalPresent,
        }),
        cooldown_active: cooldownActiveOf(ledger, rec.cluster_id, d.now()),
        tombstoned: tombstonedOf(ledger, rec.id),
        blacklisted: blacklistedOf(
          ledger,
          {
            id: rec.id,
            content_sha256: head.sha256,
            fp_hmac: rec.fp_hmac,
            text: head.body,
          },
          d.near,
        ),
        evidence_valid: evidenceValidOf(items),
        sessions: 0,
        hits: 0,
        current_content_sha256: head.sha256,
        current_cluster_signature: currentClusterSignature(src.sp.proposal, src.signals),
      };
    });
  }

  return { gateFacts, promoteFacts, holdFacts: holdFactsLegacy };
}
