/**
 * lifecycle 检查库的测试夹具:全部合成数据。密钥样式串运行时拼装(源码里没有字面量)。
 * 原子 / 提案用对象直接构造(不过 parseAtom),这样才能构造出 schema 本来不允许的非法组合(如 strength=must + verifier=none)。
 */
import { createHash } from 'node:crypto';
import { addDays } from '../../src/atoms/dates.js';
import type { Atom } from '../../src/contracts/atom.js';
import { ProposalSchema, type Proposal } from '../../src/contracts/proposal.js';
import { ruleSha256, type SignalFact } from '../../src/lifecycle/checks.js';

export type AtomLike = Pick<Atom, 'fm' | 'body'>;

export const SIG1 = 'sig_0123456789abcdef';
export const SIG2 = 'sig_fedcba9876543210';
export const EXCERPT1 = '以后提交代码前必须先运行 lint 并修复全部告警再提交';
export const EXCERPT2 = '合并之前请确认 lint 已经全部通过且没有新增告警';
export const CREATED = '2026-10-12';
export const CANARY = 'CANARY_L1_5c1d';

export function fakeKey(tag = 'k1'): string {
  const h = (s: string) => createHash('sha256').update(s).digest('hex');
  return [
    'sk',
    'proj',
    Buffer.from(h(`${tag}-a`) + h(`${tag}-b`), 'hex')
      .toString('base64url')
      .slice(0, 48),
  ].join('-');
}

export function makeAtom(over: Record<string, unknown> = {}, body: Record<string, string> = {}) {
  const fm = {
    id: 'run-lint-before-commit',
    title: '提交前先跑 lint',
    layer: 'team',
    strength: 'should',
    applies_to: ['all'],
    kind: 'practice',
    volatility: 'stable',
    status: 'proposed',
    owner: '@tester',
    created: CREATED,
    review_by: addDays(CREATED, 90),
    evidence: [
      { type: 'trace', ref: SIG1, excerpt: EXCERPT1 },
      { type: 'trace', ref: SIG2, excerpt: EXCERPT2 },
    ],
    verifier: { type: 'none' },
    signature: { type: 'phrase', pattern: 'git commit' },
    origin: 'proposal/2026-10-12-001',
    ...over,
  } as unknown as Atom['fm'];
  return {
    fm,
    body: {
      do: '提交前先运行项目的 lint 并修复全部告警。',
      why: '带告警的提交会让评审与 CI 反复返工。',
      verify: '提交前的终端记录里能看到 lint 通过。',
      ...body,
    },
  } satisfies AtomLike;
}

/** 与 makeAtom 同内容的原子全文(C6 用);status / review_by 各一行。 */
export function atomText(a: AtomLike, over: { status?: string; review_by?: string } = {}): string {
  return [
    '---',
    `id: ${a.fm.id}`,
    `title: ${a.fm.title}`,
    `layer: ${a.fm.layer}`,
    `status: ${over.status ?? a.fm.status}`,
    `owner: '${a.fm.owner}'`,
    `created: ${a.fm.created}`,
    `review_by: ${over.review_by ?? a.fm.review_by}`,
    '---',
    '',
    `**做**:${a.body.do}`,
    `**为什么**:${a.body.why}`,
    `**怎么验**:${a.body.verify}`,
    '',
  ].join('\n');
}

export function makeProposal(over: Record<string, unknown> = {}): Proposal {
  const base = {
    id: '2026-10-12-001',
    op: 'add',
    targets: ['run-lint-before-commit'],
    layer: 'team',
    rationale: '多个项目的用户都要求提交前先跑 lint。',
    evidence: [
      { sig: SIG1, project_key: 'proj-a', excerpt: EXCERPT1 },
      { sig: SIG2, project_key: 'proj-b', excerpt: EXCERPT2 },
    ],
    budget_delta_bytes: 100,
    paired_retirements: [],
    cases: [],
    reflector: {
      provider: 'claude',
      vendor: 'anthropic',
      model: 'claude-opus-5',
      run_id: 'run-20261012T080000Z-abc123',
      backend: 'claude',
    },
    judge: {
      hops: [{ hop: 'codex', vendor: 'openai', model: 'gpt-6.1-sol', result: 'ok' }],
      provider: 'codex',
      vendor: 'openai',
      verdict: 'accept',
      overfit_risk: 'low',
      injection_suspected: false,
      conflicts: [],
    },
    ...over,
  };
  return ProposalSchema.parse(base);
}

/** 合法的一整套(原子 + 全文 + 绑定了当前哈希的提案)。 */
export function makeCase(
  over: {
    atom?: Record<string, unknown>;
    body?: Record<string, string>;
    proposal?: Record<string, unknown>;
    judge?: Record<string, unknown>;
  } = {},
) {
  const atom = makeAtom(over.atom, over.body);
  const text = atomText(atom);
  const baseJudge = {
    hops: [{ hop: 'codex', vendor: 'openai', model: 'gpt-6.1-sol', result: 'ok' }],
    provider: 'codex',
    vendor: 'openai',
    verdict: 'accept',
    overfit_risk: 'low',
    injection_suspected: false,
    conflicts: [],
    rule_sha256: ruleSha256(text),
    ...over.judge,
  };
  const proposal = makeProposal({ judge: baseJudge, ...over.proposal });
  return { atom, text, proposal };
}

export const SIGNALS: Readonly<Record<string, SignalFact & { session_ref: string }>> = {
  [SIG1]: {
    sig_id: SIG1,
    project_key: 'proj-a',
    excerpt_redacted: EXCERPT1,
    session_ref: 's_0000000000000001',
  },
  [SIG2]: {
    sig_id: SIG2,
    project_key: 'proj-b',
    excerpt_redacted: EXCERPT2,
    session_ref: 's_0000000000000002',
  },
};
export const lookup = (sig: string): SignalFact | undefined => SIGNALS[sig];
export const sessionRefOf = (sig: string): string | undefined => SIGNALS[sig]?.session_ref;
