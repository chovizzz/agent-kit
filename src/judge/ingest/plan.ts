/**
 * 把校验过的 payload(或 `--confirm-reflector` 的候选筛选)与 run 里读到的暂存提案对起来(R20-18.9 ⑥ / R20-18.11),得到一份只读的计划。
 * 不写任何东西。拒绝原因只有 {@link JudgeIngestReason} 的封闭子码;状态本身损坏抛 {@link JudgeStateError}(命令层映射 `state_invalid`)。
 */
import type { JudgeOutput } from '../../contracts/proposal.js';
import type { SessionConfirmedJudgeRecord } from '../../contracts/proposal.js';
import { outputRejectionReason, type JudgeIngestReason } from '../../contracts/judge-ingest.js';
import type { Redactor } from '../../contracts/redact.js';
import { reflectorEvidence, type VendorTier } from '../../contracts/vendor.js';
import { ruleSha256 } from '../../lifecycle/checks.js';
import { scanDangerousPhrases } from '../../reflect/validate.js';
import { JudgeStateError } from '../errors.js';
import { decidePredictionStatus, type FreezeStatus } from '../freeze.js';
import { parseJudgeOutput } from '../output.js';
import type { LoadedProposal } from '../store.js';
import type { PlanView } from './types.js';
import { collectStrings, hasHiddenChars, type ValidatedPayload } from './validate.js';

export type ExistingJudge =
  | { readonly kind: 'none' }
  | { readonly kind: 'spawned'; readonly vendor: string; readonly model: string }
  | { readonly kind: 'session_confirmed'; readonly record: SessionConfirmedJudgeRecord };

export interface PlanEntry {
  readonly id: string;
  readonly loaded: LoadedProposal;
  readonly layer: 'team' | 'personal';
  /** `ingest`:校验后的评审输出;`confirm_reflector`:无 */
  readonly output: JudgeOutput | undefined;
  readonly ruleSha: string;
  readonly status: FreezeStatus;
  readonly existing: ExistingJudge;
  readonly reflectorTier: VendorTier;
  readonly reflectorVendor: string;
  /** `layer = team` ∧ `reflector.provenance = session_declared` ∧ 无有效 `reflector.confirmed` */
  readonly needsReflectorConfirm: boolean;
}

export interface Plan {
  readonly mode: 'ingest' | 'confirm_reflector';
  readonly runId: string;
  /** 按提案 id 升序(写入顺序) */
  readonly entries: readonly PlanEntry[];
  readonly payload: ValidatedPayload | undefined;
  readonly replace: boolean;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly reason: JudgeIngestReason };

export interface PlanInput {
  readonly mode: 'ingest' | 'confirm_reflector';
  readonly runId: string;
  readonly loaded: readonly LoadedProposal[];
  readonly unsupported: readonly string[];
  readonly payload: ValidatedPayload | undefined;
  readonly replace: boolean;
  readonly proposalFilter: readonly string[];
  /** 仓库 + 本 run 里确实存在的原子 id(`conflicts` 必须落在其中) */
  readonly knownAtomIds: ReadonlySet<string>;
  readonly redactor: Pick<Redactor, 'pass2'>;
}

function existingOf(l: LoadedProposal): ExistingJudge {
  const j = l.proposal.judge;
  if (j === undefined) return { kind: 'none' };
  if (j.provenance === 'session_confirmed') return { kind: 'session_confirmed', record: j };
  const last = j.hops[j.hops.length - 1];
  return { kind: 'spawned', vendor: j.vendor, model: last?.model ?? '-' };
}

function entryOf(
  l: LoadedProposal,
  output: JudgeOutput | undefined,
  ruleSha: string,
  status: FreezeStatus,
): PlanEntry {
  const p = l.proposal;
  const side = reflectorEvidence(p).side;
  return {
    id: p.id,
    loaded: l,
    layer: p.layer === 'team' ? 'team' : 'personal',
    output,
    ruleSha,
    status,
    existing: existingOf(l),
    reflectorTier: side.tier,
    reflectorVendor: side.vendor,
    needsReflectorConfirm:
      p.layer === 'team' &&
      p.reflector.provenance === 'session_declared' &&
      side.tier !== 'self_confirmed',
  };
}

/** 同一 run 内的 `session_declared` 提案必属同一次会话(R20-18.6 第 3 步前提):`input_digest` 不止一种 → 拒一次覆盖 */
function sameSession(entries: readonly PlanEntry[]): boolean {
  const need = entries.filter((e) => e.needsReflectorConfirm);
  return new Set(need.map((e) => e.loaded.proposal.reflector.input_digest ?? '')).size <= 1;
}

export function buildPlan(i: PlanInput): PlanResult {
  const no = (reason: JudgeIngestReason): PlanResult => ({ ok: false, reason });
  const byId = new Map(i.loaded.map((l) => [l.proposal.id, l] as const));
  for (const l of i.loaded) {
    if (l.proposal.reflector.run_id !== i.runId) {
      throw new JudgeStateError('JUDGE_STATE_INVALID: 提案的 reflector.run_id 与 --run 不一致');
    }
  }

  if (i.mode === 'confirm_reflector') {
    const candidates = i.loaded.filter(
      (l) =>
        l.proposal.reflector.provenance === 'session_declared' &&
        reflectorEvidence(l.proposal).side.tier !== 'self_confirmed',
    );
    const wanted =
      i.proposalFilter.length === 0
        ? candidates.map((l) => l.proposal.id)
        : [...new Set(i.proposalFilter)];
    for (const id of wanted) {
      if (i.unsupported.includes(id)) return no('proposal_unsupported');
      if (!candidates.some((l) => l.proposal.id === id)) return no('proposal_unknown');
    }
    const entries = wanted
      .sort()
      .map((id) => {
        const l = byId.get(id) as LoadedProposal;
        return entryOf(
          l,
          undefined,
          safeRuleSha(l),
          decidePredictionStatus(l.rule.signature, l.guidance),
        );
      })
      // `--confirm-reflector` 不限层(用户显式指定要确认的提案):候选全部都要问
      .map((e) => ({ ...e, needsReflectorConfirm: true }));
    if (!sameSession(entries)) return no('schema_invalid');
    return {
      ok: true,
      plan: { mode: i.mode, runId: i.runId, entries, payload: undefined, replace: false },
    };
  }

  const payload = i.payload as ValidatedPayload;
  const declared = payload.payload.declared;
  const entries: PlanEntry[] = [];
  for (const v of payload.payload.verdicts) {
    const l = byId.get(v.id);
    if (l === undefined)
      return no(i.unsupported.includes(v.id) ? 'proposal_unsupported' : 'proposal_unknown');
    let sha: string;
    try {
      sha = ruleSha256(l.ruleText);
    } catch {
      return no('rule_hash_mismatch');
    }
    if (v.rule_sha256 !== sha) return no('rule_hash_mismatch');
    const ex = existingOf(l);
    if (ex.kind !== 'none' && !(i.replace && ex.kind === 'session_confirmed')) {
      return no('already_judged');
    }
    const status = decidePredictionStatus(l.rule.signature, l.guidance);
    const strings = collectStrings(v.output);
    if (strings.some((s) => s.includes('[[REDACTED'))) return no('placeholder_in_output');
    if (strings.some(hasHiddenChars)) return no('hidden_chars_in_output');
    if (strings.some((s) => scanDangerousPhrases(s).blocked.length > 0)) {
      return no('injection_suspected_local');
    }
    const parsed = parseJudgeOutput(JSON.stringify(v.output), i.redactor, {
      predictionRequired: status === 'predicted',
    });
    if (!parsed.ok) return no(outputRejectionReason(parsed.code));
    if (!parsed.value.conflicts.every((c) => i.knownAtomIds.has(c))) return no('conflicts_invalid');
    const entry = entryOf(l, parsed.value, sha, status);
    // 同厂商:声明的裁判厂商与反思器侧已有层级的厂商相同(反思器侧未知时在键入后再判)
    if (entry.reflectorTier !== 'none' && entry.reflectorVendor === declared.vendor) {
      return no('same_vendor');
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!sameSession(entries)) return no('schema_invalid');
  return { ok: true, plan: { mode: i.mode, runId: i.runId, entries, payload, replace: i.replace } };
}

function safeRuleSha(l: LoadedProposal): string {
  try {
    return ruleSha256(l.ruleText);
  } catch {
    return '';
  }
}

/** 计划的只读视图(干跑打印与确认屏共用) */
export function viewOf(plan: Plan): PlanView[] {
  return plan.entries.map((e) => ({
    id: e.id,
    layer: e.layer,
    verdict: e.output?.verdict ?? 'accept',
    overfit: e.output?.overfit_risk ?? 'low',
    injection: e.output?.injection_suspected ?? false,
    conflicts: e.output?.conflicts.length ?? 0,
    prediction: e.status === 'predicted' ? 'required' : 'not_required',
    needsReflectorConfirm: e.needsReflectorConfirm,
  }));
}
