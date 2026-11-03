/**
 * R20-A6:`rsi dismiss <run_id>... | --all [--write] [--json]`(R20-17.5–R20-17.10;20.17-8 ① ② ⑧;负向矩阵 R20-17.25 的 dismiss 与扫描未知部分)。
 * 世界 = `a6-fixture.ts` 的 confirmed 世界(假 HOME / 合规 repo / 真实持锁写入方造的快照)。写审计由外部数组累计。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBytes } from '../../src/io/read-fs.js';
import { mkdirp, remove, writeFile } from '../../src/io/safe-fs.js';
import { runDismiss, parseDismissArgs, type RsiDismissDeps } from '../../src/rsi/dismiss.js';
import { runStatus, type StatusDoc } from '../../src/rsi/status.js';
import { dismissedDoc, makeA6World, putReport, putRsiFile, rsiFilePath } from './a6-fixture.js';
import { NOW, makeRoFx, runDirect, setExtra, type RoFx } from './ro-fixture.js';
import { treeOf } from './rsi-fixture.js';

const deps = (over: RsiDismissDeps = {}): RsiDismissDeps => ({ now: () => new Date(NOW), ...over });
const dis = (f: RoFx, argv: string[], over: RsiDismissDeps = {}) =>
  runDirect(f, runDismiss, argv, deps(over));
const reflectTree = (f: RoFx): Promise<string[]> => treeOf(path.join(f.io.stateDir, 'reflect'));
const dismissedPath = (f: RoFx): string => rsiFilePath(f, 'dismissed.json');
const readDismissedIds = async (f: RoFx): Promise<string[]> =>
  (
    JSON.parse(Buffer.from(await readBytes(dismissedPath(f))).toString('utf8')) as {
      runs: { run_id: string }[];
    }
  ).runs.map((r) => r.run_id);
const status = async (f: RoFx): Promise<StatusDoc> =>
  JSON.parse(
    (await runDirect(f, runStatus, ['--json'], { now: () => new Date(NOW) })).out,
  ) as StatusDoc;

async function world(prefix: string, ids = ['r-1', 'r-2']) {
  const f = await makeRoFx(prefix);
  await makeA6World(
    f,
    ids.map((runId) => ({ runId })),
  );
  return f;
}

describe('R20-17.5 参数解析(参数先于配置判定,零写入)', () => {
  it('纯函数:合法形状与各类错误', () => {
    expect(parseDismissArgs(['--all'])).toMatchObject({ ok: true, value: { all: true, ids: [] } });
    expect(parseDismissArgs(['r-b', 'r-a', '--write', '--json'])).toMatchObject({
      ok: true,
      value: { all: false, write: true, json: true, ids: ['r-a', 'r-b'] },
    });
    expect(parseDismissArgs([])).toEqual({ ok: false, reason: 'mode_conflict' });
    expect(parseDismissArgs(['--all', 'r-1'])).toEqual({ ok: false, reason: 'mode_conflict' });
    expect(parseDismissArgs(['--write'])).toEqual({ ok: false, reason: 'mode_conflict' });
    for (const bad of [
      ['../x'],
      ['r-1', 'r-1'],
      ['--bogus'],
      ['--all', '--all'],
      ['--write', '--write', 'r-1'],
      ['--all=1'],
      ['a/b'],
      [''],
    ]) {
      expect(parseDismissArgs(bad), bad.join(' ')).toEqual({ ok: false, reason: 'unknown_arg' });
    }
  });

  it('经命令:退 2,stderr 只有稳定码,stdout 空,写审计为空', async () => {
    const f = await world('a6-dis-args-');
    for (const [argv, reason] of [
      [[], 'mode_conflict'],
      [['--all', 'r-1'], 'mode_conflict'],
      [['r-1', 'r-1'], 'unknown_arg'],
      [['bad id'], 'unknown_arg'],
      [['--nope'], 'unknown_arg'],
    ] as const) {
      const r = await dis(f, [...argv]);
      expect([r.code, r.err, r.out, r.audit], argv.join(' ')).toEqual([
        2,
        `RSI_USAGE reason=${reason}\n`,
        '',
        [],
      ]);
    }
  });
});

describe('R20-17.6 状态', () => {
  it('配置 off → 退 4 RSI_NOT_RUN reason=off,零写入', async () => {
    const f = await makeRoFx('a6-dis-off-');
    await writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 });
    for (const argv of [['--all'], ['--all', '--write'], ['r-1', '--write']]) {
      const r = await dis(f, argv);
      expect([r.code, r.err, r.out, r.audit], argv.join(' ')).toEqual([
        4,
        'RSI_NOT_RUN reason=off\n',
        '',
        [],
      ]);
    }
  });

  it('armed(无确认记录)与 stopped(STOP 在场)均可执行 --write;confirmed 下同样可以', async () => {
    const armed = await makeRoFx('a6-dis-armed-');
    await makeA6World(armed, [{ runId: 'r-1' }], { confirm: false });
    const a = await dis(armed, ['--all', '--write', '--json']);
    expect([a.code, JSON.parse(a.out)]).toEqual([
      0,
      { result: 'dismissed', runs: ['r-1'], count: 1 },
    ]);
    expect(await readDismissedIds(armed)).toEqual(['r-1']);

    const stopped = await world('a6-dis-stopped-', ['r-1']);
    await putRsiFile(stopped, 'STOP', '{"at":"2026-10-24T00:00:00.000Z","by":"user"}');
    const s = await dis(stopped, ['--all', '--write']);
    expect(s.code).toBe(0);
    expect(await readDismissedIds(stopped)).toEqual(['r-1']);
  });

  it('不受 KIT_AUTO_RSI=0 影响(前台命令)', async () => {
    const f = await world('a6-dis-auto0-', ['r-1']);
    const r = await runDirect(f, runDismiss, ['--all', '--write'], deps(), {
      env: { KIT_AUTO_RSI: '0' },
    });
    expect(r.code).toBe(0);
    expect(await readDismissedIds(f)).toEqual(['r-1']);
  });
});

describe('R20-17.7 / R20-17.10 干跑与 --write 语义', () => {
  it('干跑:列出将忽略的 run_id 与数量,不写任何东西(审计为空、目录树不变);--json 固定键集', async () => {
    const f = await world('a6-dis-dry-');
    const before = await treeOf(f.dir);
    const r = await dis(f, ['--all']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('dismiss dry count=2\nrun_id=r-1\nrun_id=r-2\n');
    expect(r.audit).toEqual([]);
    const j = await dis(f, ['--all', '--json']);
    expect(Object.keys(JSON.parse(j.out)).sort()).toEqual(['count', 'result', 'runs']);
    expect(JSON.parse(j.out)).toEqual({ result: 'dry', runs: ['r-1', 'r-2'], count: 2 });
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('--all --write:只写 dismissed.json;run 目录逐字节不变;status 待审 0;人读输出不含路径', async () => {
    const f = await world('a6-dis-write-');
    expect((await status(f)).counts.pending_runs).toBe(2);
    const reflectBefore = await reflectTree(f);
    const r = await dis(f, ['--all', '--write']);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out).toBe('dismiss dismissed count=2\nrun_id=r-1\nrun_id=r-2\n');
    expect(r.out).not.toContain(f.dir);
    expect(await reflectTree(f)).toEqual(reflectBefore);
    expect(await readDismissedIds(f)).toEqual(['r-1', 'r-2']);
    const st = await status(f);
    expect([st.counts.pending_runs, st.counts.pending_proposals, st.counts.dismissed_runs]).toEqual(
      [0, 0, 2],
    );
    // 忽略只停止提醒与待审计数,不释放暂存容量(staged_runs 照旧)
    expect(st.counts.staged_runs).toBe(2);
    expect(st.staging.run_limit_reached).toBe(false);
  });

  it('窄记账:写审计只涉及 rsi/lock、rsi/dismissed.json 及其 .tmp,不碰 reflect/、counts / state / snapshot / log', async () => {
    const f = await world('a6-dis-narrow-');
    const r = await dis(f, ['--all', '--write']);
    expect(r.code).toBe(0);
    expect(r.audit.length).toBeGreaterThan(0); // 正向前提:确实有写
    const rel = r.audit.map((a) => path.relative(f.io.stateDir, a.path));
    const allowed = ['rsi/lock', 'rsi/dismissed.json', 'rsi/dismissed.json.tmp'];
    expect(rel.filter((x) => !allowed.includes(x))).toEqual([]);
    expect(rel).toContain('rsi/dismissed.json');
  });

  it('具名:只忽略指定的 run;其余仍待审', async () => {
    const f = await world('a6-dis-named-', ['r-1', 'r-2', 'r-3']);
    const r = await dis(f, ['r-2', '--write', '--json']);
    expect(JSON.parse(r.out)).toEqual({ result: 'dismissed', runs: ['r-2'], count: 1 });
    expect(await readDismissedIds(f)).toEqual(['r-2']);
    expect((await status(f)).counts.pending_runs).toBe(2);
  });

  it('具名里有一个不是待审 → 整批拒(退 4 run_not_pending),零写入、dismissed.json 不产生', async () => {
    const f = await world('a6-dis-batch-', ['r-1', 'r-2']);
    for (const argv of [
      ['r-1', 'r-nope'],
      ['r-1', 'r-nope', '--write'],
    ]) {
      const r = await dis(f, argv);
      expect([r.code, r.err, r.out], argv.join(' ')).toEqual([
        4,
        'RSI_NOT_RUN reason=run_not_pending\n',
        '',
      ]);
    }
    expect(await readDismissedIds(f).catch(() => 'absent')).toBe('absent');
  });

  it('已忽略的 run 再具名 → 不是待审 → run_not_pending;--all 没有待审 → 退 0 unchanged,dismissed.json 字节不变', async () => {
    const f = await world('a6-dis-again-', ['r-1']);
    await dis(f, ['--all', '--write']);
    const bytes = Buffer.from(await readBytes(dismissedPath(f)));
    const again = await dis(f, ['r-1', '--write']);
    expect([again.code, again.err]).toEqual([4, 'RSI_NOT_RUN reason=run_not_pending\n']);
    const none = await dis(f, ['--all', '--write', '--json']);
    expect([none.code, JSON.parse(none.out)]).toEqual([
      0,
      { result: 'unchanged', runs: [], count: 0 },
    ]);
    expect(Buffer.from(await readBytes(dismissedPath(f))).equals(bytes)).toBe(true);
    expect(
      none.audit
        .map((a) => path.relative(f.io.stateDir, a.path))
        .filter((p) => p.startsWith('rsi/dismissed')),
    ).toEqual([]);
  });

  it('report.run_id 与目录名不同 → 不是待审:具名被拒', async () => {
    const f = await makeRoFx('a6-dis-mismatch-');
    await makeA6World(f, [{ runId: 'r-1', report: false }]);
    await putReport(f, 'r-1', 'ingest', 1, `${JSON.stringify({ run_id: 'r-else' })}\n`);
    const r = await dis(f, ['r-1', '--write']);
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=run_not_pending\n']);
  });

  it('写入时顺带移除目录已不存在的条目,按 run_id 升序', async () => {
    const f = await world('a6-dis-prune-', ['r-5']);
    await putRsiFile(f, 'dismissed.json', dismissedDoc(['gone-1', 'gone-2']));
    const r = await dis(f, ['--all', '--write']);
    expect(r.code).toBe(0);
    expect(await readDismissedIds(f)).toEqual(['r-5']);
  });
});

describe('R20-17.8 dismissed.json 损坏 / 上限', () => {
  it('损坏:写路径退 3 RSI_FAIL_CLOSED reason=dismissed_invalid,文件字节不变(不覆盖、不重建);干跑同样退 3', async () => {
    const f = await world('a6-dis-corrupt-', ['r-1']);
    const junk = '{"schema_version":1,"runs":"nope"}';
    await putRsiFile(f, 'dismissed.json', junk);
    const r = await dis(f, ['--all', '--write']);
    expect([r.code, r.err, r.out]).toEqual([3, 'RSI_FAIL_CLOSED reason=dismissed_invalid\n', '']);
    expect(Buffer.from(await readBytes(dismissedPath(f))).toString('utf8')).toBe(junk);
    // 干跑预告 --write 的结果:同样退 3,不预告一个不可能执行的写入(A6i-13)
    const dry = await dis(f, ['--all']);
    expect([dry.code, dry.err, dry.out, dry.audit]).toEqual([
      3,
      'RSI_FAIL_CLOSED reason=dismissed_invalid\n',
      '',
      [],
    ]);
    expect((await status(f)).warnings).toContain('dismissed_invalid');
  });

  it('权限过宽(0644)同样算损坏', async () => {
    const f = await world('a6-dis-perm-', ['r-1']);
    await putRsiFile(f, 'dismissed.json', dismissedDoc([]), 0o644);
    const r = await dis(f, ['--all', '--write']);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=dismissed_invalid\n']);
  });

  it('上限:合并后超过 1000 条 → 退 4 dismiss_full,零写入(用放宽扫描上限的测试缝构造;默认上限下该码不可达,见 A6i-12)', async () => {
    const f = await world('a6-dis-full-', ['r-new']);
    const root = path.join(f.io.stateDir, 'reflect');
    const old = Array.from({ length: 1000 }, (_, i) => `d-${String(i).padStart(4, '0')}`);
    for (const id of old) await mkdirp(f.io, path.join(root, id), 0o755);
    await putRsiFile(f, 'dismissed.json', dismissedDoc(old));
    const bytes = Buffer.from(await readBytes(dismissedPath(f)));
    const r = await dis(f, ['--all', '--write'], { scanLimits: { maxEntries: 5000 } });
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=dismiss_full\n']);
    expect(Buffer.from(await readBytes(dismissedPath(f))).equals(bytes)).toBe(true);
    // 对照:同一世界里目录已不存在的旧条目会被清掉,于是放得下
    const g = await world('a6-dis-full-ok-', ['r-new']);
    await putRsiFile(g, 'dismissed.json', dismissedDoc(old));
    const ok = await dis(g, ['--all', '--write'], { scanLimits: { maxEntries: 5000 } });
    expect(ok.code).toBe(0);
    expect(await readDismissedIds(g)).toEqual(['r-new']);
  }, 120_000);
});

describe('R20-17.9 锁与窄记账例外', () => {
  it('锁被占(另一个存活进程持有)→ 退 4 RSI_NOT_RUN reason=locked,dismissed.json 不产生;放锁后同一命令成功', async () => {
    const f = await world('a6-dis-locked-', ['r-1']);
    const lockDoc = JSON.stringify({
      pid: 4242,
      started_at: NOW,
      nonce: '0123456789abcdef',
      kit_version: '0.0.0',
    });
    await putRsiFile(f, 'lock', lockDoc);
    const lock = { isAlive: () => true, now: () => new Date(NOW) };
    const r = await dis(f, ['--all', '--write'], { lock });
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=locked\n']);
    expect(await readDismissedIds(f).catch(() => 'absent')).toBe('absent');
    await remove(f.io, rsiFilePath(f, 'lock'));
    const ok = await dis(f, ['--all', '--write']);
    expect(ok.code).toBe(0); // 正向对照
  });

  it('TAINTED 已落盘但摘录未清完:dismiss 只写 dismissed.json,不碰任何 run(不承担 taint 前置)', async () => {
    const f = await world('a6-dis-taint-', ['r-1']);
    const td = path.join(f.io.stateDir, 'reflect', 'r-t');
    await mkdirp(f.io, path.join(td, 'proposals'), 0o755);
    await writeFile(
      f.io,
      path.join(td, 'TAINTED'),
      JSON.stringify({ reason: 'exclude', at: NOW }),
      { mode: 0o600 },
    );
    await writeFile(f.io, path.join(td, 'proposals', 'leftover.yaml'), 'excerpt: leftover\n', {
      mode: 0o644,
    });
    const before = await reflectTree(f);
    const r = await dis(f, ['--all', '--write']);
    expect(r.code).toBe(0);
    expect(await reflectTree(f)).toEqual(before);
    expect(await readDismissedIds(f)).toEqual(['r-1']);
    const rel = r.audit.map((a) => path.relative(f.io.stateDir, a.path));
    expect(rel.some((p) => p.startsWith('reflect/'))).toBe(false);
  });

  it('拿锁之后配置被改成 off:锁内复检退 4 off,零数据写入', async () => {
    const f = await world('a6-dis-afterlock-', ['r-1']);
    const r = await dis(f, ['--all', '--write'], {
      afterLock: async () => {
        await writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 });
      },
    });
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(await readDismissedIds(f).catch(() => 'absent')).toBe('absent');
  });
});

describe('R20-17.2 / R20-17.4a:归属与扫描未知的入口映射', () => {
  it('ingest 之后写下排除、worker 尚未 taint:该 run 已不计入(dismiss 看不到它),status 同口径', async () => {
    const f = await world('a6-dis-excl-', ['r-1']);
    const proj = path.join(f.dir, 'work', 'proj');
    await setExtra(f, `exclude_dirs = [${JSON.stringify(proj)}]\n`);
    const r = await dis(f, ['--all']);
    expect([r.code, r.out]).toEqual([0, 'dismiss unchanged count=0\n']);
    const named = await dis(f, ['r-1']);
    expect([named.code, named.err]).toEqual([4, 'RSI_NOT_RUN reason=run_not_pending\n']);
    expect((await status(f)).counts.pending_runs).toBe(0);
  });

  it('项目根消失(变 U):同样不计入', async () => {
    const f = await world('a6-dis-gone-', ['r-1']);
    await remove(f.fx, path.join(f.dir, 'work', 'proj'));
    const r = await dis(f, ['r-1']);
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=run_not_pending\n']);
  });

  it('reflect/ 下 1001 个子项:干跑 / --write × 具名 / --all 全部退 4 run_scan_incomplete,零写入', async () => {
    const f = await world('a6-dis-trunc-', ['r-1']);
    const root = path.join(f.io.stateDir, 'reflect');
    for (let i = 0; i < 1000; i++)
      await mkdirp(f.io, path.join(root, `pad-${String(i).padStart(4, '0')}`), 0o755);
    const before = await treeOf(f.dir);
    for (const argv of [['--all'], ['r-1'], ['--all', '--write'], ['r-1', '--write']]) {
      const r = await dis(f, argv);
      expect([r.code, r.err, r.out], argv.join(' ')).toEqual([
        4,
        'RSI_NOT_RUN reason=run_scan_incomplete\n',
        '',
      ]);
      if (!argv.includes('--write')) expect(r.audit).toEqual([]);
    }
    expect(await readDismissedIds(f).catch(() => 'absent')).toBe('absent');
    // 锁文件(基础设施)不留:目录树只多出 rsi/ 下已存在的东西以外没有变化
    expect((await treeOf(f.dir)).filter((l) => l.includes('dismissed'))).toEqual(
      before.filter((l) => l.includes('dismissed')),
    );
  }, 120_000);
});
