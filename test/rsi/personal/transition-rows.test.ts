/**
 * R21-4.5:每条转移的守卫为假不转移、同一 idem_key 执行两次只转移一次;四件事显式在表里;能力相位逐行对照。
 * 表驱动:`CASES` 必须覆盖 `TRANSITION_TABLE` 的每一行(覆盖完整性测试),新增一行而没有用例 → 红。
 */
import { describe, expect, it } from 'vitest';
import { RSI_CAPABILITY_PHASE } from '../../../src/contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import {
  isRefusal,
  transition,
  type RefusalCode,
  type Transitioned,
} from '../../../src/rsi/personal/transition.js';
import {
  TRANSITION_TABLE,
  type TransitionCtx,
  type TransitionEvent,
} from '../../../src/rsi/personal/transition-table.js';
import { E, ID, NOW, ctxFor, deepFreeze, rec } from './transition-fixture.js';

type Rec = () => PersonalLifecycleRecord;
interface FalseCase {
  label: string;
  rec?: Rec;
  ev?: TransitionEvent;
  ctx?: Partial<TransitionCtx>;
  /** 缺省 `guard_false` */
  refused?: RefusalCode;
  guard?: string;
}
interface Case {
  row: string;
  rec: Rec;
  ev: TransitionEvent;
  /** 该行可用的最早相位整数(手写:V1a = 1,V1b = 2);`null` = 本期永不可用 */
  minPhase: 1 | 2 | null;
  falseCases: FalseCase[];
  /** 正向断言 */
  check?: (r: Transitioned) => void;
}

const proposed: Rec = () => rec('proposed');
const shadow: Rec = () => rec('shadow');
const canary: Rec = () =>
  rec('canary', { deploy: { claude: 'injected', pi: 'none', codex: 'none' } });
const rolling = (
  phase:
    'rollback_requested' | 'injection_disabled' | 'static_removal_pending' | 'rollback_complete',
  reason = 'limit_reached',
  target: 'rolled_back' | 'expired' | 'shadow' | 'retired' = 'expired',
  deploy: Partial<PersonalLifecycleRecord['deploy']> = {},
): Rec => {
  return () =>
    rec('rolling_back', {
      rollback: { phase, reason, target_terminal: target },
      deploy: { claude: 'none', pi: 'none', codex: 'none', ...deploy },
    });
};

const phase0 = {
  label: '相位 0(能力未到期)',
  ctx: { phase: 0 },
  refused: 'phase_not_available' as const,
};
const phase1 = {
  label: '相位 1(V1b 能力未到期)',
  ctx: { phase: 1 },
  refused: 'phase_not_available' as const,
};

const rejectedCheck =
  (reason: string, terminal: string) =>
  (r: Transitioned): void => {
    expect(r.outcome).toBe('transitioned');
    expect(r.next.lifecycle).toBe('rejected');
    expect(r.next.terminal_reason).toBe(terminal);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ dim: 'lifecycle', to: 'rejected', reason });
    expect(r.effects).toContainEqual({ type: 'commit_lifecycle', id: ID });
    expect(r.effects.some((e) => e.type === 'write_tombstone')).toBe(true);
  };

const CASES: Case[] = [
  {
    row: 'proposed_to_shadow',
    rec: proposed,
    ev: E.gatesPassed(),
    minPhase: 1,
    falseCases: [
      {
        label: 'G0–G7 未全过',
        ev: E.gatesPassed('g2', { gates_green: false }),
        guard: 'gates_not_green',
      },
      { label: '撤销凭据列出', ctx: { revocation_listed: true }, guard: 'revoked' },
      {
        label: '权威副本已是终态(旧副本不推进)',
        ctx: { authoritative_lifecycle: 'rejected' },
        guard: 'authority_mismatch',
      },
      {
        label: '旧版记录无 cluster_signature',
        rec: () => rec('proposed', { cluster_signature: undefined }),
        guard: 'no_cluster_signature',
      },
    ],
    check: (r) => {
      expect(r.next.lifecycle).toBe('shadow');
      expect(r.next.terminal_reason).toBeNull();
      expect(r.entries[0]).toMatchObject({
        from: 'proposed',
        to: 'shadow',
        reason: 'gates_passed',
      });
    },
  },
  {
    row: 'proposed_to_rejected_gate',
    rec: proposed,
    ev: E.gateRed('g1_phrase'),
    minPhase: 1,
    falseCases: [
      {
        label: 'g7_queued 是排队不是拒绝',
        ev: E.gateRed('g7_queued', 'r2'),
        guard: 'g7_queued_is_not_rejection',
      },
      {
        label: 'G8 属 V3(能力表里没有 → 默认拒绝)',
        ev: E.gateRed('g8_worse', 'r3'),
        refused: 'phase_not_available',
      },
      phase0,
    ],
    check: rejectedCheck('g1_phrase', 'rejected_gate'),
  },
  ...(['proposed', 'shadow'] as const).flatMap((from): Case[] => {
    const r: Rec = from === 'proposed' ? proposed : shadow;
    return [
      {
        row: `${from}_to_rejected_veto`,
        rec: r,
        ev: E.veto(),
        minPhase: 1,
        falseCases: [phase0],
        check: rejectedCheck('vetoed', 'vetoed'),
      },
      {
        row: `${from}_to_rejected_taint`,
        rec: r,
        ev: E.taint(),
        minPhase: 1,
        falseCases: [phase0],
        check: rejectedCheck('tainted', 'tainted'),
      },
      {
        row: `${from}_to_rejected_clear`,
        rec: r,
        ev: E.clear(),
        minPhase: 1,
        falseCases: [phase0],
        check: rejectedCheck('cleared', 'cleared'),
      },
      {
        row: `${from}_to_rejected_judge`,
        rec: r,
        ev: E.judge(),
        minPhase: 1,
        falseCases: [
          {
            label: '关联记录未通过完整校验',
            ev: E.judge('j2', { validated: false }),
            guard: 'judge_unvalidated',
          },
          {
            label: 'verdict 非 reject 且无注入嫌疑',
            ev: E.judge('j3', { verdict_reject: false }),
            guard: 'judge_not_reject',
          },
          phase0,
        ],
        check: rejectedCheck('judge_reject', 'judge_rejected'),
      },
    ];
  }),
  {
    row: 'shadow_to_expired_no_hit',
    rec: shadow,
    ev: E.noHit(),
    minPhase: 1,
    falseCases: [
      {
        label: '会话不足 20',
        ev: E.noHit('nh2', { sessions: 19 }),
        guard: 'shadow_sessions_short',
      },
      { label: '命中已达 2', ev: E.noHit('nh3', { hits: 2 }), guard: 'shadow_hits_met' },
    ],
    check: (r) => {
      expect(r.next.lifecycle).toBe('expired');
      expect(r.next.terminal_reason).toBe('no_hit');
      expect(r.entries[0]?.reason).toBe('no_hit');
      expect(r.effects).toContainEqual({
        type: 'start_cooldown',
        cluster_id: 'cluster-1',
        kind: 'expired',
        days: 30,
      });
    },
  },
  {
    row: 'shadow_to_expired_queue',
    rec: shadow,
    ev: E.queueExpired('2026-10-11'),
    minPhase: 1,
    falseCases: [
      { label: 'queued_since 为空', ev: E.queueExpired(null, 'q2'), guard: 'queue_not_expired' },
      {
        label: '排队只满 29 个 UTC 日',
        ev: E.queueExpired('2026-10-12', 'q3'),
        guard: 'queue_not_expired',
      },
    ],
    check: (r) => {
      expect(r.next.lifecycle).toBe('expired');
      expect(r.next.terminal_reason).toBe('auto_expired');
      expect(r.entries[0]?.reason).toBe('limit_reached');
    },
  },
  {
    row: 'shadow_to_canary',
    rec: shadow,
    ev: E.promote(),
    minPhase: 2,
    falseCases: [
      {
        label: '全局评估名额被占',
        ev: E.promote('p2', { slot_occupied: true }),
        guard: 'slot_occupied',
      },
      {
        label: '排队已满 30 日(到期先于推进)',
        ev: E.promote('p9', { queued_since: '2026-10-11' }),
        guard: 'queue_expired',
      },
      { label: 'auto_paused(增加影响被禁止)', ctx: { auto_paused: true }, guard: 'auto_paused' },
      {
        label: '自动循环无效',
        ctx: { auto_loop_effective: false },
        guard: 'auto_loop_not_effective',
      },
      { label: '配置无效', ev: E.promote('p3', { config_valid: false }), guard: 'config_invalid' },
      phase1,
    ],
    check: (r) => {
      expect(r.next.lifecycle).toBe('canary');
      expect(r.next.deploy).toEqual({ claude: 'none', pi: 'none', codex: 'none' });
      expect(r.entries[0]).toMatchObject({
        from: 'shadow',
        to: 'canary',
        reason: 'shadow_hits_met',
      });
    },
  },
  ...(
    [
      ['harm', E.harm(), 'harm_c1', 'auto_rollback', 'rolled_back'],
      ['veto', E.veto(), 'vetoed', 'vetoed', 'rolled_back'],
      ['taint', E.taint(), 'tainted', 'tainted', 'rolled_back'],
      ['clear', E.clear(), 'cleared', 'cleared', 'rolled_back'],
      ['judge_reject', E.judge(), 'judge_reject', 'judge_rejected', 'rolled_back'],
      ['canary_limit', E.limit(), 'limit_reached', 'auto_expired', 'expired'],
    ] as const
  ).flatMap(([kind, ev, reason, , target]): Case[] => {
    const falseCases: FalseCase[] = [phase1];
    if (kind === 'harm')
      falseCases.push({
        label: 'R21-7.4 未判变差',
        ev: E.harm('h2', { worse: false }),
        guard: 'not_worse',
      });
    if (kind === 'judge_reject')
      falseCases.push({
        label: '关联记录未通过完整校验',
        ev: E.judge('j2', { validated: false }),
        guard: 'judge_unvalidated',
      });
    if (kind === 'canary_limit')
      falseCases.push({
        label: '未到 120 会话且未满 90 日',
        ev: E.limit('l2', 119),
        guard: 'limit_not_reached',
      });
    return [
      {
        row: `canary_to_rolling_back_${kind}`,
        rec: canary,
        ev,
        minPhase: 2,
        falseCases,
        check: (r) => {
          expect(r.next.lifecycle).toBe('rolling_back');
          expect(r.next.rollback).toEqual({
            phase: 'rollback_requested',
            reason,
            target_terminal: target,
          });
          // R21-4.3:rolling_back 下 agent 只能 none | removal_pending → 同一次结果里把 injected 的 claude 改掉
          expect(r.next.deploy.claude).toBe('removal_pending');
          expect(r.next.deploy.pi).toBe('none');
          expect(r.entries.map((e) => `${e.dim}:${e.from}>${e.to}`)).toEqual([
            'lifecycle:canary>rolling_back',
            'deploy:injected>removal_pending',
          ]);
          expect(r.next.terminal_reason).toBeNull();
        },
      },
      {
        row: `rolling_back_repeat_${kind}`,
        // 起点:目标最低(expired)、理由最低优先级之一(limit_reached)的 rolling_back,不同证据的终止事件自环
        rec: rolling('injection_disabled', 'static_sync_timeout', 'expired', {
          claude: 'removal_pending',
        }),
        ev: kind === 'canary_limit' ? E.limit('l9') : ev,
        minPhase: 2,
        falseCases,
        check: (r) => {
          expect(r.next.lifecycle).toBe('rolling_back');
          expect(r.next.rollback?.phase).toBe('injection_disabled');
          expect(r.entries).toHaveLength(1);
          expect(r.entries[0]).toMatchObject({ from: 'rolling_back', to: 'rolling_back', reason });
          expect(r.next.deploy.claude).toBe('removal_pending');
        },
      },
    ];
  }),
  {
    row: 'canary_to_adopted',
    rec: canary,
    ev: E.decide(),
    minPhase: null,
    falseCases: [
      { label: '相位 2:V2 能力未到期', refused: 'phase_not_available' },
      { label: '相位 4(V2):判定开关恒假', ctx: { phase: 4 }, guard: 'decide_better_disabled' },
    ],
  },
  {
    row: 'rolling_back_to_terminal',
    rec: rolling('rollback_complete', 'vetoed', 'rolled_back'),
    ev: E.done(),
    minPhase: 2,
    falseCases: [
      {
        label: '补偿尚未走到 rollback_complete',
        rec: rolling('static_removal_pending', 'vetoed', 'rolled_back'),
        guard: 'rollback_not_complete',
      },
      { label: '完成判据不成立', ev: E.done('cd2', false), guard: 'completion_not_met' },
      {
        label: '仍有 agent 是 removal_pending',
        rec: rolling('rollback_complete', 'vetoed', 'rolled_back', { claude: 'removal_pending' }),
        guard: 'deploy_not_cleared',
      },
      {
        label: 'target_terminal=shadow 仅 E1 可达(V6a)',
        rec: rolling('rollback_complete', 'vetoed', 'shadow'),
        guard: 'target_shadow_exec_only',
      },
      {
        label: 'target_terminal=retired 仅 retiring(V2)',
        rec: rolling('rollback_complete', 'vetoed', 'retired'),
        guard: 'target_retired_not_available',
      },
      {
        label: '回滚理由码无终态理由映射',
        rec: rolling('rollback_complete', 'compensation_done', 'rolled_back'),
        guard: 'terminal_reason_unmapped',
      },
      phase1,
    ],
    check: (r) => {
      expect(r.next.lifecycle).toBe('rolled_back');
      expect(r.next.terminal_reason).toBe('vetoed');
      expect(r.entries[0]).toMatchObject({
        from: 'rolling_back',
        to: 'rolled_back',
        reason: 'compensation_done',
      });
      expect(r.effects.some((e) => e.type === 'write_tombstone')).toBe(true);
    },
  },
  {
    row: 'deploy_none_to_injected',
    rec: () => rec('canary'),
    ev: E.inject('claude'),
    minPhase: 2,
    falseCases: [
      { label: 'codex 恒不进入', ev: E.inject('codex', 'i2'), guard: 'codex_not_participating' },
      { label: '未通过准入', ev: E.inject('claude', 'i3', false), guard: 'not_admitted' },
      { label: '撤销凭据列出(对账先于授予)', ctx: { revocation_listed: true }, guard: 'revoked' },
      { label: 'auto_paused(增加影响被禁止)', ctx: { auto_paused: true }, guard: 'auto_paused' },
      {
        label: '自动循环无效',
        ctx: { auto_loop_effective: false },
        guard: 'auto_loop_not_effective',
      },
      {
        label: 'category=exec 经部署事件也不放行',
        rec: () => rec('canary', { category: 'exec' }),
        refused: 'phase_not_available',
      },
      phase1,
    ],
    check: (r) => {
      expect(r.next.deploy).toEqual({ claude: 'injected', pi: 'none', codex: 'none' });
      expect(r.entries[0]).toMatchObject({
        dim: 'deploy',
        agent: 'claude',
        from: 'none',
        to: 'injected',
        reason: 'deploy_injected',
      });
      expect(r.next.lifecycle).toBe('canary');
    },
  },
  {
    row: 'deploy_removal_pending_to_none',
    rec: rolling('rollback_complete', 'vetoed', 'rolled_back', { claude: 'removal_pending' }),
    ev: E.removal('claude'),
    minPhase: 2,
    falseCases: [
      {
        label: '第四段尚未到',
        rec: rolling('static_removal_pending', 'vetoed', 'rolled_back', {
          claude: 'removal_pending',
        }),
        guard: 'rollback_not_complete',
      },
      {
        label: '该 agent 完成判据不成立',
        ev: E.removal('claude', 'rm2', false),
        guard: 'removal_criterion_not_met',
      },
      phase1,
    ],
    check: (r) => {
      expect(r.next.deploy.claude).toBe('none');
      expect(r.entries[0]).toMatchObject({
        dim: 'deploy',
        agent: 'claude',
        from: 'removal_pending',
        to: 'none',
      });
      expect(r.next.lifecycle).toBe('rolling_back');
    },
  },
  ...(
    [
      ['rollback_requested', 'injection_disabled'],
      ['injection_disabled', 'static_removal_pending'],
      ['static_removal_pending', 'rollback_complete'],
    ] as const
  ).map(([from, to]): Case => ({
    row: `rollback_${from}_to_${to}`,
    rec: rolling(from, 'vetoed', 'rolled_back'),
    ev: E.advance(to),
    minPhase: 2,
    falseCases: [
      {
        label: '当前子状态的完成判据不成立',
        ev: E.advance(to, 'a2', false),
        guard: 'phase_not_completed',
      },
      phase1,
    ],
    check: (r) => {
      expect(r.next.rollback?.phase).toBe(to);
      expect(r.next.lifecycle).toBe('rolling_back');
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]).toMatchObject({ dim: 'rollback', from, to, reason: 'vetoed' });
    },
  })),
];

const ctxOf = (r: PersonalLifecycleRecord, o: Partial<TransitionCtx> = {}): TransitionCtx =>
  ctxFor(r, { ...o });

describe('R21-4.5 覆盖完整性:表里每一行都有用例', () => {
  it('CASES 的行名集合 = TRANSITION_TABLE 的行名集合(新增或删除一行而没改用例 → 红)', () => {
    const tableNames = TRANSITION_TABLE.map((r) => r.name);
    expect(new Set(tableNames).size).toBe(tableNames.length);
    expect(CASES.map((c) => c.row).sort()).toEqual([...tableNames].sort());
    expect(tableNames.length).toBe(32);
  });
});

describe('R21-4.5 四件事显式写在表里', () => {
  it('每行:守卫是函数、幂等证据指纹是函数且不含时钟、时钟 = ctx.now、恢复入口非空', () => {
    for (const row of TRANSITION_TABLE) {
      expect(typeof row.guard, row.name).toBe('function');
      expect(typeof row.evidence, row.name).toBe('function');
      expect(row.clock, row.name).toBe('ctx.now');
      expect(row.recovery.length, row.name).toBeGreaterThan(10);
    }
    const c = CASES[0] as Case;
    const fp = TRANSITION_TABLE[0]?.evidence(c.ev) ?? '';
    expect(fp).toBe('gates_passed:-:g1');
    expect(fp).not.toContain(NOW);
    expect(fp).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('幂等指纹含事件种类与区分原因(同证据的 veto 与 taint、不同 harm 指标、不同 agent 不撞键)', () => {
    const fp = (e: TransitionEvent): string =>
      TRANSITION_TABLE.find((r) => r.kind === e.kind)?.evidence(e) ?? '';
    expect(fp(E.veto('x'))).not.toBe(fp(E.taint('x')));
    expect(fp(E.harm('x', { metric: 'c1' }))).not.toBe(fp(E.harm('x', { metric: 'c2' })));
    expect(fp(E.judge('x'))).not.toBe(fp(E.judge('x', { injection_suspected: true })));
    expect(fp(E.inject('claude', 'x'))).not.toBe(fp(E.inject('pi', 'x')));
  });

  it('能力键:除两个有意不登记的键(默认拒绝)外,表里用到的每个键都在 RSI_CAPABILITY_PHASE 里', () => {
    const DENY = new Set(['gate_g8', 'exec_admission']);
    const used = new Set<string>();
    for (const c of CASES) {
      const r = c.rec();
      for (const row of TRANSITION_TABLE.filter((x) => x.name === c.row)) {
        for (const k of row.caps(c.ev, r)) used.add(k);
      }
    }
    for (const row of TRANSITION_TABLE) {
      if (row.kind === 'gate_red') {
        for (const k of row.caps(E.gateRed('g8_worse'), rec('proposed'))) used.add(k);
      }
      if (row.kind === 'shadow_promote') {
        for (const k of row.caps(E.promote(), rec('shadow', { category: 'exec' }))) used.add(k);
      }
    }
    for (const k of used) {
      if (DENY.has(k)) expect(Object.hasOwn(RSI_CAPABILITY_PHASE, k), k).toBe(false);
      else expect(Object.hasOwn(RSI_CAPABILITY_PHASE, k), k).toBe(true);
    }
    expect(used.has('gate_g8')).toBe(true);
    expect(used.has('exec_admission')).toBe(true);
    expect(used.size).toBeGreaterThan(10);
  });
});

describe('R21-4.5 每条转移:守卫为假不转移', () => {
  for (const c of CASES) {
    it(`R21-4.5 ${c.row}:正向对照(守卫全真时转移)+ 逐项守卫为假各一例,入参不变`, () => {
      const r0 = c.rec();
      if (c.minPhase !== null) {
        const ok = transition(deepFreeze(r0), c.ev, ctxOf(r0));
        expect(isRefusal(ok), `${c.row} 正向对照被拒:${JSON.stringify(ok)}`).toBe(false);
        c.check?.(ok as Transitioned);
        expect((ok as Transitioned).outcome).toBe('transitioned');
      }
      expect(c.falseCases.length, `${c.row} 至少一个守卫为假的用例`).toBeGreaterThan(0);
      for (const f of c.falseCases) {
        const r = f.rec ? f.rec() : c.rec();
        const before = JSON.stringify(r);
        const res = transition(deepFreeze(r), f.ev ?? c.ev, ctxOf(r, f.ctx));
        expect(isRefusal(res), `${c.row} / ${f.label}:应被拒,实际 ${JSON.stringify(res)}`).toBe(
          true,
        );
        if (isRefusal(res)) {
          expect(res.refused, `${c.row} / ${f.label}`).toBe(f.refused ?? 'guard_false');
          if (f.guard !== undefined) expect(res.guard, `${c.row} / ${f.label}`).toBe(f.guard);
        }
        expect(JSON.stringify(r), `${c.row} / ${f.label}:入参被改`).toBe(before);
      }
    });
  }
});

describe('R21-4.5 每条转移:同一 idem_key 执行两次只转移一次', () => {
  for (const c of CASES.filter((x) => x.minPhase !== null)) {
    it(`R21-4.5 ${c.row}:第二次执行的结果种类是 noop(不是拒绝),transitions 条数不增、状态不变`, () => {
      const r0 = c.rec();
      const first = transition(r0, c.ev, ctxOf(r0));
      expect(isRefusal(first)).toBe(false);
      const a = first as Transitioned;
      expect(a.outcome).toBe('transitioned');
      expect(a.entries.length).toBeGreaterThan(0);
      expect(a.next.transitions.length).toBe(r0.transitions.length + a.entries.length);
      // 第二次:记录已是新状态;事件完全相同
      const second = transition(a.next, c.ev, ctxOf(a.next));
      expect(isRefusal(second), `${c.row} 第二次被拒:${JSON.stringify(second)}`).toBe(false);
      const b = second as Transitioned;
      expect(b.outcome).toBe('noop');
      expect(b.noop_reason).toBe('duplicate_idem_key');
      expect(b.entries).toEqual([]);
      expect(b.effects).toEqual([]);
      expect(b.next).toEqual(a.next);
      expect(b.next.transitions.length).toBe(a.next.transitions.length);
    });
  }
});

describe('R21-4.1 / W0-1 能力相位逐行对照(手写的最早相位)', () => {
  for (const c of CASES.filter((x) => x.minPhase !== null)) {
    it(`R21-4.1 ${c.row}:相位 ${(c.minPhase as number) - 1} 时 phase_not_available,相位 ${c.minPhase} 时可用`, () => {
      const r0 = c.rec();
      const below = transition(r0, c.ev, ctxOf(r0, { phase: (c.minPhase as number) - 1 }));
      expect(isRefusal(below) && below.refused, c.row).toBe('phase_not_available');
      const at = transition(r0, c.ev, ctxOf(r0, { phase: c.minPhase as number }));
      expect(isRefusal(at), c.row).toBe(false);
      expect((at as Transitioned).outcome).toBe('transitioned');
    });
  }

  it('R21-4.1 canary → adopted 在相位 2 仍拒(V2);表里没有的能力默认拒绝', () => {
    const c = canary();
    const res = transition(c, E.decide(), ctxFor(c, { phase: 2 }));
    expect(isRefusal(res) && res.refused).toBe('phase_not_available');
  });
});
