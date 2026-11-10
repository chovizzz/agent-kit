/**
 * §21.24 W0-13 达标 shadow 的推进(纯函数层能表达的部分):M13-1 推进前置逐项、M13-2 权威终态不被旧副本推进、M13-4 名额、
 * M13-5 排队只数 G7 等待、M13-6 到期先于推进、M13-7 `canary_ready_since` 只排序。
 * 锁内重读、入口清零(pause / resume / 配置变化 / 凭据新增 → 先清空全部 queued_since)属 W3 接线,不在本块(见汇报「问题」)。
 */
import { describe, expect, it } from 'vitest';
import {
  decideShadowStep,
  isRefusal,
  pickPromotionHead,
  transition,
  type ShadowStepInput,
  type Transitioned,
} from '../../../src/rsi/personal/transition.js';
import {
  evaluationSlotOccupied,
  queueExpired,
  utcDayDiff,
  type PromoteFacts,
  type TransitionCtx,
} from '../../../src/rsi/personal/transition-table.js';
import { E, FACTS, OTHER_SIG, ctxFor, rec } from './transition-fixture.js';

const QUEUED = '2026-11-05';
const input = (
  o: {
    facts?: Partial<PromoteFacts>;
    ctx?: Partial<TransitionCtx>;
    shadow?: Partial<ShadowStepInput['shadow']>;
    record?: ReturnType<typeof rec>;
  } = {},
): ShadowStepInput => {
  const record = o.record ?? rec('shadow');
  return {
    record,
    ctx: ctxFor(record, o.ctx),
    facts: FACTS(o.facts),
    shadow: { canary_ready_since: null, queued_since: QUEUED, ...o.shadow },
    evidence: 'ev',
  };
};
const at = (day: string): Partial<TransitionCtx> => ({ now: `${day}T08:00:00Z` });

describe('M13-1 前置任一不成立不推进(逐项各一例;queued_since 同时清零)', () => {
  it('M13-1 正向对照:全部成立且名额空闲 → promote,事件交给 transition() 后进入 canary', () => {
    const step = decideShadowStep(input());
    expect(step.action).toBe('promote');
    if (step.action !== 'promote' || step.event === undefined) throw new Error('应当 promote');
    expect(step.blocker).toBeNull();
    expect(step.patch.queued_since).toBeNull();
    const r = rec('shadow');
    const res = transition(r, step.event, ctxFor(r));
    expect(isRefusal(res)).toBe(false);
    expect((res as Transitioned).next.lifecycle).toBe('canary');
  });

  const ITEMS: Array<[string, NonNullable<Parameters<typeof input>[0]>, string]> = [
    ['相位 1(V1b 能力未到期)', { ctx: { phase: 1 } }, 'phase_not_available'],
    ['配置无效', { facts: { config_valid: false } }, 'config_invalid'],
    ['enabled 为假', { facts: { enabled: false } }, 'auto_disabled'],
    ['授权缺', { facts: { authorized: false } }, 'not_authorized'],
    ['taint 命中', { facts: { tainted: true } }, 'tainted'],
    ['冷却中', { facts: { cooldown_active: true } }, 'cooldown_active'],
    ['墓碑命中', { facts: { tombstoned: true } }, 'tombstoned'],
    ['黑名单命中', { facts: { blacklisted: true } }, 'veto_blacklisted'],
    [
      '内容变(content_sha256)',
      { facts: { current_content_sha256: 'b'.repeat(64) } },
      'content_changed',
    ],
    ['签名变', { facts: { current_cluster_signature: { ...OTHER_SIG } } }, 'signature_changed'],
    ['签名不可得', { facts: { current_cluster_signature: null } }, 'signature_changed'],
    ['证据失效', { facts: { evidence_valid: false } }, 'evidence_invalid'],
    ['会话不足 20', { facts: { sessions: 19 } }, 'shadow_sessions_short'],
    ['命中不足 2', { facts: { hits: 1 } }, 'shadow_hits_short'],
    ['撤销凭据列出', { ctx: { revocation_listed: true } }, 'revoked'],
    ['暂停中(auto_paused)', { ctx: { auto_paused: true } }, 'auto_paused'],
    ['自动循环有效条件不成立', { ctx: { auto_loop_effective: false } }, 'auto_loop_not_effective'],
    [
      '旧版记录无 cluster_signature(不参与 shadow)',
      { record: rec('shadow', { cluster_signature: undefined }) },
      'no_cluster_signature',
    ],
    [
      'category=exec(E1 准入 V6a)',
      { record: rec('shadow', { category: 'exec' }) },
      'category_exec_unsupported',
    ],
    ['相位 ≥ V3 而 G8 未实现(fail-closed)', { ctx: { phase: 5 } }, 'g8_not_implemented'],
  ];
  for (const [label, o, code] of ITEMS) {
    it(`M13-1 ${label}:decideShadowStep 不推进、queued_since 清零;transition() 同样拒绝`, () => {
      const step = decideShadowStep(input(o));
      expect(step.action).toBe('wait');
      if (step.action === 'invalid') throw new Error(step.detail);
      expect(step.blocker).toBe(code);
      expect(step.patch.queued_since).toBeNull();
      expect(step.event).toBeUndefined();
      // 引擎侧:同一组事实喂给 shadow_promote 事件,结果是拒绝而不是转移
      const record = o.record ?? rec('shadow');
      const res = transition(record, E.promote('p', FACTS(o.facts)), ctxFor(record, o.ctx));
      expect(isRefusal(res), label).toBe(true);
    });
  }

  it('M13-1 逐项各一例的覆盖:ITEMS 的守卫码两两不同(除 signature_changed 的两种构造),防止一例被复制凑数', () => {
    const codes = ITEMS.map((i) => i[2]);
    expect(new Set(codes).size).toBe(codes.length - 1);
  });
});

describe('M13-2 权威终态不被旧工作副本推进', () => {
  it('M13-2 权威 lifecycle 已是 rejected(无撤销凭据),手里的副本仍是 shadow → 不推进;对照:权威 = shadow 时推进', () => {
    const bad = decideShadowStep(input({ ctx: { authoritative_lifecycle: 'rejected' } }));
    expect(bad.action === 'wait' && bad.blocker).toBe('authority_mismatch');
    const good = decideShadowStep(input({ ctx: { authoritative_lifecycle: 'shadow' } }));
    expect(good.action).toBe('promote');
    const r = rec('shadow');
    const res = transition(r, E.promote(), ctxFor(r, { authoritative_lifecycle: 'rejected' }));
    expect(isRefusal(res) && res.guard).toBe('authority_mismatch');
  });
});

describe('M13-4 全局名额互斥(纯函数层:占用判定与守卫)', () => {
  it('M13-4 名额被占 → 不推进,起算 queued_since;名额释放后推进;占用判定按 R21-6.8', () => {
    const held = decideShadowStep(
      input({
        facts: { slot_occupied: true },
        shadow: { queued_since: null },
        ctx: at('2026-11-10'),
      }),
    );
    expect(held.action).toBe('wait');
    if (held.action === 'invalid') throw new Error(held.detail);
    expect(held.blocker).toBe('slot_occupied');
    expect(held.patch.queued_since).toBe('2026-11-10');
    // 已在排队的保持原起算日,不是每次重置
    const keep = decideShadowStep(input({ facts: { slot_occupied: true }, ctx: at('2026-11-10') }));
    expect(keep.action === 'wait' && keep.patch.queued_since).toBe(QUEUED);
    expect(decideShadowStep(input({ facts: { slot_occupied: false } })).action).toBe('promote');
  });

  it('M13-4 evaluationSlotOccupied:canary / adopted 占;rolling_back 不占;shadow 等不占;stable 看 watch.result', () => {
    const occ = (lc: Parameters<typeof rec>[0], o: Parameters<typeof rec>[1] = {}): boolean =>
      evaluationSlotOccupied([rec(lc, o)]);
    expect(occ('canary')).toBe(true);
    expect(occ('adopted')).toBe(true);
    expect(occ('rolling_back')).toBe(false);
    for (const lc of ['proposed', 'shadow', 'rejected', 'expired', 'rolled_back'] as const)
      expect(occ(lc), lc).toBe(false);
    const w = (
      result:
        | 'not_started'
        | 'pending'
        | 'passed'
        | 'withdrawn_residual'
        | 'withdrawn_ended'
        | 'skipped'
        | 'harm',
    ) => ({
      phase: 'post' as const,
      started_at_session: 0,
      pre_sessions: 0,
      post_sessions: 0,
      result,
    });
    for (const held of ['not_started', 'pending', 'withdrawn_residual'] as const) {
      expect(
        occ('stable', { watch: { claude: w('passed'), pi: null, codex: w(held) } }),
        held,
      ).toBe(true);
    }
    for (const freed of ['passed', 'withdrawn_ended', 'skipped'] as const) {
      expect(
        occ('stable', { watch: { claude: w('passed'), pi: w('passed'), codex: w(freed) } }),
        freed,
      ).toBe(false);
    }
    expect(evaluationSlotOccupied([])).toBe(false);
    expect(evaluationSlotOccupied([rec('shadow'), rec('canary')])).toBe(true);
  });

  it('M13-4 两个候选同时具备资格:只有队首先进 canary,第二个看到名额被占而等待(顺序按 canary_ready_since,id)', () => {
    const a = rec('shadow', { id: 'ra_aaaaaaaaaaaa' });
    const b = rec('shadow', { id: 'ra_bbbbbbbbbbbb' });
    const head = pickPromotionHead([
      { id: b.id, canary_ready_since: '2026-10-01' },
      { id: a.id, canary_ready_since: '2026-10-02' },
    ]);
    expect(head?.id).toBe('ra_bbbbbbbbbbbb');
    const first = decideShadowStep(
      input({ record: b, facts: { slot_occupied: evaluationSlotOccupied([a]) } }),
    );
    expect(first.action).toBe('promote');
    if (first.action !== 'promote' || first.event === undefined) throw new Error('应当 promote');
    const canary = (transition(b, first.event, ctxFor(b)) as Transitioned).next;
    const second = decideShadowStep(
      input({ record: a, facts: { slot_occupied: evaluationSlotOccupied([canary]) } }),
    );
    expect(second.action).toBe('wait');
    expect(second.action === 'wait' && second.blocker).toBe('slot_occupied');
  });

  it('W0-13 pickPromotionHead:按 (canary_ready_since, id) 升序;日期相同按 id;null 排最后;空 → null', () => {
    const p = (ids: Array<[string, string | null]>): string | undefined =>
      pickPromotionHead(ids.map(([id, d]) => ({ id, canary_ready_since: d })))?.id;
    expect(
      p([
        ['ra_2', '2026-10-02'],
        ['ra_1', '2026-10-03'],
      ]),
    ).toBe('ra_2');
    expect(
      p([
        ['ra_2', '2026-10-02'],
        ['ra_1', '2026-10-02'],
      ]),
    ).toBe('ra_1');
    expect(
      p([
        ['ra_1', null],
        ['ra_2', '2026-10-09'],
      ]),
    ).toBe('ra_2');
    expect(pickPromotionHead([])).toBeNull();
  });
});

describe('M13-5 排队只数 G7 等待', () => {
  it('M13-5 相位未到等待 > 30 日:queued_since 不起算;升相位后不立即 limit_reached,而是从升相位当日起算', () => {
    const early = decideShadowStep(
      input({
        ctx: { ...at('2026-12-20'), phase: 1 },
        shadow: { queued_since: null, canary_ready_since: '2026-10-01' },
        facts: { slot_occupied: true },
      }),
    );
    expect(early.action).toBe('wait');
    expect(early.action === 'wait' && [early.blocker, early.patch.queued_since]).toEqual([
      'phase_not_available',
      null,
    ]);
    // 升到相位 2 的当日:名额被占 → 起算今天,没有到期
    const later = decideShadowStep(
      input({
        ctx: { ...at('2026-12-21'), phase: 2 },
        shadow: { queued_since: null, canary_ready_since: '2026-10-01' },
        facts: { slot_occupied: true },
      }),
    );
    expect(later.action).toBe('wait');
    expect(later.action === 'wait' && later.patch.queued_since).toBe('2026-12-21');
    expect(later.action === 'wait' && later.blocker).toBe('slot_occupied');
  });

  it('M13-5 其他条件不满足的等待(如 taint)同样不计:恢复后从当日重新起算,不累计、不追溯', () => {
    const base = { facts: { slot_occupied: true } };
    // 第 0 日起算
    const d0 = decideShadowStep(
      input({ ...base, ctx: at('2026-10-01'), shadow: { queued_since: null } }),
    );
    const q0 = d0.action === 'wait' ? d0.patch.queued_since : 'x';
    expect(q0).toBe('2026-10-01');
    // 第 10 日 taint:清零
    const d10 = decideShadowStep(
      input({
        facts: { slot_occupied: true, tainted: true },
        ctx: at('2026-10-11'),
        shadow: { queued_since: q0 as string },
      }),
    );
    expect(d10.action === 'wait' && d10.patch.queued_since).toBeNull();
    // 第 11 日恢复:重新起算 2026-10-12
    const d11 = decideShadowStep(
      input({ ...base, ctx: at('2026-10-12'), shadow: { queued_since: null } }),
    );
    const q11 = d11.action === 'wait' ? d11.patch.queued_since : 'x';
    expect(q11).toBe('2026-10-12');
    // 从 2026-10-01 数已满 30 日(2026-10-31),但按新起算日未满 → 不到期;满 30 日(2026-11-11)才到期
    const notYet = decideShadowStep(
      input({ ...base, ctx: at('2026-10-31'), shadow: { queued_since: q11 as string } }),
    );
    expect(notYet.action).toBe('wait');
    const due = decideShadowStep(
      input({ ...base, ctx: at('2026-11-11'), shadow: { queued_since: q11 as string } }),
    );
    expect(due.action).toBe('expire');
  });

  it('M13-5 排队只数 G7:资格不成立的日子里 queued_since 始终为 null(不是「条件成立才继续累计」)', () => {
    for (const day of ['2026-10-01', '2026-10-15', '2026-11-20']) {
      const s = decideShadowStep(
        input({
          facts: { enabled: false, slot_occupied: true },
          ctx: at(day),
          shadow: { queued_since: null },
        }),
      );
      expect(s.action === 'wait' && s.patch.queued_since, day).toBeNull();
    }
  });
});

describe('M13-6 到期先于推进(判定顺序 到期 → 资格 → 名额)', () => {
  it('M13-6 排队第 30 日名额恰好释放:expire(不进 canary);第 29 日同样条件则 promote(两侧各钉一例)', () => {
    const due = decideShadowStep(
      input({ shadow: { queued_since: '2026-10-11' }, facts: { slot_occupied: false } }),
    );
    expect(due.action).toBe('expire');
    if (due.action !== 'expire' || due.event === undefined) throw new Error('应当 expire');
    expect(due.event).toMatchObject({ kind: 'shadow_queue_expired', queued_since: '2026-10-11' });
    const r = rec('shadow');
    const res = transition(r, due.event, ctxFor(r)) as Transitioned;
    expect(res.next.lifecycle).toBe('expired');
    expect(res.entries[0]?.reason).toBe('limit_reached');
    expect(res.next.terminal_reason).toBe('auto_expired');

    const notDue = decideShadowStep(
      input({ shadow: { queued_since: '2026-10-12' }, facts: { slot_occupied: false } }),
    );
    expect(notDue.action).toBe('promote');
    expect(utcDayDiff('2026-11-10', '2026-10-11')).toBe(30);
    expect(queueExpired('2026-10-11', '2026-11-10')).toBe(true);
    expect(queueExpired('2026-10-12', '2026-11-10')).toBe(false);
    expect(queueExpired(null, '2026-11-10')).toBe(false);
  });

  it('M13-6 已满 30 日而资格同时失效(taint):仍是 expire(到期先于「资格不成立 → 清零」)', () => {
    const s = decideShadowStep(
      input({ shadow: { queued_since: '2026-10-11' }, facts: { tainted: true } }),
    );
    expect(s.action).toBe('expire');
  });

  it('M13-6 已满 30 日而名额仍被占:expire', () => {
    const s = decideShadowStep(
      input({ shadow: { queued_since: '2026-10-11' }, facts: { slot_occupied: true } }),
    );
    expect(s.action).toBe('expire');
  });

  it('M13-6 引擎守卫:queued_since 为空或未满 30 日的 shadow_queue_expired 事件被拒', () => {
    const r = rec('shadow');
    for (const q of [null, '2026-10-12']) {
      const res = transition(r, E.queueExpired(q), ctxFor(r));
      expect(isRefusal(res) && res.guard).toBe('queue_not_expired');
    }
  });
});

describe('M13-7 canary_ready_since 只排序,不参与到期或授权', () => {
  const run = (ready: string | null): ReturnType<typeof decideShadowStep> =>
    decideShadowStep(input({ shadow: { canary_ready_since: ready, queued_since: QUEUED } }));

  it('M13-7 重建后日期变化(很早 / 今天 / 未来 / 缺失),action 与 queued_since 补丁都不变', () => {
    const results = ['2020-01-01', '2026-10-01', '2026-11-10', '2030-01-01', null].map(run);
    for (const r of results) {
      expect(r.action).toBe('promote');
      if (r.action === 'invalid') throw new Error(r.detail);
      expect(r.patch.queued_since).toBeNull();
    }
  });

  it('M13-7 canary_ready_since 很早(100 日前)而 queued_since 为空:不会到期(只有 queued_since 驱动到期)', () => {
    const s = decideShadowStep(
      input({
        shadow: { canary_ready_since: '2026-08-01', queued_since: null },
        facts: { slot_occupied: true },
      }),
    );
    expect(s.action).toBe('wait');
    expect(s.action === 'wait' && s.patch.queued_since).toBe('2026-11-10');
    // 对照:同一输入若把 queued_since 设为 100 日前才会到期
    const old = decideShadowStep(
      input({
        shadow: { canary_ready_since: '2026-08-01', queued_since: '2026-08-01' },
        facts: { slot_occupied: true },
      }),
    );
    expect(old.action).toBe('expire');
  });

  it('M13-7 canary_ready_since 首次达标日:达标(≥ 20 会话且命中 ≥ 2)时记当日,已有则保留,未达标保持 null', () => {
    const first = decideShadowStep(
      input({ shadow: { canary_ready_since: null, queued_since: null }, ctx: at('2026-11-10') }),
    );
    expect(first.action !== 'invalid' && first.patch.canary_ready_since).toBe('2026-11-10');
    const kept = decideShadowStep(
      input({ shadow: { canary_ready_since: '2026-10-20', queued_since: null } }),
    );
    expect(kept.action !== 'invalid' && kept.patch.canary_ready_since).toBe('2026-10-20');
    const unmet = decideShadowStep(
      input({ facts: { sessions: 19 }, shadow: { canary_ready_since: null, queued_since: null } }),
    );
    expect(unmet.action !== 'invalid' && unmet.patch.canary_ready_since).toBeNull();
    // 其它前置不成立(相位 1)时也记首次达标日(它只是展示 / 排序缓存,不是授权)
    const phase1 = decideShadowStep(
      input({
        ctx: { ...at('2026-11-10'), phase: 1 },
        shadow: { canary_ready_since: null, queued_since: null },
      }),
    );
    expect(phase1.action === 'wait' && phase1.patch.canary_ready_since).toBe('2026-11-10');
    expect(phase1.action === 'wait' && phase1.blocker).toBe('phase_not_available');
  });
});

describe('W0-13 decideShadowStep 输入校验', () => {
  it('缺字段 / 多余字段 → invalid(fail-closed,不推进也不清零);非 shadow 记录 → wait(not_shadow)', () => {
    const bad = { ...input(), facts: { ...FACTS(), extra: 1 } } as unknown as ShadowStepInput;
    expect(decideShadowStep(bad).action).toBe('invalid');
    expect(decideShadowStep({ ...input(), evidence: '' }).action).toBe('invalid');
    const notShadow = decideShadowStep(input({ record: rec('canary') }));
    expect(notShadow.action === 'wait' && notShadow.blocker).toBe('not_shadow');
    expect(decideShadowStep(input()).action).toBe('promote');
  });
});
