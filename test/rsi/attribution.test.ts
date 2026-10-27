/**
 * R20-A2 B3a + 统一:项目归属现算(R20-4.3 / 4.4 / 4.6)。优先级 X > U > P;X 只看根路径与排除规则(盐是否相符不影响);
 * counts 缺失 / 盐不符 = 无法核对盐 → 非 X 的 key 为 U;证据 key 不在索引里 = U。这是 status / projects / 即时闸 / taint 共用的唯一实现。
 * 探测全经注入的假 probe(不依赖真实文件系统布局),排除项的 canonical 用真实 realpath(不存在的路径按字面处理)。
 */
import { describe, expect, it } from 'vitest';
import type { RsiCounts, RsiProjectIndex } from '../../src/contracts/rsi.js';
import path from 'node:path';
import {
  attribute,
  createAttributor,
  latestRoot,
  type AttributionProbe,
} from '../../src/rsi/attribution.js';
import { stat } from '../../src/io/read-fs.js';
import { mkdirp, symlink } from '../../src/io/safe-fs.js';
import { makeRsiFx } from './rsi-fixture.js';
import type { RsiConfigOn } from '../../src/rsi/config.js';

type Root = RsiProjectIndex['entries'][number]['roots'][number];

const cfg = (over: Partial<RsiConfigOn> = {}): RsiConfigOn => ({
  status: 'on',
  repo: '/r',
  overlayPath: null,
  overlaySha256: null,
  agents: ['claude'],
  excludeDirs: [],
  excludeNames: [],
  block: null,
  warnings: [],
  ...over,
});
const K = (n: number): string => `p_${n.toString(16).padStart(2, '0')}${'0'.repeat(14)}`;
/** 每个路径一个互不相同的假 inode,避免「所有祖先 (dev,ino) 恒等」造成的假命中 */
const inoOf = (p: string): number =>
  [...p].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_003, 7);
const root = (p: string, last = '2026-10-23', dev = 1, ino = inoOf(p)): Root => ({
  path: p,
  dev,
  ino,
  first_seen: '2026-10-01',
  last_seen: last,
});
const idx = (entries: [string, Root[]][], salt = 'aaaaaaaaaaaa'): RsiProjectIndex => ({
  schema_version: 1,
  salt_fp: salt,
  generation: 1,
  entries: entries
    .map(([key, roots]) => ({ key, roots, sessions: 1, signals: 1, first_indexed_generation: 1 }))
    .sort((a, b) => (a.key < b.key ? -1 : 1)),
});
const counts = (salt = 'aaaaaaaaaaaa'): RsiCounts => ({
  schema_version: 1,
  salt_fp: salt,
  generation: 1,
  computed_at: '2026-10-24T00:00:00.000Z',
  cluster_min: 3,
  per_key: {},
  clusters: [],
  staged: [],
  unknown_keys_signals: 0,
});

/** 全部存在、realpath 恒等、(dev, ino) = (1, inoOf(路径)) 的探测;可逐项覆盖 */
function probe(over: Partial<AttributionProbe> = {}): AttributionProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exists: async (p) => (calls.push(`exists ${p}`), true),
    realpath: async (p) => (calls.push(`realpath ${p}`), p),
    devIno: async (p) => (calls.push(`devIno ${p}`), { dev: 1, ino: inoOf(p) }),
    ...over,
  };
}

const run = async (
  entries: [string, Root[]][],
  config = cfg(),
  p: AttributionProbe = probe(),
  extra: { status?: 'ok' | 'absent' | 'invalid'; counts?: RsiCounts | null } = {},
) =>
  attribute({
    config,
    indexStatus: extra.status ?? 'ok',
    index: extra.status === 'invalid' || extra.status === 'absent' ? null : idx(entries),
    counts: extra.counts === undefined ? counts() : extra.counts,
    probe: p,
  });

describe('P / X / U 决策表', () => {
  it('基线:根存在、realpath 恒等、(dev,ino) 一致 → P', async () => {
    const r = await run([[K(1), [root('/w/a')]]]);
    expect(r.byKey.get(K(1))).toBe('P');
    expect(r.indexUsable).toBe(true);
  });

  it('排除目录:相等 / 之内(按段边界)命中;`/w/a-evil` 不命中 `/w/a`;大小写折叠', async () => {
    const c = cfg({ excludeDirs: ['/w/a'] });
    const r = await run(
      [
        [K(1), [root('/w/a')]],
        [K(2), [root('/w/a/sub/deep')]],
        [K(3), [root('/w/a-evil')]],
        [K(4), [root('/W/A/Sub')]],
      ],
      c,
    );
    expect([1, 2, 3, 4].map((n) => r.byKey.get(K(n)))).toEqual(['X', 'X', 'P', 'X']);
  });

  it('排除名字:任一根的 basename 相等(折叠大小写);非绝对排除路径不参与目录比较', async () => {
    const r = await run(
      [
        [K(1), [root('/w/Client-X')]],
        [K(2), [root('/w/other')]],
      ],
      cfg({ excludeNames: ['client-x'], excludeDirs: ['relative/dir', 'other'] }),
    );
    expect(r.byKey.get(K(1))).toBe('X');
    expect(r.byKey.get(K(2))).toBe('P');
  });

  it('(dev,ino) 祖先规则:排除路径当前存在、根的某个祖先与它 (dev,ino) 相同 → X(认出别名写法)', async () => {
    const ids: Record<string, { dev: number; ino: number }> = {
      '/ex/Alias': { dev: 9, ino: 77 },
      '/real/inner': { dev: 9, ino: 77 },
    };
    const p = probe({ devIno: async (q) => ids[q] ?? { dev: 1, ino: inoOf(q) } });
    const r = await run(
      [
        [K(1), [root('/real/inner/sub')]],
        [K(2), [root('/real/other/sub')]],
      ],
      cfg({ excludeDirs: ['/ex/Alias'] }),
      p,
    );
    expect(r.byKey.get(K(1))).toBe('X');
    expect(r.byKey.get(K(2))).toBe('P');
    // 对照:排除路径不存在(探测不到 dev,ino)→ 不触发该规则
    const none = probe({ devIno: async (q) => (q === '/real/inner' ? { dev: 9, ino: 77 } : null) });
    const r2 = await run(
      [[K(1), [root('/real/inner/sub')]]],
      cfg({ excludeDirs: ['/ex/Alias'] }),
      none,
    );
    expect(r2.byKey.get(K(1))).toBe('U'); // 根本身探不到 → U,不是 X
  });

  it('U 判据逐条:全部根不存在 / 最近根 realpath 不符 / (dev,ino) 变了;其余仍 P', async () => {
    const gone = probe({ exists: async () => false });
    expect((await run([[K(1), [root('/w/a')]]], cfg(), gone)).byKey.get(K(1))).toBe('U');
    const moved = probe({ realpath: async (q) => q.toUpperCase() });
    expect((await run([[K(1), [root('/w/a')]]], cfg(), moved)).byKey.get(K(1))).toBe('U');
    const swapped = probe({ devIno: async (q) => ({ dev: 2, ino: inoOf(q) }) });
    expect((await run([[K(1), [root('/w/a')]]], cfg(), swapped)).byKey.get(K(1))).toBe('U');
    const noRealpath = probe({ realpath: async () => null });
    expect((await run([[K(1), [root('/w/a')]]], cfg(), noRealpath)).byKey.get(K(1))).toBe('U');
  });

  it('优先级:X 高于 U(根不存在但命中排除 → X);盐不符 / counts 缺失时 X 仍是 X,其余才整体 U', async () => {
    const gone = probe({ exists: async () => false });
    const x = await run([[K(1), [root('/w/a')]]], cfg({ excludeDirs: ['/w'] }), gone);
    expect(x.byKey.get(K(1))).toBe('X');
    // 盐不符:X 与盐无关(宁可多 taint);未命中排除的同索引 key 因无法确认归属而 U
    const r = await attribute({
      config: cfg({ excludeDirs: ['/w/x'] }),
      indexStatus: 'ok',
      index: idx(
        [
          [K(1), [root('/w/x/a')]],
          [K(2), [root('/w/b')]],
        ],
        'bbbbbbbbbbbb',
      ),
      counts: counts('aaaaaaaaaaaa'),
      probe: probe(),
    });
    expect(r.saltMismatch).toBe(true);
    expect(r.saltVerified).toBe(false);
    expect(r.indexUsable).toBe(true);
    expect(r.classify(K(1))).toBe('X');
    expect(r.classify(K(2))).toBe('U');
    // 对照:同一份输入,盐相符 → K(2) 是 P
    const ok = await run(
      [
        [K(1), [root('/w/x/a')]],
        [K(2), [root('/w/b')]],
      ],
      cfg({ excludeDirs: ['/w/x'] }),
    );
    expect([ok.classify(K(1)), ok.classify(K(2))]).toEqual(['X', 'P']);
  });

  it('多根:任一根命中排除 → X;U 只看「最近一次见到的根」(last_seen 最大,并列取靠后);其它根的变化不影响', async () => {
    const c = cfg({ excludeDirs: ['/ex'] });
    const r = await run([[K(1), [root('/w/ok'), root('/ex/old', '2026-10-01')]]], c);
    expect(r.byKey.get(K(1))).toBe('X');
    // 最近根 realpath 不符 → U,哪怕较早的根完全正常
    const p = probe({ realpath: async (q) => (q === '/w/new' ? '/w/NEW' : q) });
    const u = await run(
      [[K(1), [root('/w/old', '2026-10-01'), root('/w/new', '2026-10-23')]]],
      cfg(),
      p,
    );
    expect(u.byKey.get(K(1))).toBe('U');
    // 对照:较早的根异常、最近根正常 → P
    const p2 = probe({ realpath: async (q) => (q === '/w/old' ? '/w/OLD' : q) });
    const ok = await run(
      [[K(1), [root('/w/old', '2026-10-01'), root('/w/new', '2026-10-23')]]],
      cfg(),
      p2,
    );
    expect(ok.byKey.get(K(1))).toBe('P');
    expect(latestRoot([root('/a', '2026-10-01'), root('/b', '2026-10-01')]).path).toBe('/b'); // 并列取靠后
  });

  it('索引缺失 / 损坏 → 不可用,classify 一律 U(含任意证据 key 与字面量 ?)', async () => {
    for (const status of ['absent', 'invalid'] as const) {
      const r = await run([], cfg(), probe(), { status });
      expect(r.indexUsable).toBe(false);
      expect(r.saltMismatch).toBe(false);
      expect(r.classify(K(1))).toBe('U');
      expect(r.classify('?')).toBe('U');
    }
  });

  it('counts.json 缺失(无法核对盐)→ 非 X 的 key 一律 U;已命中排除的仍是 X;对照:盐可核对时是 P', async () => {
    const entries: [string, Root[]][] = [
      [K(1), [root('/w/a')]],
      [K(2), [root('/ex/b')]],
    ];
    const c = cfg({ excludeDirs: ['/ex'] });
    const noCounts = await run(entries, c, probe(), { counts: null });
    expect(noCounts.indexUsable).toBe(true);
    expect(noCounts.saltVerified).toBe(false);
    expect(noCounts.saltMismatch).toBe(false);
    expect([noCounts.classify(K(1)), noCounts.classify(K(2))]).toEqual(['U', 'X']);
    const withCounts = await run(entries, c);
    expect([withCounts.classify(K(1)), withCounts.classify(K(2))]).toEqual(['P', 'X']);
  });

  it('证据 key 不在索引里 → U;字面量 ? → U', async () => {
    const r = await run([[K(1), [root('/w/a')]]]);
    expect(r.classify(K(1))).toBe('P');
    expect(r.classify(K(7))).toBe('U');
    expect(r.classify('?')).toBe('U');
  });
});

describe('R20-4.6 每次调用现算:缓存只活在一次调用内', () => {
  it('同一次调用里同一路径只探测一次;两次调用各自重新探测', async () => {
    const entries: [string, Root[]][] = [
      [K(1), [root('/w/a')]],
      [K(2), [root('/w/a')]],
    ];
    const p = probe();
    await run(entries, cfg({ excludeDirs: ['/ex'] }), p);
    const first = p.calls.filter((c) => c === 'devIno /w/a').length;
    expect(first).toBeGreaterThan(0);
    await run(entries, cfg({ excludeDirs: ['/ex'] }), p);
    expect(p.calls.filter((c) => c === 'devIno /w/a').length).toBe(first * 2);
  });

  it('配置在两次调用之间收紧 → 第二次立即变 X(不读上一次的结论)', async () => {
    const entries: [string, Root[]][] = [[K(1), [root('/w/a')]]];
    expect((await run(entries, cfg())).byKey.get(K(1))).toBe('P');
    expect((await run(entries, cfg({ excludeDirs: ['/w'] }))).byKey.get(K(1))).toBe('X');
    // 放宽后又回到 P
    expect((await run(entries, cfg())).byKey.get(K(1))).toBe('P');
  });
});

describe('basename 取 canonical 之后的(R20-4.4)与别名 / 符号链接路径(真实文件系统)', () => {
  async function fx(prefix: string): Promise<{
    f: Awaited<ReturnType<typeof makeRsiFx>>;
    real: string;
    link: string;
  }> {
    const f = await makeRsiFx(prefix);
    const real = path.join(f.dir, 'real', 'Client-X');
    await mkdirp(f.fx, real, 0o755);
    const link = path.join(f.dir, 'alias');
    await symlink(f.fx, path.join(f.dir, 'real'), link);
    return { f, real, link };
  }
  const realRoot = async (p: string): Promise<Root> => {
    const st = await stat(p);
    return root(p, '2026-10-23', st.dev, st.ino);
  };

  it('根记录的是符号链接写法:exclude_names 对 canonical 后的 basename 命中;记录里的原始 basename 不决定结果', async () => {
    // `odd-name -> real/Client-X`:记录写法的原始 basename 是 odd-name,canonical 之后是 Client-X
    const f2 = await makeRsiFx('attr-basename-');
    const target = path.join(f2.dir, 'real', 'Client-X');
    await mkdirp(f2.fx, target, 0o755);
    const odd = path.join(f2.dir, 'odd-name');
    await symlink(f2.fx, target, odd);
    const r = await attribute({
      config: cfg({ excludeNames: ['client-x'] }),
      indexStatus: 'ok',
      index: idx([[K(1), [root(odd)]]]),
      counts: counts(),
    });
    expect(r.classify(K(1))).toBe('X');
    // 对照:不排除该名字 → 记录的是别名写法,realpath 与记录不逐字节相等 → U
    const none = await attribute({
      config: cfg(),
      indexStatus: 'ok',
      index: idx([[K(1), [root(odd)]]]),
      counts: counts(),
    });
    expect(none.classify(K(1))).toBe('U');
  });

  it('别名路径:记录写法经符号链接 → 未排除时 U;排除目录写真实路径 / 别名写法都命中 X;真实路径本身是 P', async () => {
    const { real, link } = await fx('attr-alias-');
    const aliased = path.join(link, 'Client-X');
    const entries = idx([
      [K(1), [root(aliased)]],
      [K(2), [await realRoot(real)]],
    ]);
    const run2 = (c: RsiConfigOn) =>
      attribute({ config: c, indexStatus: 'ok', index: entries, counts: counts() });
    const plain = await run2(cfg());
    expect([plain.classify(K(1)), plain.classify(K(2))]).toEqual(['U', 'P']);
    const byReal = await run2(cfg({ excludeDirs: [real] }));
    expect([byReal.classify(K(1)), byReal.classify(K(2))]).toEqual(['X', 'X']);
    const byAlias = await run2(cfg({ excludeDirs: [aliased] }));
    expect([byAlias.classify(K(1)), byAlias.classify(K(2))]).toEqual(['X', 'X']);
  });

  it('createAttributor 惰性:只对被问到的 key 探测,同一实例内同 key 只算一次', async () => {
    const p = probe();
    const a = await createAttributor({
      config: cfg(),
      indexStatus: 'ok',
      index: idx([
        [K(1), [root('/w/a')]],
        [K(2), [root('/w/b')]],
      ]),
      counts: counts(),
      probe: p,
    });
    expect(p.calls).toEqual([]);
    expect(await a.classify(K(1))).toBe('P');
    const n = p.calls.length;
    expect(await a.classify(K(1))).toBe('P');
    expect(p.calls.length).toBe(n);
    expect(p.calls.some((c) => c.includes('/w/b'))).toBe(false);
  });
});
