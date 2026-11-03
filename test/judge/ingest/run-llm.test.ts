/**
 * N4 ⑧:`judge --run-llm` 接入(R20-18.21,行为翻转):已确认反思器侧的 session_declared 提案此后可被评审,产出仍是 `spawned` 记录并显式带 provenance;
 * 未确认的仍 fail-closed(JUDGE_VENDOR_UNKNOWN);既有 session_confirmed 裁决被跳过(R20-18.8)。
 */
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ProposalSchema } from '../../../src/contracts/proposal.js';
import { reflectorBindingFor } from '../../../src/contracts/judge-binding.js';
import { vendorEvidence } from '../../../src/contracts/vendor.js';
import { runJudge } from '../../../src/judge/run.js';
import * as safe from '../../../src/io/safe-fs.js';
import { readText } from '../../../src/io/read-fs.js';
import {
  FROZEN_NOW,
  makeStubs,
  newWork,
  rawJudgeProvenance,
  readSpawnedProposal,
  redactor,
  RUN_ID,
  snapshot,
} from '../helpers.js';
import type { Work } from '../helpers.js';
import { writeSessionProposal } from './fixtures.js';

const go = (w: Work, stubs: ReturnType<typeof makeStubs>, dry = false) =>
  runJudge(
    {
      io: w.io,
      redactor,
      backends: stubs.backends,
      now: () => FROZEN_NOW,
      resolveHead: () => w.head,
    },
    { runId: RUN_ID, dry, maxCalls: 5 },
  );

async function confirmReflector(
  w: Work,
  file: string,
  vendor: string,
  model: string,
): Promise<void> {
  const raw = parse(await readText(file)) as Record<string, unknown>;
  const p = ProposalSchema.parse(raw);
  const base = {
    vendor,
    model,
    method: 'tty_typed_vendor' as const,
    confirmed_at: '2026-10-14T05:41:00Z',
    kit_version: '0.2.0',
  };
  (raw['reflector'] as Record<string, unknown>)['confirmed'] = {
    ...base,
    binding_sha256: reflectorBindingFor(p, base),
  };
  await safe.writeFile(w.io, file, stringify(raw, { lineWidth: 0 }), { mode: 0o600 });
}

describe('R20-18.21 judge --run-llm 接入', () => {
  it('未确认的 session_declared 提案:仍 fail-closed(JUDGE_VENDOR_UNKNOWN),零调用零写入', async () => {
    const w = await newWork();
    await writeSessionProposal(w, { layer: 'personal', target: 'p-rule' });
    const before = await snapshot(w.runDir);
    const s = makeStubs();
    await expect(go(w, s)).rejects.toThrow('JUDGE_VENDOR_UNKNOWN');
    expect(s.totalCalls()).toBe(0);
    expect(await snapshot(w.runDir)).toEqual(before);
  });
  it('行为翻转:反思器侧确认(anthropic)后可评审;产出 spawned,磁盘上显式带 provenance: spawned;证据 = self_confirmed 反思器 + proven 裁判', async () => {
    const w = await newWork();
    const a = await writeSessionProposal(w, { layer: 'personal', target: 'p-rule' });
    await confirmReflector(w, a.file, 'anthropic', 'claude-example');
    const s = makeStubs();
    const rep = await go(w, s);
    expect(rep.outcomes[0]).toMatchObject({
      status: 'judged',
      judgeProvenance: 'spawned',
      wrote: true,
    });
    expect(s.byHop.codex.calls).toHaveLength(1);
    expect(await rawJudgeProvenance(a.file)).toBe('spawned');
    const p = await readSpawnedProposal(a.file);
    expect(p.judge?.provider).toBe('codex');
    const ev = vendorEvidence(p as never);
    expect(ev.ok).toBe(true);
    expect([ev.reflector.tier, ev.judge.tier]).toEqual(['self_confirmed', 'proven']);
  });
  it('确认的厂商参与同厂商判定:反思器确认为 openai → codex 跳 skipped:same-vendor,改由下一家评审', async () => {
    const w = await newWork();
    const a = await writeSessionProposal(w, { layer: 'personal', target: 'p-rule' });
    await confirmReflector(w, a.file, 'openai', 'gpt-example');
    const s = makeStubs();
    const rep = await go(w, s);
    expect(s.byHop.codex.calls).toHaveLength(0);
    expect(rep.outcomes[0]?.hops[0]).toMatchObject({ hop: 'codex', result: 'skipped:same-vendor' });
    const p = await readSpawnedProposal(a.file);
    expect(p.judge?.vendor).toBe('deepseek');
    expect(ProposalSchema.safeParse(parse(await readText(a.file))).success).toBe(true);
  });
  it('全链无成功时写的 judge_attempts 以有效反思器厂商记 same-vendor 跳,自己的 schema 接受(否则确认后 judge --run-llm 的产出会被自己拒绝)', async () => {
    const w = await newWork();
    const a = await writeSessionProposal(w, { layer: 'personal', target: 'p-rule' });
    await confirmReflector(w, a.file, 'openai', 'gpt-example');
    const s = makeStubs({}, ['codex']);
    const rep = await go(w, s);
    expect(rep.outcomes[0]).toMatchObject({ status: 'pending', pending: 'same_vendor_only' });
    const p = ProposalSchema.parse(parse(await readText(a.file)));
    expect(p.judge_attempts?.[0]).toMatchObject({ hop: 'codex', result: 'skipped:same-vendor' });
  });
  it('既有 session_confirmed 裁决:judge --run-llm 跳过(not_measurable 口径),不调用,outcome 标注来源', async () => {
    const w = await newWork();
    const a = await writeSessionProposal(w, { layer: 'personal', target: 'p-rule' });
    await confirmReflector(w, a.file, 'anthropic', 'claude-example');
    // 借 ingest 服务写入自报裁决
    const { runJudgeIngest } = await import('../../../src/judge/ingest/service.js');
    const { FakeTty, makeDeps, payloadText } = await import('./fixtures.js');
    const out = await runJudgeIngest(makeDeps(w, { tty: new FakeTty(['openai']) }), {
      mode: 'ingest',
      runId: RUN_ID,
      write: true,
      replace: false,
      proposalFilter: [],
      payloadText: payloadText([{ id: a.id, rule_sha256: a.ruleSha }]),
    });
    expect(out.kind).toBe('written');
    const s = makeStubs();
    const rep = await go(w, s);
    expect(s.totalCalls()).toBe(0);
    expect(rep.outcomes[0]).toMatchObject({
      status: 'already_judged',
      judgeProvenance: 'session_confirmed',
      hops: [],
      verdict: 'accept',
    });
  });
  it('干跑也走同一判定;spawned 提案的评审计划不因本改动变化', async () => {
    const w = await newWork();
    await writeSessionProposal(w, { layer: 'personal', target: 'p-rule', provenance: 'spawned' });
    const s = makeStubs();
    const rep = await go(w, s, true);
    expect(rep.outcomes[0]?.status).toBe('planned');
  });
});
