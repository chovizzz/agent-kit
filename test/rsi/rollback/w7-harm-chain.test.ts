/**
 * W6 harm → W1 `rolling_back` → W7 执行器的串接:纯编排;只对 `harm` 结论产出;能力闸;凭据先于记录;缺端口 fail-closed。
 */
import { describe, expect, it } from 'vitest';
import type { AnalysisOutcome } from '../../../src/rsi/analysis/run.js';
import { onAnalysisOutcome } from '../../../src/rsi/personal/harm-chain.js';
import { unwiredPayloadSync } from '../../../src/rsi/personal/rollback-ports.js';
import { V1A, ID, SHA, canaryRec, recordOf, world7 } from './w7-fixture.js';

/** 只填被 `harmEvent` 读的字段的 harm 结论 */
function harmOutcome(metric: 'c1' | 'c4' = 'c1'): AnalysisOutcome {
  return {
    kind: 'harm',
    analysis: {
      plan_version: 1,
      harm:
        metric === 'c4'
          ? { metric: 'c4', k: 0, t: 0, p: null, boundary: null }
          : { metric: 'c1', k: 3, t: 0.5, p: 0.01, boundary: 0.02 },
      c4: { bytes: 2000, limit: 1536 },
    },
  } as unknown as AnalysisOutcome;
}

describe('串接', () => {
  it('harm 结论 → 候选走完四段:凭据 by=worker reason=harm_c1,记录 rolled_back / auto_rollback', async () => {
    const w = world7();
    const r = await onAnalysisOutcome(w.d, harmOutcome(), canaryRec());
    expect(r).toMatchObject({ kind: 'rolled', outcome: { status: 'complete' } });
    expect(w.revs[0]).toMatchObject({
      by: 'worker',
      reason: 'harm_c1',
      candidate_id: ID,
      content_sha256: SHA,
    });
    expect(recordOf(w).terminal_reason).toBe('auto_rollback');
  });

  it('C4 越限也是 harm(reason=harm_c4)', async () => {
    const w = world7();
    await onAnalysisOutcome(w.d, harmOutcome('c4'), canaryRec());
    expect(w.revs[0]?.reason).toBe('harm_c4');
  });

  it.each([['no_harm'], ['no_decision'], ['paused'], ['unavailable']])(
    '结论 %s → 不产出事件,什么都不写',
    async (kind) => {
      const w = world7();
      const r = await onAnalysisOutcome(w.d, { kind } as unknown as AnalysisOutcome, canaryRec());
      expect(r).toEqual({ kind: 'no_event' });
      expect(w.txns.size).toBe(0);
      expect(w.revs).toHaveLength(0);
      expect(recordOf(w).lifecycle).toBe('canary');
    },
  );

  it('候选不在 canary / rolling_back → 拒绝,不写 journal 与凭据', async () => {
    const w = world7();
    const r = await onAnalysisOutcome(w.d, harmOutcome(), {
      ...canaryRec(),
      lifecycle: 'shadow',
      deploy: { claude: 'none', pi: 'none', codex: 'none' },
    });
    expect(r).toEqual({ kind: 'refused', why: 'not_canary' });
    expect(w.txns.size).toBe(0);
  });

  it('能力闸:相位未到 V1b(rollback_four_phase)→ 拒绝,不写任何东西', async () => {
    const w = world7({ phase: V1A });
    expect(await onAnalysisOutcome(w.d, harmOutcome(), canaryRec())).toEqual({
      kind: 'refused',
      why: 'phase_not_available',
    });
    expect(w.revs).toHaveLength(0);
    expect(w.txns.size).toBe(0);
  });

  it('生产缺端口(payload 没装配):执行器 incomplete,凭据已落盘(hint 已停),journal 保留 —— 不假装完成', async () => {
    const w = world7();
    w.d.payload = unwiredPayloadSync;
    const r = await onAnalysisOutcome(w.d, harmOutcome(), canaryRec());
    expect(r).toMatchObject({
      kind: 'rolled',
      outcome: { status: 'incomplete', why: 'port_not_wired:payload_sync', cause: 'not_wired' },
    });
    expect(w.revs).toHaveLength(1);
    expect(w.txns.size).toBe(1);
  });

  it('仓库 deferred(人工分叉)时 harm:凭据照样落盘 —— hint 停止注入不依赖私有仓库', async () => {
    const w = world7();
    w.store.mode = 'deferred';
    await onAnalysisOutcome(w.d, harmOutcome(), canaryRec());
    expect(w.revs).toHaveLength(1);
    expect(recordOf(w).lifecycle).toBe('canary'); // 记录推进被推迟
  });
});
