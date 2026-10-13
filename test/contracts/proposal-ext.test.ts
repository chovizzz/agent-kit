import { describe, expect, it } from 'vitest';
import { ProposalSchema } from '../../src/contracts/index.js';

const baseProposal = {
  id: '2026-10-12-001',
  op: 'add',
  targets: ['a-rule'],
  layer: 'personal',
  rationale: 'r',
  evidence: [{ sig: 'sig_0123456789abcdef', project_key: 'p_fedcba9876543210', excerpt: 'e' }],
  budget_delta_bytes: 10,
  paired_retirements: [],
  cases: [],
  reflector: { provider: 'anthropic', vendor: 'anthropic', model: 'm', run_id: 'run-1' },
};
const hop = (h: string, vendor: string, result: string) => ({ hop: h, vendor, model: 'm', result });
const fullAttempts = [
  hop('codex', 'openai', 'error:429'),
  hop('maas-deepseek', 'deepseek', 'error:not_configured'),
  hop('glm', 'zhipu', 'skipped:cooldown'),
  hop('kimi', 'moonshot', 'error:403'),
  hop('official-deepseek', 'deepseek', 'error:402'),
];
const okJudge = {
  hops: [hop('codex', 'openai', 'ok')],
  provider: 'codex',
  vendor: 'openai',
  verdict: 'accept',
  overfit_risk: 'low',
  injection_suspected: false,
  conflicts: [],
};
const parse = (extra: Record<string, unknown>) =>
  ProposalSchema.safeParse({ ...baseProposal, ...extra });

describe('R0-3 Proposal.reflector 追加可选字段', () => {
  const sha = 'a'.repeat(64);
  it('旧提案(无新字段)仍通过', () => {
    expect(parse({}).success).toBe(true);
  });
  it('全部新字段合法值通过', () => {
    const r = parse({
      reflector: {
        ...baseProposal.reflector,
        backend: 'pi',
        prompt_id: 'reflect-v1',
        prompt_sha256: sha,
        input_digest: `sha256:${sha}`,
        kit_version: '0.1.0',
        stub: true,
      },
    });
    expect(r.success, JSON.stringify(r)).toBe(true);
  });
  it('非法值被拒:stub:false、坏哈希、坏 semver、坏 prompt_id', () => {
    const bad: Record<string, unknown>[] = [
      { stub: false },
      { stub: 'true' },
      { prompt_sha256: 'abc' },
      { prompt_sha256: 'A'.repeat(64) },
      { input_digest: sha },
      { input_digest: `sha256:${'g'.repeat(64)}` },
      { kit_version: '1.2' },
      { kit_version: 'v1.2.3' },
      { backend: 'http' },
      { prompt_id: '' },
      { prompt_id: 'has space' },
    ];
    for (const b of bad) {
      expect(
        parse({ reflector: { ...baseProposal.reflector, ...b } }).success,
        JSON.stringify(b),
      ).toBe(false);
    }
  });
  it('reflector 仍是 strictObject', () => {
    expect(parse({ reflector: { ...baseProposal.reflector, status: 'x' } }).success).toBe(false);
  });
});

describe('R0-3 Proposal.judge_attempts', () => {
  it('全链失败/跳过时可以记账(无 judge)', () => {
    expect(parse({ judge_attempts: fullAttempts }).success).toBe(true);
  });
  it('同厂商的跳记 skipped:same-vendor 通过;未配置槽位用哨兵 vendor=unknown model=-', () => {
    const r = parse({
      judge_attempts: [
        hop('codex', 'anthropic', 'skipped:same-vendor'),
        { hop: 'maas-deepseek', vendor: 'unknown', model: '-', result: 'error:not_configured' },
        hop('glm', 'zhipu', 'error:budget_exhausted'),
        hop('kimi', 'moonshot', 'error:budget_exhausted'),
        hop('official-deepseek', 'deepseek', 'error:budget_exhausted'),
      ],
    });
    expect(r.success, JSON.stringify(r)).toBe(true);
  });
  it('必须记满整条链:缺尾巴(没尝试的跳被藏起来)被拒', () => {
    expect(parse({ judge_attempts: fullAttempts }).success).toBe(true);
    for (let n = 1; n < fullAttempts.length; n++) {
      expect(parse({ judge_attempts: fullAttempts.slice(0, n) }).success, `n=${n}`).toBe(false);
    }
    expect(
      parse({ judge_attempts: [...fullAttempts, hop('codex', 'openai', 'error:1')] }).success,
    ).toBe(false);
  });
  it('judge 存在时不允许同时出现 judge_attempts', () => {
    // 用满链 attempts:这样除「judge 与 judge_attempts 并存」外没有别的规则会拒它
    const r = parse({ judge: okJudge, judge_attempts: fullAttempts });
    expect(parse({ judge_attempts: fullAttempts }).success).toBe(true);
    expect(r.success).toBe(false);
    // 正向控制:去掉 judge_attempts 同一份提案通过,证明失败确实由该字段引起
    expect(parse({ judge: okJudge }).success).toBe(true);
  });
  it('同厂商的跳必须是 skipped:same-vendor(大小写/空白不能绕过)', () => {
    for (const v of ['anthropic', 'Anthropic', 'ANTHROPIC', ' anthropic ']) {
      expect(
        parse({ judge_attempts: [hop('codex', v, 'error:429'), ...fullAttempts.slice(1)] }).success,
        JSON.stringify(v),
      ).toBe(false);
    }
    // 正向控制:同一位置记成 skipped:same-vendor 就通过
    expect(
      parse({
        judge_attempts: [
          hop('codex', 'Anthropic', 'skipped:same-vendor'),
          ...fullAttempts.slice(1),
        ],
      }).success,
    ).toBe(true);
  });
  it('厂商不同却写 skipped:same-vendor 也拒(记账不能说谎)', () => {
    expect(
      parse({
        judge_attempts: [hop('codex', 'openai', 'skipped:same-vendor'), ...fullAttempts.slice(1)],
      }).success,
    ).toBe(false);
  });
  it('不允许 ok(成功的一跳应写进 judge)', () => {
    expect(
      parse({ judge_attempts: [hop('codex', 'openai', 'ok'), ...fullAttempts.slice(1)] }).success,
    ).toBe(false);
  });
  it('hop 顺序必须等于兜底链、不能为空、结果枚举复用 HopResultSchema、strict', () => {
    const swap = [fullAttempts[1], fullAttempts[0], ...fullAttempts.slice(2)];
    expect(parse({ judge_attempts: [] }).success).toBe(false);
    expect(parse({ judge_attempts: swap }).success).toBe(false);
    const withResult = (r: string) => [hop('codex', 'openai', r), ...fullAttempts.slice(1)];
    expect(parse({ judge_attempts: withResult('skipped:known-unavailable') }).success).toBe(false);
    expect(parse({ judge_attempts: withResult('error:') }).success).toBe(false);
    expect(parse({ judge_attempts: withResult('error:429') }).success).toBe(true);
    expect(
      parse({ judge_attempts: [{ ...fullAttempts[0], extra: 1 }, ...fullAttempts.slice(1)] })
        .success,
    ).toBe(false);
  });
});

describe('既有 superRefine 保持', () => {
  it('裁判与反思器同厂商被拒;同厂商的跳不记 skipped:same-vendor 被拒', () => {
    expect(
      parse({
        judge: { ...okJudge, vendor: 'anthropic', hops: [hop('codex', 'anthropic', 'ok')] },
      }).success,
    ).toBe(false);
    expect(
      parse({
        judge: {
          ...okJudge,
          hops: [hop('codex', 'anthropic', 'error:429'), hop('maas-deepseek', 'deepseek', 'ok')],
          provider: 'maas-deepseek',
          vendor: 'deepseek',
        },
      }).success,
    ).toBe(false);
  });
});
