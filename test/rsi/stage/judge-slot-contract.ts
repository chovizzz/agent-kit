/**
 * W9 判决槽的**共享契约测试**(C 定义槽、W9b 提供实现;W9b 与 D 通过它才算可并行):任何「声明缺能力 / 未装配」的槽实现,
 * 都必须满足「缺能力 / 未装配 / 读失败 = 拒绝,绝不缺省为通过」。C1a 用它测 `UNAVAILABLE_JUDGE` 与一个符合性替身;W9b 的真实现在「判决源不可读」夹具下复用同一份。
 */
import { describe, expect, it } from 'vitest';
import {
  checkJudgeGrowth,
  normalizeJudgeReport,
  type JudgeSlots,
} from '../../../src/rsi/personal/judge-slot.js';
import { rec } from './c1-fixture.js';

const SOURCE = { run_id: 'run-1', proposal_id: 'p-1' };

/** `mk()` 必须返回「判决能力不可用」状态下的槽(缺省实现、或真实现在判决源不可读时) */
export function judgeSlotUnavailableContract(name: string, mk: () => JudgeSlots): void {
  describe(`判决槽共享契约(不可用状态):${name}`, () => {
    it('check:带 source_proposal 的记录 → 拒绝(judge_unavailable 或 judge_indeterminate),绝不是 ok', async () => {
      const v = await checkJudgeGrowth(mk().growth, rec(SOURCE));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(['judge_unavailable', 'judge_indeterminate']).toContain(v.code);
    });

    it('check:source_proposal 为 null / 缺失 → ok(契约:null = 不消费;来源缺失由 evaluateGrowth 的 G6 另行拒绝)', async () => {
      expect(await checkJudgeGrowth(mk().growth, rec(null))).toEqual({ ok: true });
      expect(await checkJudgeGrowth(mk().growth, rec(undefined))).toEqual({ ok: true });
    });

    it('run:永不抛、报告通过运行期校验;不转移任何候选;不报告 halted(空操作)', async () => {
      for (const args of [{}, { ids: [] }, { ids: ['a', 'b'] }]) {
        const r = normalizeJudgeReport(await mk().reduce.run(args));
        expect(r).not.toBeNull();
        expect(r?.transitioned).toEqual([]);
        expect(r?.halted).toBeNull();
        expect(r?.evaluated).toBe(0);
      }
    });

    it('run:报告 unavailable=true(让调用方看得见「判决没做」)', async () => {
      expect((await mk().reduce.run({})).unavailable).toBe(true);
    });
  });
}
