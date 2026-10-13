// A21–A24 共用:生命周期(attest / promote / retire)合成夹具。全部合成数据,不碰真实信号库与真实 HOME。
// 对象由 dist 里的真模块构造(ProposalSchema.parse、ruleSha256),所以夹具与产品代码走同一套口径;
// 原子对象直接构造(不过 parseAtom),才能造出 schema 本来不允许的非法组合(如 strength=must + verifier=none)。
import { createHash } from 'node:crypto';
import { importDist } from './accept-p1.mjs';

export const SIG1 = 'sig_0123456789abcdef';
export const SIG2 = 'sig_fedcba9876543210';
export const EXCERPT1 = '以后提交代码前必须先运行 lint 并修复全部告警再提交';
export const EXCERPT2 = '合并之前请确认 lint 已经全部通过且没有新增告警';
export const CREATED = '2026-10-12';
export const CANARY = 'CANARY_A21_5c1d';

/** 运行时拼装的密钥样式串(源码里没有字面量,A10)。 */
export function fakeKey(tag = 'k1') {
  const h = (s) => createHash('sha256').update(s).digest('hex');
  return [
    'sk',
    'proj',
    Buffer.from(h(`${tag}-a`) + h(`${tag}-b`), 'hex')
      .toString('base64url')
      .slice(0, 48),
  ].join('-');
}

/** 加载夹具要用的 dist 模块。 */
export async function loadLifecycleMods(ctx) {
  return {
    checks: await importDist(ctx, 'lifecycle/checks.js'),
    proposal: await importDist(ctx, 'contracts/proposal.js'),
    dates: await importDist(ctx, 'atoms/dates.js'),
    redact: await importDist(ctx, 'redact/index.js'),
  };
}

export function makeFixtures(mods) {
  const { addDays } = mods.dates;
  const { ruleSha256 } = mods.checks;

  const makeAtom = (over = {}, body = {}) => ({
    fm: {
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
    },
    body: {
      do: '提交前先运行项目的 lint 并修复全部告警。',
      why: '带告警的提交会让评审与 CI 反复返工。',
      verify: '提交前的终端记录里能看到 lint 通过。',
      ...body,
    },
  });

  /** 与 makeAtom 同内容的原子全文(C6 用);status / review_by 各一行 */
  const atomText = (a, over = {}) =>
    [
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

  const goodJudge = () => ({
    hops: [{ hop: 'codex', vendor: 'openai', model: 'gpt-6.1-sol', result: 'ok' }],
    provider: 'codex',
    vendor: 'openai',
    verdict: 'accept',
    overfit_risk: 'low',
    injection_suspected: false,
    conflicts: [],
  });

  const makeProposal = (over = {}) =>
    mods.proposal.ProposalSchema.parse({
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
      judge: goodJudge(),
      ...over,
    });

  /** 合法的一整套(原子 + 全文 + 绑定了当前规则哈希的提案) */
  const makeCase = (over = {}) => {
    const atom = makeAtom(over.atom, over.body);
    const text = atomText(atom);
    const judge = { ...goodJudge(), rule_sha256: ruleSha256(text), ...over.judge };
    const proposal = makeProposal({ judge, ...over.proposal });
    return { atom, text, proposal };
  };

  const SIGNALS = {
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
  const lookup = (sig) => SIGNALS[sig];
  const sessionRefOf = (sig) => SIGNALS[sig]?.session_ref;

  return { makeAtom, atomText, makeProposal, makeCase, goodJudge, lookup, sessionRefOf, SIGNALS };
}
