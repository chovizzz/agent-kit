/**
 * N4(docs/contracts.md §20.18)的内存提案构造器:vendorEvidence / checkC5 / judgeChecks 的参数化对拍共用。
 * 全部合成数据;binding 用生产同一函数算出(`judge-binding.ts`),所以「有效确认」的夹具就是真有效。
 */
import {
  ProposalSchema,
  type Proposal,
  type SessionConfirmedJudgeRecord,
  type SpawnedJudgeRecord,
} from '../../src/contracts/proposal.js';
import { judgeBindingSha256, reflectorBindingFor } from '../../src/contracts/judge-binding.js';

export const H = (n: number): string => n.toString(16).padStart(64, '0');
export const RULE_SHA = H(7);

const ACCEPTANCE = {
  schema_version: 1,
  method: 'signature_proxy_v1',
  rule_sha256: RULE_SHA,
  signature_sha256: H(8),
  guidance_until: '2026-10-14T03:12:00Z',
  baseline_sha256: H(10),
  judged_at_head: '0123456789abcdef0123456789abcdef01234567',
  frozen_at: '2026-10-14T05:40:00Z',
  anchor_min: '2026-10-15',
  tile_days: 7,
  max_tiles: 4,
  sha256: H(9),
} as const;

const PREDICTION = {
  schema_version: 1,
  metric: 'exposure_rate',
  status: 'baseline_insufficient',
  acceptance_sha256: H(9),
} as const;

/** spawned 反思器 = anthropic / claude(可复算),无 judge */
export function baseProposal(): Proposal {
  return ProposalSchema.parse({
    id: '2026-10-12-001',
    op: 'add',
    targets: ['a-rule'],
    layer: 'team',
    rationale: 'r',
    evidence: [{ sig: 'sig_0123456789abcdef', project_key: 'p_fedcba9876543210', excerpt: 'e' }],
    budget_delta_bytes: 10,
    paired_retirements: [],
    cases: [],
    reflector: {
      provider: 'anthropic',
      vendor: 'anthropic',
      model: 'claude-example',
      run_id: 'run-0001',
      backend: 'claude',
      input_digest: `sha256:${H(5)}`,
    },
  });
}

/** A4 写出的 session_declared 形状(provider=session、model=undeclared、vendor=unknown) */
export function sessionDeclared(backend: 'claude' | 'codex' | 'pi' = 'claude'): Proposal {
  const p = baseProposal();
  return ProposalSchema.parse({
    ...p,
    reflector: {
      ...p.reflector,
      provider: 'session',
      vendor: 'unknown',
      model: 'undeclared',
      backend,
      provenance: 'session_declared',
    },
  });
}

export function withReflectorConfirmed(
  p: Proposal,
  c: { vendor: string; model: string },
  tamper: (binding: string) => string = (b) => b,
): Proposal {
  const base = {
    vendor: c.vendor,
    model: c.model,
    method: 'tty_typed_vendor' as const,
    confirmed_at: '2026-10-14T05:41:00Z',
    kit_version: '0.2.0',
  };
  const binding = tamper(reflectorBindingFor(p, base));
  return ProposalSchema.parse({
    ...p,
    reflector: { ...p.reflector, confirmed: { ...base, binding_sha256: binding } },
  });
}

export function withSpawnedJudge(
  p: Proposal,
  j: {
    vendor?: string;
    model?: string;
    verdict?: 'accept' | 'revise' | 'reject';
    hopResult?: string;
    provider?: string;
  } = {},
): Proposal {
  const vendor = j.vendor ?? 'openai';
  const model = j.model ?? 'gpt-example';
  const rec: SpawnedJudgeRecord = {
    provenance: 'spawned',
    hops: [{ hop: 'codex', vendor, model, result: j.hopResult ?? 'ok' }],
    provider: j.provider ?? 'codex',
    vendor,
    verdict: j.verdict ?? 'accept',
    overfit_risk: 'low',
    injection_suspected: false,
    conflicts: [],
    rule_sha256: RULE_SHA,
  };
  return ProposalSchema.parse({ ...p, judge: rec });
}

export function withSessionJudge(
  p: Proposal,
  j: {
    agent?: 'claude' | 'codex' | 'pi';
    vendor?: string;
    model?: string;
    verdict?: 'accept' | 'revise' | 'reject';
    injection?: boolean;
    /** 绑定评审的规则哈希(缺省 RULE_SHA);e2e 世界里要等于当前规则文本的哈希 */
    ruleSha?: string;
    tamper?: (r: SessionConfirmedJudgeRecord) => SessionConfirmedJudgeRecord;
  } = {},
): Proposal {
  const draft: SessionConfirmedJudgeRecord = {
    provenance: 'session_confirmed',
    verdict: j.verdict ?? 'accept',
    overfit_risk: 'low',
    injection_suspected: j.injection ?? false,
    conflicts: [],
    rule_sha256: j.ruleSha ?? RULE_SHA,
    prediction: PREDICTION,
    acceptance: { ...ACCEPTANCE, rule_sha256: j.ruleSha ?? RULE_SHA },
    declared: {
      agent: j.agent ?? 'codex',
      vendor: j.vendor ?? 'openai',
      model: j.model ?? 'gpt-example',
    },
    confirmation: {
      method: 'tty_typed_vendor',
      confirmed_at: '2026-10-14T05:41:00Z',
      kit_version: '0.2.0',
      payload_sha256: H(11),
      binding_sha256: H(0),
    },
  };
  const bound: SessionConfirmedJudgeRecord = {
    ...draft,
    confirmation: { ...draft.confirmation, binding_sha256: judgeBindingSha256(p, draft) },
  };
  return ProposalSchema.parse({ ...p, judge: (j.tamper ?? ((r) => r))(bound) });
}
