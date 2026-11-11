/**
 * 候选创建行 `(无) → proposed`(reason `ingested`)的记录构造(docs/contracts.md R21-4.1、R21-3.7 / 3.8、§21.24 W0-6 / W0-16「创建行归 W3」)。
 * **纯函数**:产出权威记录、私有仓库文件、工作副本;写入由 candidate-create.ts 经 W2 的提交底座完成。
 *
 * 创建行的 `from`:契约写「(无)」而 schema 要求 `from` 为非空字符串,这里取字面量 `'none'`(dim=lifecycle,与部署态 `none` 不会混淆);
 * 列入汇报「问题」节,由 W0 订正落定。`idem_key` 沿用 W1 的 `idemKey`(证据指纹 = `ingested:-:<run_id>/<proposal_id>`,不含时钟)。
 */
import {
  CandidateWorkingCopySchema,
  PersonalLifecycleRecordSchema,
  type CandidateWorkingCopy,
  type PersonalLifecycleRecord,
  type RsiAuditLine,
} from '../../contracts/rsi-personal.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { TreeFile } from './commit.js';
import type { CandidateDraft } from './gate-types.js';
import { idemKey } from './ids.js';
import { utcDay } from './transition-table.js';
import type { Signal } from '../../contracts/signal.js';

export const CREATION_FROM = 'none' as const;

/** 创建行的 `idem_key` */
export function creationIdemKey(d: Pick<CandidateDraft, 'id' | 'runId' | 'proposalId'>): string {
  return idemKey({
    id: d.id,
    dim: 'lifecycle',
    from: CREATION_FROM,
    to: 'proposed',
    evidence: `ingested:-:${d.runId}/${d.proposalId}`,
  });
}

/** 权威记录:`proposed`,全 none,签名与来源提案创建时写入、之后不可变 */
export function newRecord(
  d: CandidateDraft,
  now: string,
  overlapsPreset: boolean,
): PersonalLifecycleRecord {
  return PersonalLifecycleRecordSchema.parse({
    schema_version: 1,
    id: d.id,
    category: d.category,
    lifecycle: 'proposed',
    deploy: { claude: 'none', pi: 'none', codex: 'none' },
    watch: { claude: null, pi: null, codex: null },
    rollback: null,
    target_paths: [d.targetPath],
    content_sha256: d.contentSha256,
    fp_hmac: d.fpHmac,
    cluster_id: d.clusterId,
    case_set_sha256: null,
    blocked_from: null,
    transitions: [
      {
        dim: 'lifecycle',
        from: CREATION_FROM,
        to: 'proposed',
        at: now,
        reason: 'ingested',
        idem_key: creationIdemKey(d),
      },
    ],
    transitions_dropped: 0,
    terminal_reason: null,
    overlaps_preset: overlapsPreset,
    source_proposal: { run_id: d.runId, proposal_id: d.proposalId },
    cluster_signature: d.clusterSignature,
  });
}

/** 创建那次提交写入私有仓库的文件:权威记录 + 原子文件(canonical JSON,末尾一个换行) */
export function creationFiles(d: CandidateDraft, rec: PersonalLifecycleRecord): TreeFile[] {
  return [
    { path: `lifecycle/${d.id}.json`, content: canonicalJson(rec) },
    { path: d.targetPath, content: d.content },
  ];
}

/** 工作副本:shadow 计数清零;证据归属取草稿证据信号的会话与 UTC 日(去重、升序、≤ 256) */
export function newWorkingCopy(
  d: CandidateDraft,
  signals: readonly Signal[],
): CandidateWorkingCopy {
  const uniq = (xs: string[]): string[] => [...new Set(xs)].sort().slice(0, 256);
  return CandidateWorkingCopySchema.parse({
    schema_version: 1,
    id: d.id,
    cluster_signature: d.clusterSignature,
    source: { run_id: d.runId, proposal_id: d.proposalId },
    shadow: { sessions: 0, hits: 0, canary_ready_since: null, queued_since: null },
    evidence: {
      sessions: uniq(signals.map((s) => s.session_ref)),
      days: uniq(signals.map((s) => utcDay(s.ts))),
    },
    stats: { sessions_observed: 0, sessions_treat: 0, sessions_control: 0, bytes_injected: 0 },
    repo_removal_deferred: false,
  });
}

/** 缺工作副本时按权威记录重建(R21-3.8:权威副本领先 → 以权威为准续做);证据归属不可得,留空 */
export function rebuildWorkingCopy(rec: PersonalLifecycleRecord): CandidateWorkingCopy | null {
  const sp = rec.source_proposal;
  if (rec.cluster_signature === undefined || sp === null || sp === undefined) return null;
  return CandidateWorkingCopySchema.parse({
    schema_version: 1,
    id: rec.id,
    cluster_signature: rec.cluster_signature,
    source: { run_id: sp.run_id, proposal_id: sp.proposal_id },
    shadow: { sessions: 0, hits: 0, canary_ready_since: null, queued_since: null },
    evidence: { sessions: [], days: [] },
    stats: { sessions_observed: 0, sessions_treat: 0, sessions_control: 0, bytes_injected: 0 },
    repo_removal_deferred: false,
  });
}

export function creationAudit(rec: PersonalLifecycleRecord, now: string): RsiAuditLine {
  return {
    at: now,
    kind: 'transition',
    id: rec.id,
    dim: 'lifecycle',
    from: CREATION_FROM,
    to: 'proposed',
    reason: 'ingested',
  };
}
