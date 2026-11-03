/**
 * N4 ④(R20-18.19 ③④):自报裁决可以走到 active(Q-N4-2 = A:K4 冻结核验对两种来源同形),
 * 但以 `session_confirmed` 为裁判的晋升按「校准不可用」处理:发 `GUARD_G3_CALIBRATION_SELF_REPORTED`(warn)并多要 STRICT_EXTRA_TILES 块。
 * 世界 = K4 的合成仓库(真 git 提交),`proposalTransform` 把冻结提交里的 spawned 裁决换成同一份 acceptance / prediction 上的自报裁决。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ProposalSchema } from '../../src/contracts/proposal.js';
import { judgeBindingSha256 } from '../../src/contracts/judge-binding.js';
import type { SessionConfirmedJudgeRecord } from '../../src/contracts/proposal.js';
import { STRICT_EXTRA_TILES } from '../../src/contracts/config.js';
import { buildWorld, twoTiles } from './frozen-world.js';
import { useRepoCleanup } from './helpers.js';

useRepoCleanup();
const G = (c: string): string => `GUARD_G3_${c}`;

/** 把带 spawned 裁决的提案 yaml 换成同一份冻结协议上的 session_confirmed 裁决(无 judge 的 yaml 原样) */
function toSelfReported(yaml: string): string {
  const doc = parseYaml(yaml) as Record<string, unknown> & { judge?: Record<string, unknown> };
  if (doc.judge === undefined) return yaml;
  const { judge, ...rest } = doc;
  const base = ProposalSchema.parse(rest);
  const draft = {
    provenance: 'session_confirmed',
    verdict: judge['verdict'],
    overfit_risk: judge['overfit_risk'],
    injection_suspected: judge['injection_suspected'],
    conflicts: judge['conflicts'],
    rule_sha256: judge['rule_sha256'],
    prediction: judge['prediction'],
    acceptance: judge['acceptance'],
    declared: { agent: 'codex', vendor: 'openai', model: 'gpt-example' },
    confirmation: {
      method: 'tty_typed_vendor',
      confirmed_at: '2026-10-08T00:00:00Z',
      kit_version: '0.2.0',
      payload_sha256: '1'.repeat(64),
      binding_sha256: '0'.repeat(64),
    },
  } as unknown as SessionConfirmedJudgeRecord;
  const bound = {
    ...draft,
    confirmation: { ...draft.confirmation, binding_sha256: judgeBindingSha256(base, draft) },
  };
  return stringifyYaml({ ...rest, judge: bound });
}

describe('R20-18.19 ③④ 自报裁决的 T2(advisory → active)', () => {
  it('正向对照:spawned 裁决 + 两块 attest → 绿,没有 SELF_REPORTED', async () => {
    const w = await buildWorld({ attests: twoTiles() });
    const r = w.run();
    expect(r.codes).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).not.toContain(G('CALIBRATION_SELF_REPORTED'));
  });
  it('session_confirmed 裁判:K4 冻结核验同形放行(无 ACCEPTANCE_*),但发 CALIBRATION_SELF_REPORTED(warn),有效块数 +STRICT_EXTRA_TILES → THRESHOLD_TILES', async () => {
    const w = await buildWorld({ attests: twoTiles(), proposalTransform: toSelfReported });
    const r = w.run();
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain(G('CALIBRATION_SELF_REPORTED'));
    expect(r.diagnostics.find((d) => d.code === G('CALIBRATION_SELF_REPORTED'))?.severity).toBe(
      'warn',
    );
    expect(r.codes.filter((c) => c.startsWith('GUARD_G3_ACCEPTANCE'))).toEqual([]);
    // 加严:多要的块数写进原因,且两块不够
    expect(r.codes).toContain(G('THRESHOLD_TILES'));
    const msg = r.diagnostics.find((d) => d.code === G('THRESHOLD_TILES'))?.message ?? '';
    expect(msg).toContain(`+${STRICT_EXTRA_TILES} 块`);
    // 只有校准加严这一项红:判官记录本身(自报、跨厂商)通过 judgeChecks
    expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual([
      G('THRESHOLD_TILES'),
    ]);
  });
});
