/**
 * W0-16 效果续做:终态效果由已提交的终态记录确定性推出,按键幂等落地;提交后崩溃 / 落地失败不丢、不重复。
 */
import { describe, expect, it } from 'vitest';
import {
  effectsForTerminal,
  landTerminalEffects,
  recoverTerminalEffects,
  terminalEffectKey,
} from '../../../src/rsi/personal/effects-recover.js';
import { transition, isRefusal } from '../../../src/rsi/personal/transition.js';
import { ctxFor, rec } from '../personal/transition-fixture.js';
import { resumeAll, startRollback } from '../../../src/rsi/personal/rollback.js';
import { ID, SHA, harmReq, recordOf, world7 } from './w7-fixture.js';

describe('effectsForTerminal:与转移引擎在「非终态 → 终态」时产出的效果逐项一致', () => {
  it.each([
    ['vetoed', 'veto'],
    ['cleared', 'clear'],
    ['tainted', 'taint'],
  ] as const)(
    'shadow 上 %s:引擎效果(去掉 commit / 审计)== 由终态记录推出的效果',
    (_reason, kind) => {
      const s = rec('shadow');
      const r = transition(s, { kind, evidence: 'e' }, ctxFor(s, { phase: 1 }));
      if (isRefusal(r)) throw new Error('应成功');
      const engine = r.effects.filter(
        (e) => e.type !== 'commit_lifecycle' && e.type !== 'append_audit',
      );
      expect(effectsForTerminal(r.next)).toEqual(engine);
    },
  );

  it('auto_rollback 终态带 90 日冷却;expired 带 30 日冷却;人工终态没有冷却;非终态为空', () => {
    expect(
      effectsForTerminal(rec('rolled_back', { terminal_reason: 'auto_rollback' })).map(
        (e) => e.type,
      ),
    ).toEqual(['write_tombstone', 'start_cooldown']);
    expect(
      effectsForTerminal(rec('expired', { terminal_reason: 'auto_expired' })).map((e) => e.type),
    ).toEqual(['write_tombstone', 'start_cooldown']);
    expect(
      effectsForTerminal(rec('rolled_back', { terminal_reason: 'cleared' })).map((e) => e.type),
    ).toEqual(['write_tombstone']);
    expect(effectsForTerminal(rec('canary'))).toEqual([]);
    expect(effectsForTerminal(rec('rolling_back'))).toEqual([]);
  });

  it('键 = 候选 id + 内容哈希:同一候选的同一份内容只有一次终态效果', () => {
    expect(terminalEffectKey(rec('rejected'))).toBe(`terminal:${ID}:${SHA}`);
  });
});

describe('landTerminalEffects / recoverTerminalEffects', () => {
  it('非终态不落地(none);终态落地一次后同键 already', async () => {
    const w = world7({ record: rec('canary') });
    expect(await landTerminalEffects(w.d.keyedEffects, rec('canary'))).toBe('none');
    const done = rec('rejected');
    expect(await landTerminalEffects(w.d.keyedEffects, done)).toBe('applied');
    expect(await landTerminalEffects(w.d.keyedEffects, done)).toBe('already');
    expect([...w.effectApplied.values()]).toEqual([1]);
  });

  it('提交后效果没落地(落地失败):扫终态记录补齐;失败不抛、记入 failed,下一次再来;之后 already,不重复', async () => {
    const w = world7({ record: rec('rejected') });
    w.keyedMode.value = 'throw';
    const first = await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect(first.failed).toEqual([{ id: ID, why: 'effects down' }]);
    expect(first.applied).toEqual([]);
    w.keyedMode.value = 'applied';
    const second = await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect(second.applied).toEqual([ID]);
    const third = await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect(third).toMatchObject({ applied: [], already: [ID], failed: [] });
    expect([...w.effectApplied.values()]).toEqual([1]);
  });

  it('缩减入口等不能访问效果存放处的调用方:deferred 记待对账(不当作已落地)', async () => {
    const w = world7({ record: rec('rejected') });
    w.keyedMode.value = 'deferred';
    const r = await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect(r).toMatchObject({ deferred: [ID], applied: [] });
    expect(w.effectApplied.size).toBe(0);
  });

  it('权威副本读不到(deferred / invalid / absent)→ skipped,无任何落地', async () => {
    const w = world7({ record: rec('rejected') });
    w.store.mode = 'deferred';
    const r = await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect(r.skipped).toBe('deferred');
    expect(w.effectLog.size).toBe(0);
  });

  it('回滚执行器:效果落地失败 → journal 保留(不删),修好后续做恰好落地一次', async () => {
    const w = world7();
    w.keyedMode.value = 'throw';
    await expect(startRollback(w.d, harmReq())).rejects.toThrow('effects down');
    expect(w.txns.size).toBe(1); // journal 还在,效果没丢
    expect(recordOf(w).lifecycle).toBe('rolled_back'); // 权威副本已提交
    w.keyedMode.value = 'applied';
    expect((await resumeAll(w.d))[0]?.status).toBe('complete');
    expect(w.txns.size).toBe(0);
    expect([...w.effectApplied.values()]).toEqual([1]);
  });
});
