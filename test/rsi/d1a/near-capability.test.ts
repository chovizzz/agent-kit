/**
 * D1a:`nearFpCapability` 四态(设计稿 v4 §4.1)。断言具体状态与原因,不只断言 `!== 'ready'`。
 * 生产值 `NEAR_ALGO.frozen === false`:即使 producer 与 key 都就绪,能力恒为 `algo_unfrozen`。
 */
import { describe, expect, it } from 'vitest';
import { NEAR_ALGO, makeNearFpProducer } from '../../../src/rsi/personal/fp/near-algo.js';
import {
  decideNearFpCapability,
  makeNearFpCapability,
  makeNearFpCapabilitySource,
  nearFpDenial,
  nearFpReady,
  type NearFpCapabilityInput,
} from '../../../src/rsi/personal/fp/near-capability.js';
import type { FpKeyPort, FpKeyRead } from '../../../src/rsi/personal/fp/fp-ports.js';
import { TEST_KEY, leaksValue } from './d1a-fixture.js';

const producer = makeNearFpProducer(TEST_KEY);
const frozenAlgo = { version: 'rsi-near-v1', frozen: true, threshold: 0.5 };
const base = (over: Partial<NearFpCapabilityInput> = {}): NearFpCapabilityInput => ({
  producer,
  key: 'ok',
  algo: frozenAlgo,
  ...over,
});

describe('decideNearFpCapability(纯同步、全函数)', () => {
  it('ready:producer 装配 ∧ key 可读 ∧ frozen === true', () => {
    expect(decideNearFpCapability(base())).toEqual({ state: 'ready', reason: 'none' });
  });
  it('unwired:没有 producer 引用(undefined / null / 字符串 / 缺 compute / compute 非函数)', () => {
    for (const p of [undefined, null, 'NearFpProducer', {}, { compute: 'x' }, 7]) {
      expect(decideNearFpCapability(base({ producer: p }))).toEqual({
        state: 'unwired',
        reason: 'producer_unwired',
      });
    }
  });
  it('key_unavailable:缺 / 无效 / 读失败,各有原因码', () => {
    expect(decideNearFpCapability(base({ key: 'absent' }))).toEqual({
      state: 'key_unavailable',
      reason: 'key_absent',
    });
    expect(decideNearFpCapability(base({ key: 'invalid' }))).toEqual({
      state: 'key_unavailable',
      reason: 'key_invalid',
    });
    expect(decideNearFpCapability(base({ key: 'read_failed' }))).toEqual({
      state: 'key_unavailable',
      reason: 'key_read_failed',
    });
  });
  it('algo_unfrozen:frozen 必须严格 === true("true" / 1 / undefined 都不算)', () => {
    for (const f of [false, 'true', 1, undefined, null]) {
      expect(decideNearFpCapability(base({ algo: { ...frozenAlgo, frozen: f } }))).toEqual({
        state: 'algo_unfrozen',
        reason: 'algo_unfrozen',
      });
    }
  });
  it('冻结位为真但阈值 / 版本串不合法 → algo_unfrozen(algo_invalid),不放行', () => {
    for (const algo of [
      { ...frozenAlgo, threshold: 0 },
      { ...frozenAlgo, threshold: Number.NaN },
      { ...frozenAlgo, threshold: 1.5 },
      { ...frozenAlgo, threshold: '0.5' },
      { ...frozenAlgo, version: '' },
      { ...frozenAlgo, version: 3 },
    ]) {
      expect(decideNearFpCapability(base({ algo }))).toEqual({
        state: 'algo_unfrozen',
        reason: 'algo_invalid',
      });
    }
  });
  it('判定顺序:unwired 先于 key,key 先于 algo', () => {
    expect(
      decideNearFpCapability(
        base({ producer: undefined, key: 'absent', algo: { ...frozenAlgo, frozen: false } }),
      ).state,
    ).toBe('unwired');
    expect(
      decideNearFpCapability(base({ key: 'invalid', algo: { ...frozenAlgo, frozen: false } }))
        .state,
    ).toBe('key_unavailable');
  });
});

const keyPort = (read: () => Promise<FpKeyRead>): FpKeyPort => ({
  read,
  ensure: () => Promise.reject(new Error('not used')),
});

describe('makeNearFpCapability(装配工厂:现读 key)', () => {
  it('near_capability_unwired_denied:没有 producer', async () => {
    const cap = makeNearFpCapability({
      fpKey: keyPort(async () => ({ kind: 'ok', key: TEST_KEY })),
    });
    expect(await cap()).toEqual({ state: 'unwired', reason: 'producer_unwired' });
    expect(await makeNearFpCapability({})()).toEqual({
      state: 'unwired',
      reason: 'producer_unwired',
    });
  });
  it('near_capability_key_unavailable_denied:absent / invalid / 读抛错 / 没有 FpKeyPort', async () => {
    const mk = (read: () => Promise<FpKeyRead>) =>
      makeNearFpCapability({ producer, fpKey: keyPort(read), algo: frozenAlgo });
    expect(await mk(async () => ({ kind: 'absent' }))()).toEqual({
      state: 'key_unavailable',
      reason: 'key_absent',
    });
    expect(await mk(async () => ({ kind: 'invalid' }))()).toEqual({
      state: 'key_unavailable',
      reason: 'key_invalid',
    });
    expect(
      await mk(async () => {
        throw new Error(`boom ${Buffer.from(TEST_KEY).toString('hex')}`);
      })(),
    ).toEqual({ state: 'key_unavailable', reason: 'key_read_failed' });
    expect(await makeNearFpCapability({ producer, algo: frozenAlgo })()).toEqual({
      state: 'key_unavailable',
      reason: 'key_absent',
    });
  });
  it('near_capability_algo_unfrozen_denied_with_reason:生产常量 frozen=false,producer 与 key 都就绪也是 algo_unfrozen', async () => {
    const cap = makeNearFpCapability({
      producer,
      fpKey: keyPort(async () => ({ kind: 'ok', key: TEST_KEY })),
    });
    const v = await cap();
    expect(NEAR_ALGO.frozen).toBe(false);
    expect(v).toEqual({ state: 'algo_unfrozen', reason: 'algo_unfrozen' });
    expect(leaksValue(v)).toBe(false);
  });
  it('near_capability_ready_only_when_frozen_true:同一装配,仅冻结位翻转后才 ready;每次调用现读 key(不缓存)', async () => {
    let kind: FpKeyRead['kind'] = 'ok';
    const fpKey = keyPort(async () =>
      kind === 'ok' ? { kind: 'ok', key: TEST_KEY } : ({ kind } as FpKeyRead),
    );
    const unfrozen = makeNearFpCapability({
      producer,
      fpKey,
      algo: { ...frozenAlgo, frozen: false },
    });
    const frozen = makeNearFpCapability({ producer, fpKey, algo: frozenAlgo });
    expect((await unfrozen()).state).toBe('algo_unfrozen');
    expect(await frozen()).toEqual({ state: 'ready', reason: 'none' });
    kind = 'invalid';
    expect((await frozen()).state).toBe('key_unavailable');
    kind = 'ok';
    expect((await frozen()).state).toBe('ready');
  });
});

describe('能力判定的操作级快照:一次取、多个消费者共用', () => {
  const flipping = () => {
    const st = { kind: 'ok' as FpKeyRead['kind'], reads: 0 };
    const fpKey = keyPort(async () => {
      st.reads++;
      return st.kind === 'ok' ? { kind: 'ok', key: TEST_KEY } : ({ kind: st.kind } as FpKeyRead);
    });
    return { st, fpKey };
  };

  it('对照:裸 verdict 函数两次调用之间 key 变了 → 两个消费者结论不同(这正是要避免的分歧)', async () => {
    const { st, fpKey } = flipping();
    const cap = makeNearFpCapability({ producer, fpKey, algo: frozenAlgo });
    const a = await cap();
    st.kind = 'invalid';
    const b = await cap();
    expect([a.state, b.state]).toEqual(['ready', 'key_unavailable']);
  });

  it('快照:取一次(只读一次 key),两个消费者对同一快照结论一致,即使之后 key 变了', async () => {
    const { st, fpKey } = flipping();
    const src = makeNearFpCapabilitySource({ producer, fpKey, algo: frozenAlgo });
    const snap = await src.snapshot();
    expect(st.reads).toBe(1);
    st.kind = 'invalid';
    expect(nearFpReady(snap)).toBe(true);
    expect(nearFpDenial(snap)).toBeNull();
    expect(st.reads).toBe(1);
    // 下一次操作重新取快照,看到新结论(不是全局缓存)
    const next = await src.snapshot();
    expect(st.reads).toBe(2);
    expect([nearFpReady(next), nearFpDenial(next)]).toEqual([
      false,
      { code: 'near_fp_unavailable', state: 'key_unavailable', reason: 'key_invalid' },
    ]);
  });

  it('消费者对非 ready 快照给出带状态与原因的拒绝;nearFpReady 与 nearFpDenial 恒一致(四态全覆盖)', async () => {
    const cases: [Parameters<typeof makeNearFpCapabilitySource>[0], string, string][] = [
      [
        { fpKey: keyPort(async () => ({ kind: 'ok', key: TEST_KEY })), algo: frozenAlgo },
        'unwired',
        'producer_unwired',
      ],
      [{ producer, algo: frozenAlgo }, 'key_unavailable', 'key_absent'],
      [
        {
          producer,
          fpKey: keyPort(async () => ({ kind: 'ok', key: TEST_KEY })),
          algo: { ...frozenAlgo, frozen: false },
        },
        'algo_unfrozen',
        'algo_unfrozen',
      ],
    ];
    for (const [deps, state, reason] of cases) {
      const snap = await makeNearFpCapabilitySource(deps).snapshot();
      expect(nearFpReady(snap)).toBe(false);
      expect(nearFpDenial(snap)).toEqual({ code: 'near_fp_unavailable', state, reason });
    }
    const ok = await makeNearFpCapabilitySource({
      producer,
      fpKey: keyPort(async () => ({ kind: 'ok', key: TEST_KEY })),
      algo: frozenAlgo,
    }).snapshot();
    expect([nearFpReady(ok), nearFpDenial(ok)]).toEqual([true, null]);
  });

  it('快照是冻结的值对象:改写会抛 / 不生效;不含密钥', async () => {
    const { fpKey } = flipping();
    const snap = await makeNearFpCapabilitySource({ producer, fpKey, algo: frozenAlgo }).snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      (snap as { state: string }).state = 'unwired';
    }).toThrow();
    expect(snap.state).toBe('ready');
    expect(leaksValue(snap)).toBe(false);
  });

  it('生产常量:快照恒为 algo_unfrozen,两个消费者都拒绝', async () => {
    const { fpKey } = flipping();
    const snap = await makeNearFpCapabilitySource({ producer, fpKey }).snapshot();
    expect(snap).toEqual({ state: 'algo_unfrozen', reason: 'algo_unfrozen' });
    expect(nearFpReady(snap)).toBe(false);
    expect(nearFpDenial(snap)?.reason).toBe('algo_unfrozen');
  });
});
