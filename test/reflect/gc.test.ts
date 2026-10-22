import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReflectCommand } from '../../src/commands/reflect.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import type { ReflectRunReport } from '../../src/contracts/reflect.js';
import { exists, readDir } from '../../src/io/read-fs.js';
import { mkdirp, symlink, writeFile } from '../../src/io/safe-fs.js';
import { loadUsedProposalIds } from '../../src/reflect/atoms-index.js';
import { runReflectGc } from '../../src/reflect/gc.js';
import { snapshot } from '../fixtures/reflect/world.js';
import { ctxFor, newR5World } from '../commands/r5-world.js';
import type { R5World } from '../commands/r5-world.js';

const NOW = new Date('2026-10-22T00:00:00Z');
const OLD = 'run-20260801T000000Z-aaaaaa'; // 82 天前
const OLD2 = 'run-20260701T000000Z-a2a2a2';
const FRESH = 'run-20261015T000000Z-bbbbbb'; // 7 天前
const EDGE = 'run-20260922T000000Z-eeeeee'; // 恰 30 天

const report = (runId: string, o: Partial<ReflectRunReport> = {}): ReflectRunReport => ({
  run_id: runId,
  mode: 'llm',
  signals_loaded: 3,
  signals_dropped: { schema: 0, residual: 0, external_excerpt_forced: 0 },
  clusters: 1,
  evidence_sent: 1,
  prompt_bytes: 10,
  prompt_sha256: null,
  input_digest: null,
  backend: null,
  calls_made: 1,
  calls_limit: 1,
  outcome: 'no_proposals',
  rejected: {},
  staged: [],
  observations_n: 0,
  ...o,
});

const reflectRoot = (w: R5World): string => path.join(w.io.stateDir, 'reflect');

async function putRun(
  w: R5World,
  runId: string,
  o: { report?: string; extra?: Record<string, string> } = {},
): Promise<void> {
  const dir = path.join(reflectRoot(w), runId);
  await mkdirp(w.io, dir, 0o700);
  if (o.report !== '') {
    await writeFile(
      w.io,
      path.join(dir, 'report.json'),
      o.report ?? `${JSON.stringify(report(runId))}\n`,
      {
        mode: 0o600,
      },
    );
  }
  for (const [rel, content] of Object.entries(o.extra ?? {})) {
    await mkdirp(w.io, path.dirname(path.join(dir, rel)), 0o700);
    await writeFile(w.io, path.join(dir, rel), content, { mode: 0o600 });
  }
}

const names = async (w: R5World): Promise<string[]> =>
  (await readDir(reflectRoot(w))).map((e) => e.name);

const gcCmd = () => createReflectCommand({ clock: () => NOW });

async function run(w: R5World, argv: string[]) {
  const { ctx, out, err } = ctxFor(w, argv);
  const code = await gcCmd().run(ctx);
  return { code, out: out.join(''), err: err.join('') };
}

describe('reflect --gc:默认干跑', () => {
  it('列出将删除的 run_id/原因/字节数,不删任何东西(正向对照:--write 后才消失)', async () => {
    const w = await newR5World({ signals: null });
    await putRun(w, OLD);
    await putRun(w, FRESH);
    const before = await snapshot(w.parent);
    const r = await run(w, ['--gc']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toContain('mode=dry');
    expect(r.out).toMatch(
      new RegExp(`would_delete run=${OLD} reason=expired_unreferenced bytes=[1-9]\\d*`),
    );
    expect(r.out).toContain(`keep run=${FRESH} reason=not_expired`);
    expect(await snapshot(w.parent)).toBe(before);
    expect(await names(w)).toEqual([FRESH, OLD].sort());
    // 正向对照
    const w2 = await run(w, ['--gc', '--write']);
    expect(w2.code).toBe(ExitCode.OK);
    expect(w2.out).toContain(`did_delete run=${OLD}`);
    expect(await names(w)).toEqual([FRESH]);
  });

  it('--json 为 canonical 且键集合固定;库层干跑也不写', async () => {
    const w = await newR5World({ signals: null });
    await putRun(w, OLD);
    const r = await run(w, ['--gc', '--json']);
    expect(r.code).toBe(ExitCode.OK);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual([
      'bytes',
      'candidates',
      'deleted',
      'kept',
      'mode',
      'retention_days',
      'scanned',
      'write',
    ]);
    expect(j['deleted']).toEqual([]);
    expect(j['write']).toBe(false);
    expect(r.out).toBe(canonicalJson(j));
    const lib = await runReflectGc(w.io, NOW, { write: false });
    expect(lib.deleted).toEqual([]);
    expect(await exists(path.join(reflectRoot(w), OLD))).toBe(true);
  });
});

describe('reflect --gc --write:只删「已过期且无引用」', () => {
  it('保留期边界:恰 30 天删,29 天多保留', async () => {
    const w = await newR5World({ signals: null });
    await putRun(w, EDGE);
    await putRun(w, 'run-20260923T000000Z-cccccc'); // 29 天
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(await names(w)).toEqual(['run-20260923T000000Z-cccccc']);
  });

  it('未过期不删', async () => {
    const w = await newR5World({ signals: null });
    await putRun(w, FRESH);
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(await names(w)).toEqual([FRESH]);
    expect(r.out).toContain('reason=not_expired');
  });

  it('有引用不删:仓库提案文本 / lifecycle 文件名 / lifecycle 内容里出现 run_id', async () => {
    const w = await newR5World({ signals: null });
    const a = 'run-20260101T000000Z-111111';
    const b = 'run-20260102T000000Z-222222';
    const c = 'run-20260103T000000Z-333333';
    const free = 'run-20260104T000000Z-444444';
    for (const id of [a, b, c, free]) await putRun(w, id);
    await w.repo.commit(
      {
        'proposals/2026-01-01-001.yaml': `reflector:\n  run_id: ${a}\n`,
        [`lifecycle/some-rule/2026-01-02-${b}.json`]: '{}\n',
        'lifecycle/other-rule/x.json': `{"run_id":"${c}"}\n`,
      },
      'refs',
    );
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(await names(w)).toEqual([a, b, c]);
    expect(r.out).toContain(`did_delete run=${free}`);
    expect(r.out).toContain(`keep run=${a} reason=referenced`);
  });

  it('含暂存内容的 run 一律保留(proposals/、rules/、apply.patch),哪怕已过期', async () => {
    const w = await newR5World({ signals: null });
    const staged = report('run-20260101T000000Z-555555', {
      outcome: 'staged',
      staged: ['2026-01-01-001'],
    });
    await putRun(w, 'run-20260101T000000Z-555555', {
      report: `${JSON.stringify(staged)}\n`,
      extra: {
        'proposals/2026-01-01-001.yaml': 'x\n',
        'rules/org/x.md': 'x\n',
        'apply.patch': 'x\n',
      },
    });
    // 报告里没暂存、但目录里有 judge 会改的 proposals/:同样保留
    await putRun(w, 'run-20260102T000000Z-666666', {
      extra: { 'proposals/2026-01-02-001.yaml': 'x\n' },
    });
    // 只有 report.json 但声称 staged:矛盾,保留
    await putRun(w, 'run-20260103T000000Z-777777', {
      report: `${JSON.stringify({ ...staged, run_id: 'run-20260103T000000Z-777777' })}\n`,
    });
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect((await names(w)).length).toBe(3);
    expect(r.out).toContain('reason=has_other_content');
    expect(r.out).toContain('reason=report_has_staged');
  });

  it('gc 不改变 loadUsedProposalIds:已用编号保持已用', async () => {
    const w = await newR5World({ signals: null });
    const keepId = 'run-20260101T000000Z-888888';
    await putRun(w, keepId, {
      report: `${JSON.stringify(report(keepId, { outcome: 'staged', staged: ['2026-01-01-007'] }))}\n`,
      extra: { 'proposals/2026-01-01-007.yaml': 'x\n' },
    });
    await putRun(w, OLD);
    await putRun(w, OLD2);
    const before = [...(await loadUsedProposalIds(w.io))].sort();
    expect(before).toEqual(['2026-01-01-007']); // 前提:确实有已用编号
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(await names(w)).toEqual([keepId]); // 前提:gc 确实删了东西
    expect([...(await loadUsedProposalIds(w.io))].sort()).toEqual(before);
  });

  it('无法判定一律保留(fail-closed):报告损坏/缺失/run_id 不符/时间戳不可解析/日期进位/未来', async () => {
    const w = await newR5World({ signals: null });
    const cases: Array<[string, Parameters<typeof putRun>[2], string]> = [
      ['run-20260101T000000Z-a00001', { report: '{not json' }, 'report_invalid'],
      ['run-20260101T000000Z-a00002', { report: '{}\n' }, 'report_invalid'],
      ['run-20260101T000000Z-a00003', { report: '' }, 'report_missing'],
      [
        'run-20260101T000000Z-a00004',
        { report: `${JSON.stringify(report('run-20260101T000000Z-zzzzzz'))}\n` },
        'report_run_id_mismatch',
      ],
      ['legacy-name-1', {}, 'stamp_unparseable'],
      ['run-20261340T000000Z-a00005', {}, 'stamp_unparseable'],
      ['run-20271001T000000Z-a00006', {}, 'not_expired'],
    ];
    for (const [id, o] of cases) {
      await putRun(w, id, o);
    }
    // legacy-name-1 的报告需要 run_id 一致才能走到时间戳判断
    await putRun(w, 'legacy-name-2', { report: `${JSON.stringify(report('legacy-name-2'))}\n` });
    await putRun(w, 'run-20261340T000000Z-a00007', {
      report: `${JSON.stringify(report('run-20261340T000000Z-a00007'))}\n`,
    });
    const before = await names(w);
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(await names(w)).toEqual(before);
    expect(r.out).toContain('reason=stamp_unparseable');
    expect(r.out).toContain('reason=report_missing');
    expect(r.out).not.toContain('did_delete');
  });

  it('点开头(.tmp-*)与 cwd 目录不碰', async () => {
    const w = await newR5World({ signals: null });
    await putRun(w, `.tmp-${OLD}`);
    await putRun(w, 'cwd');
    await putRun(w, OLD);
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(await names(w)).toEqual(['.tmp-' + OLD, 'cwd']);
  });

  it('run_id 含 ".." 的目录名(过 RunIdSchema 但可疑)不删', async () => {
    const w = await newR5World({ signals: null });
    const odd = 'run-20260101T000000Z-a..b';
    await putRun(w, odd, { report: `${JSON.stringify(report(odd))}\n` });
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(await names(w)).toEqual([odd]);
    expect(r.out).toContain('reason=bad_run_id');
  });

  it('符号链接不被跟随:指向别处目录的 run 名、目录内 report.json 链接', async () => {
    const w = await newR5World({ signals: null });
    const outside = path.join(w.parent, 'outside');
    await mkdirp(w.io, outside, 0o700);
    await writeFile(w.io, path.join(outside, 'report.json'), `${JSON.stringify(report(OLD))}\n`, {
      mode: 0o600,
    });
    await writeFile(w.io, path.join(outside, 'precious.txt'), 'keep\n', { mode: 0o600 });
    await mkdirp(w.io, reflectRoot(w), 0o700);
    await symlink(w.io, outside, path.join(reflectRoot(w), OLD));
    // 目录内的 report.json 是链接
    const linkedReport = 'run-20260101T000000Z-b00001';
    await mkdirp(w.io, path.join(reflectRoot(w), linkedReport), 0o700);
    await symlink(
      w.io,
      path.join(outside, 'report.json'),
      path.join(reflectRoot(w), linkedReport, 'report.json'),
    );
    const before = await snapshot(outside);
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(await snapshot(outside)).toBe(before);
    expect(await names(w)).toEqual([linkedReport, OLD].sort());
    expect(r.out).toContain(`keep run=${OLD} reason=not_real_dir`);
    expect(r.out).toContain(`keep run=${linkedReport} reason=has_other_content`);
  });

  it('暂存根本身是符号链接 → 退出 3,什么都不删', async () => {
    const w = await newR5World({ signals: null });
    const elsewhere = path.join(w.parent, 'elsewhere');
    await mkdirp(w.io, elsewhere, 0o700);
    await writeFile(w.io, path.join(elsewhere, 'x'), 'x', { mode: 0o600 });
    await mkdirp(w.io, w.io.stateDir, 0o700);
    await symlink(w.io, elsewhere, reflectRoot(w));
    const before = await snapshot(elsewhere);
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('REFLECT_FAIL_CLOSED reason=GC_ROOT_NOT_REAL_DIR\n');
    expect(await snapshot(elsewhere)).toBe(before);
  });

  it('引用目录读不了 → 退出 3,什么都不删', async () => {
    const w = await newR5World({ signals: null });
    await putRun(w, OLD);
    await w.repo.commit({ 'proposals/x.yaml': { link: '../../nowhere' } }, 'badref');
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('GC_REFERENCE_SCAN_FAILED');
    expect(await names(w)).toEqual([OLD]);
  });

  it('lifecycle/ 本身是符号链接(含悬空)→ 退出 3,什么都不删', async () => {
    const w = await newR5World({ signals: null });
    await putRun(w, OLD);
    await w.repo.commit({ lifecycle: { link: 'proposals-elsewhere' } }, 'dangling');
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('GC_REFERENCE_SCAN_FAILED');
    expect(await names(w)).toEqual([OLD]);
  });

  it('lifecycle/ 是指向真实目录的符号链接 → 同样退出 3(不跟随)', async () => {
    const w = await newR5World({ signals: null });
    await putRun(w, OLD);
    await w.repo.commit({ lifecycle: { link: 'rules' } }, 'linked');
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('GC_REFERENCE_SCAN_FAILED');
    expect(await names(w)).toEqual([OLD]);
  });

  it('没有暂存根:退出 0,零候选,也不创建目录', async () => {
    const w = await newR5World({ signals: null });
    const r = await run(w, ['--gc', '--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toContain('scanned=0');
    expect(await exists(reflectRoot(w))).toBe(false);
  });
});

describe('reflect --gc:参数解析', () => {
  it.each([
    [['--gc', '--agent', 'claude']],
    [['--gc', '--run-llm']],
    [['--gc', '--allow-egress']],
    [['--gc', '--show-prompt']],
    [['--gc', '--since', '2026-01-01']],
    [['--gc', '--owner', '@x']],
    [['--gc', '--unknown']],
    [['--gc=1']],
    [['--write']],
    [['--write', '--json']],
  ])('互斥/未知/孤立 --write → 退出 2,零写入:%j', async (argv) => {
    const w = await newR5World({ signals: null });
    await putRun(w, OLD);
    const before = await snapshot(w.parent);
    const r = await run(w, argv);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.out).toBe('');
    expect(await snapshot(w.parent)).toBe(before);
  });

  it('gc 不读真实 HOME / 不写假 HOME', async () => {
    const w = await newR5World({ signals: null });
    await putRun(w, OLD);
    const fakeHome = path.join(w.parent, 'fake-home');
    await mkdirp(w.io, fakeHome, 0o700);
    const before = await snapshot(fakeHome);
    const { ctx } = ctxFor(w, ['--gc', '--write'], { HOME: fakeHome });
    expect(await gcCmd().run(ctx)).toBe(ExitCode.OK);
    expect(await snapshot(fakeHome)).toBe(before);
  });
});
