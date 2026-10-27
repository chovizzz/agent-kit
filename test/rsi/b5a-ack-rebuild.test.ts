/**
 * R20-A2 B5a:`rsi status --ack`(R20-3.4.3)、`rsi projects --rebuild-index`(干跑 / `--write`,R20-3.5.5)、status 卡住提示(D7 / Q-C)。
 * 覆盖方案 §11:R20-3.4.3 ack、R20-3.5.5 / D11 generation 取 max+1、列举不完整且旧索引无效(Q-G)、D2 锁内顺序、R20-4.7 taint 放在索引落盘之后、失锁 k 遍历、零写入。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_OUTCOMES } from '../../src/contracts/rsi.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { chmod, mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { projectKeyFor } from '../../src/signals/ids.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { runProjects, type RsiProjectsDeps } from '../../src/rsi/projects.js';
import { runProjectsRebuild, type RsiRebuildDeps } from '../../src/rsi/projects-rebuild.js';
import { runStatus } from '../../src/rsi/status.js';
import { runStatusAck, type RsiStatusAckDeps } from '../../src/rsi/status-ack.js';
import { runTick } from '../../src/rsi/tick.js';
import { treeOf, writeCfg } from './rsi-fixture.js';
import { baseState, countsOf, indexOf, key, mkProject, seed, validConfirm } from './ro-fixture.js';
import { claudeLine, jl, put as putSession, uuid } from './l0-fixture.js';
import {
  SALT,
  SALT_FP,
  addSignals,
  makeSvc,
  setRsiToml,
  stageRun,
  type Svc,
} from './services-fixture.js';
import {
  cmdFxOf,
  foreignLock,
  loseLockOf,
  makeTickFx,
  overwriteRsi,
  rsiJson,
  runCmd,
  type TickFx,
} from './b5a-fixture.js';

const json = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;
const ack = (f: TickFx, argv: string[] = ['--ack'], deps: RsiStatusAckDeps = {}, tty = true) =>
  runCmd(f, runStatusAck, argv, deps, { isTty: tty });
const rebuildW = (
  f: TickFx,
  argv: string[] = ['--rebuild-index', '--write'],
  deps: RsiRebuildDeps = {},
) => runCmd(f, runProjectsRebuild, argv, deps);
const rebuildD = (f: TickFx, argv: string[] = ['--rebuild-index'], deps: RsiProjectsDeps = {}) =>
  runCmd(f, runProjects, argv, deps);
const consistent = async (f: TickFx): Promise<boolean> =>
  (await inspectSnapshot(f.io, productionSnapshotValidator)) === 'consistent';
const writeSalt = async (f: TickFx): Promise<void> => {
  await mkdirp(f.io, f.io.stateDir, 0o700);
  await writeFile(f.io, path.join(f.io.stateDir, 'salt'), SALT, { mode: 0o600 });
};

interface Dir {
  path: string;
  dev: number;
  ino: number;
}
interface SeedOver {
  state?: Record<string, unknown>;
  index?: unknown;
  counts?: unknown;
  cursor?: unknown;
  raw?: Record<string, string>;
}

/** 带真盐、两个项目目录(各有一个 claude 会话)、已提交快照的夹具;`over` 可按项目目录与 key 给出要 seed 的状态 */
async function withSalt(
  prefix: string,
  over: SeedOver | ((a: Dir, b: Dir, ka: string, kb: string) => SeedOver) = {},
  opts: { confirmedBaseline?: boolean } = {},
): Promise<{ f: TickFx; a: Dir; b: Dir; ka: string; kb: string }> {
  const f = await makeTickFx(prefix, { noSeed: true, projects: 2 });
  await writeSalt(f);
  const a = await mkProject(f, 'proj1');
  const b = await mkProject(f, 'proj2');
  const ka = projectKeyFor(SALT, a.path);
  const kb = projectKeyFor(SALT, b.path);
  const o = typeof over === 'function' ? over(a, b, ka, kb) : over;
  await seed(f, {
    state:
      o.state ??
      baseState({
        confirm: { ...(await validConfirm(f)), baseline_pending: opts.confirmedBaseline ?? false },
      }),
    ...(o.index !== undefined ? { index: o.index } : {}),
    ...(o.counts !== undefined ? { counts: o.counts } : {}),
    ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
    ...(o.raw !== undefined ? { raw: o.raw as never } : {}),
  });
  return { f, a, b, ka, kb };
}

describe('RsiOutcome ⊂ 稳定码字符集(tick-state 把 outcome 写进 last_tick.code,status 按 STABLE_CODE_RE 校验)', () => {
  it('每个 outcome 名都满足 ^[A-Za-z0-9_=.:-]{1,64}$', () => {
    for (const o of RSI_OUTCOMES) expect(o).toMatch(/^[A-Za-z0-9_=.:-]{1,64}$/);
  });
});

describe('status --ack', () => {
  it('非 TTY → 2 not_tty,零写入;未知参数 → 2 unknown_arg;配置 off → 4 off', async () => {
    const f = await makeTickFx('ack-misc-', { confirmed: true });
    const before = await treeOf(f.dir);
    expect(await ack(f, ['--ack'], {}, false)).toMatchObject({
      code: 2,
      err: 'RSI_USAGE reason=not_tty\n',
    });
    expect(await ack(f, ['--ack', '--x'])).toMatchObject({
      code: 2,
      err: 'RSI_USAGE reason=unknown_arg\n',
    });
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
    await writeCfg(f, '[rsi]\nenabled = false\n');
    expect(await ack(f)).toMatchObject({ code: 4, err: 'RSI_NOT_RUN reason=off\n' });
    expect(f.audit).toEqual([]);
  });

  it('索引缺失 → 0 `ack noop index=absent`,除锁文件外零写入(recover 之前就返回)', async () => {
    const { f } = await withSalt('ack-noop-');
    const before = await treeOf(f.dir);
    const r = await ack(f);
    expect([r.code, r.out]).toEqual([0, 'ack noop index=absent\n']);
    const writes = f.audit.filter((c) => c.op !== 'mkdirp');
    expect(writes.map((c) => c.op)).toEqual(['createExclusive', 'remove']);
    expect(await treeOf(f.dir)).toEqual(before);
    const j = await ack(f, ['--ack', '--json']);
    expect(json(j.out)).toEqual({ ack: 'noop', index: 'absent' });
  });

  it('索引损坏 / 盐不符 / 盐缺失 → 3 index_invalid,不改 state', async () => {
    const mk = async (variant: 'garbage' | 'salt_mismatch' | 'no_salt'): Promise<TickFx> => {
      const f = await makeTickFx(`ack-bad-${variant}-`, { noSeed: true, projects: 0 });
      if (variant !== 'no_salt') await writeSalt(f);
      const p = await mkProject(f, 'x');
      await seed(f, {
        state: baseState({ projects_ack_generation: 2 }),
        ...(variant === 'garbage'
          ? { raw: { 'projects.json': 'not json' } }
          : {
              index: indexOf(
                [{ key: key(1), path: p.path, dev: p.dev, ino: p.ino }],
                7,
                variant === 'salt_mismatch' ? 'bbbbbbbbbbbb' : SALT_FP,
              ),
            }),
      });
      return f;
    };
    for (const v of ['garbage', 'salt_mismatch', 'no_salt'] as const) {
      const f = await mk(v);
      const r = await ack(f);
      expect([r.code, r.err], v).toEqual([3, 'RSI_FAIL_CLOSED reason=index_invalid\n']);
      expect(
        ((await rsiJson(f, 'state.json')) as Record<string, unknown>)['projects_ack_generation'],
        v,
      ).toBe(2);
    }
  });

  it('成功:projects_ack_generation = 索引 generation;「新增项目」清零;confirm 与 baseline_pending 不动;日志 acked;快照一致', async () => {
    const f0 = await makeTickFx('ack-ok0-', { noSeed: true, projects: 0 });
    await writeSalt(f0);
    const p = await mkProject(f0, 'x');
    const q = await mkProject(f0, 'y');
    const confirm = { ...(await validConfirm(f0)), baseline_pending: true };
    await seed(f0, {
      state: baseState({ confirm, projects_ack_generation: 0 }),
      index: indexOf(
        [
          { key: key(1), path: p.path, dev: p.dev, ino: p.ino, firstGen: 3 },
          { key: key(2), path: q.path, dev: q.dev, ino: q.ino, firstGen: 5 },
        ],
        5,
        SALT_FP,
      ),
      counts: countsOf({ [key(1)]: { total: 1 }, [key(2)]: { total: 1 } }, { saltFp: SALT_FP }),
    });
    const statusNew = async (): Promise<unknown> => {
      const r = await runCmd(f0, runStatus, ['--json'], {});
      return (json(r.out)['counts'] as Record<string, unknown>)['projects_new'];
    };
    expect(await statusNew()).toBe(2);
    const r = await ack(f0);
    expect([r.code, r.out]).toEqual([0, 'ack generation=5\n']);
    const st = (await rsiJson(f0, 'state.json')) as Record<string, unknown>;
    expect(st['projects_ack_generation']).toBe(5);
    expect(st['confirm']).toEqual(confirm); // baseline_pending 仍是 true:它只由 L0 的 ackBaseline 翻转
    expect(await statusNew()).toBe(0);
    expect(await consistent(f0)).toBe(true);
    const log = (await readText(path.join(f0.rsiDir, 'log.jsonl')))
      .trim()
      .split('\n')
      .map((l) => json(l));
    expect(log[log.length - 1]).toMatchObject({ trigger: 'status', action: 'acked', code: 'ok' });
    expect(json((await ack(f0, ['--ack', '--json'])).out)).toEqual({ ack: 'ok', generation: 5 });
  });

  it('confirm 单独不合规时原始值原样透传(carryConfirm / rawConfirm),不被归一成 null', async () => {
    const f = await makeTickFx('ack-rawconf-', { noSeed: true, projects: 0 });
    await writeSalt(f);
    const p = await mkProject(f, 'x');
    await seed(f, {
      state: baseState({ confirm: { bogus: 1 } }),
      index: indexOf([{ key: key(1), path: p.path, dev: p.dev, ino: p.ino }], 4, SALT_FP),
    });
    const r = await ack(f);
    expect(r.code).toBe(0);
    const st = (await rsiJson(f, 'state.json')) as Record<string, unknown>;
    expect(st['confirm']).toEqual({ bogus: 1 });
    expect(st['projects_ack_generation']).toBe(4);
  });

  it('D2:拿锁之后配置变 off → 4 off,写审计只有锁文件(+ 目录 mkdirp 豁免);未完成的提交与 .tmp 不被 recover 动', async () => {
    const { f } = await withSalt('ack-d2-', (a) => ({
      index: indexOf([{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }], 3, SALT_FP),
    }));
    await overwriteRsi(f, 'state.json', baseState({ projects_ack_generation: 1 })); // 清单与文件不一致
    await writeFile(f.io, path.join(f.rsiDir, 'snapshot.json.tmp'), '{}', { mode: 0o600 });
    const r = await ack(f, ['--ack'], {
      afterLock: async () => writeCfg(f, '[rsi]\nenabled = false\n'),
    });
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(f.audit.filter((c) => c.op !== 'mkdirp').map((c) => c.op)).toEqual([
      'createExclusive',
      'remove',
    ]);
    expect(await exists(path.join(f.rsiDir, 'snapshot.json.tmp'))).toBe(true);
  });

  it('R20-5.1 拿锁:持锁时退 4 locked,不碰数据文件', async () => {
    const { f } = await withSalt('ack-lock-', (a) => ({
      index: indexOf([{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }], 3, SALT_FP),
    }));
    const release = await foreignLock(f);
    try {
      const before = await treeOf(f.dir);
      const r = await ack(f);
      expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=locked\n']);
      expect(await treeOf(f.dir)).toEqual(before);
    } finally {
      await release();
    }
  });

  it('失锁 k 遍历:每个写点之前失锁 → lock_lost、之后零写入;写点包含 recover / state / log / 快照', async () => {
    const mk = async (p: string): Promise<TickFx> =>
      (
        await withSalt(p, (a) => ({
          index: indexOf([{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }], 3, SALT_FP),
        }))
      ).f;
    const rec = await mk('ack-rec-');
    const ops: { op: string; audit: number }[] = [];
    expect(
      (
        await ack(rec, ['--ack'], {
          beforeWrite: async (op) => void ops.push({ op, audit: rec.audit.length }),
        })
      ).code,
    ).toBe(0);
    expect(ops.map((o) => o.op)).toEqual(
      expect.arrayContaining(['recover', 'rename:state.json', 'log-append', 'snapshot-rename']),
    );
    for (let k = 1; k <= ops.length; k++) {
      const f = await mk(`ack-lost-${k}-`);
      let seen = 0;
      let at = -1;
      const base = f.audit.length;
      const r = await ack(f, ['--ack'], {
        beforeWrite: async () => {
          if (++seen !== k) return;
          at = f.audit.length;
          await loseLockOf(f);
        },
      });
      expect([r.code, r.err], `k=${k}`).toEqual([3, 'RSI_FAIL_CLOSED reason=lock_lost\n']);
      expect(at - base).toBe(ops[k - 1]?.audit);
      expect(f.audit.length - at, `k=${k} ${ops[k - 1]?.op}`).toBe(0);
    }
  });
});

describe('projects --rebuild-index 干跑', () => {
  it('盐缺失 → 4 not_confirmed;零写入', async () => {
    const f = await makeTickFx('rb-nosalt-', { confirmed: true });
    const before = await treeOf(f.dir);
    const r = await rebuildD(f);
    expect([r.code, r.err, r.out]).toEqual([4, 'RSI_NOT_RUN reason=not_confirmed\n', '']);
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('有盐:零写入;键集合固定;newly_attributable_signals 取 counts(盐相符)里新索引的 key 的信号合计;counts 缺失 / 盐不符 / 损坏记 null,不阻断', async () => {
    const KEYS = [
      'complete',
      'entries',
      'kept_from_old',
      'limits_hit',
      'newly_attributable_signals',
      'observed',
      'remaining_files',
      'unknown_sessions',
      'write_verdict',
    ];
    for (const variant of ['ok', 'none', 'salt_mismatch', 'broken'] as const) {
      const { f } = await withSalt(`rb-dry-${variant}-`, (_a, _b, ka, kb) => ({
        ...(variant === 'ok' || variant === 'salt_mismatch'
          ? {
              counts: countsOf(
                { [ka]: { total: 4 }, [kb]: { total: 5 } },
                { saltFp: variant === 'ok' ? SALT_FP : 'bbbbbbbbbbbb' },
              ),
            }
          : {}),
        ...(variant === 'broken' ? { raw: { 'counts.json': '{bad' } } : {}),
      }));
      const before = await treeOf(f.dir);
      const r = await rebuildD(f, ['--rebuild-index', '--json']);
      expect(r.code, variant).toBe(0);
      const doc = json(r.out);
      expect(Object.keys(doc).sort(), variant).toEqual(KEYS);
      expect(doc).toMatchObject({
        entries: 2,
        observed: 2,
        kept_from_old: 0,
        complete: true,
        write_verdict: 'ok',
      });
      expect(doc['newly_attributable_signals'], variant).toBe(variant === 'ok' ? 9 : null);
      expect(f.audit, variant).toEqual([]);
      expect(await treeOf(f.dir), variant).toEqual(before);
      const text = await rebuildD(f);
      expect(text.out).toContain('entries=2\n');
      expect(text.out).not.toContain(f.dir);
    }
  });

  it('列举不完整且旧索引无效 → write_verdict=listing_incomplete_no_valid_index(干跑仍退 0,提示即将被拒)', async () => {
    const { f } = await withSalt('rb-dry-inc-', { raw: { 'projects.json': 'not json' } });
    const r = await rebuildD(f, ['--rebuild-index', '--json'], {
      l0: { limits: { maxDirEntries: 1 } },
    });
    expect(r.code).toBe(0);
    expect(json(r.out)).toMatchObject({
      complete: false,
      write_verdict: 'listing_incomplete_no_valid_index',
    });
  });
});

describe('projects --rebuild-index --write', () => {
  it('锁前早拒:盐缺失 → 4 not_confirmed;purge journal 在场 → 3 purge_incomplete;--paths → 2 mode_conflict;零写入', async () => {
    const f = await makeTickFx('rbw-early-', { confirmed: true });
    const before = await treeOf(f.dir);
    expect(await rebuildW(f)).toMatchObject({ code: 4, err: 'RSI_NOT_RUN reason=not_confirmed\n' });
    expect(await rebuildW(f, ['--rebuild-index', '--write', '--paths'])).toMatchObject({
      code: 2,
      err: 'RSI_USAGE reason=mode_conflict\n',
    });
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
    await writeSalt(f);
    await writeFile(
      f.io,
      path.join(f.rsiDir, 'purge-journal.json'),
      JSON.stringify({
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        phase: 'planned',
        keys: [key(1)],
        taint_targets: { runs: [], promotes: [] },
      }),
      { mode: 0o600 },
    );
    f.audit.length = 0;
    expect(await rebuildW(f)).toMatchObject({
      code: 3,
      err: 'RSI_FAIL_CLOSED reason=purge_incomplete\n',
    });
    expect(f.audit).toEqual([]);
  });

  it('成功(旧索引缺失):整体写索引 + 四段 counts + 日志 rebuilt;快照一致;state 不动(baseline 不碰);第二次(索引有效)合并', async () => {
    const { f, ka, kb } = await withSalt('rbw-ok-', {}, { confirmedBaseline: true });
    const st0 = (await rsiJson(f, 'state.json')) as Record<string, unknown>;
    const r = await rebuildW(f, ['--rebuild-index', '--write', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(json(r.out)).toMatchObject({
      result: 'rebuilt',
      generation: 1,
      entries: 2,
      observed: 2,
      complete: true,
    });
    const idx = (await rsiJson(f, 'projects.json')) as {
      entries: { key: string; first_indexed_generation: number }[];
      generation: number;
    };
    expect(idx.entries.map((e) => e.key).sort()).toEqual([ka, kb].sort());
    expect(idx.entries.every((e) => e.first_indexed_generation === 0)).toBe(true); // 旧索引缺失 = 不算新增
    const counts = (await rsiJson(f, 'counts.json')) as Record<string, unknown>;
    expect(Object.keys(counts).sort()).toEqual(
      [
        'clusters',
        'cluster_min',
        'computed_at',
        'generation',
        'per_key',
        'salt_fp',
        'schema_version',
        'staged',
        'unknown_keys_signals',
      ].sort(),
    );
    expect(await rsiJson(f, 'state.json')).toEqual(st0);
    expect(await consistent(f)).toBe(true);
    const log = (await readText(path.join(f.rsiDir, 'log.jsonl')))
      .trim()
      .split('\n')
      .map((l) => json(l));
    expect(log[log.length - 1]).toMatchObject({
      trigger: 'rebuild',
      action: 'rebuilt',
      code: 'ok',
    });
    for (const c of f.audit) {
      expect(['', 'rsi']).toContain(path.relative(f.io.stateDir, c.path).split(path.sep)[0]);
    }
    expect((await rebuildW(f)).code).toBe(0);
    expect(((await rsiJson(f, 'projects.json')) as { generation: number }).generation).toBe(2);
  });

  it('D11 回归:旧索引无效且 ack=40 → 新 generation = 41;之后 tick 采到新项目,「新增项目」> 0(不取 max 就永远 ≤ ack)', async () => {
    const { f } = await withSalt(
      'rbw-gen-bad-',
      { state: undefined, raw: { 'projects.json': 'not json' } },
      { confirmedBaseline: false },
    );
    await overwriteState(f, { projects_ack_generation: 40 });
    const r = await rebuildW(f);
    expect(r.code, r.err).toBe(0);
    expect(((await rsiJson(f, 'projects.json')) as { generation: number }).generation).toBe(41);
    // 新项目出现 → 之后的 tick 以 generation 42 记它的 first_indexed_generation
    const p = await mkProject(f, 'proj3');
    await putSession(
      f,
      'claude',
      `p/${uuid(9)}.jsonl`,
      jl(
        claudeLine(p.path, {
          timestamp: '2026-10-09T00:00:00.000Z',
          message: { role: 'user', content: 'from now on stop running the slow suite' },
        }),
        claudeLine(p.path, { timestamp: '2026-10-09T00:00:01.000Z' }),
      ),
    );
    expect((await runCmd(f, runTick, ['--write'], {})).code).toBe(0);
    const s = json((await runCmd(f, runStatus, ['--json'], {})).out);
    expect((s['counts'] as Record<string, unknown>)['projects_new']).toBe(1);
  });

  it('D11 回归(旧索引有效):有效索引 generation 1、ack=40、出现新项目 → 重建后新 key 的 first_indexed_generation = 新 generation(41),新增项目数 = 1', async () => {
    const { f, ka } = await withSalt('rbw-gen-ok-', (a, _b, k1) => ({
      index: indexOf([{ key: k1, path: a.path, dev: a.dev, ino: a.ino, firstGen: 1 }], 1, SALT_FP),
    }));
    await overwriteState(f, { projects_ack_generation: 40 });
    const r = await rebuildW(f);
    expect(r.code, r.err).toBe(0);
    const idx = (await rsiJson(f, 'projects.json')) as {
      generation: number;
      entries: { key: string; first_indexed_generation: number }[];
    };
    expect(idx.generation).toBe(41);
    expect(idx.entries.find((e) => e.key === ka)?.first_indexed_generation).toBe(1); // 旧条目保留
    expect(idx.entries.filter((e) => e.first_indexed_generation === 41).length).toBe(1); // 新 key
    const s = json((await runCmd(f, runStatus, ['--json'], {})).out);
    expect((s['counts'] as Record<string, unknown>)['projects_new']).toBe(1);
  });

  it('Q-G:列举不完整且旧索引无效 → 3 index_invalid、stdout `complete=false`、不写索引 / counts;对照:旧索引有效时允许写', async () => {
    const { f } = await withSalt('rbw-qg-', { raw: { 'projects.json': 'not json' } });
    const before = await readText(path.join(f.rsiDir, 'projects.json'));
    const r = await rebuildW(f, ['--rebuild-index', '--write'], {
      l0: { limits: { maxDirEntries: 1 } },
    });
    expect([r.code, r.out, r.err]).toEqual([
      3,
      'complete=false\n',
      'RSI_FAIL_CLOSED reason=index_invalid\n',
    ]);
    expect(await readText(path.join(f.rsiDir, 'projects.json'))).toBe(before);
    expect(await exists(path.join(f.rsiDir, 'counts.json'))).toBe(false);
    const ok = await withSalt('rbw-qg-ok-', (a, _b, k1) => ({
      index: indexOf([{ key: k1, path: a.path, dev: a.dev, ino: a.ino }], 3, SALT_FP),
    }));
    const r2 = await rebuildW(ok.f, ['--rebuild-index', '--write'], {
      l0: { limits: { maxDirEntries: 1 } },
    });
    expect(r2.code, r2.err).toBe(0);
  });

  it('D2:拿锁之后配置变 off → 4 off,写审计只有锁文件(+ mkdirp 豁免);.tmp 与未完成的提交不被 recover 动', async () => {
    const { f } = await withSalt('rbw-d2-');
    await overwriteRsi(f, 'state.json', baseState({ projects_ack_generation: 1 }));
    await writeFile(f.io, path.join(f.rsiDir, 'snapshot.json.tmp'), '{}', { mode: 0o600 });
    const r = await rebuildW(f, ['--rebuild-index', '--write'], {
      afterLock: async () => writeCfg(f, '[rsi]\nenabled = false\n'),
    });
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(f.audit.filter((c) => c.op !== 'mkdirp').map((c) => c.op)).toEqual([
      'createExclusive',
      'remove',
    ]);
    expect(await exists(path.join(f.rsiDir, 'snapshot.json.tmp'))).toBe(true);
  });

  it('R20-5.1 拿锁:持锁时退 4 locked,不碰数据文件', async () => {
    const { f } = await withSalt('rbw-lock-');
    const release = await foreignLock(f);
    try {
      const before = await treeOf(f.dir);
      const r = await rebuildW(f);
      expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=locked\n']);
      expect(await treeOf(f.dir)).toEqual(before);
    } finally {
      await release();
    }
  });

  it('失锁 k 遍历 + 崩溃矩阵:每个写点之前失锁 → lock_lost、之后零写入;每个写点崩溃 → 重跑成功且快照一致', async () => {
    const mk = (p: string): Promise<TickFx> => withSalt(p).then((x) => x.f);
    const rec = await mk('rbw-rec-');
    const ops: { op: string; audit: number }[] = [];
    expect(
      (
        await rebuildW(rec, ['--rebuild-index', '--write'], {
          beforeWrite: async (op) => void ops.push({ op, audit: rec.audit.length }),
        })
      ).code,
    ).toBe(0);
    expect(ops.map((o) => o.op)).toEqual(
      expect.arrayContaining([
        'recover',
        'rename:projects.json',
        'rename:counts.json',
        'log-append',
        'snapshot-rename',
      ]),
    );
    // 顺序:索引先于 counts 先于清单
    const names = ops.map((o) => o.op);
    expect(names.indexOf('rename:projects.json')).toBeLessThan(names.indexOf('rename:counts.json'));
    expect(names.indexOf('rename:counts.json')).toBeLessThan(names.indexOf('snapshot-rename'));
    for (let k = 1; k <= ops.length; k++) {
      const f = await mk(`rbw-lost-${k}-`);
      let seen = 0;
      let at = -1;
      const base = f.audit.length;
      const r = await rebuildW(f, ['--rebuild-index', '--write'], {
        beforeWrite: async () => {
          if (++seen !== k) return;
          at = f.audit.length;
          await loseLockOf(f);
        },
      });
      expect([r.code, r.err], `k=${k}`).toEqual([3, 'RSI_FAIL_CLOSED reason=lock_lost\n']);
      expect(at - base).toBe(ops[k - 1]?.audit);
      expect(f.audit.length - at, `k=${k} ${ops[k - 1]?.op}`).toBe(0);
      const g = await mk(`rbw-crash-${k}-`);
      let seen2 = 0;
      const c1 = await rebuildW(g, ['--rebuild-index', '--write'], {
        beforeWrite: async () => {
          if (++seen2 === k) throw new Error('crash');
        },
      });
      expect(c1.code, `crash k=${k}`).toBe(3);
      expect((await rebuildW(g)).code, `重跑 k=${k}`).toBe(0);
      expect(await consistent(g), `k=${k} 快照一致`).toBe(true);
    }
  }, 240_000);
});

describe('R20-4.7 taint 放在索引落盘之后(重建新认出的 X 才会被 taint)', () => {
  it('旧索引无效时某个 run 的证据归 U(不 taint);重建把它的项目写进索引后,该项目(已被配置排除)判 X → run 被 taint、摘录清空', async () => {
    const s: Svc = await makeSvc('rbw-taint-');
    const proj = path.join(s.f.dir, 'work', 'xproj');
    await mkdirp(s.f.fx, proj, 0o755);
    const kx = projectKeyFor(SALT, proj);
    await putSession(
      s.f,
      'claude',
      `p/${uuid(1)}.jsonl`,
      jl(
        claudeLine(proj, { timestamp: '2026-10-01T00:00:00.000Z' }),
        claudeLine(proj, { timestamp: '2026-10-01T00:00:01.000Z' }),
      ),
    );
    await addSignals(s, [{ id: 'aaaa000000000001', key: kx }]);
    await stageRun(s, 'rx', ['aaaa000000000001']);
    await setRsiToml(s, `exclude_dirs = [${JSON.stringify(proj)}]\n`);
    const cf = cmdFxOf(s);
    const r = await runCmd(cf, runProjectsRebuild, ['--rebuild-index', '--write'], {});
    expect(r.code, r.err).toBe(0);
    expect(await exists(path.join(s.state, 'reflect', 'rx', 'TAINTED'))).toBe(true);
    const text = await readText(
      path.join(s.state, 'reflect', 'rx', 'proposals', '2026-10-26-001.yaml'),
    );
    expect(text).not.toContain('SECRET-EXCERPT');
    // counts.staged 反映 tainted(四段全量重算里的 staged)
    const counts = JSON.parse(await readText(path.join(s.rsi, 'counts.json'))) as {
      staged: { run_id: string; tainted: boolean }[];
    };
    expect(counts.staged).toEqual([expect.objectContaining({ run_id: 'rx', tainted: true })]);
  });
});

describe('status 卡住提示(D7 / Q-C)', () => {
  const warn = async (f: TickFx): Promise<{ w: string[]; text: string; code: number }> => {
    const j = await runCmd(f, runStatus, ['--json'], {});
    const t = await runCmd(f, runStatus, [], {});
    return { w: (json(j.out)['warnings'] as string[]) ?? [], text: t.out, code: j.code + t.code };
  };
  const cursor = {
    schema_version: 1,
    fingerprint: 'd'.repeat(64),
    full_scan: {
      epoch: 1,
      started_at: '2026-10-24T08:00:00.000Z',
      done: true,
      last_completed_at: '2026-10-24T08:00:00.000Z',
    },
    files: {},
  };

  it('索引缺失而 cursor 在 → index_rebuild_required + 文本 next=rebuild_index;索引损坏 / 盐不符 同;其余(正常 / 无 cursor / 无盐 / 盐违规)没有,且退出码不变', async () => {
    const cases: [string, boolean, () => Promise<TickFx>][] = [
      ['absent+cursor', true, async () => (await withSalt('hint-a-', { cursor })).f],
      [
        'invalid',
        true,
        async () => (await withSalt('hint-b-', { raw: { 'projects.json': 'nope' } })).f,
      ],
      [
        'salt_mismatch',
        true,
        async () =>
          (
            await withSalt('hint-c-', (a) => ({
              index: indexOf(
                [{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }],
                2,
                'bbbbbbbbbbbb',
              ),
            }))
          ).f,
      ],
      ['absent,no cursor(首次,tick 能建)', false, async () => (await withSalt('hint-d-')).f],
      [
        'healthy',
        false,
        async () =>
          (
            await withSalt('hint-e-', (a) => ({
              index: indexOf([{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }], 2, SALT_FP),
              cursor,
            }))
          ).f,
      ],
      [
        'no salt',
        false,
        async () => {
          const f = await makeTickFx('hint-f-', { noSeed: true, projects: 0 });
          await seed(f, { state: baseState(), raw: { 'projects.json': 'nope' }, cursor });
          return f;
        },
      ],
      [
        'salt violation',
        false,
        async () => {
          const f = (await withSalt('hint-g-', { raw: { 'projects.json': 'nope' }, cursor })).f;
          await chmod(f.io, path.join(f.io.stateDir, 'salt'), 0o644);
          return f;
        },
      ],
    ];
    for (const [name, expectWarn, mk] of cases) {
      const f = await mk();
      const r = await warn(f);
      expect(r.code, `${name}:退出码不变(两次都是 0)`).toBe(0);
      expect(r.w.includes('index_rebuild_required'), name).toBe(expectWarn);
      expect(r.text.includes('next=rebuild_index\n'), name).toBe(expectWarn);
      if (expectWarn) expect(r.text.trimEnd().split('\n').pop()).toBe('next=rebuild_index');
    }
  });
});

async function overwriteState(f: TickFx, over: Record<string, unknown>): Promise<void> {
  const cur = (await rsiJson(f, 'state.json')) as Record<string, unknown>;
  await overwriteRsi(f, 'state.json', { ...cur, ...over });
  // 覆写后清单不一致;让下一次写入方的 recover 去重建(这正是生产里「未完成提交」的形状)
}
