import * as path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { JUDGE_HOP_CHAIN, ProposalSchema } from '../../src/contracts/proposal.js';
import type { Proposal } from '../../src/contracts/proposal.js';
import { readText } from '../../src/io/read-fs.js';
import { createIoContext } from '../../src/io/paths.js';
import { remove, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { JudgeProviderMismatchError, JudgeStateError } from '../../src/judge/errors.js';
import { assertJudgeProvider, runJudge } from '../../src/judge/run.js';
import type { JudgeBackends } from '../../src/judge/run.js';
import { SAFE_STORE_FS } from '../../src/judge/store.js';
import type { StoreFs } from '../../src/judge/store.js';
import {
  StubBackend,
  fail,
  fakeKeyLike,
  makeStubs,
  newWork,
  okWith,
  outputText,
  proposalObject,
  redactor,
  snapshot,
  writeProposal,
  RUN_ID,
  CANARY,
} from './helpers.js';
import type { Script, Work } from './helpers.js';

const readYaml = async (file: string): Promise<Proposal> =>
  ProposalSchema.parse(parse(await readText(file)));

const go = (
  w: Work,
  backends: JudgeBackends,
  over: Partial<{ dry: boolean; maxCalls: number }> = {},
) =>
  runJudge({ io: w.io, redactor, backends }, { runId: RUN_ID, dry: false, maxCalls: 5, ...over });

const results = (hops: readonly { result: string }[]): string[] => hops.map((h) => h.result);

describe('judge 兜底链', () => {
  it('第一跳成功:只调第一跳,写 judge,provider=codex,无 judge_attempts', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const s = makeStubs();
    const rep = await go(w, s.backends);
    expect(rep.callsMade).toBe(1);
    expect(s.totalCalls()).toBe(1);
    const y = await readYaml(file);
    expect(y.judge!.provider).toBe('codex');
    expect(y.judge!.vendor).toBe('openai');
    expect(y.judge!.hops).toEqual([
      { hop: 'codex', vendor: 'openai', model: 'gpt-example', result: 'ok' },
    ]);
    expect(y.judge!.verdict).toBe('accept');
    expect('judge_attempts' in y).toBe(false);
    expect(ProposalSchema.safeParse(y).success).toBe(true);
  });

  it('同厂商的跳不调用且记 skipped:same-vendor;下一跳成功', async () => {
    const w = await newWork();
    const file = await writeProposal(w, {
      reflectorVendor: 'openai',
      reflectorBackend: 'codex',
      reflectorModel: 'gpt-reflector',
    });
    const s = makeStubs();
    await go(w, s.backends);
    expect(s.byHop.codex.calls).toHaveLength(0); // 同厂商不调用
    expect(s.byHop['maas-deepseek'].calls).toHaveLength(1); // 正向对照:不同厂商的跳被调用
    const y = await readYaml(file);
    expect(results(y.judge!.hops)).toEqual(['skipped:same-vendor', 'ok']);
    expect(y.judge!.provider).toBe('maas-deepseek');
    expect(y.judge!.vendor).toBe('deepseek');
  });

  it('同厂商比较归一化:后端自报 "Anthropic " 也算同厂商,不调用', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const s = makeStubs();
    const sneaky = new StubBackend('codex', ' Anthropic ', 'claude-sneaky');
    const rep = await go(w, { ...s.backends, codex: sneaky });
    expect(sneaky.calls).toHaveLength(0);
    expect(rep.outcomes[0]!.hops[0]!.result).toBe('skipped:same-vendor');
    const y = await readYaml(file);
    expect(y.judge!.provider).toBe('maas-deepseek');
  });

  it('冷却跳、错误跳、中间跳成功:逐跳记账', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const s = makeStubs({ codex: fail('rate_limited'), 'maas-deepseek': fail('timeout') });
    await go(w, s.backends);
    const y = await readYaml(file);
    expect(y.judge!.hops).toEqual([
      { hop: 'codex', vendor: 'openai', model: 'gpt-example', result: 'skipped:cooldown' },
      {
        hop: 'maas-deepseek',
        vendor: 'deepseek',
        model: 'deepseek-example',
        result: 'error:timeout',
      },
      { hop: 'glm', vendor: 'zhipu', model: 'glm-example', result: 'ok' },
    ]);
    expect(y.judge!.provider).toBe('glm');
    expect(s.byHop.kimi.calls).toHaveLength(0); // 成功后不再往下
  });

  it('各种失败码:not_installed / not_configured / error / 后端抛异常', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const s = makeStubs({
      codex: fail('not_installed'),
      'maas-deepseek': fail('not_configured'),
      glm: fail('error'),
      kimi: () => {
        throw new Error('boom');
      },
    });
    await go(w, s.backends);
    const y = await readYaml(file);
    expect(results(y.judge!.hops)).toEqual([
      'error:not_installed',
      'error:not_configured',
      'error:error',
      'error:error',
      'ok',
    ]);
  });

  it('全链失败:不写 judge,judge_attempts 记满 5 跳且不含 ok;pending=all_failed', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const s = makeStubs({
      codex: fail('rate_limited'),
      'maas-deepseek': fail('error'),
      glm: fail('timeout'),
      kimi: fail('not_installed'),
      'official-deepseek': fail('error'),
    });
    const rep = await go(w, s.backends);
    const y = await readYaml(file);
    expect('judge' in y).toBe(false);
    expect(y.judge_attempts!).toEqual([
      { hop: 'codex', vendor: 'openai', model: 'gpt-example', result: 'skipped:cooldown' },
      {
        hop: 'maas-deepseek',
        vendor: 'deepseek',
        model: 'deepseek-example',
        result: 'error:error',
      },
      { hop: 'glm', vendor: 'zhipu', model: 'glm-example', result: 'error:timeout' },
      { hop: 'kimi', vendor: 'moonshot', model: 'kimi-example', result: 'error:not_installed' },
      {
        hop: 'official-deepseek',
        vendor: 'deepseek',
        model: 'deepseek-example-2',
        result: 'error:error',
      },
    ]);
    expect(rep.outcomes[0]!.status).toBe('pending');
    expect(rep.outcomes[0]!.pending).toBe('all_failed');
    expect(ProposalSchema.safeParse(y).success).toBe(true);
  });

  it('只有同厂商(其余未配置):same_vendor_only,零调用,attempts 记满且同厂商贴 skipped:same-vendor', async () => {
    const w = await newWork();
    const file = await writeProposal(w, {
      reflectorVendor: 'deepseek',
      reflectorBackend: 'pi',
      reflectorModel: 'deepseek-reflector',
    });
    const s = makeStubs({}, ['maas-deepseek', 'official-deepseek']);
    const rep = await go(w, s.backends);
    expect(s.totalCalls()).toBe(0);
    expect(rep.outcomes[0]!.pending).toBe('same_vendor_only');
    const y = await readYaml(file);
    expect(y.judge_attempts!).toEqual([
      { hop: 'codex', vendor: 'unknown', model: '-', result: 'error:not_configured' },
      {
        hop: 'maas-deepseek',
        vendor: 'deepseek',
        model: 'deepseek-example',
        result: 'skipped:same-vendor',
      },
      { hop: 'glm', vendor: 'unknown', model: '-', result: 'error:not_configured' },
      { hop: 'kimi', vendor: 'unknown', model: '-', result: 'error:not_configured' },
      {
        hop: 'official-deepseek',
        vendor: 'deepseek',
        model: 'deepseek-example-2',
        result: 'skipped:same-vendor',
      },
    ]);
    expect(ProposalSchema.safeParse(y).success).toBe(true);
  });

  it('链上没有任何已配置后端:not_configured(与 same_vendor_only 区分),零调用,attempts 全为 error:not_configured', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const rep = await go(w, {});
    expect(rep.outcomes[0]!.status).toBe('pending');
    expect(rep.outcomes[0]!.pending).toBe('not_configured');
    const y = await readYaml(file);
    expect(y.judge_attempts!.map((h) => h.result)).toEqual(Array(5).fill('error:not_configured'));
  });

  it('全部限流:pending=cooldown;同一次运行里第二条提案不再调用已限流槽位', async () => {
    const w = await newWork();
    await writeProposal(w, { id: '2026-10-12-001' });
    await writeProposal(w, { id: '2026-10-12-002', target: 'new-rule-b' });
    const limited = fail('rate_limited');
    const s = makeStubs({
      codex: limited,
      'maas-deepseek': limited,
      glm: limited,
      kimi: limited,
      'official-deepseek': limited,
    });
    const rep = await go(w, s.backends);
    expect(rep.outcomes.map((o) => o.pending)).toEqual(['cooldown', 'cooldown']);
    expect(s.totalCalls()).toBe(5); // 每槽位只真调一次
  });

  it('unknown / 非内置 / 与模型矛盾的厂商不放行(不调用,error:vendor_unknown);正向对照被调用', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const unknown = new StubBackend('codex', 'unknown', 'mystery');
    const acme = new StubBackend('maas-deepseek', 'acme', 'acme-model');
    const liar = new StubBackend('glm', 'zhipu', 'gpt-actually-openai'); // 自报 zhipu,模型却是 gpt
    const good = new StubBackend('kimi', 'moonshot', 'kimi-example');
    const rep = await go(w, { codex: unknown, 'maas-deepseek': acme, glm: liar, kimi: good });
    expect(unknown.calls).toHaveLength(0);
    expect(acme.calls).toHaveLength(0);
    expect(liar.calls).toHaveLength(0);
    expect(good.calls).toHaveLength(1);
    expect(results(rep.outcomes[0]!.hops)).toEqual([
      'error:vendor_unknown',
      'error:vendor_unknown',
      'error:vendor_unknown',
      'ok',
    ]);
    expect((await readYaml(file)).judge!.provider).toBe('kimi');
  });

  it('反思器厂商不可证明(unknown / 非规范形 / 与 backend 重算不符)→ JudgeStateError,零调用零写入', async () => {
    for (const reflectorVendor of ['unknown', 'Anthropic ', 'acme']) {
      const w = await newWork();
      await writeProposal(w, { reflectorVendor });
      const before = await snapshot(w.runDir);
      const s = makeStubs();
      await expect(go(w, s.backends)).rejects.toBeInstanceOf(JudgeStateError);
      expect(s.totalCalls()).toBe(0);
      expect(await snapshot(w.runDir)).toEqual(before);
    }
    // 没记 backend(无法重算)时,厂商本身仍须是可证明的内置规范厂商
    for (const reflectorVendor of ['unknown', 'Anthropic ', 'acme']) {
      const w = await newWork();
      await writeProposal(w, { reflectorVendor, reflectorBackend: null, reflectorModel: 'opus' });
      await expect(go(w, makeStubs().backends)).rejects.toBeInstanceOf(JudgeStateError);
    }
    const ok = await newWork();
    await writeProposal(ok, { reflectorBackend: null, reflectorModel: 'opus' }); // 正向对照
    await expect(go(ok, makeStubs().backends)).resolves.toBeDefined();
    // backend=codex 重算为 openai,记录却写 anthropic → 拒绝
    const w = await newWork();
    await writeProposal(w, { reflectorBackend: 'codex' });
    await expect(go(w, makeStubs().backends)).rejects.toBeInstanceOf(JudgeStateError);
  });

  it('judge.provider 必须等于成功那一跳的槽位 id:后端 slot 与跳不符 → 抛错且零调用零写入', async () => {
    const w = await newWork();
    await writeProposal(w);
    const before = await snapshot(w.runDir);
    const s = makeStubs();
    const wrong = new StubBackend('glm', 'openai', 'gpt-example'); // 挂在 codex 位置的却自称 glm
    await expect(go(w, { ...s.backends, codex: wrong })).rejects.toBeInstanceOf(
      JudgeProviderMismatchError,
    );
    expect(wrong.calls).toHaveLength(0);
    expect(s.totalCalls()).toBe(0);
    expect(await snapshot(w.runDir)).toEqual(before);
    expect(() => assertJudgeProvider('codex', 'codex')).not.toThrow(); // 正向对照
    expect(() => assertJudgeProvider('glm', 'codex')).toThrow(JudgeProviderMismatchError);
  });

  it('既有 judge 的 provider 与最后一跳不符 / 与反思器同厂商 → 状态损坏,零调用零写入', async () => {
    const base = {
      hops: [{ hop: 'codex', vendor: 'openai', model: 'gpt-example', result: 'ok' }],
      provider: 'codex',
      vendor: 'openai',
      verdict: 'accept',
      overfit_risk: 'low',
      injection_suspected: false,
      conflicts: [],
    };
    const cases = [
      { ...base, provider: 'glm' },
      { ...base, vendor: 'Anthropic' }, // 精确比较 superRefine 放过,模块级复核拦住
    ];
    for (const judge of cases) {
      const w = await newWork();
      await writeProposal(w, { extra: { judge } });
      const before = await snapshot(w.runDir);
      const s = makeStubs();
      await expect(go(w, s.backends)).rejects.toThrow();
      expect(s.totalCalls()).toBe(0);
      expect(await snapshot(w.runDir)).toEqual(before);
    }
    // 正向对照:自洽的既有 judge 被跳过(already_judged),不调用不写
    const w = await newWork();
    await writeProposal(w, { extra: { judge: base } });
    const s = makeStubs();
    const rep = await go(w, s.backends);
    expect(rep.outcomes[0]!.status).toBe('already_judged');
    expect(s.totalCalls()).toBe(0);
  });
});

describe('评审第二轮加固', () => {
  it('后端自报厂商无法被模型串证实(opus 自称 openai)→ 不调用', async () => {
    const w = await newWork();
    await writeProposal(w);
    const liar = new StubBackend('codex', 'openai', 'opus');
    const spaced = new StubBackend('maas-deepseek', 'deepseek', 'deepseek example');
    const good = makeStubs().byHop.glm;
    const rep = await go(w, { codex: liar, 'maas-deepseek': spaced, glm: good });
    expect(liar.calls).toHaveLength(0);
    expect(spaced.calls).toHaveLength(0);
    expect(good.calls).toHaveLength(1);
    expect(results(rep.outcomes[0]!.hops).slice(0, 2)).toEqual([
      'error:vendor_unknown',
      'error:vendor_unknown',
    ]);
  });

  it('没记 backend 且 vendor 与模型串矛盾(手改 vendor)→ 状态损坏', async () => {
    const w = await newWork();
    await writeProposal(w, {
      reflectorVendor: 'deepseek',
      reflectorBackend: null,
      reflectorModel: 'claude-x',
    });
    const s = makeStubs();
    await expect(go(w, s.backends)).rejects.toBeInstanceOf(JudgeStateError);
    expect(s.totalCalls()).toBe(0);
  });

  it('后端返回枚举之外的 reason → 映射成 error:error,不把任意串落盘', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const weird: Script = () => ({ ok: false, reason: 'x y/../z' }) as never;
    await go(w, makeStubs({ codex: weird }).backends);
    expect(results((await readYaml(file)).judge!.hops)[0]).toBe('error:error');
  });

  it('预置的固定名 .tmp 符号链接不会被跟随写入', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const rule = path.join(w.runDir, 'rules', 'personal', 'new-rule-a.md');
    const ruleBefore = await readText(rule);
    await symlink(w.io, rule, `${file}.tmp`);
    await go(w, makeStubs().backends);
    expect(await readText(rule)).toBe(ruleBefore);
  });

  it('评审期间提案文件被改动 → 中止,不覆盖', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const edited = (await readText(file)) + '# edited\n';
    const s = makeStubs({
      codex: () => {
        void 0;
        return { ok: true, text: outputText() };
      },
    });
    const sneaky = new StubBackend('codex', 'openai', 'gpt-example', () => ({
      ok: true,
      text: outputText(),
    }));
    const orig = sneaky.complete.bind(sneaky);
    sneaky.complete = async (req) => {
      await writeFile(w.io, file, edited);
      return orig(req);
    };
    await expect(go(w, { ...s.backends, codex: sneaky })).rejects.toBeInstanceOf(JudgeStateError);
    expect(await readText(file)).toBe(edited);
  });

  it('写出口不可写 → 调用之前就失败(零调用)', async () => {
    const w = await newWork();
    await writeProposal(w);
    const narrow = createIoContext({
      cwd: REPO_ROOT,
      root: w.repo,
      env: {
        KIT_TMP: w.dir,
        KIT_STATE_DIR: w.state,
        KIT_WRITE_ROOTS: path.join(w.dir, 'elsewhere'),
        PATH: '/usr/bin:/bin',
      },
    });
    const s = makeStubs();
    await expect(
      runJudge(
        { io: narrow, redactor, backends: s.backends },
        { runId: RUN_ID, dry: false, maxCalls: 5 },
      ),
    ).rejects.toThrow();
    expect(s.totalCalls()).toBe(0);
  });
});

describe('干跑与调用预算', () => {
  it('干跑:零调用、零写入,列出计划', async () => {
    const w = await newWork();
    await writeProposal(w, {
      reflectorVendor: 'openai',
      reflectorBackend: 'codex',
      reflectorModel: 'gpt-reflector',
    });
    const before = await snapshot(w.runDir);
    const s = makeStubs();
    const rep = await go(w, s.backends, { dry: true });
    expect(s.totalCalls()).toBe(0);
    expect(await snapshot(w.runDir)).toEqual(before);
    expect(rep.outcomes[0]!.status).toBe('planned');
    expect(results(rep.outcomes[0]!.hops)).toEqual([
      'skipped:same-vendor',
      'planned:call',
      'planned:call',
      'planned:call',
      'planned:call',
    ]);
  });

  it('超过 maxCalls:不再调用;未尝试的跳记 error:budget_exhausted(同厂商仍记 skipped:same-vendor);后续提案不开始', async () => {
    const w = await newWork();
    const f1 = await writeProposal(w, { id: '2026-10-12-001' });
    const f2 = await writeProposal(w, { id: '2026-10-12-002', target: 'new-rule-b' });
    const s = makeStubs({
      codex: fail('error'),
      'maas-deepseek': fail('error'),
      glm: fail('error'),
      kimi: fail('error'),
      'official-deepseek': fail('error'),
    });
    const b2 = await readText(f2);
    const rep = await go(w, s.backends, { maxCalls: 2 });
    expect(rep.callsMade).toBe(2);
    expect(s.totalCalls()).toBe(2);
    expect(rep.budgetExhausted).toBe(true);
    const y = await readYaml(f1);
    expect(results(y.judge_attempts!)).toEqual([
      'error:error',
      'error:error',
      'error:budget_exhausted',
      'error:budget_exhausted',
      'error:budget_exhausted',
    ]);
    expect(rep.outcomes[1]!.status).toBe('not_run');
    expect(await readText(f2)).toBe(b2); // 未开始的提案不写
  });
});

describe('幂等与互斥', () => {
  it('重复 judge:attempts 整体替换不累积,相同内容不重写;之后成功写 judge 并删除 attempts;再跑跳过', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const failing = makeStubs({
      codex: fail('error'),
      'maas-deepseek': fail('error'),
      glm: fail('error'),
      kimi: fail('error'),
      'official-deepseek': fail('error'),
    });
    await go(w, failing.backends);
    const once = await readText(file);
    const rep2 = await go(w, failing.backends);
    expect(await readText(file)).toBe(once);
    expect(rep2.outcomes[0]!.wrote).toBe(false);
    expect((await readYaml(file)).judge_attempts).toHaveLength(5);

    const good = makeStubs();
    await go(w, good.backends);
    const y = await readYaml(file);
    expect('judge_attempts' in y).toBe(false);
    expect(y.judge).toBeDefined();
    expect(ProposalSchema.safeParse(y).success).toBe(true);

    const done = await readText(file);
    const again = makeStubs();
    const rep3 = await go(w, again.backends);
    expect(again.totalCalls()).toBe(0);
    expect(rep3.outcomes[0]!.status).toBe('already_judged');
    expect(await readText(file)).toBe(done);
  });

  it('judge 与 judge_attempts 同时存在 → 状态损坏,不碰文件', async () => {
    const w = await newWork();
    const judge = {
      hops: [{ hop: 'codex', vendor: 'openai', model: 'm', result: 'ok' }],
      provider: 'codex',
      vendor: 'openai',
      verdict: 'accept',
      overfit_risk: 'low',
      injection_suspected: false,
      conflicts: [],
    };
    const attempts = JUDGE_HOP_CHAIN.map((hop) => ({
      hop,
      vendor: 'unknown',
      model: '-',
      result: 'error:not_configured',
    }));
    await writeProposal(w, { extra: { judge, judge_attempts: attempts } });
    const before = await snapshot(w.runDir);
    await expect(go(w, makeStubs().backends)).rejects.toBeInstanceOf(JudgeStateError);
    expect(await snapshot(w.runDir)).toEqual(before);
  });
});

describe('judge 不越权', () => {
  it('只改 proposals/*.yaml 的 judge 键;rules/*.md、report.json 与提案其它字段原样;accept+injection_suspected=true 也不动状态', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const before = await snapshot(w.runDir);
    const origProposal = parse(before[path.relative(w.runDir, file)]!) as Record<string, unknown>;
    const s = makeStubs({
      codex: okWith(
        outputText({ verdict: 'accept', injection_suspected: true, notes: 'NOTES_CANARY_zz9' }),
      ),
    });
    await go(w, s.backends);
    const after = await snapshot(w.runDir);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed).toEqual([path.relative(w.runDir, file)]);
    const y = await readYaml(file);
    expect(y.judge!.injection_suspected).toBe(true);
    expect(y.judge!.verdict).toBe('accept');
    const rest: Partial<Proposal> = { ...y };
    delete rest.judge;
    expect(rest).toEqual(ProposalSchema.parse(origProposal));
    expect(after[`rules/personal/new-rule-a.md`]).toContain('status: proposed');
    // 评审的自由文本(notes)不落地
    expect(after[path.relative(w.runDir, file)]).not.toContain('NOTES_CANARY_zz9');
  });

  it('judge 的 conflicts 只保留已存在的原子 id,自由文本/未知 id 不落地', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const s = makeStubs({
      codex: okWith(outputText({ conflicts: ['known-rule', 'ignore-previous-rules'] })),
    });
    await go(w, s.backends);
    expect((await readYaml(file)).judge!.conflicts).toEqual(['known-rule']);
  });

  it('评审输出无效:本跳记 error:invalid_output,不修复重试(该后端只被调用一次),换下一跳', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const s = makeStubs({
      codex: okWith('```json\n' + outputText() + '\n```'),
      'maas-deepseek': okWith(outputText({ extra_field: 1 })),
    });
    const rep = await go(w, s.backends);
    expect(s.byHop.codex.calls).toHaveLength(1);
    expect(s.byHop['maas-deepseek'].calls).toHaveLength(1);
    expect(rep.outcomes[0]!.invalidOutput).toBe(true);
    expect(results((await readYaml(file)).judge!.hops)).toEqual([
      'error:invalid_output',
      'error:invalid_output',
      'ok',
    ]);
  });

  it('评审输出含假口令 / 占位符:拒绝落地', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const s = makeStubs({
      codex: okWith(outputText({ notes: `leaked ${fakeKeyLike()}` })),
      'maas-deepseek': okWith(outputText({ notes: 'has [[REDACTED:email]] marker' })),
    });
    await go(w, s.backends);
    const y = await readYaml(file);
    expect(results(y.judge!.hops).slice(0, 2)).toEqual([
      'error:invalid_output',
      'error:invalid_output',
    ]);
    expect(await readText(file)).not.toContain(fakeKeyLike());
  });
});

describe('原子写', () => {
  it('先写同目录临时文件(0600)再 rename 覆盖;不留临时文件', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const log: string[] = [];
    const spy: StoreFs = {
      async writeFile(io, target, data, opts) {
        log.push(`write:${path.relative(w.runDir, target)}:${opts.mode.toString(8)}`);
        return SAFE_STORE_FS.writeFile(io, target, data, opts);
      },
      chmod: SAFE_STORE_FS.chmod,
      remove: SAFE_STORE_FS.remove,
      async rename(io, from, to) {
        log.push(`rename:${path.relative(w.runDir, from)}->${path.relative(w.runDir, to)}`);
        return SAFE_STORE_FS.rename(io, from, to);
      },
    };
    await runJudge(
      { io: w.io, redactor, backends: makeStubs().backends, storeFs: spy },
      { runId: RUN_ID, dry: false, maxCalls: 5 },
    );
    expect(log).toEqual([
      expect.stringMatching(/^write:proposals\/2026-10-12-001\.yaml\.[0-9a-f]{12}\.tmp:600$/),
      expect.stringMatching(
        /^rename:proposals\/2026-10-12-001\.yaml\.[0-9a-f]{12}\.tmp->proposals\/2026-10-12-001\.yaml$/,
      ),
    ]);
    const snap = await snapshot(w.runDir);
    expect(Object.keys(snap).some((k) => k.endsWith('.tmp'))).toBe(false);
    expect(await readText(file)).toContain('judge:');
  });
});

describe('状态损坏 → 整体 fail-closed(零调用零写入,包括同 run 里其它好提案)', () => {
  const cases: Record<string, (w: Work) => Promise<void>> = {
    'yaml 无法解析': async (w) => {
      const f = await writeProposal(w, { id: '2026-10-12-009', target: 'new-rule-z' });
      await writeFile(w.io, f, 'id: [unclosed\n');
    },
    缺规则文件: async (w) => {
      await writeProposal(w, { id: '2026-10-12-009', target: 'new-rule-z' });
      await remove(w.io, path.join(w.runDir, 'rules', 'personal', 'new-rule-z.md'));
    },
    '文件名与 id 不一致': async (w) => {
      const f = await writeProposal(w, { id: '2026-10-12-009', target: 'new-rule-z' });
      await rename(w.io, f, path.join(w.runDir, 'proposals', '2026-10-12-008.yaml'));
    },
    'reflector.run_id 与 --run 不一致': async (w) => {
      await writeProposal(w, { id: '2026-10-12-009', target: 'new-rule-z', runId: 'other-run' });
    },
  };
  for (const [name, corrupt] of Object.entries(cases)) {
    it(name, async () => {
      const w = await newWork();
      await writeProposal(w); // 一条好提案
      await corrupt(w);
      const before = await snapshot(w.runDir);
      const s = makeStubs();
      await expect(go(w, s.backends)).rejects.toBeInstanceOf(JudgeStateError);
      expect(s.totalCalls()).toBe(0);
      expect(await snapshot(w.runDir)).toEqual(before);
    });
  }
  it('正向对照:同样两条提案都好时正常评审', async () => {
    const w = await newWork();
    await writeProposal(w);
    await writeProposal(w, { id: '2026-10-12-009', target: 'new-rule-z' });
    const s = makeStubs();
    const rep = await go(w, s.backends);
    expect(rep.outcomes.map((o) => o.status)).toEqual(['judged', 'judged']);
  });
});

describe('夹具自检', () => {
  it('proposalObject 通过 ProposalSchema', () => {
    expect(ProposalSchema.safeParse(proposalObject()).success).toBe(true);
    expect(CANARY.sig).toMatch(/^sig_/);
  });
});
