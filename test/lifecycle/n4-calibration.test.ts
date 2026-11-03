/**
 * N4 ④(R20-18.19 ④ K5a 校准账):`session_confirmed` 记录永不计入任何校准键的历史,也不让整本账 unavailable。
 * 用假 git(单提交历史)直接喂 `computeCalibration`。
 */
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LifecycleCoreConfigSchema } from '../../src/contracts/config.js';
import { computeCalibration, calibrationStrictReasons } from '../../src/lifecycle/calibration.js';
import type { GuardGit } from '../../src/guards/types.js';
import { baseProposal, withSessionJudge } from '../contracts/n4-fixtures.js';

const PATH = 'proposals/2026-09-01-001.yaml';

function envFor(yaml: string) {
  const git: GuardGit = {
    resolveCommit: () => 'c'.repeat(40),
    changes: () => [],
    blobText: () => '',
    textAt: () => yaml,
    stableTagCommits: () => [],
    isAncestor: () => true,
    listFiles: () => [],
    fileHistory: () => [{ commit: 'c'.repeat(40), date: '2026-10-07' }],
  };
  return {
    git,
    baseOid: 'c'.repeat(40),
    baseView: (p: string) => (p === PATH ? yaml : undefined),
    listBase: (dir: string) => (dir === 'proposals' ? [PATH] : []),
    cfg: LifecycleCoreConfigSchema.parse({}),
    roster: new Map<string, string | undefined>(),
    excludeProposalId: '2099-01-01-001',
    target: { vendor: 'openai', model: 'gpt-example' },
  };
}

describe('R20-18.19 ④ 校准账排除自报记录', () => {
  it('历史里有 session_confirmed 记录:不进任何键、不产生 unreadable / unavailable、seen 为空', () => {
    const p = withSessionJudge(baseProposal(), { vendor: 'openai', model: 'gpt-example' });
    const out = computeCalibration(
      envFor(stringify(JSON.parse(JSON.stringify(p)), { lineWidth: 0 })),
    );
    expect(out.unavailable).toBeUndefined();
    expect(out.unreadable).toEqual([]);
    expect(out.seen).toEqual([]);
    expect(out.tiers.every((t) => t.n === 0)).toBe(true);
    expect(out.counts.entries).toBe(0);
    expect(calibrationStrictReasons(out)).toEqual([]);
  });
  it('正向对照:没有 judge 的提案同样不产生条目(基线);损坏的 judge(非对象)仍让账 unavailable——排除只针对 session_confirmed', () => {
    const none = computeCalibration(
      envFor(stringify(JSON.parse(JSON.stringify(baseProposal())), { lineWidth: 0 })),
    );
    expect(none.unavailable).toBeUndefined();
    const raw = JSON.parse(JSON.stringify(baseProposal())) as Record<string, unknown>;
    raw['judge'] = 'garbage';
    expect(computeCalibration(envFor(stringify(raw))).unavailable).toContain('judge 不是对象');
  });
  it('一个无法读出 vendor / 最后一跳 model 的 spawned 记录仍让账 unavailable(自报的特例没有放宽 spawned 的口径)', () => {
    const raw = JSON.parse(JSON.stringify(baseProposal())) as Record<string, unknown>;
    raw['judge'] = { provenance: 'spawned', verdict: 'accept' };
    expect(computeCalibration(envFor(stringify(raw))).unavailable).toContain('读不出 vendor/model');
  });
});
