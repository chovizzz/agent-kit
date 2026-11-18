/**
 * D1b-2:`applyEvent` 的增影响端口(`GrowthClaimPort`;I9)。增影响事件(`gates_passed` / `shadow_promote` / `deploy_inject`)必须先经端口:
 * 端口缺 / `unmappable` / `claim` 拒 / 返回畸形 = `denied`,**零写入**(判定先于 `seal.open` / `store.read` / `store.commit`);
 * 放行 → 钩子进 `commit({beforeRefUpdate})`;提交前复核拒(`denied`)→ `denied`。减影响事件不看端口(任何时候都能做)。
 */
import { describe, expect, it } from 'vitest';
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { applyEvent, type ApplyDeps } from '../../../src/rsi/personal/candidate-apply.js';
import type { GrowthClaimPort } from '../../../src/rsi/personal/candidate-ports.js';
import type { EntrySeal, StampRegion } from '../../../src/rsi/personal/entry-stamp.js';
import type { TransitionEvent } from '../../../src/rsi/personal/transition-table.js';
import { E, ID, SHA, rec } from '../personal/transition-fixture.js';
import { MemStore, world3, type GrowthFake } from '../personal/w3-fixture.js';

const V1B = 2;

interface Probe {
  d: ApplyDeps;
  store: MemStore;
  growth: GrowthFake;
  /** 全部「写入 / 读取 / 取时」的计数 */
  n: {
    reads: number;
    nowCalls: number;
    opens: number;
    closes: number;
    stamps: number;
    workingPuts: number;
    audits: number;
    effects: number;
  };
}

/** `port`:`'fake'` = 放行假件;`'absent'` = 不给端口;或自定义端口 */
function probe(
  r: PersonalLifecycleRecord,
  port: 'fake' | 'absent' | GrowthClaimPort = 'fake',
): Probe {
  const w = world3({ phase: V1B });
  w.store.put(r);
  const n: Probe['n'] = {
    reads: 0,
    nowCalls: 0,
    opens: 0,
    closes: 0,
    stamps: 0,
    workingPuts: 0,
    audits: 0,
    effects: 0,
  };
  const read = w.store.read.bind(w.store);
  w.store.read = async (id) => {
    n.reads++;
    return read(id);
  };
  const region: StampRegion = {
    stampFirst: (now) => {
      n.stamps++;
      return now().toISOString();
    },
    markSourceCommitted: () => undefined,
    close: () => {
      n.closes++;
    },
  };
  const seal: EntrySeal = {
    open: async () => {
      n.opens++;
      return region;
    },
  };
  const d: ApplyDeps = {
    store: w.store,
    working: {
      list: async () => [],
      put: async () => {
        n.workingPuts++;
      },
    },
    revocations: w.d.revocations,
    audit: {
      append: async (l) => {
        n.audits += l.length;
      },
    },
    effects: {
      apply: async (e) => {
        n.effects += e.length;
      },
    },
    env: w.d.env,
    now: () => {
      n.nowCalls++;
      return new Date('2026-11-10T12:00:00.000Z');
    },
    seal,
    ...(port === 'absent' ? {} : { growth: port === 'fake' ? w.growth.port : port }),
  };
  return { d, store: w.store, growth: w.growth, n };
}

/** 零写入:无提交、无读、无区域、无取时、无工作副本 / 审计 / 效果 */
function expectZeroWrites(p: Probe): void {
  expect(p.store.commits).toEqual([]);
  expect(p.n).toEqual({
    reads: 0,
    nowCalls: 0,
    opens: 0,
    closes: 0,
    stamps: 0,
    workingPuts: 0,
    audits: 0,
    effects: 0,
  });
}

interface Case {
  name: string;
  record: () => PersonalLifecycleRecord;
  event: TransitionEvent;
  op: 'candidate_create' | 'shadow_to_canary' | 'deploy_inject';
  cand: { id: string; content_sha256: string } | null;
  to: string;
}
const CASES: Case[] = [
  {
    name: 'gates_passed(proposed → shadow)',
    record: () => rec('proposed'),
    event: E.gatesPassed(),
    op: 'candidate_create',
    cand: null,
    to: 'shadow',
  },
  {
    name: 'shadow_promote(shadow → canary)',
    record: () => rec('shadow'),
    event: E.promote(),
    op: 'shadow_to_canary',
    cand: { id: ID, content_sha256: SHA },
    to: 'canary',
  },
];

describe('增影响事件:端口缺 / 拒 / 畸形 = denied 且零写入', () => {
  for (const c of CASES) {
    it(`d1_sinks_refuse_without_pass:${c.name} 缺 growth 端口 → denied{unwired};零写入`, async () => {
      const p = probe(c.record(), 'absent');
      expect(await applyEvent(p.d, c.record(), c.event)).toEqual({
        kind: 'denied',
        why: 'unwired',
      });
      expectZeroWrites(p);
    });

    it(`apply_growth_claim_denied_zero_write:${c.name} claim 拒 → denied{原因码};零写入;claim 收到对应 op 与候选`, async () => {
      const p = probe(c.record());
      p.growth.denyClaim = 'paused';
      expect(await applyEvent(p.d, c.record(), c.event)).toEqual({
        kind: 'denied',
        why: 'paused',
      });
      expectZeroWrites(p);
      expect(p.growth.claims).toEqual([{ op: c.op, cand: c.cand }]);
    });

    it(`${c.name} claim 返回畸形(缺钩子 / 钩子非函数 / 无码的拒绝 / null / 非对象)→ 一律 denied{claim_malformed};零写入`, async () => {
      const bad: unknown[] = [
        { ok: true },
        { ok: true, hook: 'nope' },
        { ok: false },
        { ok: false, code: 7 },
        null,
        undefined,
        'ok',
        {},
      ];
      for (const b of bad) {
        const p = probe(c.record(), { claim: async () => b as never });
        const r = await applyEvent(p.d, c.record(), c.event);
        expect(r, JSON.stringify(b)).toEqual({
          kind: 'denied',
          why: 'claim_malformed',
        });
        expectZeroWrites(p);
      }
    });

    it(`${c.name} claim 自己抛丢锁 → 原样传播(不吞、不改写成拒绝);零写入`, async () => {
      const err = new RsiLockError('lock_lost');
      const p = probe(c.record(), {
        claim: async () => {
          throw err;
        },
      });
      await expect(applyEvent(p.d, c.record(), c.event)).rejects.toBe(err);
      expectZeroWrites(p);
    });

    it(`${c.name} 放行:钩子进 commit 的 beforeRefUpdate 并被提交底座调用一次;转移 → ${c.to}`, async () => {
      const p = probe(c.record());
      const r = await applyEvent(p.d, c.record(), c.event);
      expect(r.kind).toBe('transitioned');
      expect(p.store.records.get(ID)?.lifecycle).toBe(c.to);
      expect(p.store.commits).toHaveLength(1);
      expect(typeof p.store.commits[0]?.beforeRefUpdate).toBe('function');
      expect(p.growth.hookCalls).toBe(1);
      expect(p.growth.claims).toEqual([{ op: c.op, cand: c.cand }]);
    });

    it(`${c.name} 提交前复核拒(commit 返回 denied)→ denied{码};权威记录不变;区域已关闭;无审计 / 效果 / 工作副本写`, async () => {
      const p = probe(c.record());
      p.growth.hookDeny = 'taint_pending';
      const r = await applyEvent(p.d, c.record(), c.event);
      expect(r).toEqual({ kind: 'denied', why: 'taint_pending' });
      expect(p.store.records.get(ID)?.lifecycle).toBe(c.record().lifecycle);
      expect(p.store.commits).toEqual([]);
      expect(p.n.opens).toBe(1);
      expect(p.n.closes).toBe(1);
      expect([p.n.audits, p.n.effects, p.n.workingPuts]).toEqual([0, 0, 0]);
    });
  }

  it('claim_hook_reread:claim 返回带 getter 的对象 → 每个字段只读一次,commit 收到的就是校验过的那个函数(不重读同一个对象)', async () => {
    for (const c of CASES) {
      let hookReads = 0;
      const fn = async (): Promise<void> => undefined;
      const port: GrowthClaimPort = {
        claim: async () =>
          ({
            ok: true,
            get hook() {
              hookReads++;
              return hookReads === 1 ? fn : undefined;
            },
          }) as never,
      };
      const p = probe(c.record(), port);
      const r = await applyEvent(p.d, c.record(), c.event);
      expect(r.kind, c.name).toBe('transitioned');
      expect(hookReads, c.name).toBe(1);
      expect(p.store.commits[0]?.beforeRefUpdate, c.name).toBe(fn);
    }
  });

  it('deploy_inject 同样先过端口(canary 记录):缺端口零写入;claim 收到 (deploy_inject, 候选)', async () => {
    const canary = rec('canary', { deploy: { claude: 'none', pi: 'none', codex: 'none' } });
    const absent = probe(canary, 'absent');
    expect(await applyEvent(absent.d, canary, E.inject())).toEqual({
      kind: 'denied',
      why: 'unwired',
    });
    expectZeroWrites(absent);
    const denied = probe(canary);
    denied.growth.denyClaim = 'admission';
    await applyEvent(denied.d, canary, E.inject());
    expect(denied.growth.claims).toEqual([
      { op: 'deploy_inject', cand: { id: ID, content_sha256: SHA } },
    ]);
    expectZeroWrites(denied);
  });
});

describe('decide_better_always_refused_as_growth / 未登记事件', () => {
  it('decide_better 即使端口放行也恒拒(unmappable);不调 claim;零写入', async () => {
    const canary = rec('canary');
    const p = probe(canary);
    expect(await applyEvent(p.d, canary, E.decide())).toEqual({
      kind: 'denied',
      why: 'unmappable',
    });
    expect(p.growth.claims).toEqual([]);
    expectZeroWrites(p);
  });

  it('未登记的事件 kind(跨信任边界的脏值)→ unmappable 拒绝,而不是当成减影响放行', async () => {
    const r0 = rec('shadow');
    const p = probe(r0, 'absent');
    const dirty = { kind: 'brand_new', evidence: 'x' } as unknown as TransitionEvent;
    expect(await applyEvent(p.d, r0, dirty)).toEqual({
      kind: 'denied',
      why: 'unmappable',
    });
    expectZeroWrites(p);
  });
});

describe('减影响事件不看端口(不受暂停 / 缺端口限制)', () => {
  it('veto / clear(shadow)、shadow_no_hit、shadow_queue_expired:无 growth 端口也照常转移,claim 从未被调', async () => {
    const cases: [string, PersonalLifecycleRecord, TransitionEvent][] = [
      ['veto', rec('shadow'), E.veto()],
      ['clear', rec('shadow'), E.clear()],
      ['shadow_no_hit', rec('shadow'), E.noHit()],
      ['shadow_queue_expired', rec('shadow'), E.queueExpired()],
      ['gate_red', rec('proposed'), E.gateRed()],
    ];
    for (const [name, r0, ev] of cases) {
      const p = probe(r0, 'absent');
      const r = await applyEvent(p.d, r0, ev);
      expect(r.kind, name).toBe('transitioned');
      const q = probe(r0);
      q.growth.denyClaim = 'paused'; // 端口即使会拒,减影响也不问它
      expect((await applyEvent(q.d, r0, ev)).kind, name).toBe('transitioned');
      expect(q.growth.claims, name).toEqual([]);
    }
  });
});
