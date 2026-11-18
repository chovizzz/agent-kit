/**
 * D1b-2:转移事件的增影响分类(`growth-events.ts`;I10)。穷举:`TransitionEventSchema` 的每个 `kind` 恰落入一类,新增事件未分类 = 红;
 * 运行期对未登记的 kind(跨信任边界的脏值)按 `unmappable` 拒绝,**不**当成减影响放行。
 */
import { describe, expect, it } from 'vitest';
import { GROWTH_EVENT_CLASS, growthOpOfEvent } from '../../../src/rsi/personal/growth-events.js';
import {
  TransitionEventSchema,
  type EventKind,
} from '../../../src/rsi/personal/transition-table.js';

const KINDS = TransitionEventSchema.options.map((o) => o.shape.kind.value) as EventKind[];

describe('event_kind_classified:增影响分类穷举', () => {
  it('分类表的键恰等于 schema 的全部事件 kind(新增事件未分类 = 红;多登记不存在的 kind 也红)', () => {
    expect(KINDS.length).toBeGreaterThanOrEqual(17);
    expect(Object.keys(GROWTH_EVENT_CLASS).sort()).toEqual([...KINDS].sort());
  });

  it('每个 kind 的分类值合法:三个 op 之一 / unmappable / null(减影响)', () => {
    for (const k of KINDS) {
      const c = growthOpOfEvent(k);
      expect(
        c === null ||
          c === 'unmappable' ||
          c === 'candidate_create' ||
          c === 'shadow_to_canary' ||
          c === 'deploy_inject',
        k,
      ).toBe(true);
    }
  });

  it('增影响类:gates_passed → candidate_create(owner Q3)、shadow_promote → shadow_to_canary、deploy_inject → deploy_inject', () => {
    expect(growthOpOfEvent('gates_passed')).toBe('candidate_create');
    expect(growthOpOfEvent('shadow_promote')).toBe('shadow_to_canary');
    expect(growthOpOfEvent('deploy_inject')).toBe('deploy_inject');
  });

  it('decide_better 无对应 op → unmappable(恒拒)', () => {
    expect(growthOpOfEvent('decide_better')).toBe('unmappable');
  });

  it('减影响类(终止 / 回滚 / 对账 / 到期 / 无命中 / 闸红 / 补偿 / 移除)= null:不走授权、不受暂停限制', () => {
    const reducing: EventKind[] = [
      'gate_red',
      'shadow_no_hit',
      'shadow_queue_expired',
      'veto',
      'taint',
      'clear',
      'revocation_reconcile',
      'judge_reject',
      'harm',
      'canary_limit',
      'rollback_advance',
      'removal_done',
      'compensation_done',
    ];
    for (const k of reducing) expect(growthOpOfEvent(k), k).toBeNull();
    // 其余恰是增影响 / 恒拒 4 个:没有第三种漏网
    const rest = KINDS.filter((k) => !reducing.includes(k)).sort();
    expect(rest).toEqual(['decide_better', 'deploy_inject', 'gates_passed', 'shadow_promote']);
  });

  it('growth_event_unclassified:未登记 / 脏 kind(含原型链键)→ unmappable,绝不返回 null(null = 免授权)', () => {
    for (const k of ['brand_new', '', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(growthOpOfEvent(k as EventKind), k).toBe('unmappable');
    }
    expect(growthOpOfEvent(undefined as unknown as EventKind)).toBe('unmappable');
    expect(growthOpOfEvent(7 as unknown as EventKind)).toBe('unmappable');
  });

  it('分类表是冻结的(运行期不可改)', () => {
    expect(Object.isFrozen(GROWTH_EVENT_CLASS)).toBe(true);
  });
});
