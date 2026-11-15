/**
 * W9a(判官裁决读判定)测试夹具:个人层提案 + 两种裁决记录(`session_confirmed` 的 binding 与 `spawned` 的 `proven` 证据都由生产同一函数算出,「有效」夹具就是真有效)、
 * 注入环境、假读端口。全部合成数据。
 */
import { ProposalSchema, type Proposal } from '../../../src/contracts/proposal.js';
import { judgeEvidence } from '../../../src/contracts/vendor.js';
import { ruleSha256 } from '../../../src/lifecycle/rule-hash.js';
import type {
  JudgeEnv,
  JudgeSourceRead,
  ProposalJudgeSource,
} from '../../../src/rsi/personal/judge-signal.js';
import { baseProposal, withSessionJudge, withSpawnedJudge } from '../../contracts/n4-fixtures.js';

export const RUN = 'run-20261109-01';
export const PID = '2026-11-09-001';
export const TARGET = 'new-rule';
export const LINK = { run_id: RUN, proposal_id: PID } as const;

/** 规则文本:`status` / `review_by` 各恰一行(`ruleSha256` 的前提) */
export const RULE_TEXT = [
  '---',
  `id: ${TARGET}`,
  'layer: personal',
  'status: active',
  'review_by: 2027-01-01',
  '---',
  'do: x',
  '',
].join('\n');
export const RULE_SHA = ruleSha256(RULE_TEXT);

export const env: JudgeEnv = { ruleSha256, judgeEvidence: (p) => judgeEvidence(p) };

/** 未带裁决的个人层提案(id / run_id / targets 与 LINK 对齐) */
export function personalProposal(over: Record<string, unknown> = {}): Proposal {
  const b = baseProposal();
  return ProposalSchema.parse({
    ...b,
    id: PID,
    targets: [TARGET],
    layer: 'personal',
    reflector: { ...b.reflector, run_id: RUN },
    ...over,
  });
}

export interface JudgeOpts {
  verdict?: 'accept' | 'revise' | 'reject';
  injection?: boolean;
  ruleSha?: string;
}

/** `session_confirmed` 裁决(有效确认:binding 真实重算一致) */
export function sessionJudged(opts: JudgeOpts = {}, base: Proposal = personalProposal()): Proposal {
  return withSessionJudge(base, {
    ruleSha: opts.ruleSha ?? RULE_SHA,
    ...(opts.verdict === undefined ? {} : { verdict: opts.verdict }),
    ...(opts.injection === undefined ? {} : { injection: opts.injection }),
  });
}

/** `spawned` 且 `proven` 的裁决;`ruleSha: null` = 不带 `rule_sha256`(schema 允许缺失) */
export function spawnedJudged(
  opts: Omit<JudgeOpts, 'ruleSha'> & { ruleSha?: string | null; provider?: string } = {},
  base: Proposal = personalProposal(),
): Proposal {
  const p = withSpawnedJudge(base, {
    ...(opts.verdict === undefined ? {} : { verdict: opts.verdict }),
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
  });
  const judge: Record<string, unknown> = { ...(p.judge as unknown as Record<string, unknown>) };
  if (opts.ruleSha === null) delete judge['rule_sha256'];
  else judge['rule_sha256'] = opts.ruleSha ?? RULE_SHA;
  if (opts.injection !== undefined) judge['injection_suspected'] = opts.injection;
  return ProposalSchema.parse({ ...p, judge });
}

export const okRead = (
  proposal: unknown,
  rule: { target: string; text: string } | null = { target: TARGET, text: RULE_TEXT },
): JudgeSourceRead => ({ kind: 'ok', proposal, rule });

export interface FakeSource extends ProposalJudgeSource {
  calls: { runId: string; proposalId: string; signal: AbortSignal }[];
}

/** 假读端口:`reply` 决定每次 `read` 的返回(可抛、可挂起) */
export function fakeSource(
  reply: (signal: AbortSignal) => JudgeSourceRead | Promise<JudgeSourceRead> | unknown,
): FakeSource {
  const calls: FakeSource['calls'] = [];
  return {
    calls,
    async read(runId, proposalId, ctl) {
      calls.push({ runId, proposalId, signal: ctl.signal });
      return (await reply(ctl.signal)) as JudgeSourceRead;
    },
  };
}
