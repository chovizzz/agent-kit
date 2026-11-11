/**
 * R21-4.3 合法组合矩阵全量(12 个 lifecycle × 6³ 个 deploy 组合 = 2592 格):非法一律 `candidate_invalid`(含 V2 才可达的组合)。
 * 期望值由本文件**照契约原文手写**的 oracle 给出,不调用 `deployMatrixViolation`(否则是同义反复)。
 */
import { describe, expect, it } from 'vitest';
import { RSI_DEPLOY_STATES, RSI_LIFECYCLE_STATES } from '../../../src/contracts/rsi.js';
import { isRefusal, transition } from '../../../src/rsi/personal/transition.js';
import { E, ctxFor, rec } from './transition-fixture.js';

const LIFECYCLES = [
  'proposed',
  'shadow',
  'blocked',
  'canary',
  'adopted',
  'stable',
  'retiring',
  'rolling_back',
  'rejected',
  'expired',
  'rolled_back',
  'retired',
] as const;
const DEPLOYS = [
  'none',
  'injected',
  'static_pending',
  'static',
  'withdraw_pending',
  'removal_pending',
] as const;

/** 契约 R21-4.3 原文:其余 = candidate_invalid */
function legal(lc: string, claude: string, pi: string, codex: string): boolean {
  const all = [claude, pi, codex];
  if (
    ['proposed', 'shadow', 'blocked', 'rejected', 'expired', 'rolled_back', 'retired'].includes(lc)
  ) {
    return all.every((v) => v === 'none');
  }
  if (lc === 'canary' || lc === 'adopted') {
    return codex === 'none' && [claude, pi].every((v) => v === 'none' || v === 'injected');
  }
  if (lc === 'stable') return true;
  if (lc === 'rolling_back' || lc === 'retiring') {
    return all.every((v) => v === 'none' || v === 'removal_pending');
  }
  throw new Error(`oracle 未覆盖 ${lc}`);
}

describe('R21-4.3 合法组合矩阵(逐格)', () => {
  it('夹具前提:状态与部署枚举与契约一致(防枚举漂移后矩阵静默缩水)', () => {
    expect([...LIFECYCLES].sort()).toEqual([...RSI_LIFECYCLE_STATES].sort());
    expect([...DEPLOYS].sort()).toEqual([...RSI_DEPLOY_STATES].sort());
  });

  it('R21-4.3 全 2592 格:合法格不是 candidate_invalid;非法格一律 candidate_invalid;合法格数 = 247', () => {
    let legalCells = 0;
    let illegalCells = 0;
    let total = 0;
    for (const lc of LIFECYCLES) {
      for (const claude of DEPLOYS) {
        for (const pi of DEPLOYS) {
          for (const codex of DEPLOYS) {
            total++;
            const ok = legal(lc, claude, pi, codex);
            const r = rec(lc, { deploy: { claude, pi, codex } });
            const res = transition(r, E.veto('matrix'), ctxFor(r));
            const code = isRefusal(res) ? res.refused : 'applied';
            if (ok) {
              legalCells++;
              // 正向钉死:合法格走到了别的结果(转移 / 空操作 / 未到期),而不是被矩阵拒绝
              expect(code, `${lc} ${claude}/${pi}/${codex}`).not.toBe('candidate_invalid');
            } else {
              illegalCells++;
              expect(code, `${lc} ${claude}/${pi}/${codex}`).toBe('candidate_invalid');
            }
          }
        }
      }
    }
    expect(total).toBe(12 * 216);
    // 7 个无部署状态 ×1 + canary/adopted ×4 + stable 216 + rolling_back/retiring ×8
    expect(legalCells).toBe(7 + 2 * 4 + 216 + 2 * 8);
    expect(legalCells).toBe(247);
    expect(illegalCells).toBe(2592 - 247);
  });

  it('R21-4.3 抽样明确点名:codex 在 canary 下为 injected → 拒;V2 的 stable 组合合法但本期 phase_not_available', () => {
    const bad = rec('canary', { deploy: { claude: 'none', pi: 'none', codex: 'injected' } });
    const r1 = transition(bad, E.veto('m1'), ctxFor(bad));
    expect(isRefusal(r1) && r1.refused).toBe('candidate_invalid');
    const stable = rec('stable', {
      deploy: { claude: 'static', pi: 'withdraw_pending', codex: 'removal_pending' },
    });
    const r2 = transition(stable, E.veto('m2'), ctxFor(stable));
    expect(isRefusal(r2) && r2.refused).toBe('phase_not_available');
  });
});
