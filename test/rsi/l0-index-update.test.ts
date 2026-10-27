/**
 * R20-A2 B4c1:`updateIndex`(R20-4.2 / 4.2a / D7;B4 方案 §3.4)。纯函数,不碰磁盘。
 * 判据:缺失 / 合并 / 新增 n / roots 收敛 / 满员 / 输入不被修改;每条都有正向前提,防止断言静默变空。
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_INDEX_MAX_ENTRIES,
  RsiProjectIndexSchema,
  type RsiProjectIndex,
} from '../../src/contracts/rsi.js';
import { updateIndex } from '../../src/rsi/l0/index-update.js';
import type { IndexObservation, PerKeyCounts } from '../../src/rsi/l0/types.js';

const SALT_FP = 'abcdef012345';
const TODAY = '2026-10-26';

const key = (n: number): string => `p_${n.toString(16).padStart(16, '0')}`;
const obs = (n: number, p = `/work/p${n}`, dev = 1, ino = 100 + n): IndexObservation => ({
  key: key(n),
  path: p,
  dev,
  ino,
});
const counts = (n: number, sessions: number, signals: number): PerKeyCounts => ({
  [key(n)]: { signals_total: signals, sessions, signals_by_day: {} },
});

type Root = RsiProjectIndex['entries'][number]['roots'][number];
const root = (p: string, first: string, last: string, dev = 1, ino = 1): Root => ({
  path: p,
  dev,
  ino,
  first_seen: first,
  last_seen: last,
});
function indexWith(
  entries: { n: number; roots: Root[]; gen?: number; sessions?: number; signals?: number }[],
  generation = 5,
): RsiProjectIndex {
  return RsiProjectIndexSchema.parse({
    schema_version: 1,
    salt_fp: SALT_FP,
    generation,
    entries: entries
      .map((e) => ({
        key: key(e.n),
        roots: e.roots,
        sessions: e.sessions ?? 1,
        signals: e.signals ?? 1,
        first_indexed_generation: e.gen ?? 1,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
  });
}
const run = (
  prev: RsiProjectIndex | null,
  observations: IndexObservation[],
  perKey: PerKeyCounts = {},
  generation = 6,
): ReturnType<typeof updateIndex> =>
  updateIndex({ prev, observations, perKey, saltFp: SALT_FP, generation, today: TODAY });

describe('updateIndex:缺失时用 saltFp 建合法索引', () => {
  it('prev 为空:salt_fp / generation 取入参,新 key 的 first_indexed_generation = generation,sessions / signals 取 perKey,entries 按 key 升序', () => {
    const r = run(null, [obs(3), obs(1), obs(2)], { ...counts(1, 2, 7), ...counts(3, 5, 9) }, 4);
    expect(RsiProjectIndexSchema.safeParse(r.index).success).toBe(true);
    expect(r.index.salt_fp).toBe(SALT_FP);
    expect(r.index.generation).toBe(4);
    expect(r.index.entries.map((e) => e.key)).toEqual([key(1), key(2), key(3)]);
    expect(r.index.entries.map((e) => [e.sessions, e.signals])).toEqual([
      [2, 7],
      [0, 0], // perKey 缺席 = 0(perKey 是全量重算)
      [5, 9],
    ]);
    expect(r.index.entries.every((e) => e.first_indexed_generation === 4)).toBe(true);
    expect(r.index.entries[0]?.roots).toEqual([root('/work/p1', TODAY, TODAY, 1, 101)]);
    expect(r.newKeys).toEqual([key(1), key(2), key(3)]);
    expect(r.full).toBe(false);
  });

  it('没有观测:空索引也合法', () => {
    const r = run(null, []);
    expect(r.index.entries).toEqual([]);
    expect(RsiProjectIndexSchema.safeParse(r.index).success).toBe(true);
    expect(r.newKeys).toEqual([]);
  });

  it('同一批里重复的观测等价于一条;观测顺序不影响结果', () => {
    const a = run(null, [obs(2), obs(1), obs(2), obs(1)]);
    const b = run(null, [obs(1), obs(2)]);
    expect(a).toEqual(b);
    expect(a.index.entries).toHaveLength(2);
  });
});

describe('updateIndex:合并(同 key 同 path 只更新 last_seen)', () => {
  it('(dev, ino) 一致:last_seen 刷新,first_seen / first_indexed_generation 不变,不算新增;sessions / signals 取 perKey', () => {
    const prev = indexWith([
      { n: 1, roots: [root('/work/p1', '2026-10-01', '2026-10-20', 1, 101)], gen: 2, sessions: 9 },
    ]);
    const r = run(prev, [obs(1)], counts(1, 3, 4));
    const e = r.index.entries[0];
    expect(e?.roots).toEqual([root('/work/p1', '2026-10-01', TODAY, 1, 101)]);
    expect(e?.first_indexed_generation).toBe(2);
    expect([e?.sessions, e?.signals]).toEqual([3, 4]);
    expect(r.newKeys).toEqual([]);
    expect(r.index.generation).toBe(6);
  });

  it('(dev, ino) 不一致(目录被换过):这条根完全不动(不刷新 last_seen、不改记录的 dev/ino、不追加同路径第二条根)', () => {
    const prev = indexWith([
      { n: 1, roots: [root('/work/p1', '2026-10-01', '2026-10-20', 1, 101)] },
    ]);
    const r = run(prev, [{ ...obs(1), ino: 999 }]);
    expect(r.index.entries[0]?.roots).toEqual([
      root('/work/p1', '2026-10-01', '2026-10-20', 1, 101),
    ]);
    // 对照:同一输入 (dev, ino) 一致时确实会刷新(防止「不动」来自别处)
    const ok = run(prev, [obs(1)]);
    expect(ok.index.entries[0]?.roots[0]?.last_seen).toBe(TODAY);
  });

  it('没被观测的条目:roots 原样保留,sessions / signals 仍取 perKey(缺席 = 0)', () => {
    const prev = indexWith([
      { n: 1, roots: [root('/work/p1', '2026-10-01', '2026-10-20')], sessions: 8, signals: 8 },
      { n: 2, roots: [root('/work/p2', '2026-10-02', '2026-10-21')], sessions: 8, signals: 8 },
    ]);
    const r = run(prev, [obs(2, '/work/p2', 1, 1)], counts(1, 2, 3));
    const e1 = r.index.entries.find((e) => e.key === key(1));
    const e2 = r.index.entries.find((e) => e.key === key(2));
    expect(e1?.roots).toEqual([root('/work/p1', '2026-10-01', '2026-10-20')]);
    expect([e1?.sessions, e1?.signals]).toEqual([2, 3]);
    expect([e2?.sessions, e2?.signals]).toEqual([0, 0]);
  });

  it('新 key 与旧条目并存:newKeys 只含新的,旧条目的 first_indexed_generation 不变,新的取本次 generation', () => {
    const prev = indexWith([
      { n: 1, roots: [root('/work/p1', '2026-10-01', '2026-10-20')], gen: 3 },
    ]);
    const r = run(prev, [obs(1, '/work/p1', 1, 1), obs(2)], {}, 9);
    expect(r.newKeys).toEqual([key(2)]);
    expect(r.index.entries.map((e) => [e.key, e.first_indexed_generation])).toEqual([
      [key(1), 3],
      [key(2), 9],
    ]);
  });

  it('输入不被修改', () => {
    const prev = indexWith([
      { n: 1, roots: [root('/work/p1', '2026-10-01', '2026-10-20', 1, 101)] },
    ]);
    const snap = JSON.stringify(prev);
    const observations = [obs(1), obs(2)];
    const osnap = JSON.stringify(observations);
    const perKey = counts(1, 5, 5);
    const psnap = JSON.stringify(perKey);
    run(prev, observations, perKey);
    expect(JSON.stringify(prev)).toBe(snap);
    expect(JSON.stringify(observations)).toBe(osnap);
    expect(JSON.stringify(perKey)).toBe(psnap);
  });
});

describe('updateIndex:同 key 不同 path 的根收敛到 ≤ 8 条(最早一条 + last_seen 最近的 7 条)', () => {
  const eight = (): Root[] =>
    Array.from({ length: 8 }, (_, i) =>
      root(
        `/work/a${i}`,
        `2026-09-${String(10 + i).padStart(2, '0')}`,
        `2026-10-${String(10 + i).padStart(2, '0')}`,
      ),
    );

  it('不足 8 条:追加,first_seen = last_seen = today', () => {
    const prev = indexWith([{ n: 1, roots: [root('/work/a', '2026-10-01', '2026-10-05')] }]);
    const r = run(prev, [obs(1, '/work/b', 2, 22)]);
    expect(r.index.entries[0]?.roots).toEqual([
      root('/work/a', '2026-10-01', '2026-10-05'),
      root('/work/b', TODAY, TODAY, 2, 22),
    ]);
  });

  it('第 9 条进来:保留 first_seen 最早的 a0,再按 last_seen 降序留 7 条,丢掉 last_seen 最旧的 a1;相对顺序不变', () => {
    const prev = indexWith([{ n: 1, roots: eight() }]);
    const r = run(prev, [obs(1, '/work/new', 3, 33)]);
    const paths = r.index.entries[0]?.roots.map((x) => x.path);
    expect(paths).toHaveLength(8);
    expect(paths).toEqual([
      '/work/a0', // first_seen 最早:保留(即使它的 last_seen 不是最近)
      '/work/a2',
      '/work/a3',
      '/work/a4',
      '/work/a5',
      '/work/a6',
      '/work/a7',
      '/work/new',
    ]);
    // 对照:丢掉的确实是 last_seen 次旧的 a1,而不是 first_seen 最早的
    expect(paths).not.toContain('/work/a1');
  });

  it('漂移根((dev, ino) 不一致、被冻结)不特殊处理:第 9 条新路径进来时按 first_seen / last_seen 正常收敛,冻结的陈旧根会被砍掉;对照:同位置的根若被正常观测则保留', () => {
    const roots = eight();
    const drifted = { ...obs(1, '/work/a1'), ino: 99999 }; // a1 = last_seen 次旧的那条,观测到的 (dev, ino) 与记录不符
    const r = run(indexWith([{ n: 1, roots }]), [drifted, obs(1, '/work/new', 3, 33)]);
    const paths = r.index.entries[0]?.roots.map((x) => x.path);
    expect(paths).toHaveLength(8);
    expect(paths).not.toContain('/work/a1');
    // 对照:a1 被正常观测(dev, ino 一致 → 刷新 last_seen)则保留,被砍的换成 a2
    const ok = run(indexWith([{ n: 1, roots }]), [
      { ...obs(1, '/work/a1'), dev: 1, ino: 1 },
      obs(1, '/work/new', 3, 33),
    ]);
    const okPaths = ok.index.entries[0]?.roots.map((x) => x.path);
    expect(okPaths).toContain('/work/a1');
    expect(okPaths).not.toContain('/work/a2');
  });

  it('first_seen 最早的那条 last_seen 最旧时也保留(与「只按 last_seen 取前 8」区分)', () => {
    const roots = eight();
    roots[0] = root('/work/a0', '2026-01-01', '2026-02-01'); // 最早、也最久没见
    const r = run(indexWith([{ n: 1, roots }]), [obs(1, '/work/new', 3, 33)]);
    expect(r.index.entries[0]?.roots.map((x) => x.path)).toContain('/work/a0');
  });
});

describe('updateIndex:并列时的取舍是确定的', () => {
  it('first_seen / last_seen 全部相同:最早 = 数组里靠前的一条;其余并列取数组里靠后的 → 丢掉第二条', () => {
    const same = (i: number): Root => root(`/work/t${i}`, TODAY, TODAY);
    const prev = indexWith([{ n: 1, roots: Array.from({ length: 8 }, (_, i) => same(i)) }]);
    const r = run(prev, [obs(1, '/work/new', 3, 33)]);
    expect(r.index.entries[0]?.roots.map((x) => x.path)).toEqual([
      '/work/t0',
      '/work/t2',
      '/work/t3',
      '/work/t4',
      '/work/t5',
      '/work/t6',
      '/work/t7',
      '/work/new',
    ]);
    // 同一输入再跑一次,结果逐字节相同
    expect(run(prev, [obs(1, '/work/new', 3, 33)])).toEqual(r);
  });
});

describe('updateIndex:满 RSI_INDEX_MAX_ENTRIES 后新 key 不入索引', () => {
  const bigPrev = (n: number): RsiProjectIndex =>
    RsiProjectIndexSchema.parse({
      schema_version: 1,
      salt_fp: SALT_FP,
      generation: 5,
      entries: Array.from({ length: n }, (_, i) => ({
        key: key(i + 1000),
        roots: [root(`/w/${i}`, '2026-10-01', '2026-10-02')],
        sessions: 1,
        signals: 1,
        first_indexed_generation: 1,
      })),
    });

  it('正好满员:新 key 丢弃且 full = true;已有 key 照常刷新;索引仍合法', () => {
    const prev = bigPrev(RSI_INDEX_MAX_ENTRIES);
    expect(prev.entries).toHaveLength(RSI_INDEX_MAX_ENTRIES);
    const r = run(prev, [obs(1), { key: key(1000), path: '/w/0', dev: 1, ino: 1 }]);
    expect(r.full).toBe(true);
    expect(r.newKeys).toEqual([]);
    expect(r.index.entries).toHaveLength(RSI_INDEX_MAX_ENTRIES);
    expect(r.index.entries.find((e) => e.key === key(1))).toBeUndefined();
    expect(r.index.entries[0]?.roots[0]?.last_seen).toBe(TODAY);
  });

  it('差一个满员:key 升序在前的先入,后面的丢;full = true', () => {
    const prev = bigPrev(RSI_INDEX_MAX_ENTRIES - 1);
    const r = run(prev, [obs(3), obs(2)]);
    expect(r.newKeys).toEqual([key(2)]);
    expect(r.full).toBe(true);
    expect(r.index.entries).toHaveLength(RSI_INDEX_MAX_ENTRIES);
  });

  it('未满、也没有被丢的:full = false(正向对照)', () => {
    const r = run(bigPrev(RSI_INDEX_MAX_ENTRIES - 2), [obs(2), obs(3)]);
    expect(r.full).toBe(false);
    expect(r.newKeys).toEqual([key(2), key(3)]);
  });
});

describe('updateIndex:调用方违约时不静默', () => {
  it('prev.salt_fp 与真实盐指纹不符 → 抛错(D7:盐不符的索引只能 --rebuild-index 替换)', () => {
    const prev = indexWith([{ n: 1, roots: [root('/work/p1', '2026-10-01', '2026-10-20')] }]);
    expect(() =>
      updateIndex({
        prev,
        observations: [obs(1)],
        perKey: {},
        saltFp: '000000000000',
        generation: 6,
        today: TODAY,
      }),
    ).toThrow(RangeError);
    // 对照:盐一致不抛
    expect(() => run(prev, [obs(1)])).not.toThrow();
  });

  it('观测的路径不是绝对路径 → 不产出写不出去的索引(抛错)', () => {
    expect(() => run(null, [obs(1, 'relative/dir')])).toThrow();
    expect(() => run(null, [obs(1)])).not.toThrow();
  });
});
