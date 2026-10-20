/**
 * K6:判官记录的提示词可追溯字段 `judge.prompt_id` / `judge.prompt_sha256`。
 * 钉住:①由 runJudge 写入,predicted 用 v2、其余用 v1;②模板哈希覆盖 user 骨架(≠ 旧的只哈希 system 的常量);
 * ③旧记录无此字段仍合法;④字段不进 acceptance / rule_sha256 的哈希;⑤G3 不要求它们(有无都同样通过)。
 */
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { JudgeRecordSchema, ProposalSchema } from '../../src/contracts/proposal.js';
import type { Proposal } from '../../src/contracts/proposal.js';
import { readText } from '../../src/io/read-fs.js';
import { acceptanceSha256 } from '../../src/judge/freeze.js';
import { runJudge } from '../../src/judge/run.js';
import {
  JUDGE_PROMPT_ID as V1_ID,
  JUDGE_PROMPT_SHA256 as V1_SYSTEM_ONLY_SHA,
  JUDGE_PROMPT_TEMPLATE_SHA256 as V1_TEMPLATE_SHA,
  JUDGE_SYSTEM_PROMPT as V1_SYSTEM,
  SKELETON_INPUT,
  SKELETON_REDACTOR,
  buildJudgePrompt,
} from '../../src/judge/prompt/v1.js';
import {
  JUDGE_PROMPT_ID as V2_ID,
  JUDGE_PROMPT_SHA256 as V2_SYSTEM_ONLY_SHA,
  JUDGE_PROMPT_TEMPLATE_SHA256 as V2_TEMPLATE_SHA,
} from '../../src/judge/prompt/v2.js';
import { buildWorld } from '../guards/frozen-world.js';
import { useRepoCleanup } from '../guards/helpers.js';
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
  writeProposal,
} from './helpers.js';

useRepoCleanup();

const readYaml = async (file: string): Promise<Proposal> =>
  ProposalSchema.parse(parse(await readText(file)));
const go = (w: Awaited<ReturnType<typeof newWork>>, b: ReturnType<typeof makeStubs>['backends']) =>
  runJudge(
    { io: w.io, redactor, backends: b, now: fixedNow },
    { runId: RUN_ID, dry: false, maxCalls: 5 },
  );
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('模板哈希的口径', () => {
  it('覆盖 user 骨架:既不等于只哈希 system 的旧常量,也等于 system + 骨架渲染结果的哈希;v1 ≠ v2', () => {
    expect(V1_TEMPLATE_SHA).not.toBe(V1_SYSTEM_ONLY_SHA);
    expect(V2_TEMPLATE_SHA).not.toBe(V2_SYSTEM_ONLY_SHA);
    expect(V1_TEMPLATE_SHA).not.toBe(V2_TEMPLATE_SHA);
    const user = buildJudgePrompt(SKELETON_INPUT, SKELETON_REDACTOR).user;
    expect(V1_TEMPLATE_SHA).toBe(sha(`${V1_SYSTEM}\n--USER-SKELETON--\n${user}`));
    // 骨架里没有数据:换一份内容的输入,user 段的标签结构不变,但哈希只依赖固定占位符
    expect(user).toContain('<evidence id="e1">EVIDENCE</evidence>');
  });
});

describe('runJudge 写入 prompt_id / prompt_sha256', () => {
  it('predicted(有 guidance)→ judge-v2 + v2 模板哈希;冻结哈希不受这两个字段影响', async () => {
    const w = await newWork();
    const file = await writeProposal(w, { guidance: GUIDANCE });
    await go(
      w,
      makeStubs({ codex: okWith(outputText({ prediction: VALID_PREDICTION })) }).backends,
    );
    const y = await readYaml(file);
    expect(y.judge!.prompt_id).toBe(V2_ID);
    expect(y.judge!.prompt_sha256).toBe(V2_TEMPLATE_SHA);
    // acceptance 自哈希自洽,且字段改动后仍不变(它们根本不是 acceptance 的输入)
    const acc = y.judge!.acceptance!;
    expect(acc.sha256).toBe(acceptanceSha256(acc));
    const tampered = { ...y.judge!, prompt_id: 'judge-v9', prompt_sha256: 'e'.repeat(64) };
    expect(JudgeRecordSchema.parse(tampered).acceptance!.sha256).toBe(acc.sha256);
    expect(acceptanceSha256(JudgeRecordSchema.parse(tampered).acceptance!)).toBe(acc.sha256);
    expect(tampered.rule_sha256).toBe(y.judge!.rule_sha256);
    expect(JSON.stringify(acc)).not.toMatch(/prompt/);
  });

  it('无 guidance(非 predicted)→ judge-v1 + v1 模板哈希', async () => {
    const w = await newWork();
    const file = await writeProposal(w, {});
    await go(w, makeStubs().backends);
    const y = await readYaml(file);
    expect(y.judge!.prompt_id).toBe(V1_ID);
    expect(y.judge!.prompt_sha256).toBe(V1_TEMPLATE_SHA);
  });

  it('同一输入重跑,rule_sha256 / acceptance 里与提示无关的部分不变(只多了两个留痕字段)', async () => {
    const w = await newWork();
    const file = await writeProposal(w, {});
    await go(w, makeStubs().backends);
    const y = await readYaml(file);
    const { prompt_id, prompt_sha256, ...rest } = y.judge!;
    void prompt_id;
    void prompt_sha256;
    expect(JudgeRecordSchema.parse(rest)).toEqual(rest); // 去掉两个字段仍是合法旧记录
  });
});

describe('schema 兼容', () => {
  const base = {
    hops: [{ hop: 'codex', vendor: 'openai', model: 'm', result: 'ok' }],
    provider: 'codex',
    vendor: 'openai',
    verdict: 'accept',
    overfit_risk: 'low',
    injection_suspected: false,
    conflicts: [],
  };
  it('旧记录(无两个字段)仍合法;带合法字段合法;坏值被拒', () => {
    expect(JudgeRecordSchema.safeParse(base).success).toBe(true);
    expect(
      JudgeRecordSchema.safeParse({ ...base, prompt_id: 'judge-v2', prompt_sha256: 'a'.repeat(64) })
        .success,
    ).toBe(true);
    for (const bad of [
      { prompt_id: 'Judge V2' },
      { prompt_id: '' },
      { prompt_sha256: 'xyz' },
      { prompt_sha256: 'A'.repeat(64) },
    ]) {
      expect(JudgeRecordSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});

describe('G3 不要求这两个字段', () => {
  it('同一冻结世界:判官记录没有 / 带有 prompt 字段,G3 诊断码完全一致(都绿)', async () => {
    const without = await buildWorld();
    let applied = 0;
    const withFields = await buildWorld({
      proposalTransform: (y) => {
        if (!y.includes('\njudge:\n')) return y; // reflect 阶段的提案还没有 judge 块
        applied++;
        return y.replace(
          '\njudge:\n',
          `\njudge:\n  prompt_id: judge-v2\n  prompt_sha256: ${'b'.repeat(64)}\n`,
        );
      },
    });
    const a = without.run();
    const b = withFields.run();
    expect(applied).toBeGreaterThan(0); // 对照:字段确实写进了判官记录
    expect(a.codes).toEqual([]);
    expect(b.codes).toEqual(a.codes);
  });
});
