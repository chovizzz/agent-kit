/**
 * `FactsProvider`(含 `holdFacts`)契约套件:假件与真组合层**同跑**。
 * 契约:默认世界给出手写期望;任一**依赖的**读端口读失败 → `null`;**不依赖的**端口失败不影响结果(正向对照);
 * `lock_lost` 对每个依赖端口都原样传播(不吞成 `null`);`holdFacts` 恒为两码 `unavailable`、每次返回新对象;输出不含测试密钥。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import type { FactsProviderD1a } from '../../../src/rsi/personal/facts/facts-ports.js';
import { leaksValue } from './d1a-fixture.js';
import {
  DEPENDS,
  expectedGate,
  expectedPromote,
  makeWorld,
  type Failure,
  type FactsWorld,
} from './facts-world.js';

export type MakeFacts = (w: FactsWorld, failure: Failure) => FactsProviderD1a;

const ALL = [
  'staged',
  'signals',
  'presets',
  'head',
  'ledger',
  'classifier',
  'taint',
  'policy',
  'context',
] as const;

export function runFactsContract(name: string, make: MakeFacts): void {
  describe(`FactsProvider 契约:${name}`, () => {
    it('默认世界:gateFacts / promoteFacts 等于手写期望(sessions / hits 恒 0)', async () => {
      const w = makeWorld();
      const p = make(w, null);
      expect(await p.gateFacts(w.rec, w.wc)).toEqual(expectedGate(w));
      expect(await p.promoteFacts(w.rec, w.wc)).toEqual(expectedPromote(w));
    });

    for (const dep of ALL) {
      for (const kind of ['gate', 'promote'] as const) {
        const depends = DEPENDS[kind].includes(dep);
        it(`读端口 ${dep} 读失败:${kind}Facts ${depends ? '= null' : '不受影响(正向对照)'}`, async () => {
          const w = makeWorld();
          const p = make(w, { reader: dep, mode: 'error' });
          const got =
            kind === 'gate' ? await p.gateFacts(w.rec, w.wc) : await p.promoteFacts(w.rec, w.wc);
          if (depends) expect(got).toBeNull();
          else expect(got).toEqual(kind === 'gate' ? expectedGate(w) : expectedPromote(w));
        });

        it(`读端口 ${dep} 锁丢失:${kind}Facts ${depends ? '原样抛 lock_lost(不吞成 null)' : '不受影响(正向对照)'}`, async () => {
          const w = makeWorld();
          const p = make(w, { reader: dep, mode: 'lock_lost' });
          const run = (): Promise<unknown> =>
            kind === 'gate' ? p.gateFacts(w.rec, w.wc) : p.promoteFacts(w.rec, w.wc);
          if (depends) {
            const e = await run().then(
              () => undefined,
              (x: unknown) => x,
            );
            expect(e).toBeInstanceOf(RsiLockError);
            expect((e as RsiLockError).kind).toBe('lock_lost');
          } else {
            expect(await run()).toEqual(kind === 'gate' ? expectedGate(w) : expectedPromote(w));
          }
        });
      }
    }

    it('holdFacts:budget_high_legacy / cost_high_legacy 恒 unavailable(只少一道熔断,不放行);每次返回新对象', () => {
      const w = makeWorld();
      const p = make(w, null);
      const a = p.holdFacts();
      expect(a).toEqual({ budget_high_legacy: 'unavailable', cost_high_legacy: 'unavailable' });
      (a as { budget_high_legacy: string }).budget_high_legacy = 'ok';
      expect(p.holdFacts()).toEqual({
        budget_high_legacy: 'unavailable',
        cost_high_legacy: 'unavailable',
      });
    });

    it('输出不含测试密钥(三种编码)', async () => {
      const w = makeWorld();
      const p = make(w, null);
      expect(leaksValue(await p.gateFacts(w.rec, w.wc))).toBe(false);
      expect(leaksValue(await p.promoteFacts(w.rec, w.wc))).toBe(false);
    });
  });
}
