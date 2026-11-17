/**
 * C1b:静音降级阶梯(`stage/ladder.ts`;纯逻辑 + 假端口)。
 * 覆盖:阶梯 ①→④ 逐级、失锁立即停写、state 非法时不调 `enforceFull` 且无 state / 清单写端口可调、`tripAndMute` 的「state 写抛错仍静音」包装、永不抛。
 * 期望值由测试自己手写,不调用被测函数求值。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  NO_PAUSE,
  type AutoPauseState,
  type BreakerDeps,
} from '../../../src/rsi/personal/breaker.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import {
  muteDown,
  runEnforceLadder,
  runFallbackLadder,
  tripAndMuteGuarded,
  type MuteLadderPorts,
  type S0Ports,
  type S0StateKind,
} from '../../../src/rsi/personal/stage/ladder.js';
import type { FallbackPorts, StateRead } from '../../../src/rsi/personal/stage/ports.js';

const lost = (): Error => new RsiLockError('lock_lost');
const eio = (): Error => Object.assign(new Error('eio'), { code: 'EIO' });

interface Script {
  mute?: () => Promise<boolean>;
  remove?: () => Promise<boolean>;
  marker?: () => Promise<'created' | 'exists'>;
  assertHeld?: () => Promise<void>;
}
function ladder(s: Script = {}): MuteLadderPorts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    muteCanary: () => {
      calls.push('mute');
      return (s.mute ?? (() => Promise.resolve(true)))();
    },
    removeCanary: () => {
      calls.push('remove');
      return (s.remove ?? (() => Promise.resolve(true)))();
    },
    ensureBreakerMarker: () => {
      calls.push('marker');
      return (s.marker ?? (() => Promise.resolve('created' as const)))();
    },
    assertHeld: () => {
      calls.push('assert');
      return (s.assertHeld ?? (() => Promise.resolve()))();
    },
  };
}

describe('muteDown:阶梯 ①→④', () => {
  it('① 静音成功:muted / 已静音(返回 false):nothing;其余端口不调', async () => {
    const a = ladder();
    expect(await muteDown(a)).toBe('muted');
    expect(a.calls).toEqual(['assert', 'mute']);
    const b = ladder({ mute: () => Promise.resolve(false) });
    expect(await muteDown(b)).toBe('nothing');
    expect(b.calls).not.toContain('remove');
  });

  it('② 静音抛错 → 删除 canary → removed;不建 B', async () => {
    const a = ladder({ mute: () => Promise.reject(eio()) });
    expect(await muteDown(a)).toBe('removed');
    expect(a.calls.filter((c) => c !== 'assert')).toEqual(['mute', 'remove']);
  });

  it('③ 静音与删除都抛错 → 创建 B(gate_internal)→ marker', async () => {
    const a = ladder({ mute: () => Promise.reject(eio()), remove: () => Promise.reject(eio()) });
    expect(await muteDown(a)).toBe('marker');
    expect(a.calls.filter((c) => c !== 'assert')).toEqual(['mute', 'remove', 'marker']);
  });

  it('④ 三级都失败 → unreliable(不抛)', async () => {
    const a = ladder({
      mute: () => Promise.reject(eio()),
      remove: () => Promise.reject(eio()),
      marker: () => Promise.reject(eio()),
    });
    expect(await muteDown(a)).toBe('unreliable');
  });

  it('每个写点前 assertHeld;失锁(任一点)原样抛出且之后零写端口调用', async () => {
    // (a) 第一次复核就丢锁:一个写端口都不调
    const a = ladder({ assertHeld: () => Promise.reject(lost()) });
    await expect(muteDown(a)).rejects.toThrow('lock_lost');
    expect(a.calls).toEqual(['assert']);
    // (b) 静音端口内丢锁:不再删除、不建 B
    const b = ladder({ mute: () => Promise.reject(lost()) });
    await expect(muteDown(b)).rejects.toThrow('lock_lost');
    expect(b.calls).toEqual(['assert', 'mute']);
    // (c) 删除端口内丢锁:不建 B
    const c = ladder({ mute: () => Promise.reject(eio()), remove: () => Promise.reject(lost()) });
    await expect(muteDown(c)).rejects.toThrow('lock_lost');
    expect(c.calls).toEqual(['assert', 'mute', 'assert', 'remove']);
    // (d) 建 B 时丢锁
    const d = ladder({
      mute: () => Promise.reject(eio()),
      remove: () => Promise.reject(eio()),
      marker: () => Promise.reject(lost()),
    });
    await expect(muteDown(d)).rejects.toThrow('lock_lost');
    expect(d.calls).toEqual(['assert', 'mute', 'assert', 'remove', 'assert', 'marker']);
  });
});

interface FbScript extends Script {
  markers?: () => Promise<{ B: boolean; U: boolean }>;
  state?: () => Promise<StateRead>;
}
function fb(s: FbScript = {}): FallbackPorts & { calls: string[] } {
  const base = ladder(s);
  return {
    ...base,
    markers: () => {
      base.calls.push('markers');
      return (s.markers ?? (() => Promise.resolve({ B: false, U: false })))();
    },
    readStateRaw: () => {
      base.calls.push('state');
      return (s.state ?? (() => Promise.resolve({ kind: 'ok', paused: false } as StateRead)))();
    },
  };
}

describe('runFallbackLadder(兜底:只读 state / 标记,不写 state)', () => {
  it('B / U 任一在 → 进阶梯;都不在且 state 未暂停 → nothing(静音端口零调用)', async () => {
    const quiet = fb();
    expect(await runFallbackLadder(quiet)).toEqual({ kind: 'nothing' });
    expect(quiet.calls).not.toContain('mute');
    for (const m of [
      { B: true, U: false },
      { B: false, U: true },
    ]) {
      const a = fb({ markers: () => Promise.resolve(m) });
      expect(await runFallbackLadder(a)).toEqual({ kind: 'muted' });
    }
  });

  it('state 暂停 → 静音;state 非法 / 读不出 / 读抛错 → fail-closed 静音', async () => {
    for (const st of [
      () => Promise.resolve({ kind: 'ok', paused: true } as StateRead),
      () => Promise.resolve({ kind: 'invalid' } as StateRead),
      () => Promise.resolve({ kind: 'unreadable' } as StateRead),
      () => Promise.reject(eio()),
    ]) {
      const a = fb({ state: st });
      expect(await runFallbackLadder(a)).toEqual({ kind: 'muted' });
    }
  });

  it('标记读抛错也按「需要静音」(不确定时收紧)', async () => {
    const a = fb({ markers: () => Promise.reject(eio()) });
    expect(await runFallbackLadder(a)).toEqual({ kind: 'muted' });
  });

  it('阶梯各级结果原样报告;三级都失败 = unreliable', async () => {
    const paused = (): Promise<StateRead> => Promise.resolve({ kind: 'ok', paused: true });
    expect(
      await runFallbackLadder(fb({ state: paused, mute: () => Promise.reject(eio()) })),
    ).toEqual({ kind: 'removed' });
    expect(
      await runFallbackLadder(
        fb({
          state: paused,
          mute: () => Promise.reject(eio()),
          remove: () => Promise.reject(eio()),
        }),
      ),
    ).toEqual({ kind: 'marker' });
    expect(
      await runFallbackLadder(
        fb({
          state: paused,
          mute: () => Promise.reject(eio()),
          remove: () => Promise.reject(eio()),
          marker: () => Promise.reject(eio()),
        }),
      ),
    ).toEqual({ kind: 'unreliable' });
  });

  it('永不抛:rsi 失锁 → aborted(之后零写端口调用);其它意外抛出 → threw', async () => {
    const a = fb({
      state: () => Promise.resolve({ kind: 'ok', paused: true }),
      mute: () => Promise.reject(lost()),
    });
    expect(await runFallbackLadder(a)).toEqual({ kind: 'aborted', why: 'rsi_lock_lost' });
    expect(a.calls).not.toContain('remove');
    expect(a.calls).not.toContain('marker');
    const b = fb({ assertHeld: () => Promise.reject(lost()) });
    expect(await runFallbackLadder(b)).toEqual({ kind: 'aborted', why: 'rsi_lock_lost' });
    const c = fb({ assertHeld: () => Promise.reject(new TypeError('boom')) });
    expect(await runFallbackLadder(c)).toEqual({ kind: 'threw', name: 'TypeError' });
  });

  it('fallback_has_no_state_write_port:FallbackPorts 的键集只有读 / 静音 / 标记 / 复核,没有任何写 state / 清单的成员', () => {
    type K = keyof FallbackPorts;
    expectTypeOf<K>().toEqualTypeOf<
      | 'readStateRaw'
      | 'markers'
      | 'muteCanary'
      | 'removeCanary'
      | 'ensureBreakerMarker'
      | 'assertHeld'
    >();
    expect(
      Object.keys(fb())
        .filter((k) => k !== 'calls')
        .sort(),
    ).toEqual(
      [
        'assertHeld',
        'ensureBreakerMarker',
        'markers',
        'muteCanary',
        'readStateRaw',
        'removeCanary',
      ].sort(),
    );
  });
});

interface S0Script extends Script {
  kind?: () => Promise<S0StateKind>;
  enforce?: () => Promise<boolean>;
}
function s0(s: S0Script = {}): S0Ports & { calls: string[]; enforced: number } {
  const base = ladder(s);
  const out = {
    ...base,
    enforced: 0,
    enforceFull: () => {
      out.enforced += 1;
      base.calls.push('enforce');
      return (s.enforce ?? (() => Promise.resolve(false)))();
    },
    stateKind: () => (s.kind ?? (() => Promise.resolve('valid' as const)))(),
  };
  return out;
}

describe('runEnforceLadder(S0)', () => {
  it('state 合规:enforceFull 一次;返回 muted / nothing,无故障', async () => {
    const a = s0({ enforce: () => Promise.resolve(true) });
    expect(await runEnforceLadder(a)).toEqual({ mute: 'muted', fault: null });
    expect(a.enforced).toBe(1);
    const b = s0();
    expect(await runEnforceLadder(b)).toEqual({ mute: 'nothing', fault: null });
  });

  it('state_and_manifest_bytes_untouched:整份不合规 / 读不出 → 不调 enforceFull(它读写 state),直接走阶梯静音,故障 state_invalid:schema', async () => {
    for (const k of ['schema', 'unreadable'] as const) {
      const a = s0({ kind: () => Promise.resolve(k) });
      expect(await runEnforceLadder(a)).toEqual({ mute: 'muted', fault: 'state_invalid:schema' });
      expect(a.enforced).toBe(0);
      expect(a.calls).not.toContain('marker'); // 不建 B(静音成功)
    }
    const t = s0({ kind: () => Promise.reject(eio()) });
    expect(await runEnforceLadder(t)).toEqual({ mute: 'muted', fault: 'state_invalid:schema' });
  });

  it('state 非法且静音 / 删除都失败 → 才建 B(阶梯 ③);三级全败 → fault 取 mute_unreliable', async () => {
    const a = s0({
      kind: () => Promise.resolve('schema'),
      mute: () => Promise.reject(eio()),
      remove: () => Promise.reject(eio()),
    });
    expect(await runEnforceLadder(a)).toEqual({ mute: 'marker', fault: 'state_invalid:schema' });
    const b = s0({
      kind: () => Promise.resolve('schema'),
      mute: () => Promise.reject(eio()),
      remove: () => Promise.reject(eio()),
      marker: () => Promise.reject(eio()),
    });
    expect(await runEnforceLadder(b)).toEqual({ mute: 'unreliable', fault: 'mute_unreliable' });
  });

  it('enforceFull 抛错:state 缺失 → state_invalid:missing;整份坏 → :schema;合规 → safety_unavailable;都先走阶梯静音', async () => {
    let n = 0;
    const kinds = (seq: S0StateKind[]) => () =>
      Promise.resolve(seq[Math.min(n++, seq.length - 1)] as S0StateKind);
    const mk = (seq: S0StateKind[]): S0Ports & { calls: string[] } => {
      n = 0;
      return s0({ kind: kinds(seq), enforce: () => Promise.reject(eio()) });
    };
    expect(await runEnforceLadder(mk(['valid', 'missing']))).toEqual({
      mute: 'muted',
      fault: 'state_invalid:missing',
    });
    expect(await runEnforceLadder(mk(['valid', 'schema']))).toEqual({
      mute: 'muted',
      fault: 'state_invalid:schema',
    });
    expect(await runEnforceLadder(mk(['valid', 'valid']))).toEqual({
      mute: 'muted',
      fault: 'safety_unavailable',
    });
  });

  it('rsi 失锁原样上抛(enforceFull 内 / 阶梯内 / 读形状时);其它错误不抛', async () => {
    await expect(runEnforceLadder(s0({ enforce: () => Promise.reject(lost()) }))).rejects.toThrow(
      'lock_lost',
    );
    await expect(runEnforceLadder(s0({ kind: () => Promise.reject(lost()) }))).rejects.toThrow(
      'lock_lost',
    );
    await expect(
      runEnforceLadder(
        s0({ kind: () => Promise.resolve('schema'), mute: () => Promise.reject(lost()) }),
      ),
    ).rejects.toThrow('lock_lost');
  });
});

function breakerFake(over: { write?: () => Promise<void>; mute?: () => Promise<boolean> } = {}): {
  d: BreakerDeps;
  calls: string[];
} {
  const calls: string[] = [];
  let st: AutoPauseState = NO_PAUSE;
  const d: BreakerDeps = {
    state: {
      read: () => Promise.resolve(st),
      write: async (s) => {
        calls.push('state.write');
        if (over.write !== undefined) await over.write();
        st = s;
      },
    },
    canary: {
      mute: () => {
        calls.push('canary.mute');
        return (over.mute ?? (() => Promise.resolve(true)))();
      },
    },
    marker: {
      breaker: {
        ensure: () => {
          calls.push('marker.ensure');
          return Promise.resolve('created');
        },
        read: () => Promise.resolve(null),
        remove: () => Promise.resolve(false),
      },
      user: { exists: () => Promise.resolve(false) },
    },
    phase: 9,
  };
  return { d, calls };
}

describe('tripAndMuteGuarded:state 写抛错仍静音', () => {
  it('trip_state_write_enospc_still_mutes:state.write 抛 ENOSPC → 阶梯静音仍被调用,原错误原样抛出', async () => {
    const enospc = Object.assign(new Error('enospc'), { code: 'ENOSPC' });
    const { d, calls } = breakerFake({ write: () => Promise.reject(enospc) });
    const l = ladder();
    await expect(tripAndMuteGuarded(d, l, ['rollback_storm'])).rejects.toBe(enospc);
    expect(calls).toEqual(['marker.ensure', 'state.write']); // breaker 自己在 state 写抛错后跳过了 canary.mute
    expect(l.calls).toContain('mute'); // 包装补了静音
  });

  it('成功路径:tripped=true,静音一遍(幂等);已处于该码 → tripped=false', async () => {
    const { d } = breakerFake();
    const l = ladder({ mute: () => Promise.resolve(false) });
    expect(await tripAndMuteGuarded(d, l, ['rollback_storm'])).toEqual({
      tripped: true,
      mute: 'nothing',
    });
    expect(await tripAndMuteGuarded(d, l, ['rollback_storm'])).toEqual({
      tripped: false,
      mute: 'nothing',
    });
  });

  it('多个码:第一个失败的错误被保留,其余码仍尝试;失锁立即上抛不再静音', async () => {
    const first = new Error('first');
    let n = 0;
    const { d } = breakerFake({
      write: () => (n++ === 0 ? Promise.reject(first) : Promise.resolve()),
    });
    const l = ladder();
    await expect(tripAndMuteGuarded(d, l, ['rollback_storm', 'user_vetoes'])).rejects.toBe(first);
    const lockLost = breakerFake({ write: () => Promise.reject(lost()) });
    const l2 = ladder();
    await expect(tripAndMuteGuarded(lockLost.d, l2, ['rollback_storm'])).rejects.toThrow(
      'lock_lost',
    );
    expect(l2.calls).toEqual([]);
  });
});
