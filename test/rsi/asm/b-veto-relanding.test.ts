/**
 * B2 评审第 1 轮 ①:`veto → lift → veto` 必须重新生效(`veto_relands_after_lift`)。
 * 重复的 veto 事件命中既有 `idem_key`,引擎返回 `noop` + 空 effects,E1 不再产出;命令自己保证「用户显式否决」经带键端口落地
 * (生产装配里 `veto:` 键路由到 `userVeto.veto`,覆盖 lifted)。假带键端口按生产语义建模:`veto:` 键 = 用户意图(覆盖 lifted),其余键 = replay(从不清 lifted)。
 */
import { describe, expect, it } from 'vitest';
import type { WritePorts } from '../../../src/rsi/auto/write/ports.js';
import type {
  KeyedEffectResult,
  KeyedEffectSink,
} from '../../../src/rsi/personal/rollback-ports.js';
import type { TransitionEffect } from '../../../src/rsi/personal/transition.js';
import { makeFx, runWrite, type WriteFx } from '../auto/write-fixture.js';
import { world7, recordOf, ID, SHA } from '../rollback/w7-fixture.js';
import { rec } from '../personal/transition-fixture.js';

class IntentSink implements KeyedEffectSink {
  bl = new Map<string, 'active' | 'lifted'>();
  /** `veto:` 键(用户意图)的调用次数 */
  intentCalls = 0;
  /** true:`veto:` 键(用户意图)返回 `deferred`,状态不变(模拟黑名单落地推迟) */
  deferIntent = false;
  private keys = new Set<string>();
  async applyOnce(key: string, effects: readonly TransitionEffect[]): Promise<KeyedEffectResult> {
    const members = effects.flatMap((e) =>
      e.type === 'blacklist_veto' ? [`${e.id}:${e.content_sha256}`] : [],
    );
    if (key.startsWith('veto:')) {
      this.intentCalls += 1;
      if (this.deferIntent) return 'deferred';
      let changed = false;
      for (const m of members) {
        if (this.bl.get(m) !== 'active') changed = true;
        this.bl.set(m, 'active');
      }
      return changed ? 'applied' : 'already';
    }
    if (this.keys.has(key)) return 'already';
    this.keys.add(key);
    for (const m of members) if (!this.bl.has(m)) this.bl.set(m, 'active'); // replay 从不清 lifted
    return 'applied';
  }
  lift(id: string, sha: string): 'lifted' | 'absent' {
    const m = `${id}:${sha}`;
    if (this.bl.get(m) !== 'active') return 'absent';
    this.bl.set(m, 'lifted');
    return 'lifted';
  }
}

const M = `${ID}:${SHA}`;

function portsOf(fx: WriteFx, sink: IntentSink): WritePorts {
  return {
    ...fx.ports,
    rollbackDeps: (held) => ({
      ...fx.w7.d,
      locks: { personal: held.personal },
      keyedEffects: sink,
    }),
    vetoLift: { lift: async (id, sha) => sink.lift(id, sha) },
  };
}

describe('veto_relands_after_lift', () => {
  it('终态(经引擎 veto 进 rejected):veto → lift → veto:黑名单重新生效,输出 effects=applied(不是 already)', async () => {
    const fx = makeFx(world7({ record: rec('shadow') }));
    const sink = new IntentSink();
    const ports = portsOf(fx, sink);
    expect((await runWrite('veto', [ID], fx, { ports })).code).toBe(0);
    expect(sink.bl.get(M)).toBe('active');
    expect((await runWrite('veto', ['--lift', ID], fx, { ports })).code).toBe(0);
    expect(sink.bl.get(M)).toBe('lifted');
    const third = await runWrite('veto', [ID], fx, { ports });
    expect(third.code, third.err).toBe(0);
    expect(third.out).toContain('result=blacklist_only effects=applied');
    expect(third.out).not.toContain('effects=already');
    expect(sink.bl.get(M)).toBe('active');
    // 记录不动:仍是第一次 veto 的终态
    expect(recordOf(fx.w7).lifecycle).toBe('rejected');
  });

  it('对照:连续两次 veto(中间没有 lift)→ 第二次确实是已满足:effects=already,黑名单仍生效', async () => {
    const fx = makeFx(world7({ record: rec('shadow') }));
    const sink = new IntentSink();
    const ports = portsOf(fx, sink);
    expect((await runWrite('veto', [ID], fx, { ports })).code).toBe(0);
    const second = await runWrite('veto', [ID], fx, { ports });
    expect(second.code, second.err).toBe(0);
    expect(second.out).toContain('result=blacklist_only effects=already');
    expect(sink.bl.get(M)).toBe('active');
    expect(sink.intentCalls).toBe(2); // 每次命令恰好一次用户意图调用:第一次是引擎产出的 E1(veto: 键),第二次由命令补调(已满足,不改变状态)
  });

  it('回滚路径:在途回滚(记录 rolling_back,veto 条目与 E1 已落)被 lift 后再 veto → 黑名单重新生效', async () => {
    const w7 = world7();
    const fx = makeFx(w7);
    const sink = new IntentSink();
    const ports = portsOf(fx, sink);
    // 第一次 veto 在记录推进到 rolling_back 之后崩溃(E1 已经落地)
    w7.crashAt('after:record_event');
    await runWrite('veto', [ID], fx, { ports }).catch(() => undefined);
    w7.crashAt(null);
    expect(recordOf(w7).lifecycle).toBe('rolling_back');
    expect(sink.intentCalls).toBeGreaterThanOrEqual(2); // 第二次 veto 的自环事件确实产出过 E1(夹具自检:此后两把键都在)
    expect(sink.bl.get(M)).toBe('active');
    expect(sink.lift(ID, SHA)).toBe('lifted');
    // 再 veto:引擎对已有 veto 条目返回重复空操作,E1 不会再出现
    const again = await runWrite('veto', [ID], fx, { ports });
    expect(again.code, again.err).toBe(0);
    expect(sink.bl.get(M)).toBe('active');
  });

  /**
   * 在途回滚「已吃过两条 veto 事件」的真实状态:第一次 veto 崩在进入回滚之后(enter 键已在),第二次 veto 经自环再崩一次(自环键也在)。
   * 此后再来的 veto 事件两处施加(lateEventStatus / driveRecord)全是重复空操作,E1 不再出;返回此时的用户意图调用次数。
   */
  async function inFlightWithBothKeys(): Promise<{
    fx: WriteFx;
    sink: IntentSink;
    ports: WritePorts;
    calls: number;
  }> {
    const w7 = world7();
    const fx = makeFx(w7);
    const sink = new IntentSink();
    const ports = portsOf(fx, sink);
    w7.crashAt('after:record_event');
    await runWrite('veto', [ID], fx, { ports }).catch(() => undefined);
    expect(recordOf(w7).lifecycle).toBe('rolling_back');
    w7.crashAt('after:record_event');
    await runWrite('veto', [ID], fx, { ports }).catch(() => undefined);
    w7.crashAt(null);
    expect(recordOf(w7).lifecycle).toBe('rolling_back');
    expect(sink.bl.get(M)).toBe('active');
    expect(sink.lift(ID, SHA)).toBe('lifted');
    return { fx, sink, ports, calls: sink.intentCalls };
  }

  it('回滚路径(两把键都在、E1 不再出):lift 后再 veto → 只靠补调重新生效,恰多一次用户意图调用,退 0', async () => {
    const { fx, sink, ports, calls } = await inFlightWithBothKeys();
    const r = await runWrite('veto', [ID], fx, { ports });
    expect(r.code, r.err).toBe(0);
    expect(sink.bl.get(M)).toBe('active');
    expect(sink.intentCalls).toBe(calls + 1); // 引擎两处施加都没产出 E1;唯一的一次调用 = 命令补调
    expect(recordOf(fx.w7).lifecycle).toBe('rolled_back');
  });

  it('回滚路径补调 deferred(layers 缺省、consumers 已接线):退 1 且有「否决未落地」提示,黑名单仍是 lifted;对照:补调 applied(上一条)/ already → 退 0', async () => {
    const { fx, sink, ports } = await inFlightWithBothKeys();
    expect(ports.layers).toBeUndefined();
    expect(ports.consumers).toBeDefined();
    sink.deferIntent = true;
    const r = await runWrite('veto', [ID], fx, { ports });
    expect(r.code, r.err).toBe(1);
    expect(r.out).toContain('否决未落地');
    expect(sink.bl.get(M)).toBe('lifted');
    // 重跑(落地恢复正常):事务已走完 → 终态路径补调 applied,退 0
    sink.deferIntent = false;
    const again = await runWrite('veto', [ID], fx, { ports });
    expect(again.code, again.err).toBe(0);
    expect(sink.bl.get(M)).toBe('active');
    // already:没有 lift,在途回滚上再 veto,补调是已满足
    const w2 = world7();
    const fx2 = makeFx(w2);
    const sink2 = new IntentSink();
    const ports2 = portsOf(fx2, sink2);
    w2.crashAt('after:record_event');
    await runWrite('veto', [ID], fx2, { ports: ports2 }).catch(() => undefined);
    w2.crashAt('after:record_event');
    await runWrite('veto', [ID], fx2, { ports: ports2 }).catch(() => undefined);
    w2.crashAt(null);
    const ok = await runWrite('veto', [ID], fx2, { ports: ports2 });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).not.toContain('否决未落地');
  });

  it('终态路径补调 deferred(layers 缺省):lift 后再 veto,补调推迟 → 退 1 + 提示,黑名单仍 lifted(原理由即 vetoed 也不豁免);对照:补调正常 → 退 0 effects=applied', async () => {
    const fx = makeFx(world7({ record: rec('shadow') }));
    const sink = new IntentSink();
    const ports = portsOf(fx, sink);
    expect(ports.layers).toBeUndefined();
    expect((await runWrite('veto', [ID], fx, { ports })).code).toBe(0);
    expect(sink.lift(ID, SHA)).toBe('lifted');
    sink.deferIntent = true;
    const r = await runWrite('veto', [ID], fx, { ports });
    expect(r.code, r.err).toBe(1);
    expect(r.out).toContain('否决未落地');
    expect(r.out).not.toContain('result=');
    expect(sink.bl.get(M)).toBe('lifted');
    sink.deferIntent = false;
    const ok = await runWrite('veto', [ID], fx, { ports });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain('effects=applied');
    expect(sink.bl.get(M)).toBe('active');
  });
});
