import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ProposalSchema } from '../../src/contracts/proposal.js';
import type { Proposal } from '../../src/contracts/proposal.js';
import { readText } from '../../src/io/read-fs.js';
import { acceptanceSha256 } from '../../src/judge/freeze.js';
import { parseJudgeOutput } from '../../src/judge/output.js';
import { JudgeStateError } from '../../src/judge/errors.js';
import { runJudge } from '../../src/judge/run.js';
import type { JudgeBackends } from '../../src/judge/run.js';
import { applyJudgeFields } from '../../src/judge/store.js';
import { buildJudgePromptV2, JUDGE_PROMPT_ID } from '../../src/judge/prompt/v2.js';
import { JUDGE_PROMPT_ID as V1_ID } from '../../src/judge/prompt/v1.js';
import {
  GUIDANCE,
  RUN_ID,
  VALID_PREDICTION,
  fixedNow,
  makeStubs,
  newWork,
  okWith,
  outputText,
  redactor,
  snapshot,
  writeProposal,
} from './helpers.js';
import type { Work } from './helpers.js';

const readYaml = async (file: string): Promise<Proposal> =>
  ProposalSchema.parse(parse(await readText(file)));
const go = (w: Work, backends: JudgeBackends, over: { dry?: boolean } = {}) =>
  runJudge(
    { io: w.io, redactor, backends, now: fixedNow },
    { runId: RUN_ID, dry: over.dry ?? false, maxCalls: 5 },
  );
const withPred = (p: Record<string, unknown> = {}) =>
  outputText({ prediction: { ...VALID_PREDICTION, ...p } });
const req = { predictionRequired: true };

describe('P1 output.ts 预测校验', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['lo 离网格', { ratio_lo: 0.3 }],
    ['hi 离网格', { ratio_hi: 0.9 }],
    ['lo >= hi', { ratio_lo: 0.8, ratio_hi: 0.8 }],
    ['lo > hi', { ratio_lo: 0.8, ratio_hi: 0.25 }],
    ['下标差 4(超宽度上限)', { direction: 'down', ratio_lo: 0, ratio_hi: 0.8 }],
    ['置信度 0.6', { confidence: 0.6 }],
    ['down 但 lo >= 0.8', { direction: 'down', ratio_lo: 0.8, ratio_hi: 2 }],
    ['up 但 hi <= 1.25', { direction: 'up', ratio_lo: 0.25, ratio_hi: 1.25 }],
    ['flat 但不与 [0.8,1.25] 相交', { direction: 'flat', ratio_lo: 0.1, ratio_hi: 0.5 }],
    ['方向不在枚举', { direction: 'sideways' }],
    ['多余键', { extra: 1 }],
  ];
  it.each(bad)('%s → prediction_invalid', (_n, over) => {
    expect(parseJudgeOutput(withPred(over), redactor, req)).toEqual({
      ok: false,
      code: 'prediction_invalid',
    });
  });
  it('缺 prediction / 非对象 → prediction_invalid', () => {
    expect(parseJudgeOutput(outputText(), redactor, req)).toEqual({
      ok: false,
      code: 'prediction_invalid',
    });
    expect(parseJudgeOutput(outputText({ prediction: 'down' }), redactor, req)).toEqual({
      ok: false,
      code: 'prediction_invalid',
    });
  });
  it('正向对照:合法样例 ok,含 "inf" 上界与宽度恰为 3', () => {
    const r = parseJudgeOutput(withPred(), redactor, req);
    expect(r.ok && r.value.prediction).toEqual(VALID_PREDICTION);
    expect(
      parseJudgeOutput(
        withPred({ direction: 'up', ratio_lo: 1.25, ratio_hi: 'inf' }),
        redactor,
        req,
      ).ok,
    ).toBe(true);
    expect(
      parseJudgeOutput(withPred({ direction: 'down', ratio_lo: 0, ratio_hi: 0.5 }), redactor, req)
        .ok,
    ).toBe(true); // 下标 0→3
  });
  it('不要求时:合法或非法的 prediction 都被丢弃(不报错),旧 v1 行为不变', () => {
    const a = parseJudgeOutput(withPred(), redactor);
    expect(a.ok && a.value.prediction).toBeUndefined();
    const b = parseJudgeOutput(outputText({ prediction: 'garbage' }), redactor);
    expect(b.ok && b.value.prediction).toBeUndefined();
    expect(parseJudgeOutput(outputText({ bogus: 1 }), redactor)).toEqual({
      ok: false,
      code: 'schema',
    });
  });
});

describe('P2 predicted 下缺 prediction = 该跳 invalid_output、走下一跳(③A)', () => {
  it('第一跳缺 prediction → 第二跳被调用并成功;落盘 prediction 为 predicted', async () => {
    const w = await newWork();
    const file = await writeProposal(w, { guidance: GUIDANCE });
    const s = makeStubs({ codex: okWith(outputText()), 'maas-deepseek': okWith(withPred()) });
    const rep = await go(w, s.backends);
    expect(s.byHop.codex.calls).toHaveLength(1);
    expect(s.byHop['maas-deepseek'].calls).toHaveLength(1);
    expect(rep.outcomes[0]?.invalidOutput).toBe(true);
    const y = await readYaml(file);
    expect(y.judge!.hops.map((h) => h.result)).toEqual(['error:invalid_output', 'ok']);
    expect(y.judge!.prediction).toMatchObject({ status: 'predicted', ...VALID_PREDICTION });
  });
  it('全链都缺 → 不写 judge,写 judge_attempts,全是 invalid_output', async () => {
    const w = await newWork();
    const file = await writeProposal(w, { guidance: GUIDANCE });
    const s = makeStubs({}, ['codex', 'maas-deepseek']);
    for (const h of ['codex', 'maas-deepseek'] as const) {
      s.byHop[h] = Object.assign(s.byHop[h]);
    }
    const bk = makeStubs({ codex: okWith(outputText()), 'maas-deepseek': okWith(outputText()) }, [
      'codex',
      'maas-deepseek',
    ]);
    const rep = await go(w, bk.backends);
    expect(rep.outcomes[0]?.status).toBe('pending');
    const raw = parse(await readText(file)) as Record<string, unknown>;
    expect(raw['judge']).toBeUndefined();
    expect(
      (raw['judge_attempts'] as { result: string }[]).slice(0, 2).map((h) => h.result),
    ).toEqual(['error:invalid_output', 'error:invalid_output']);
  });
  it('predicted 用 v2 提示(带 <baseline> 与 prediction 说明);其余 status 用 v1(无基线)', async () => {
    const w = await newWork();
    await writeProposal(w, { guidance: GUIDANCE });
    const s = makeStubs({ codex: okWith(withPred()) });
    await go(w, s.backends);
    const c = s.byHop.codex.calls[0]!;
    expect(c.user).toContain('<baseline sessions_total="412" exposure_sessions="37" fired="51"');
    expect(c.system).toContain('"prediction"');
    const w2 = await newWork();
    await writeProposal(w2, {}); // 无 guidance
    const s2 = makeStubs();
    await go(w2, s2.backends);
    expect(s2.byHop.codex.calls[0]!.user).not.toContain('<baseline');
    expect(s2.byHop.codex.calls[0]!.system).not.toContain('"prediction"');
    expect(JUDGE_PROMPT_ID).toBe('judge-v2');
    expect(V1_ID).toBe('judge-v1');
  });
  it('v2 提示拒绝不自洽基线', () => {
    const input = {
      op: 'add',
      layer: 'personal',
      signature: { type: 'phrase', pattern: 'x' },
      do: 'd',
      why: 'w',
      verify: 'v',
      evidence: ['e'],
    };
    expect(() =>
      buildJudgePromptV2(
        { ...input, baseline: { sessions_total: 10, exposure_sessions: 11, fired: 12 } },
        redactor,
      ),
    ).toThrow();
    expect(() =>
      buildJudgePromptV2(
        { ...input, baseline: { sessions_total: 30, exposure_sessions: 5, fired: 6 } },
        redactor,
      ),
    ).not.toThrow();
  });
});

describe('P3 非 predicted 时 LLM 的 prediction 被丢弃', () => {
  const cases: Array<[string, Parameters<typeof writeProposal>[1], string]> = [
    ['always 型', { guidance: GUIDANCE, signature: 'always' }, 'not_measurable'],
    ['path 型', { guidance: GUIDANCE, signature: 'path' }, 'not_measurable'],
    ['无签名', { guidance: GUIDANCE, signature: 'none' }, 'not_measurable'],
    [
      '会话 < 20',
      {
        guidance: { ...GUIDANCE, baseline: { sessions_total: 19, exposure_sessions: 5, fired: 5 } },
      },
      'baseline_insufficient',
    ],
    [
      '曝光 < 3',
      {
        guidance: { ...GUIDANCE, baseline: { sessions_total: 50, exposure_sessions: 2, fired: 2 } },
      },
      'baseline_insufficient',
    ],
    ['旧暂存提案无 guidance(不拒)', {}, 'baseline_insufficient'],
  ];
  it.each(cases)('%s → %s,落盘无四值', async (_n, spec, status) => {
    const w = await newWork();
    const file = await writeProposal(w, spec);
    const s = makeStubs({ codex: okWith(withPred({ confidence: 0.9 })) });
    await go(w, s.backends);
    const y = await readYaml(file);
    expect(y.judge!.prediction!.status).toBe(status);
    for (const k of ['direction', 'ratio_lo', 'ratio_hi', 'confidence'] as const) {
      expect(y.judge!.prediction![k]).toBeUndefined();
    }
    expect(y.judge!.prediction!.acceptance_sha256).toBe(y.judge!.acceptance!.sha256);
  });
  it('即使给的 prediction 非法也只是丢弃(有意:不记 invalid_output)', async () => {
    const w = await newWork();
    const file = await writeProposal(w, { signature: 'always' });
    const s = makeStubs({ codex: okWith(outputText({ prediction: 'junk' })) });
    const rep = await go(w, s.backends);
    expect(rep.outcomes[0]?.invalidOutput).toBe(false);
    expect((await readYaml(file)).judge).toBeDefined();
  });
});

describe('冻结记录落盘', () => {
  it('judge.acceptance 全字段正确,自哈希自洽,prediction 绑定它', async () => {
    const w = await newWork();
    const file = await writeProposal(w, { guidance: GUIDANCE });
    await go(w, makeStubs({ codex: okWith(withPred()) }).backends);
    const y = await readYaml(file);
    const a = y.judge!.acceptance!;
    expect(a).toMatchObject({
      schema_version: 1,
      method: 'signature_proxy_v1',
      rule_sha256: y.judge!.rule_sha256,
      guidance_until: GUIDANCE.until,
      judged_at_head: w.head,
      frozen_at: '2026-10-14T05:40:00Z',
      anchor_min: '2026-10-15',
      tile_days: 7,
      max_tiles: 4,
    });
    expect(a.sha256).toBe(acceptanceSha256(a));
    // 子哈希的独立期望值(node 另算):接错对象时自哈希仍自洽,只有这两条能抓到
    expect(a.signature_sha256).toBe(
      '7ac2e2a88f23a66e6b18905270a40ae1f71e783a324242f773beeb8e89d123f9',
    );
    expect(a.baseline_sha256).toBe(
      'ea74124d835f9a581b010c441502f16859e1bc8f3a8bd2cb22f84f0a180b0483',
    );
    expect(y.judge!.prediction!.acceptance_sha256).toBe(a.sha256);
    expect(ProposalSchema.safeParse(y).success).toBe(true);
  });
  it('kit.toml [lifecycle] 的 tile/max_tiles 被冻结;空 [lifecycle] 走默认也能冻结', async () => {
    const w = await newWork();
    const { writeFile } = await import('../../src/io/safe-fs.js');
    const kitText = await readText(`${w.repo}/kit.toml`);
    const block = /\[lifecycle\][^\[]*/;
    expect(block.test(kitText)).toBe(true); // 正向对照:替换目标存在
    await writeFile(
      w.io,
      `${w.repo}/kit.toml`,
      kitText.replace(
        block,
        '[lifecycle]\nacceptance_tile_days = 10\nacceptance_max_tiles = 5\n\n',
      ),
    );
    const file = await writeProposal(w, { guidance: GUIDANCE });
    await go(w, makeStubs({ codex: okWith(withPred()) }).backends);
    const a = (await readYaml(file)).judge!.acceptance!;
    expect([a.tile_days, a.max_tiles]).toEqual([10, 5]);
  });
  it('kit.toml 没有 [lifecycle] 段 → 用 schema 默认(7 / 4)冻结', async () => {
    const w = await newWork();
    const { writeFile } = await import('../../src/io/safe-fs.js');
    const kitText = await readText(`${w.repo}/kit.toml`);
    await writeFile(w.io, `${w.repo}/kit.toml`, kitText.replace(/\[lifecycle\][^\[]*/, ''));
    const file = await writeProposal(w, { guidance: GUIDANCE });
    await go(w, makeStubs({ codex: okWith(withPred()) }).backends);
    const a = (await readYaml(file)).judge!.acceptance!;
    expect([a.tile_days, a.max_tiles]).toEqual([7, 4]);
  });
});

describe('fail-closed', () => {
  it('毫秒边界:guidance.until=05:40:00.100Z、时钟=05:40:00.900Z(冻结值截成 05:40:00Z < until)→ 调用前中止,零调用零写入;时钟=05:40:01.000Z 通过', async () => {
    const w = await newWork();
    const file = await writeProposal(w, {
      guidance: { ...GUIDANCE, until: '2026-10-14T05:40:00.100Z' },
    });
    const before = await snapshot(w.runDir);
    const s = makeStubs({ codex: okWith(withPred()) });
    const at = (iso: string) =>
      runJudge(
        { io: w.io, redactor, backends: s.backends, now: () => new Date(iso) },
        { runId: RUN_ID, dry: false, maxCalls: 5 },
      );
    await expect(at('2026-10-14T05:40:00.900Z')).rejects.toBeInstanceOf(JudgeStateError);
    expect(s.totalCalls()).toBe(0);
    expect(await snapshot(w.runDir)).toEqual(before);
    await at('2026-10-14T05:40:01.000Z'); // 正向对照
    expect((await readYaml(file)).judge!.acceptance!.frozen_at).toBe('2026-10-14T05:40:01Z');
  });
  it('取不到 HEAD → 真跑 JudgeStateError;干跑不需要 HEAD', async () => {
    const w = await newWork();
    await writeProposal(w, { guidance: GUIDANCE });
    const s = makeStubs();
    await expect(
      runJudge(
        { io: w.io, redactor, backends: s.backends, resolveHead: () => undefined, now: fixedNow },
        { runId: RUN_ID, dry: false, maxCalls: 5 },
      ),
    ).rejects.toBeInstanceOf(JudgeStateError);
    expect(s.totalCalls()).toBe(0);
    const rep = await runJudge(
      { io: w.io, redactor, backends: s.backends, resolveHead: () => undefined, now: fixedNow },
      { runId: RUN_ID, dry: true, maxCalls: 5 },
    );
    expect(rep.outcomes[0]?.status).toBe('planned');
  });
  it('judge 时钟早于 guidance.until → 调用前中止', async () => {
    const w = await newWork();
    await writeProposal(w, { guidance: GUIDANCE });
    const s = makeStubs();
    await expect(
      runJudge(
        { io: w.io, redactor, backends: s.backends, now: () => new Date('2026-10-01T00:00:00Z') },
        { runId: RUN_ID, dry: false, maxCalls: 5 },
      ),
    ).rejects.toBeInstanceOf(JudgeStateError);
    expect(s.totalCalls()).toBe(0);
  });
});

describe('P4 只改 judge / judge_attempts 键', () => {
  it('落盘后除 judge 外整份提案(含 reflector.guidance)与评审前逐字段相等', async () => {
    const w = await newWork();
    const file = await writeProposal(w, { guidance: GUIDANCE });
    const before = parse(await readText(file)) as Record<string, unknown>;
    await go(w, makeStubs({ codex: okWith(withPred()) }).backends);
    const after = parse(await readText(file)) as Record<string, unknown>;
    const { judge, ...rest } = after;
    expect(judge).toBeDefined();
    expect(rest).toEqual(before);
    expect((after['reflector'] as { guidance: unknown }).guidance).toEqual(GUIDANCE);
  });
  it('不变量:顺手改 reflector.guidance 的写入被拒', () => {
    const raw = { id: 'x', reflector: { guidance: GUIDANCE } };
    expect(() => applyJudgeFields(raw, { judge: {} })).not.toThrow();
    const mutated = { ...raw, reflector: { guidance: { ...GUIDANCE, until: 'z' } } };
    // applyJudgeFields 只替换 judge 键;直接断言不变量函数对 reflector 变化敏感
    return import('../../src/judge/store.js').then((m) =>
      expect(() => m.assertOnlyJudgeKeysChanged(raw, mutated)).toThrow(),
    );
  });
});
