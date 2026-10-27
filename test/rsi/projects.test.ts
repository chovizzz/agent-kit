/**
 * R20-A2 B3a:`rsi projects`(docs/contracts.md §20.3.5 R20-3.5.1 ~ 3.5.6)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stat } from '../../src/io/read-fs.js';
import { mkdirp } from '../../src/io/safe-fs.js';
import { runProjects, type RsiProjectsDeps } from '../../src/rsi/projects.js';
import { runStatus } from '../../src/rsi/status.js';
import { treeOf } from './rsi-fixture.js';
import {
  SALT_FP,
  baseState,
  countsOf,
  indexOf,
  key,
  makeRoFx,
  mkProject,
  runDirect,
  runMain,
  seed,
  setExtra,
  validConfirm,
  type RoFx,
} from './ro-fixture.js';

const direct = (
  f: RoFx,
  argv: string[],
  deps: RsiProjectsDeps = {},
  over: { isTty?: boolean } = {},
) => runDirect(f, runProjects, argv, deps, over);

async function scenario(): Promise<{ f: RoFx; a: string; g: string }> {
  const f = await makeRoFx('pj-');
  const a = await mkProject(f, 'a');
  const d = await mkProject(f, 'd');
  const b = await mkProject(f, 'b');
  const b2 = await mkProject(f, 'b2');
  const g = path.join(f.dir, 'work', 'gone');
  await setExtra(
    f,
    `exclude_dirs = [${[b.path, b2.path].map((x) => JSON.stringify(x)).join(', ')}]\n`,
  );
  await seed(f, {
    state: baseState({ confirm: await validConfirm(f), projects_ack_generation: 3 }),
    index: indexOf([
      { key: key(1), path: a.path, dev: a.dev, ino: a.ino, sessions: 3, signals: 10, firstGen: 1 },
      { key: key(2), path: d.path, dev: d.dev, ino: d.ino, sessions: 1, signals: 4, firstGen: 4 },
      { key: key(3), path: b.path, dev: b.dev, ino: b.ino, sessions: 1, signals: 5 },
      { key: key(4), path: b2.path, dev: b2.dev, ino: b2.ino, sessions: 1, signals: 0 },
      { key: key(5), path: g, dev: 1, ino: 1, sessions: 2, signals: 2 },
    ]),
    counts: countsOf(
      {
        [key(1)]: { total: 10 },
        [key(2)]: { total: 4 },
        [key(3)]: { total: 5 },
        [key(4)]: { total: 0 },
        [key(5)]: { total: 2, sessions: 2 },
        [key(9)]: { total: 6, sessions: 4 },
      },
      { unknown: 1 },
    ),
  });
  return { f, a: a.path, g };
}

describe('R20-3.5.1 / 3.5.4 缺省文本与 --json', () => {
  it('文本:按 key 升序;unknown 行没有 name、没有 path;purge_pending = 已排除但仍有信号;末行汇总', async () => {
    const { f, g } = await scenario();
    const r = await direct(f, []);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        'key=01000000 name=a sessions=3 signals=10 status=collecting',
        'key=02000000 name=d sessions=1 signals=4 status=new',
        'key=03000000 name=b sessions=1 signals=5 status=purge_pending',
        'key=04000000 name=b2 sessions=1 signals=0 status=excluded',
        'key=05000000 sessions=2 signals=2 status=unknown',
        'projects collecting=2 excluded=2 new=1 unknown_signals=9',
        '',
      ].join('\n'),
    );
    expect(r.out).not.toContain('gone');
    expect(r.out).not.toContain(g);
    expect(r.out).not.toContain(f.dir);
    expect(r.audit).toEqual([]);
  });

  it('--json:键集合固定;unknown 行 name 为 null;summary 含 unknown_sessions(索引外的 key 的会话也计入)', async () => {
    const { f } = await scenario();
    const r = await direct(f, ['--json']);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out) as {
      state: string;
      first_armed: boolean;
      rows: Record<string, unknown>[];
      summary: unknown;
    };
    expect(Object.keys(d).sort()).toEqual(['first_armed', 'rows', 'state', 'summary']);
    expect(d.state).toBe('confirmed');
    expect(d.first_armed).toBe(false);
    expect(d.summary).toEqual({
      collecting: 2,
      excluded: 2,
      new: 1,
      unknown_signals: 9,
      unknown_sessions: 6,
    });
    expect(d.rows.map((x) => Object.keys(x).sort())).toEqual(
      d.rows.map(() => ['key8', 'name', 'sessions', 'signals', 'status']),
    );
    expect(d.rows[4]).toEqual({
      key8: '05000000',
      name: null,
      sessions: 2,
      signals: 2,
      status: 'unknown',
    });
    expect(r.out).not.toContain(f.dir);
  });

  it('盐指纹不符:索引整体不可用,所有行都是 unknown(无 name)', async () => {
    const f = await makeRoFx('pj-salt-');
    const a = await mkProject(f, 'secret-name');
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      index: indexOf([{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }], 5, 'bbbbbbbbbbbb'),
      counts: countsOf({ [key(1)]: { total: 4 } }, { saltFp: SALT_FP }),
    });
    const r = await direct(f, []);
    expect(r.out).toContain('status=unknown');
    expect(r.out).not.toContain('secret-name');
    expect(r.out).toContain('projects collecting=0 excluded=0 new=0 unknown_signals=4');
  });

  it('off:退出 0,只有汇总行 / 空 rows', async () => {
    const f = await makeRoFx('pj-off-');
    await setExtra(f, 'enabled = false\n'); // 重复键会让 TOML 解析失败 → cfg_parse(也是 off)
    const r = await direct(f, []);
    expect(r.code).toBe(0);
    expect(r.out).toBe('projects collecting=0 excluded=0 new=0 unknown_signals=0\n');
    const j = JSON.parse((await direct(f, ['--json'])).out) as { state: string; rows: unknown[] };
    expect(j).toMatchObject({ state: 'off', rows: [] });
  });
});

describe('R20-3.5.2 / 3.5.3 目录名清洗与 --paths', () => {
  it('清洗:控制字符 / bidi 覆盖 / 零宽字符替换为 ?;超过 64 字节按码点边界截断', async () => {
    const f = await makeRoFx('pj-clean-');
    const names = ['evil‮name', 'zero​width', 'tab\there', 'x'.repeat(100), '中'.repeat(30)];
    const entries = [];
    for (const [i, n] of names.entries()) {
      const p = await mkProject(f, n);
      entries.push({ key: key(i + 1), path: p.path, dev: p.dev, ino: p.ino });
    }
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      index: indexOf(entries),
      counts: countsOf({}),
    });
    const lines = (await direct(f, [])).out.split('\n');
    expect(lines[0]).toContain('name=evil?name');
    expect(lines[1]).toContain('name=zero?width');
    expect(lines[2]).toContain('name=tab?here');
    expect(lines[3]).toContain(`name=${'x'.repeat(64)} `);
    const cjk = /name=(中+) /.exec(lines[4] ?? '')?.[1] ?? '';
    expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(64);
    expect(cjk.length).toBe(21); // 21 × 3 = 63 字节,第 22 个会超过 64
    for (const l of lines) expect(l).not.toMatch(/[‮​\t]/u);
  });

  it('--paths:仅 TTY;与 --json / --rebuild-index 互斥;path= 只加在非 unknown 行', async () => {
    const { f, a, g } = await scenario();
    const noTty = await direct(f, ['--paths'], {}, { isTty: false });
    expect(noTty.code).toBe(2);
    expect(noTty.err).toBe('RSI_USAGE reason=paths_requires_tty\n');
    expect(noTty.out).toBe('');
    for (const argv of [
      ['--paths', '--json'],
      ['--paths', '--rebuild-index'],
    ]) {
      const r = await direct(f, argv, {}, { isTty: true });
      expect(r.err, argv.join(' ')).toBe('RSI_USAGE reason=mode_conflict\n');
    }
    const r = await direct(f, ['--paths'], {}, { isTty: true });
    expect(r.code).toBe(0);
    const rows = r.out.split('\n');
    expect(rows[0]).toBe(`key=01000000 name=a sessions=3 signals=10 status=collecting path=${a}`);
    expect(rows[4]).toBe('key=05000000 sessions=2 signals=2 status=unknown'); // 不追加 path
    expect(r.out).not.toContain(g);
  });

  it('其它参数用法:未知 → unknown_arg;--write 无 --rebuild-index → write_requires_mode;--rebuild-index(含 --write)是 B5 桩(64),不读配置', async () => {
    const f = await makeRoFx('pj-args-');
    for (const [argv, err] of [
      [['--x'], 'RSI_USAGE reason=unknown_arg\n'],
      [['--json', '--json'], 'RSI_USAGE reason=unknown_arg\n'],
      [['--paths=1'], 'RSI_USAGE reason=unknown_arg\n'],
      [['--write'], 'RSI_USAGE reason=write_requires_mode\n'],
      [['--write', '--json'], 'RSI_USAGE reason=write_requires_mode\n'],
    ] as const) {
      const r = await runMain(f, ['rsi', 'projects', ...argv]);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toBe(err);
    }
    for (const argv of [
      ['--rebuild-index'],
      ['--rebuild-index', '--write'],
      ['--rebuild-index', '--json'],
    ]) {
      const r = await runMain(f, ['rsi', 'projects', ...argv]);
      expect(r.code, argv.join(' ')).toBe(64);
      expect(r.err).toBe('RSI_NOT_IMPLEMENTED subcommand=projects.rebuild_index\n');
      expect(r.audit).toEqual([]);
    }
  });
});

describe('R20-3.5.6 泄漏闸:豁免只限 --paths 行的 path= 字段值,由渲染器以结构给出', () => {
  it('项目在仓库内:--paths 的 path= 值含仓库根,照常输出(豁免);去掉 --paths 则 name 里没有路径', async () => {
    const f = await makeRoFx('pj-leak-ok-');
    const inRepo = path.join(f.repo, 'sub');
    await mkdirp(f.fx, inRepo, 0o755);
    const st = await stat(inRepo);
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      index: indexOf([{ key: key(1), path: inRepo, dev: st.dev, ino: st.ino }]),
      counts: countsOf({ [key(1)]: { total: 1 } }),
    });
    const withPaths = await direct(f, ['--paths'], {}, { isTty: true });
    expect(withPaths.code).toBe(0);
    expect(withPaths.out).toContain(`path=${inRepo}`);
    expect((await direct(f, [])).out).not.toContain(f.repo);
  });

  it('名字里伪造 `path=` 得不到豁免;(反向对照)同一份文本由渲染器放进 pathValue 才被豁免', async () => {
    const f = await makeRoFx('pj-leak-fake-');
    const p = await mkProject(f, 'foo path=bar');
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      index: indexOf([{ key: key(1), path: p.path, dev: p.dev, ino: p.ino }]),
      counts: countsOf({ [key(1)]: { total: 1 } }),
    });
    const ok = await direct(f, []);
    expect(ok.out).toContain('name=foo path=bar ');
    // 篡改:把仓库根塞进 head(含「伪造 path=」的前缀)→ 整份作废
    const leak = await direct(f, [], {
      tamper: (lines) => lines.map((l, i) => (i === 0 ? { head: `${l.head} path=${f.repo}` } : l)),
    });
    expect(leak.code).toBe(3);
    expect(leak.err).toBe('RSI_FAIL_CLOSED reason=output_leak\n');
    expect(leak.out).toBe('');
    // 对照:同样的路径文本由渲染器放进 pathValue(--paths 行)→ 放行
    const exempt = await direct(
      f,
      ['--paths'],
      {
        tamper: (lines) => lines.map((l, i) => (i === 0 ? { head: l.head, pathValue: f.repo } : l)),
      },
      { isTty: true },
    );
    expect(exempt.code).toBe(0);
    expect(exempt.out).toContain(`path=${f.repo}`);
  });

  it('状态目录 / HOME / KIT_TMP 的绝对路径出现在非豁免位置 → 3 output_leak,stdout 空', async () => {
    const f = await makeRoFx('pj-leak-all-');
    await seed(f, { state: baseState({ confirm: await validConfirm(f) }), counts: countsOf({}) });
    for (const secret of [f.io.stateDir, f.home, f.tmp]) {
      const r = await direct(f, [], {
        tamper: (lines) => [...lines, { head: `x ${secret}/y` }],
      });
      expect(r.code, secret).toBe(3);
      expect(r.out).toBe('');
    }
  });
});

describe('R20-1.4 / R20-3.5.1 首次 armed:现算清单来自 armed 列举服务(B4)', () => {
  it('没有列举服务 → 64 命令桩(B3a 范围例外);零写入', async () => {
    const f = await makeRoFx('pj-armed-stub-');
    const before = await treeOf(f.dir);
    const r = await runMain(f, ['rsi', 'projects']);
    expect(r.code).toBe(64);
    expect(r.err).toBe('RSI_NOT_IMPLEMENTED subcommand=projects.armed_listing\n');
    expect(r.out).toBe('');
    expect(r.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('注入列举服务:行为 `key=- name=… sessions=n status=pending`,汇总带 unknown_sessions;JSON 的 key8 为 null;名字清洗', async () => {
    const f = await makeRoFx('pj-armed-');
    const before = await treeOf(f.dir);
    const deps: RsiProjectsDeps = {
      listArmed: async () => ({
        rows: [
          { name: 'proj‮a', sessions: 2, path: '/x/proj', excluded: false },
          { name: 'skip', sessions: 1, path: '/x/skip', excluded: true },
        ],
        unknownSessions: 3,
      }),
    };
    const t = await direct(f, [], deps);
    expect(t.out).toBe(
      [
        'key=- name=proj?a sessions=2 status=pending',
        'key=- name=skip sessions=1 status=excluded',
        'projects collecting=1 excluded=1 new=0 unknown_signals=0 unknown_sessions=3',
        '',
      ].join('\n'),
    );
    const j = JSON.parse((await direct(f, ['--json'], deps)).out) as {
      first_armed: boolean;
      rows: { key8: unknown }[];
      summary: { unknown_sessions: number };
    };
    expect(j.first_armed).toBe(true);
    expect(j.rows.every((r) => r.key8 === null)).toBe(true);
    expect(j.summary.unknown_sessions).toBe(3);
    expect(await treeOf(f.dir)).toEqual(before);
    expect(t.audit).toEqual([]);
  });
});

describe('计数口径:counts.json 存在时是权威;缺失才回退索引条目的 signals(行与汇总一致,且与 status 一致)', () => {
  it('索引条目被判 U、counts 里没有它的 key:行 signals=0、汇总 unknown_signals=0;counts 缺失时行与汇总都用索引的 5', async () => {
    const mk = async (withCounts: boolean): Promise<RoFx> => {
      const f = await makeRoFx('pj-consist-');
      await seed(f, {
        state: baseState({ confirm: await validConfirm(f) }),
        index: indexOf([
          {
            key: key(1),
            path: path.join(f.dir, 'work', 'gone'),
            dev: 1,
            ino: 1,
            sessions: 2,
            signals: 5,
          },
        ]),
        ...(withCounts ? { counts: countsOf({}) } : {}),
      });
      return f;
    };
    const a = await mk(true);
    const ra = await direct(a, []);
    expect(ra.out).toBe(
      'key=01000000 sessions=2 signals=0 status=unknown\nprojects collecting=0 excluded=0 new=0 unknown_signals=0\n',
    );
    const sa = JSON.parse((await runDirect(a, runStatus, ['--json'], {})).out) as {
      counts: { unknown_signals: number };
    };
    expect(sa.counts.unknown_signals).toBe(0);
    const b = await mk(false);
    expect((await direct(b, [])).out).toBe(
      'key=01000000 sessions=2 signals=5 status=unknown\nprojects collecting=0 excluded=0 new=0 unknown_signals=5\n',
    );
  });
});
