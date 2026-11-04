/**
 * R20-16.11-a / R20-16.28(A4 订正 #8):digest 组装时的路径中和与单条证据丢弃;整份输出的闸保留作兜底。
 * 世界见 `a4-fixture.ts`(假 HOME、KIT_TMP = 假仓库目录、状态目录在其下);所有路径运行时由夹具拼出,不写任何真实用户路径字面量。
 */
import { describe, expect, it } from 'vitest';
import { RSI_DIGEST_PATH_PLACEHOLDERS } from '../../src/contracts/rsi.js';
import { evidencePassesLeakGate, neutralizePaths } from '../../src/rsi/digest-paths.js';
import {
  DIGEST_ARGS,
  digestCmd,
  lesson,
  makeA4World,
  parseDigest,
  recommit,
  writeSignalFile,
  type A4World,
} from './a4-fixture.js';

const excerpts = (out: string): string[] =>
  parseDigest(out).clusters.flatMap((c) => c.evidence.map((e) => e.excerpt));
const strip = (t: string): string => t.replace(/<\/?untrusted-excerpt>/g, '');

/**
 * 往世界里追加一簇教训(另一个月份文件,夹具默认簇保持不变):每条一个会话,词表与默认簇不同;`paths` 逐条拼进正文。
 * 路径在世界建好之后才知道,所以用回调拿到 A4World 再拼。
 */
async function addCluster(
  w: A4World,
  tag: string,
  paths: (w: A4World) => readonly string[],
): Promise<void> {
  const list = paths(w).map((p, i) =>
    lesson(
      w.keys.cur,
      `${tag}${i}`,
      0,
      `from now on keep ${tag} scratch notes alpha beta gamma delta epsilon zeta eta theta in ${p}`,
    ),
  );
  await writeSignalFile(w, list, '202609');
  await recommit(w);
}

describe('neutralizePaths(纯函数)', () => {
  const roots = [
    { label: 'home' as const, path: '/h/ab' },
    { label: 'repo' as const, path: '/h/ab/work/repo' },
    { label: 'state' as const, path: '/h/ab/work/repo/.state' },
    { label: 'kit_tmp' as const, path: '/tmp/kt' },
  ];
  it('HOME → ~;仓库根 → <repo>;状态目录 → <state>;KIT_TMP → <kit_tmp>;重叠时取最长;同一文本多处都换', () => {
    expect(neutralizePaths('see /h/ab/notes and /h/ab', roots)).toBe('see ~/notes and ~');
    expect(neutralizePaths('x /h/ab/work/repo/src/a.ts', roots)).toBe('x <repo>/src/a.ts');
    expect(neutralizePaths('x /h/ab/work/repo/.state/rsi', roots)).toBe('x <state>/rsi');
    expect(neutralizePaths('x /tmp/kt/f', roots)).toBe('x <kit_tmp>/f');
    expect(neutralizePaths('/h/ab/a;/h/ab/b', roots)).toBe('~/a;~/b');
    expect(RSI_DIGEST_PATH_PLACEHOLDERS).toEqual({
      home: '~',
      repo: '<repo>',
      state: '<state>',
      kit_tmp: '<kit_tmp>',
    });
  });
  it('段边界:同段延伸 / 前缀冒充不改写;结尾、`/`、标点后可改写;根前是路径段字符不改写', () => {
    for (const bad of [
      '/h/ab2/x',
      '/h/ab-x/y',
      '/h/ab.d/y',
      '/h/abc',
      '/h/ab_',
      '/h/ab~',
      'xx/h/ab/y',
    ]) {
      expect(neutralizePaths(bad, roots), bad).toBe(bad);
    }
    expect(neutralizePaths('(/h/ab/x) "/h/ab" /h/ab:/h/ab,', roots)).toBe('(~/x) "~" ~:~,');
    // 正向对照:同形状但真在边界上
    expect(neutralizePaths('/h/ab/2x', roots)).toBe('~/2x');
  });
  it('根带尾斜杠也可;长度 ≤ 1 的根与非绝对路径的根被忽略(不会把所有 `/` 都换掉)', () => {
    expect(neutralizePaths('/h/ab/x', [{ label: 'home', path: '/h/ab/' }])).toBe('~/x');
    expect(neutralizePaths('/a/b', [{ label: 'home', path: '/' }])).toBe('/a/b');
    expect(neutralizePaths('/a/b', [{ label: 'home', path: '' }])).toBe('/a/b');
    expect(neutralizePaths('rel/x', [{ label: 'home', path: 'rel' }])).toBe('rel/x');
  });
  it('单条闸:中和后无禁止值 → 通过;仍含(前缀冒充)→ 不过;含控制字符的摘录经 JSON 转义不因换行误杀', () => {
    const forbidden = ['/h/ab'];
    expect(evidencePassesLeakGate(neutralizePaths('go /h/ab/x', roots), forbidden)).toBe(true);
    expect(evidencePassesLeakGate(neutralizePaths('go /h/ab2/x', roots), forbidden)).toBe(false);
    expect(evidencePassesLeakGate('line1\nline2', forbidden)).toBe(true);
  });
});

describe('R20-16.11-a / R20-16.28 digest 命令级', () => {
  it('① 摘录含 HOME 路径 → digest 成功(0),该处为 `~/…`,输出不含 HOME 绝对路径;evidence_dropped 为 0', async () => {
    const w = await makeA4World('a4-nz-home-');
    await addCluster(w, 'homey', (W) => [
      `${W.s.f.home}/notes/one`,
      `${W.s.f.home}/notes/two`,
      `${W.s.f.home}`,
    ]);
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err]).toEqual([0, '']);
    const ex = excerpts(r.out).map(strip);
    expect(ex.filter((e) => e.includes('homey'))).toHaveLength(3);
    expect(ex.some((e) => e.endsWith('in ~/notes/one'))).toBe(true);
    expect(ex.some((e) => e.endsWith('in ~'))).toBe(true);
    expect(r.out).not.toContain(w.s.f.home);
    expect(parseDigest(r.out).truncated).toEqual({ clusters_dropped: 0, evidence_dropped: 0 });
  });

  it('① 状态目录 → <state>;仓库根 / KIT_TMP(夹具里同一目录)→ 占位;原信号库摘录不变', async () => {
    const w = await makeA4World('a4-nz-roots-');
    await addCluster(w, 'rooty', (W) => [
      `${W.s.state}/rsi/x`,
      `${W.s.f.repo}/src/a.ts`,
      `${W.s.f.repo}`,
    ]);
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err]).toEqual([0, '']);
    const ex = excerpts(r.out)
      .map(strip)
      .filter((e) => e.includes('rooty'));
    expect(ex).toHaveLength(3);
    expect(ex.some((e) => e.endsWith('in <state>/rsi/x'))).toBe(true);
    expect(ex.some((e) => /in <(repo|kit_tmp)>\/src\/a\.ts$/.test(e))).toBe(true);
    expect(r.out).not.toContain(w.s.f.repo);
    expect(r.out).not.toContain(w.s.state);
  });

  it('② 前缀冒充(HOME + 同段延伸)不被改写、该条被丢、evidence_dropped 精确;同簇其它条保留(正向对照)', async () => {
    const w = await makeA4World('a4-nz-impersonate-');
    await addCluster(w, 'fakey', (W) => [
      `${W.s.f.home}/ok/a`,
      `${W.s.f.home}2/secret/b`,
      `${W.s.f.home}/ok/c`,
    ]);
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err]).toEqual([0, '']);
    const ex = excerpts(r.out)
      .map(strip)
      .filter((e) => e.includes('fakey'));
    expect(ex).toHaveLength(2); // 冒充那条被丢
    expect(ex.every((e) => /in ~\/ok\/[ac]$/.test(e))).toBe(true);
    expect(r.out).not.toContain(`${w.s.f.home}2`);
    expect(r.out).not.toContain(w.s.f.home);
    const t = parseDigest(r.out).truncated;
    expect(t).toEqual({ clusters_dropped: 0, evidence_dropped: 1 });
  });

  it('③ 某簇证据全丢 → 该簇不入选、clusters_dropped 计数;默认簇不受影响', async () => {
    const w = await makeA4World('a4-nz-empty-cluster-');
    await addCluster(w, 'deady', (W) => [`${W.s.f.home}2/a`, `${W.s.f.home}-x/b`]);
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err]).toEqual([0, '']);
    const d = parseDigest(r.out);
    expect(excerpts(r.out).some((e) => e.includes('deady'))).toBe(false);
    expect(d.truncated).toEqual({ clusters_dropped: 1, evidence_dropped: 2 });
    // 正向对照:夹具默认的两个簇照常给出
    expect(d.clusters.map((c) => c.evidence.length)).toEqual([3, 2]);
  });

  it('被丢的证据不占「每簇 8 条」名额:10 条里 3 条冒充 → 仍给满 7 条(不是 5)', async () => {
    const w = await makeA4World('a4-nz-quota-');
    await addCluster(w, 'quoty', (W) => [
      ...Array.from({ length: 7 }, (_, i) => `${W.s.f.home}/ok/${i}`),
      ...Array.from({ length: 3 }, (_, i) => `${W.s.f.home}2/bad/${i}`),
    ]);
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err]).toEqual([0, '']);
    const ex = excerpts(r.out).filter((e) => e.includes('quoty'));
    expect(ex).toHaveLength(7);
    expect(parseDigest(r.out).truncated.evidence_dropped).toBe(3);
  });

  it('④ 兜底:HOME 出现在非摘录字段(digest_id)→ 仍整份 output_leak:3、无文件、stdout 空;正向对照:同一世界正常 id 成功', async () => {
    const w = await makeA4World('a4-nz-fallback-');
    // 复扫器放行,只测路径泄漏闸:假 HOME 的随机目录后缀在某些环境(如 CI 的 mkdtemp 路径)会被 pass2 当成秘密,先于路径闸命中,
    // 不放行的话这条用例在不同机器上测的就不是同一道闸
    const r = await digestCmd(w, DIGEST_ARGS(), {
      redactor: { pass2: () => ({ clean: true }) } as never,
      randomHex: () => w.s.f.home,
    });
    expect([r.code, r.err, r.out]).toEqual([3, 'RSI_DIGEST_REJECTED reason=output_leak\n', '']);
    expect((await digestCmd(w, DIGEST_ARGS())).code).toBe(0);
  });
});
