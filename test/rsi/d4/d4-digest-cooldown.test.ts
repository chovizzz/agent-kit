/**
 * D4 / digest 的聚类冷却过滤(契约 R21-11.1「期间该聚类不进 digest」;设计稿 verify_r21-asm-d-design.md §7)。
 * 冷却账(B1a 的 effects 账)尚未合并:这里只测依赖端口 + 纯逻辑 + `runDigest` 的接线(端口用假件)。生产适配器不在本块。
 * fail-closed:端口已注入但读不到 → 所有簇都视为在冷却中(一个簇也不提),原因进结构化报告、不进 digest 输出。
 * 每条不变量都带正向对照(同夹具下冷却集合为空 / 不命中,结果必须不同)。
 */
import { describe, expect, it } from 'vitest';
import { selectClustersScreened } from '../../../src/rsi/digest.js';
import {
  COOLDOWN_MAX_ID_BYTES,
  COOLDOWN_MAX_IDS,
  COOLDOWN_MAX_TOTAL_BYTES,
  makeCooldownFilter,
  readCooldown,
  reportOf,
  utcDayOf,
  type CooldownPort,
  type CooldownRead,
  type CooldownReport,
} from '../../../src/rsi/digest-cooldown.js';
import {
  DIGEST_ARGS,
  L_FILES,
  L_TEST,
  digestCmd,
  lesson,
  makeA4World,
  parseDigest,
} from '../a4-fixture.js';

const KEY = 'p_aaaaaaaaaaaaaaaa';
const OTHER = 'p_bbbbbbbbbbbbbbbb';
const sigs = (n: number) =>
  Array.from({ length: n }, (_, i) => lesson(KEY, `s${i}`, i, 'from now on alpha beta gamma'));

/** 假端口:`active` 是今天仍生效的冷却聚类 id;`clusterId` 由测试给 */
const portOf = (
  read: CooldownRead | (() => Promise<CooldownRead>),
  clusterId: CooldownPort['clusterId'],
  seen: string[] = [],
): CooldownPort => ({
  source: {
    activeClusterIds: async (day) => {
      seen.push(day);
      return typeof read === 'function' ? read() : read;
    },
  },
  clusterId,
});
const okSet = (...ids: string[]): CooldownRead => ({ kind: 'ok', active: new Set(ids) });
const NOW = new Date('2026-10-26T12:00:00.000Z');

describe('D4 冷却:读冷却事实(readCooldown 永不抛错)', () => {
  it('未注入端口 → null(未接线,不过滤);注入后原样返回 ok 集合', async () => {
    expect(await readCooldown(undefined, NOW)).toBeNull();
    const r = await readCooldown(
      portOf(okSet('c_1'), () => null),
      NOW,
    );
    expect(r).toEqual({ kind: 'ok', active: new Set(['c_1']) });
  });

  it('把「今天」按 UTC 日传给端口(带偏移的时间按 UTC 折算;UTC 日界两侧不同)', async () => {
    const seen: string[] = [];
    const port = portOf(okSet(), () => null, seen);
    await readCooldown(port, new Date('2026-10-26T23:59:59.999Z'));
    await readCooldown(port, new Date('2026-10-27T00:00:00.000Z'));
    await readCooldown(port, new Date('2026-10-26T23:30:00-05:00')); // = 10-27T04:30Z
    expect(seen).toEqual(['2026-10-26', '2026-10-27', '2026-10-27']);
    expect(utcDayOf(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02');
  });

  it('端口报告 unavailable:带稳定短码原样保留;短码不合格式(路径 / 异常文本)→ invalid_result', async () => {
    expect(
      await readCooldown(
        portOf({ kind: 'unavailable', why: 'ledger_unreadable' }, () => null),
        NOW,
      ),
    ).toEqual({ kind: 'unavailable', why: 'ledger_unreadable' });
    for (const why of [
      '/Users/x/.state/effects.json',
      'ENOENT: no such file',
      '',
      'x'.repeat(65),
    ]) {
      expect(
        await readCooldown(
          portOf({ kind: 'unavailable', why }, () => null),
          NOW,
        ),
        why,
      ).toEqual({
        kind: 'unavailable',
        why: 'invalid_result',
      });
    }
  });

  it('端口抛错 / 返回形状不对(ok 但 active 不是 Set、未知 kind)→ unavailable,不当成「没有冷却」', async () => {
    const thrown = await readCooldown(
      portOf(
        async () => {
          throw new Error('EACCES /secret/path');
        },
        () => null,
      ),
      NOW,
    );
    expect(thrown).toEqual({ kind: 'unavailable', why: 'source_threw' });
    for (const bad of [{ kind: 'ok', active: ['c_1'] }, { kind: 'ok' }, { kind: 'nope' }, null]) {
      expect(
        await readCooldown(
          portOf(bad as never, () => null),
          NOW,
        ),
        JSON.stringify(bad),
      ).toEqual({
        kind: 'unavailable',
        why: 'invalid_result',
      });
    }
  });
});

describe('D4 冷却:ok 集合的资源边界与受控遍历(M1;超限 → unavailable/too_large,不当成「没有命中」)', () => {
  const read = (active: unknown) =>
    readCooldown(
      portOf({ kind: 'ok', active } as never, () => null),
      NOW,
    );
  const ids = (n: number, width = 8): Set<string> =>
    new Set(Array.from({ length: n }, (_, i) => String(i).padStart(width, 'x')));

  it('常量钉死:10000 条 / 单个 256 字节 / 累计 1 MiB', () => {
    expect([COOLDOWN_MAX_IDS, COOLDOWN_MAX_ID_BYTES, COOLDOWN_MAX_TOTAL_BYTES]).toEqual([
      10_000,
      256,
      1024 * 1024,
    ]);
  });

  it('条数:恰好 10000 → ok;10001 → unavailable(too_large)', async () => {
    const at = await read(ids(COOLDOWN_MAX_IDS));
    expect(at?.kind === 'ok' && at.active.size).toBe(COOLDOWN_MAX_IDS);
    expect(await read(ids(COOLDOWN_MAX_IDS + 1))).toEqual({
      kind: 'unavailable',
      why: 'too_large',
    });
  });

  it('单个 id:恰好 256 字节 → ok;257 字节 → too_large;按 UTF-8 字节而不是字符数(129 个 é = 258 字节)', async () => {
    expect((await read(new Set(['a'.repeat(256)])))?.kind).toBe('ok');
    expect(await read(new Set(['a'.repeat(257)]))).toEqual({
      kind: 'unavailable',
      why: 'too_large',
    });
    const wide = new Set(['é'.repeat(129)]);
    expect([...wide][0]?.length).toBe(129);
    expect(await read(wide)).toEqual({ kind: 'unavailable', why: 'too_large' });
    expect((await read(new Set(['é'.repeat(128)])))?.kind).toBe('ok'); // 256 字节,对照
  });

  it('累计字节:4096 个 256 字节的 id(恰好 1 MiB)→ ok;4097 个 → too_large(条数与单个都没超)', async () => {
    const mk = (n: number): Set<string> =>
      new Set(Array.from({ length: n }, (_, i) => String(i).padStart(COOLDOWN_MAX_ID_BYTES, 'x')));
    const at = await read(mk(4096));
    expect(at?.kind === 'ok' && at.active.size).toBe(4096);
    expect(await read(mk(4097))).toEqual({ kind: 'unavailable', why: 'too_large' });
  });

  it('适配器覆盖迭代器 / size 的 Set 子类:读的是真实内容(不调用被覆盖的迭代器),也不能靠谎报 size 绕过上限', async () => {
    // 有限但与真实内容不同的假迭代器(无限迭代器会让「用了被覆盖迭代器」的变异直接挂死,这里用可断言的内容代替)
    const fake = (): IterableIterator<string> => ['evil_1', 'evil_2'].values();
    const evil = new Set(['c_real']);
    Object.defineProperty(evil, Symbol.iterator, { value: fake });
    Object.defineProperty(evil, 'values', { value: fake });
    Object.defineProperty(evil, 'forEach', { value: fake });
    expect(await read(evil)).toEqual({ kind: 'ok', active: new Set(['c_real']) });

    const liar = ids(COOLDOWN_MAX_IDS + 1);
    Object.defineProperty(liar, 'size', { get: () => 1 });
    expect(liar.size).toBe(1);
    expect(await read(liar)).toEqual({ kind: 'unavailable', why: 'too_large' });
  });

  it('非原生 Set(Proxy / 鸭子类型 / 数组)→ invalid_result;对照:原生 Set 同内容 ok', async () => {
    const real = new Set(['c_1']);
    expect(await read(real)).toEqual({ kind: 'ok', active: new Set(['c_1']) });
    for (const fake of [
      new Proxy(real, {}),
      {
        size: 1,
        values: () => ['c_1'][Symbol.iterator](),
        [Symbol.iterator]: () => ['c_1'][Symbol.iterator](),
      },
      ['c_1'],
    ]) {
      expect(await read(fake)).toEqual({ kind: 'unavailable', why: 'invalid_result' });
    }
  });
});

describe('D4 冷却:ok 集合的内容校验(不只看 Set 外壳)', () => {
  it('元素必须是非空字符串(Set<number> / Set<object> / 混合 / 含空串)→ unavailable,不当成「没有命中」', async () => {
    const bads = [
      new Set([1]),
      new Set([{ cluster_id: 'abc' }]),
      new Set(['c_1', 2]),
      new Set(['c_1', '']),
    ];
    for (const [i, bad] of bads.entries()) {
      expect(
        await readCooldown(
          portOf({ kind: 'ok', active: bad } as never, () => null),
          NOW,
        ),
        `#${i}`,
      ).toEqual({ kind: 'unavailable', why: 'invalid_result' });
    }
    // 对照:纯字符串集合合法;空集合合法(= 今天没有冷却)
    expect(
      await readCooldown(
        portOf(okSet('c_1', 'c_2'), () => null),
        NOW,
      ),
    ).toEqual({
      kind: 'ok',
      active: new Set(['c_1', 'c_2']),
    });
    expect(
      await readCooldown(
        portOf(okSet(), () => null),
        NOW,
      ),
    ).toEqual({
      kind: 'ok',
      active: new Set(),
    });
  });

  it('合法集合被复制:适配器读完后再改它,不影响本次结果', async () => {
    const mine = new Set(['c_1']);
    const r = await readCooldown(
      portOf({ kind: 'ok', active: mine }, () => null),
      NOW,
    );
    mine.add('c_2');
    mine.delete('c_1');
    expect(r).toEqual({ kind: 'ok', active: new Set(['c_1']) });
  });
});

describe('D4 冷却:簇过滤器(纯)', () => {
  // 假 clusterId:按信号个数命名,这样「全部成员」与「可作证据的成员」会得到不同的 id
  const byCount = (s: readonly unknown[]): string | null => `n${s.length}`;

  it('未接线 / 未读 → 永远不过滤', () => {
    expect(makeCooldownFilter(undefined, okSet('n3'))(sigs(3), sigs(3))).toBe(false);
    expect(makeCooldownFilter(portOf(okSet('n3'), byCount), null)(sigs(3), sigs(3))).toBe(false);
  });

  it('命中判定:全部成员的 id 或可作证据成员的 id 任一在冷却集合里 → 冷却;都不在 → 不冷却(对照);空集合 → 不冷却', () => {
    const f = (...ids: string[]) =>
      makeCooldownFilter(portOf(okSet(...ids), byCount), okSet(...ids));
    expect(f('n4')(sigs(4), sigs(3))).toBe(true); // 全部成员命中
    expect(f('n3')(sigs(4), sigs(3))).toBe(true); // 只有可作证据的成员命中
    expect(f('n9')(sigs(4), sigs(3))).toBe(false); // 都不命中
    expect(f()(sigs(4), sigs(3))).toBe(false); // 冷却账为空
    expect(f('n4')(sigs(4), [])).toBe(true); // 没有可作证据成员时只看全部成员
  });

  it('聚类 id 算不出(null)→ 该簇不在冷却账里(不可能被提成过候选);算 id 抛错 → 按冷却中处理(fail-closed)', () => {
    const nullId = makeCooldownFilter(
      portOf(okSet('n3'), () => null),
      okSet('n3'),
    );
    expect(nullId(sigs(3), sigs(3))).toBe(false);
    const boom = makeCooldownFilter(
      portOf(okSet('n3'), () => {
        throw new Error('boom');
      }),
      okSet('n3'),
    );
    expect(boom(sigs(3), sigs(3))).toBe(true);
  });

  it('端口读不到(unavailable)→ 所有簇都在冷却中,与簇内容无关', () => {
    const f = makeCooldownFilter(portOf(okSet(), byCount), { kind: 'unavailable', why: 'x_y' });
    expect(f(sigs(1), sigs(1))).toBe(true);
    expect(f([], [])).toBe(true);
  });

  it('报告:未接线 / 未读(已注入但无可提的簇)/ ok / unavailable 四种形状固定', () => {
    const port = portOf(okSet(), byCount);
    expect(reportOf(undefined, null, 0)).toEqual({ state: 'not_wired' });
    expect(reportOf(port, null, 0)).toEqual({ state: 'skipped' });
    expect(reportOf(port, okSet(), 2)).toEqual({ state: 'ok', dropped: 2 });
    expect(reportOf(port, { kind: 'unavailable', why: 'ledger_unreadable' }, 3)).toEqual({
      state: 'unavailable',
      why: 'ledger_unreadable',
      dropped: 3,
    });
  });
});

describe('D4 冷却:取舍里的位置(selectClustersScreened;冷却簇不占 5 簇名额)', () => {
  const texts = [1, 2, 3, 4, 5, 6].map((i) => `from now on alpha${i} beta${i} gamma${i} delta${i}`);
  const sizes = [2, 10, 3, 3, 1, 4];
  const mk = (key: string, n: number, text: string, sess: string) =>
    Array.from({ length: n }, (_, i) => lesson(key, `${sess}${i}`, 0, text));
  const all = texts.flatMap((t, i) => mk(KEY, sizes[i] as number, t, `s${i}x`));
  const idOf = (s: readonly { excerpt_redacted: string }[]): string | null =>
    /alpha\d/.exec(s[0]?.excerpt_redacted ?? '')?.[0] ?? null;
  const filterFor = (read: CooldownRead) => makeCooldownFilter(portOf(read, idOf), read);
  const lens = (s: ReturnType<typeof selectClustersScreened>): number[] =>
    s.selected.map((c) => c.current.length);

  it('基线(无过滤)→ 8,4,3,3,2;冷却集合不命中时与基线逐项相同(对照)', () => {
    const base = selectClustersScreened(all, KEY, (s) => s);
    expect([lens(base), base.cooldownDropped]).toEqual([[8, 4, 3, 3, 2], 0]);
    const miss = selectClustersScreened(all, KEY, (s) => s, filterFor(okSet('alpha99')));
    expect(miss).toEqual(base);
  });

  it('冷却中的最大簇被丢弃且先于 5 簇截断:原本被挤掉的 1 条簇补位;cooldownDropped 计 1', () => {
    const r = selectClustersScreened(all, KEY, (s) => s, filterFor(okSet('alpha2')));
    expect(lens(r)).toEqual([4, 3, 3, 2, 1]);
    expect(r.cooldownDropped).toBe(1);
    // 被丢的簇的文本不在任何入选簇里
    const text = JSON.stringify(r.selected);
    expect(text).not.toContain('alpha2');
  });

  it('只数「本来会被提」的簇:只有其它项目有证据的冷却簇不计数(它本来就不入选);同一簇两种证据口径只数一次', () => {
    const other = mk(OTHER, 3, 'from now on alpha7 beta7 gamma7 delta7', 'ox');
    const r = selectClustersScreened([...all, ...other], KEY, (s) => s, filterFor(okSet('alpha7')));
    expect(r.cooldownDropped).toBe(0);
    expect(lens(r)).toEqual([8, 4, 3, 3, 2]);
    const both = selectClustersScreened(all, KEY, (s) => s, filterFor(okSet('alpha2', 'alpha1')));
    expect(both.cooldownDropped).toBe(2);
  });

  it('cooldownDropped 口径 = 冷却前具备初始证据的簇(不是精确的反事实):证据本来会被单条闸全部丢掉的冷却簇也计 1,且不进单条闸;对照:不冷却时它们走 clustersEmptied', () => {
    const none = selectClustersScreened(all, KEY, () => null);
    expect([none.cooldownDropped, none.evidenceDropped, none.clustersEmptied]).toEqual([0, 23, 6]);
    const r = selectClustersScreened(all, KEY, () => null, filterFor(okSet('alpha2')));
    // alpha2 簇(10 条)没进单条闸:evidenceDropped = 23 - 10;它计为冷却丢簇而不是 clustersEmptied
    expect([r.cooldownDropped, r.evidenceDropped, r.clustersEmptied]).toEqual([1, 13, 5]);
    expect(r.selected).toEqual([]);
  });

  it('读不到冷却事实(unavailable)→ 一个簇也不提,6 个本来会被提的簇全部计入 cooldownDropped', () => {
    const r = selectClustersScreened(
      all,
      KEY,
      (s) => s,
      filterFor({ kind: 'unavailable', why: 'ledger_unreadable' }),
    );
    expect([r.selected, r.cooldownDropped]).toEqual([[], 6]);
  });

  it('冷却丢弃发生在单条闸之前:被冷却的簇不增加 evidenceDropped / clustersEmptied', () => {
    let screened = 0;
    const r = selectClustersScreened(
      all,
      KEY,
      (s) => {
        screened++;
        return s;
      },
      filterFor(okSet('alpha2')),
    );
    // 10 条的冷却簇一条都没进单条闸:其余簇 2+3+3+1+4 = 13 条
    expect(screened).toBe(13);
    expect([r.evidenceDropped, r.clustersEmptied]).toEqual([0, 0]);
  });
});

describe('D4 冷却:runDigest 接线(假端口;真实世界、真实配置)', () => {
  const idOf = (s: readonly { excerpt_redacted: string }[]): string | null =>
    s.some((x) => x.excerpt_redacted.includes('unit tests')) ? 'k_test' : 'k_files';
  const run = async (prefix: string, read: CooldownRead | (() => Promise<CooldownRead>) | null) => {
    const w = await makeA4World(prefix);
    const reports: CooldownReport[] = [];
    const seen: string[] = [];
    const r = await digestCmd(w, DIGEST_ARGS(), {
      ...(read === null ? {} : { cooldown: portOf(read, idOf, seen) }),
      onCooldown: (x) => void reports.push(x),
    });
    return { r, reports, seen, d: r.code === 0 ? parseDigest(r.out) : null };
  };

  it('未接线 → 与改前相同(2 个簇、clusters_dropped=0),报告 not_wired', async () => {
    const { r, reports, d } = await run('d4-cd-nowire-', null);
    expect(r.code).toBe(0);
    expect(d?.clusters.map((c) => c.evidence.length)).toEqual([3, 2]);
    expect(d?.truncated).toEqual({ clusters_dropped: 0, evidence_dropped: 0 });
    expect(reports).toEqual([{ state: 'not_wired' }]);
  });

  it('正向对照:接线但冷却集合为空 → 与未接线输出相同;端口收到的是 UTC 今天', async () => {
    const { reports, seen, d } = await run('d4-cd-empty-', okSet());
    expect(d?.clusters.map((c) => c.evidence.length)).toEqual([3, 2]);
    expect(d?.truncated.clusters_dropped).toBe(0);
    expect(reports).toEqual([{ state: 'ok', dropped: 0 }]);
    expect(seen).toEqual(['2026-10-26']);
  });

  it('命中冷却的簇不进摘要(文本不出现),计入 truncated.clusters_dropped;另一个簇照常', async () => {
    const { r, reports, d } = await run('d4-cd-hit-', okSet('k_test'));
    expect(r.code).toBe(0);
    expect(d?.reason).toBe('ok');
    expect(d?.clusters.map((c) => [c.alias, c.evidence.length])).toEqual([['c1', 2]]);
    expect(d?.truncated).toEqual({ clusters_dropped: 1, evidence_dropped: 0 });
    expect(r.out).not.toContain(L_TEST);
    expect(r.out).toContain(L_FILES);
    expect(reports).toEqual([{ state: 'ok', dropped: 1 }]);
  });

  it('读不到冷却事实(端口 unavailable)→ fail-closed:空摘要 reason=no_clusters,两个簇都计入丢弃,退出码仍 0', async () => {
    const { r, reports, d } = await run('d4-cd-unavail-', {
      kind: 'unavailable',
      why: 'ledger_unreadable',
    });
    expect(r.code).toBe(0);
    expect(d?.reason).toBe('no_clusters');
    expect(d?.clusters).toEqual([]);
    expect(d?.truncated).toEqual({ clusters_dropped: 2, evidence_dropped: 0 });
    expect(r.out).not.toContain(L_TEST);
    expect(r.out).not.toContain(L_FILES);
    expect(reports).toEqual([{ state: 'unavailable', why: 'ledger_unreadable', dropped: 2 }]);
  });

  it('项目被排除(没有可提的簇)→ 已注入的端口不被调用,报告 skipped;摘要 reason=project_excluded', async () => {
    const w = await makeA4World('d4-cd-skip-');
    const reports: CooldownReport[] = [];
    const seen: string[] = [];
    const r = await digestCmd(w, DIGEST_ARGS(), {
      cwd: w.roots.ex,
      cooldown: portOf(okSet('k_test'), idOf, seen),
      onCooldown: (x) => void reports.push(x),
    });
    expect(r.code).toBe(0);
    expect(parseDigest(r.out).reason).toBe('project_excluded');
    expect(seen).toEqual([]);
    expect(reports).toEqual([{ state: 'skipped' }]);
  });

  it('端口抛错 → 同样 fail-closed,原因 source_threw(异常文本不外泄)', async () => {
    const { r, reports, d } = await run('d4-cd-throw-', async () => {
      throw new Error('EACCES /very/secret/path');
    });
    expect(d?.clusters).toEqual([]);
    expect(reports).toEqual([{ state: 'unavailable', why: 'source_threw', dropped: 2 }]);
    expect(r.out + r.err).not.toContain('secret');
  });
});
