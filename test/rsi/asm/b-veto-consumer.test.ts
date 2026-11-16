/**
 * B2 ③:消费方未接线时 `rsi veto` 不得报完整成功(`veto_consumer_unwired_not_success`;设计稿 v2 §5)。既有 W8b veto 用例的夹具(`makeFx`)模拟「消费方已接线」,
 * 这里钉住缺省(未接线)的行为,并用同一夹具的已接线对照证明判据确实是 `consumers` 而不是别的。
 */
import { describe, expect, it } from 'vitest';
import { runWrite, makeFx } from '../auto/write-fixture.js';
import { canaryRec, world7, ID } from '../rollback/w7-fixture.js';
import { rec } from '../personal/transition-fixture.js';

describe('veto_consumer_unwired_not_success', () => {
  it.each([
    [
      '终态候选(只写黑名单)',
      () => world7({ record: rec('rolled_back', { terminal_reason: 'cleared' }) }),
    ],
    ['未部署候选(直接 rejected)', () => world7({ record: rec('shadow') })],
    ['已部署候选(回滚)', () => world7({ record: canaryRec() })],
  ] as const)(
    '%s:账已提交但消费方未接线 → 退 1,stdout 含 consumer=unwired;对照:已接线退 0',
    async (_n, mk) => {
      const wired = makeFx(mk());
      expect((await runWrite('veto', [ID], wired)).code).toBe(0);

      const fx = makeFx(mk());
      const { consumers: _c, ...rest } = fx.ports;
      void _c;
      const r = await runWrite('veto', [ID], fx, { ports: rest });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`veto: id=${ID} consumer=unwired`);
      // 账 / 记录的写入照常发生(权威状态已提交):只是不报完整成功
      expect(fx.sink.keys.has(`veto:${ID}:${'a'.repeat(64)}`) || fx.sink.keys.size > 0).toBe(true);
    },
  );

  it('veto --lift 不受影响(只解除黑名单,不声称否决生效):未接线也退 0', async () => {
    const fx = makeFx(world7({ record: rec('rolled_back', { terminal_reason: 'vetoed' }) }));
    const { consumers: _c, ...rest } = fx.ports;
    void _c;
    expect((await runWrite('veto', ['--lift', ID], fx, { ports: rest })).code).toBe(0);
  });
});
