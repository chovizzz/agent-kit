/**
 * `FactsProvider` 的组合层(D1a):在窄只读端口之上,用 `facts-pure.ts` 的纯计算拼出 `gateFacts` / `promoteFacts`,另给 `holdFacts()`。
 * 失败语义(同 `shadow-facts.ts`):任一端口读失败 / 来源提案已不在暂存 / 草稿与记录对不上 / **工作副本与权威记录的 id、来源不一致 / 暂存规则文件已不是创建时那份 / 信号端口混入未请求的信号** → **整体 `null`**(步骤据此 fail-closed:
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
  stagedMatchesRecord,
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

  /**
   * 事实主体的唯一来源:**权威记录**的 `source_proposal`(创建时写入、不可变)。工作副本只是缓存,必须与记录逐项一致,
   * 否则整体 `null`(不让工作副本选择安全事实的主体)。同时核对:暂存区里恰好一份匹配、它的**规则文件**仍是创建时的那份(id / content_sha256)、
   * 信号端口只返回被请求的 sig(不得混入别的提案的证据)。
   * **已知缺口(如实,须 owner 拍板)**:提案的**证据列表**(`proposal.evidence`)不在候选 id / content_sha256 里,权威记录也没存它的摘要(只有 `cluster_signature`),
   * 所以「规则文件不变、仅把暂存提案的证据换成另一份且聚类签名相同」在 D1a 无法识别。彻底堵上需要创建时在记录里持久化证据摘要(记录 schema 加法 = 契约变更),不在 D1a 范围。
   */
  async function source(
    rec: PersonalLifecycleRecord,
    wc: CandidateWorkingCopy,
  ): Promise<{ sp: StagedProposal; signals: Signal[]; runId: string } | null> {
    const auth = rec.source_proposal;
    if (auth === null || auth === undefined) return null;
    if (wc.id !== rec.id) return null;
    if (wc.source.run_id !== auth.run_id || wc.source.proposal_id !== auth.proposal_id) return null;
    return guarded(async () => {
      const hits = (await r.staged.list()).filter(
        (s) => s.runId === auth.run_id && s.proposal.id === auth.proposal_id,
      );
      const sp = hits[0];
      if (hits.length !== 1 || sp === undefined) return null;
      if (!stagedMatchesRecord(sp, rec)) return null;
      const asked = sp.proposal.evidence.map((e) => e.sig);
      const signals = await r.signals.getMany(asked);
      const allowed = new Set(asked);
      const seen = new Set<string>();
      for (const s of signals) {
        if (!allowed.has(s.sig_id) || seen.has(s.sig_id)) return null;
        seen.add(s.sig_id);
      }
      return { sp, signals, runId: auth.run_id };
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
    const src = await source(rec, wc);
    if (src === null) return null;
    // 草稿构建会调用注入的 fingerprint(可能抛错 / 返回非法值):同属读失败,一并受 guarded 保护(锁丢失仍原样抛)
    return guarded(async () => {
      const dr = buildDraft(src.sp, src.signals, { fingerprint: d.fingerprint });
      if (dr.kind !== 'draft') return null;
      const draft: CandidateDraft = dr.draft;
      if (draft.id !== rec.id || draft.contentSha256 !== rec.content_sha256) return null;
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
    const src = await source(rec, wc);
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
      const runTainted = await r.taint.runTainted(src.runId);
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
