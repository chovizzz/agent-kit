/**
 * R20-A2 B5a:`rsi tick`(干跑与 `--write`)。覆盖方案 §11 中归 B5a 的行:R20-5.1 拿锁、D2 / 锁内顺序、R20-3.1.1 零写入、R20-3.1.2 熔断、armed 检查点、
 * confirmed 检查点、§0.5 R3 带回 confirm、§0.5 R4 half_open、失锁 k 遍历、崩溃矩阵、armed 的 D3(不建盐 / 不写 counts)。
 * 全部在假 HOME / KIT_TMP 内;写审计由外部数组累计;不读真实会话根。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readBytes, readText } from '../../src/io/read-fs.js';
import { chmod, writeFile } from '../../src/io/safe-fs.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { runTick, type RsiTickDeps } from '../../src/rsi/tick.js';
import { runStop } from '../../src/rsi/stop.js';
import { runStatus } from '../../src/rsi/status.js';
import { runProjects } from '../../src/rsi/projects.js';
import { treeOf, writeCfg, rsiToml } from './rsi-fixture.js';
import { mkProject, validConfirm, baseState, runMain, seed } from './ro-fixture.js';
import {
  foreignLock,
  loseLockOf,
  makeTickFx,
  overwriteRsi,
  rsiJson,
  runCmd,
  writeKinds,
  type TickFx,
} from './b5a-fixture.js';

const TICK_KEYS = [
  'bytes_read',
  'cursor',
  'duration_ms',
  'files_planned',
  'files_read',
  'limits_hit',
  'mode',
  'projects',
  'reason',
  'salt',
  'signals_new',
  'sessions_new',
  'skipped',
  'state',
  'unknown_signals',
].sort();

const stopDoc = '{"at":"2026-10-26T00:00:00.000Z","by":"user"}';
const tick = (f: TickFx, argv: string[], deps: RsiTickDeps = {}) => runCmd(f, runTick, argv, deps);
const json = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;

async function consistent(f: TickFx): Promise<boolean> {
  return (await inspectSnapshot(f.io, productionSnapshotValidator)) === 'consistent';
}

describe('R20-3.1.1 干跑:零写入(外部写审计 + 前后目录树)', () => {
  const cases: [string, (f: TickFx) => Promise<void>, number, string][] = [
    ['first armed', async () => {}, 0, ''],
    ['confirmed', async () => {}, 0, ''],
    [
      'stopped',
      async (f) => {
        await runCmd(f, runStop, [], {});
        f.audit.length = 0;
      },
      4,
      'RSI_NOT_RUN reason=stopped\n',
    ],
    [
      'collect_blocked(exclude_invalid)',
      async (f) => writeCfg(f, rsiToml(f, 'exclude_dirs = ["relative"]\n')),
      4,
      'RSI_NOT_RUN reason=collect_blocked\n',
    ],
    [
      'off(disabled)',
      async (f) => writeCfg(f, '[rsi]\nenabled = false\n'),
      4,
      'RSI_NOT_RUN reason=off\n',
    ],
    [
      'busy(清单与文件不一致)',
      async (f) =>
        overwriteRsi(f, 'state.json', { ...(baseState() as object), projects_ack_generation: 9 }),
      4,
      'RSI_SNAPSHOT_BUSY\n',
    ],
    [
      'salt 违规(权限过宽)',
      async (f) => {
        const salt = path.join(f.io.stateDir, 'salt');
        await writeFile(f.io, salt, 'ab'.repeat(32), { mode: 0o644 });
        await chmod(f.io, salt, 0o644);
      },
      3,
      'RSI_FAIL_CLOSED reason=salt_invalid\n',
    ],
  ];
  for (const [name, setup, code, err] of cases) {
    it(`${name}:退 ${code},写审计为 0,目录树不变`, async () => {
      const f = await makeTickFx(`tk-dry-${name.slice(0, 5)}-`, {
        confirmed: name === 'confirmed',
      });
      await setup(f);
      const before = await treeOf(f.dir);
      const base = f.audit.length;
      for (const argv of [[], ['--json']]) {
        const r = await tick(f, argv);
        expect(r.code, `${name} ${argv.join(' ')}`).toBe(code);
        expect(r.err).toBe(err);
        if (code !== 0) expect(r.out).toBe('');
      }
      expect(f.audit.slice(base)).toEqual([]);
      expect(await treeOf(f.dir)).toEqual(before);
    });
  }

  it('state.json 整份不合规(清单与文件一致):干跑 → 3 state_invalid(由 readRsiState 负责),零写入', async () => {
    const f = await makeTickFx('tk-dry-badstate-', { noSeed: true });
    await seed(f, { raw: { 'state.json': '{"nope":1}' } });
    const before = await treeOf(f.dir);
    for (const argv of [[], ['--json']]) {
      const r = await tick(f, argv);
      expect([r.code, r.err, r.out]).toEqual([3, 'RSI_FAIL_CLOSED reason=state_invalid\n', '']);
    }
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('JSON 键集合固定且不含 outcome;state / mode / salt("none" → "ephemeral")映射;文本模式同键', async () => {
    for (const confirmed of [false, true]) {
      const f = await makeTickFx(`tk-dry-keys-${confirmed}-`, { confirmed });
      const r = await tick(f, ['--json']);
      expect(r.code).toBe(0);
      const doc = json(r.out);
      expect(Object.keys(doc).sort()).toEqual(TICK_KEYS);
      expect(doc['mode']).toBe('dry');
      expect(doc['state']).toBe(confirmed ? 'confirmed' : 'armed');
      expect(doc['reason']).toBeNull();
      expect(doc['salt']).toBe('ephemeral');
      expect(doc['files_planned'] as number).toBeGreaterThan(0); // 正向前提:夹具里有会话
      expect(doc['signals_new']).toBeNull(); // 干跑 / 临时盐:不输出依赖 key 的计数
      const text = await tick(f, []);
      expect(text.out).toContain('mode=dry\n');
      expect(text.out).toContain('salt=ephemeral\n');
      expect(text.out).not.toContain(f.dir);
    }
  });

  it('对照:同一个审计钩子下 --write 会被记到写入(钩子确实接在命令上);之后干跑的 salt 是 persisted,projects 非 null', async () => {
    const f = await makeTickFx('tk-dry-ctl-', { confirmed: true });
    const w = await tick(f, ['--write']);
    expect(w.code).toBe(0);
    expect(f.audit.length).toBeGreaterThan(5);
    const base = f.audit.length;
    const d = json((await tick(f, ['--json'])).out);
    expect(d['salt']).toBe('persisted');
    expect(d['projects']).not.toBeNull();
    expect(f.audit.length).toBe(base);
  });
});

describe('tick --write:confirmed', () => {
  it('第一次成功:写入范围只在 .state/{rsi,signals,sessions,salt};快照一致;confirm 原样保留(baseline 翻 false、ack = 索引 generation);attempt 为 null', async () => {
    const f = await makeTickFx('tk-conf-', { confirmed: true });
    const confirm0 = (await rsiJson(f, 'state.json'))?.['confirm'] as Record<string, unknown>;
    const r = await tick(f, ['--write', '--json']);
    expect(r.code).toBe(0);
    const doc = json(r.out);
    expect(Object.keys(doc).sort()).toEqual(TICK_KEYS);
    expect(doc).toMatchObject({
      mode: 'write',
      state: 'confirmed',
      salt: 'persisted',
      reason: null,
    });
    expect(doc['signals_new'] as number).toBeGreaterThan(0);
    for (const c of f.audit) {
      const rel = path.relative(f.io.stateDir, c.path);
      // ''(= .state 目录本身的 mkdirp)与四个允许的子树
      expect(['', 'rsi', 'signals', 'sessions', 'salt'], `${c.op} ${rel}`).toContain(
        rel.split(path.sep)[0],
      );
    }
    expect(await consistent(f)).toBe(true);
    const st = (await rsiJson(f, 'state.json')) as Record<string, unknown>;
    const idx = (await rsiJson(f, 'projects.json')) as { generation: number };
    expect(st['confirm']).toEqual({ ...confirm0, baseline_pending: false });
    expect(st['projects_ack_generation']).toBe(idx.generation);
    expect(st['attempt']).toBeNull();
    expect(st['last_tick']).toMatchObject({ trigger: 'tick', outcome: 'ok', code: null });
    expect(await exists(path.join(f.rsiDir, 'cursor.json'))).toBe(true);
    expect(await exists(path.join(f.rsiDir, 'counts.json'))).toBe(true);
  });

  it('R3 带回:tick 不改 confirm / projects_ack_generation;不预写 attempt(残留的 attempt 被清为 null)', async () => {
    const f0 = await makeTickFx('tk-carry-', { confirmed: true });
    const c = { ...(await validConfirm(f0)), baseline_pending: false };
    const f = await makeTickFx('tk-carry2-', {
      confirmed: true,
      state: {
        confirm: c,
        projects_ack_generation: 7,
        attempt: { started_at: '2026-10-01T00:00:00.000Z', nonce: 'a'.repeat(16) },
      },
    });
    // 用同一配置下算出的 confirm(两个夹具的 repo 路径不同,必须按各自夹具重算)
    const own = { ...(await validConfirm(f)), baseline_pending: false };
    await overwriteRsi(
      f,
      'state.json',
      baseState({
        confirm: own,
        projects_ack_generation: 7,
        attempt: { started_at: '2026-10-01T00:00:00.000Z', nonce: 'a'.repeat(16) },
      }),
    );
    const r = await tick(f, ['--write']);
    expect(r.code).toBe(0);
    const st = (await rsiJson(f, 'state.json')) as Record<string, unknown>;
    expect(st['confirm']).toEqual(own);
    expect(st['projects_ack_generation']).toBe(7);
    expect(st['attempt']).toBeNull();
    expect(st['last_tick']).toMatchObject({ outcome: 'ok' });
  });

  it('首次建索引的 generation = max(0, ack) + 1:ack 已到 40、索引与 cursor 都缺失 → 首次 L0 后新 key 的 first_indexed_generation = 41 > ack,status / projects 算作「新增」', async () => {
    const f = await makeTickFx('tk-gen-ack-', { confirmed: true });
    const own = { ...(await validConfirm(f)), baseline_pending: false };
    await overwriteRsi(f, 'state.json', baseState({ confirm: own, projects_ack_generation: 40 }));
    expect((await tick(f, ['--write'])).code).toBe(0);
    const idx = (await rsiJson(f, 'projects.json')) as {
      generation: number;
      entries: { first_indexed_generation: number }[];
    };
    expect(idx.generation).toBe(41);
    expect(idx.entries.length).toBe(2);
    expect(idx.entries.every((e) => e.first_indexed_generation === 41)).toBe(true);
    const st = (await rsiJson(f, 'state.json')) as Record<string, unknown>;
    expect(st['projects_ack_generation']).toBe(40);
    const status = JSON.parse((await runCmd(f, runStatus, ['--json'], {})).out) as {
      counts: { projects_new: number };
    };
    expect(status.counts.projects_new).toBe(2);
    const proj = JSON.parse((await runCmd(f, runProjects, ['--json'], {})).out) as {
      summary: { new: number };
    };
    expect(proj.summary.new).toBe(2);
  });

  it('R20-3.1.2 熔断:safety / retryable 打开时照常执行,成功后清熔断与连续失败计数', async () => {
    for (const breaker of [
      { kind: 'safety', opened_at: '2026-10-01T00:00:00.000Z', until: null },
      {
        kind: 'retryable',
        opened_at: '2026-10-01T00:00:00.000Z',
        until: '2026-10-01T01:00:00.000Z',
      },
    ]) {
      const f = await makeTickFx(`tk-brk-${breaker.kind}-`, { confirmed: true });
      const own = { ...(await validConfirm(f)), baseline_pending: false };
      await overwriteRsi(
        f,
        'state.json',
        baseState({ confirm: own, breaker, consecutive_failures: 3 }),
      );
      const r = await tick(f, ['--write']);
      expect(r.code, breaker.kind).toBe(0);
      const st = (await rsiJson(f, 'state.json')) as Record<string, unknown>;
      expect(st['breaker']).toBeNull();
      expect(st['consecutive_failures']).toBe(0);
    }
  });

  it('R4 half_open:不因半开而跳过;并发靠锁只放一个——持锁时第二个 tick 退 4 locked 且 breaker 不动,释放后执行并清熔断', async () => {
    const f = await makeTickFx('tk-half-', { confirmed: true });
    const own = { ...(await validConfirm(f)), baseline_pending: false };
    const breaker = {
      kind: 'retryable',
      opened_at: '2026-10-01T00:00:00.000Z',
      until: '2026-10-01T01:00:00.000Z',
    };
    await overwriteRsi(
      f,
      'state.json',
      baseState({ confirm: own, breaker, consecutive_failures: 2 }),
    );
    const release = await foreignLock(f);
    try {
      const r = await tick(f, ['--write']);
      expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=locked\n']);
      expect(((await rsiJson(f, 'state.json')) as Record<string, unknown>)['breaker']).toEqual(
        breaker,
      );
    } finally {
      await release();
    }
    expect((await tick(f, ['--write'])).code).toBe(0);
    expect(((await rsiJson(f, 'state.json')) as Record<string, unknown>)['breaker']).toBeNull();
  });

  it('confirmed 检查点:读阶段中途收紧排除 → 4 binding_changed;信号 / 索引 / cursor 不提交;状态记 skipped_binding_changed,熔断原样不动', async () => {
    const f = await makeTickFx('tk-bind-', { confirmed: true });
    const own = { ...(await validConfirm(f)), baseline_pending: false };
    const breaker = { kind: 'safety', opened_at: '2026-10-01T00:00:00.000Z', until: null };
    await overwriteRsi(
      f,
      'state.json',
      baseState({ confirm: own, breaker, consecutive_failures: 1 }),
    );
    const proj1 = path.join(f.dir, 'work', 'proj1');
    let fired = false;
    const r = await tick(f, ['--write'], {
      run: {
        l0: {
          beforeStep: async () => {
            if (fired) return;
            fired = true;
            await writeCfg(f, rsiToml(f, `exclude_dirs = [${JSON.stringify(proj1)}]\n`));
          },
        },
      },
    });
    expect(fired).toBe(true);
    expect([r.code, r.err, r.out]).toEqual([4, 'RSI_NOT_RUN reason=binding_changed\n', '']);
    const st = (await rsiJson(f, 'state.json')) as Record<string, unknown>;
    expect(st['last_tick']).toMatchObject({ outcome: 'skipped_binding_changed' });
    expect(st['breaker']).toEqual(breaker);
    expect(st['consecutive_failures']).toBe(1);
    expect(await exists(path.join(f.rsiDir, 'cursor.json'))).toBe(false);
    expect(await exists(path.join(f.rsiDir, 'projects.json'))).toBe(false);
    expect(await exists(path.join(f.io.stateDir, 'signals'))).toBe(false);
    expect(await consistent(f)).toBe(true);
  });

  it('stop 语义②:已拿锁、复检之后在 #pre 检查点看到 STOP → 4 stopped,不读正文(没有盐 / 信号 / 索引),状态记 stopped', async () => {
    const f = await makeTickFx('tk-stop2-', { confirmed: true });
    const r = await tick(f, ['--write'], {
      run: {
        beforeWrite: async (op) => {
          if (op === 'recover') {
            await writeFile(f.io, path.join(f.rsiDir, 'STOP'), stopDoc, { mode: 0o600 });
          }
        },
      },
    });
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=stopped\n']);
    expect(await exists(path.join(f.io.stateDir, 'salt'))).toBe(false); // #pre 就中止:盐都没建
    expect(await exists(path.join(f.io.stateDir, 'signals'))).toBe(false);
    expect(await exists(path.join(f.rsiDir, 'projects.json'))).toBe(false);
    expect(
      ((await rsiJson(f, 'state.json')) as Record<string, unknown>)['last_tick'],
    ).toMatchObject({
      outcome: 'stopped',
    });
  });

  it('stop 语义③:读阶段中途写 STOP → 4 stopped,cursor / 索引 / 信号库不提交', async () => {
    const f = await makeTickFx('tk-stop3-', { confirmed: true });
    let fired = false;
    const r = await tick(f, ['--write'], {
      run: {
        l0: {
          beforeStep: async (): Promise<void> => {
            if (fired) return;
            fired = true;
            await writeFile(f.io, path.join(f.rsiDir, 'STOP'), stopDoc, { mode: 0o600 });
          },
        },
      },
    });
    expect(fired).toBe(true);
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=stopped\n']);
    expect(await exists(path.join(f.rsiDir, 'cursor.json'))).toBe(false);
    expect(await exists(path.join(f.rsiDir, 'projects.json'))).toBe(false);
    expect(await exists(path.join(f.io.stateDir, 'signals'))).toBe(false);
    expect(
      ((await rsiJson(f, 'state.json')) as Record<string, unknown>)['last_tick'],
    ).toMatchObject({
      outcome: 'stopped',
    });
  });
});

describe('tick --write:armed(D3)', () => {
  it('首次 armed:只列举 + 写 state(armed_listing)/ 日志 / 快照;不建盐、不写 counts / 索引 / cursor / 信号库', async () => {
    const f = await makeTickFx('tk-armed-');
    const r = await tick(f, ['--write', '--json']);
    expect(r.code).toBe(0);
    const doc = json(r.out);
    expect(doc).toMatchObject({ mode: 'write', state: 'armed', salt: 'ephemeral', projects: null });
    expect(doc['files_planned'] as number).toBeGreaterThan(0);
    const st = (await rsiJson(f, 'state.json')) as Record<string, unknown>;
    expect(st['armed_listing']).toMatchObject({ projects: 2, excluded: 0, unknown_sessions: 0 });
    expect(st['confirm']).toBeNull();
    for (const n of ['counts.json', 'projects.json', 'cursor.json']) {
      expect(await exists(path.join(f.rsiDir, n)), n).toBe(false);
    }
    expect(await exists(path.join(f.io.stateDir, 'salt'))).toBe(false);
    expect(await exists(path.join(f.io.stateDir, 'signals'))).toBe(false);
    const names = new Set(
      f.audit.map((c) => path.relative(f.io.stateDir, c.path).split(path.sep)[0]),
    );
    expect([...names].sort()).toEqual(['', 'rsi']);
    expect(await consistent(f)).toBe(true);
  });

  it('armed_listing:列举不完整(complete:false)不持久化(对照:完整时持久化)', async () => {
    const f = await makeTickFx('tk-armed-inc-', { projects: 3 });
    const r = await tick(f, ['--write'], { run: { l0: { limits: { maxDirEntries: 1 } } } });
    expect(r.code).toBe(0);
    expect(
      ((await rsiJson(f, 'state.json')) as Record<string, unknown>)['armed_listing'],
    ).toBeUndefined();
    const ok = await makeTickFx('tk-armed-ok-', { projects: 3 });
    await tick(ok, ['--write']);
    expect(
      ((await rsiJson(ok, 'state.json')) as Record<string, unknown>)['armed_listing'],
    ).toBeDefined();
  });

  it('armed 检查点:不是 createCheckpoint(它在 armed 下恒判 binding_changed)——正常完成;#pre 看到 STOP → 4 stopped(状态记 stopped、armed_listing 不写)', async () => {
    const f = await makeTickFx('tk-armed-cp-');
    expect((await tick(f, ['--write'])).code).toBe(0); // 若用了 createCheckpoint 这里会是 4 binding_changed
    const g = await makeTickFx('tk-armed-stop-');
    const r = await tick(g, ['--write'], {
      run: {
        beforeWrite: async (op) => {
          if (op === 'recover') {
            await writeFile(g.io, path.join(g.rsiDir, 'STOP'), stopDoc, { mode: 0o600 });
          }
        },
      },
    });
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=stopped\n']);
    const st = (await rsiJson(g, 'state.json')) as Record<string, unknown>;
    expect(st['last_tick']).toMatchObject({ outcome: 'stopped' });
    expect(st['armed_listing']).toBeUndefined();
  });

  it('armed 检查点:绑定变化(agents 在拿锁之后被改)→ 4 binding_changed;同一窗口里配置变成停止采集 → taint 的配置重读先 fail-closed(3 exclude_invalid,不继续)', async () => {
    const a = await makeTickFx('tk-armed-cp-off-');
    const off = await tick(a, ['--write'], {
      run: {
        beforeWrite: async (op) => {
          if (op === 'recover') await writeCfg(a, rsiToml(a, 'exclude_dirs = ["relative"]\n'));
        },
      },
    });
    expect([off.code, off.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=exclude_invalid\n']);
    const b = await makeTickFx('tk-armed-cp-bind-');
    const bind = await tick(b, ['--write'], {
      run: {
        beforeWrite: async (op) => {
          if (op === 'recover') await writeCfg(b, rsiToml(b, 'agents = ["claude"]\n'));
        },
      },
    });
    expect([bind.code, bind.err]).toEqual([4, 'RSI_NOT_RUN reason=binding_changed\n']);
  });
});

describe('D2 / 锁内顺序:复检先于 recover', () => {
  async function prepared(prefix: string): Promise<{ f: TickFx; snap0: Uint8Array }> {
    const f = await makeTickFx(prefix, { confirmed: true });
    const own = { ...(await validConfirm(f)), baseline_pending: false };
    // 未完成的提交:state.json 合法但与清单不一致;外加 snapshot.json.tmp(recover 首行会删它)
    await overwriteRsi(f, 'state.json', baseState({ confirm: own, projects_ack_generation: 3 }));
    await writeFile(f.io, path.join(f.rsiDir, 'snapshot.json.tmp'), '{}', { mode: 0o600 });
    return { f, snap0: await readBytes(path.join(f.rsiDir, 'snapshot.json')) };
  }
  const stopFile = '{"at":"2026-10-26T00:00:00.000Z","by":"user"}';

  it('锁后拒绝(STOP / 配置变 off):写审计恰好是锁文件的 createExclusive + remove;.tmp 仍在;snapshot.json 字节不变', async () => {
    for (const how of ['stop', 'off'] as const) {
      const { f, snap0 } = await prepared(`tk-d2-${how}-`);
      const r = await tick(f, ['--write'], {
        afterLock: async () => {
          if (how === 'stop')
            await writeFile(f.io, path.join(f.rsiDir, 'STOP'), stopFile, { mode: 0o600 });
          else await writeCfg(f, '[rsi]\nenabled = false\n');
        },
      });
      expect([r.code, r.err], how).toEqual([
        4,
        `RSI_NOT_RUN reason=${how === 'stop' ? 'stopped' : 'off'}\n`,
      ]);
      // 锁文件的 createExclusive + remove;acquire 内部对 `.state/`、`.state/rsi/` 的 mkdirp(目录已在时也会记一次审计)是豁免(§20.14 D2 订正 #11)
      const nonMkdir = f.audit.filter((c) => c.op !== 'mkdirp');
      expect(
        nonMkdir.map((c) => c.op),
        how,
      ).toEqual(['createExclusive', 'remove']);
      expect(
        nonMkdir.every((c) => c.path.endsWith(`${path.sep}rsi${path.sep}lock`)),
        how,
      ).toBe(true);
      expect(
        f.audit
          .filter((c) => c.op === 'mkdirp')
          .every((c) => [f.io.stateDir, f.rsiDir].includes(c.path)),
        how,
      ).toBe(true);
      expect(await exists(path.join(f.rsiDir, 'snapshot.json.tmp')), `${how}: tmp 仍在`).toBe(true);
      expect(
        Buffer.from(await readBytes(path.join(f.rsiDir, 'snapshot.json'))).equals(
          Buffer.from(snap0),
        ),
      ).toBe(true);
    }
  });

  it('拒绝优先于快照检查:清单损坏 + 锁后 STOP → 仍是 4 stopped;同一夹具不被拒绝 → 3 snapshot_invalid', async () => {
    const a = await prepared('tk-d2-bad-a-');
    await overwriteRsi(a.f, 'snapshot.json', 'garbage');
    const rej = await tick(a.f, ['--write'], {
      afterLock: async () =>
        writeFile(a.f.io, path.join(a.f.rsiDir, 'STOP'), stopFile, { mode: 0o600 }),
    });
    expect([rej.code, rej.err]).toEqual([4, 'RSI_NOT_RUN reason=stopped\n']);
    const b = await prepared('tk-d2-bad-b-');
    await overwriteRsi(b.f, 'snapshot.json', 'garbage');
    const bad = await tick(b.f, ['--write']);
    expect([bad.code, bad.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=snapshot_invalid\n']);
  });

  it('R20-5.1 拿锁:持锁时 --write 退 4 locked,除对锁的试探外不碰任何数据文件', async () => {
    const f = await makeTickFx('tk-lock-', { confirmed: true });
    const release = await foreignLock(f);
    try {
      const before = await treeOf(f.dir);
      const r = await tick(f, ['--write']);
      expect([r.code, r.err, r.out]).toEqual([4, 'RSI_NOT_RUN reason=locked\n', '']);
      const writes = f.audit.filter((c) => c.op !== 'mkdirp');
      expect(writes.every((c) => c.path.endsWith(`${path.sep}rsi${path.sep}lock`))).toBe(true);
      expect(writes.length, '正向前提:确实试探过拿锁').toBeGreaterThan(0);
      expect(await treeOf(f.dir)).toEqual(before);
    } finally {
      await release();
    }
  });
});

describe('purge journal(B5c 接线)', () => {
  it('confirmed 且 journal 不合规 → 3 journal_invalid(tick 不做 salvage,journal 字节不变);合规 journal 的续做见 b5c-salvage.test.ts', async () => {
    const f = await makeTickFx('tk-jr-', { confirmed: true });
    const file = path.join(f.rsiDir, 'purge-journal.json');
    await writeFile(
      f.io,
      file,
      JSON.stringify({
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        mode: 'purge',
        phase: 'planned',
        keys: [],
        taint_targets: { runs: [], promotes: [] },
      }),
      { mode: 0o600 },
    );
    const body = await readText(file);
    const r = await tick(f, ['--write']);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=journal_invalid\n']);
    expect(await readText(file)).toBe(body);
  });
});

describe('失锁 k 遍历与崩溃矩阵', () => {
  type Mk = (prefix: string) => Promise<TickFx>;
  const scenarios: [string, Mk][] = [
    ['confirmed', (p) => makeTickFx(p, { confirmed: true })],
    ['armed', (p) => makeTickFx(p)],
  ];

  for (const [name, mk] of scenarios) {
    it(`${name}:每个写点之前失锁 → lock_lost、之后零写入;每个写点崩溃 → 下一次 tick 完成且快照一致`, async () => {
      // 记录写点
      const rec = await mk(`tk-rec-${name}-`);
      const ops: { op: string; audit: number }[] = [];
      const recRun = await tick(rec, ['--write'], {
        run: { beforeWrite: async (op) => void ops.push({ op, audit: rec.audit.length }) },
      });
      expect(recRun.code).toBe(0);
      const N = ops.length;
      expect(N, '写点清单非空(正向前提)').toBeGreaterThan(name === 'armed' ? 5 : 20);
      const names = ops.map((o) => o.op);
      expect(names).toContain('recover');
      expect(names).toContain('rename:state.json');
      expect(names).toContain('snapshot-rename');
      // 提交顺序(R20-6.9):索引 → counts → state → cursor → 清单(armed 没有数据文件:state → 日志 → 清单)
      const at = (n: string): number => names.indexOf(n);
      if (name === 'confirmed') {
        expect(at('rename:projects.json')).toBeLessThan(at('rename:counts.json'));
        expect(at('rename:counts.json')).toBeLessThan(at('rename:state.json'));
        expect(at('rename:state.json')).toBeLessThan(at('rename:cursor.json'));
        expect(at('rename:cursor.json')).toBeLessThan(at('log-append'));
      } else {
        expect(at('rename:state.json')).toBeLessThan(at('log-append'));
        expect(names).not.toContain('rename:cursor.json');
        expect(names).not.toContain('rename:counts.json');
      }
      expect(at('log-append')).toBeLessThan(at('snapshot-rename'));
      expect(at('recover')).toBe(0); // 锁内第一个写点就是 recover(之前只有无副作用复检)
      for (let k = 1; k <= N; k++) {
        const f = await mk(`tk-lost-${name}-${k}-`);
        let seen = 0;
        let atHook = -1;
        const base = f.audit.length;
        const r = await tick(f, ['--write'], {
          run: {
            beforeWrite: async () => {
              if (++seen !== k) return;
              atHook = f.audit.length;
              await loseLockOf(f);
            },
          },
        });
        expect([r.code, r.err], `k=${k} ${ops[k - 1]?.op}`).toEqual([
          3,
          'RSI_FAIL_CLOSED reason=lock_lost\n',
        ]);
        expect(atHook - base, `k=${k} 与记录的写点流一致`).toBe(ops[k - 1]?.audit);
        expect(f.audit.length - atHook, `k=${k} ${ops[k - 1]?.op}:失锁之后零写入`).toBe(0);
      }
    }, 240_000);

    it(`${name}:每个写点之前崩溃(抛错)→ 重跑一次 tick 成功、快照一致、信号总数与无崩溃的参照一致`, async () => {
      const ref = await mk(`tk-ref-${name}-`);
      let n = 0;
      expect(
        (await tick(ref, ['--write'], { run: { beforeWrite: async () => void n++ } })).code,
      ).toBe(0);
      // key 依赖每个夹具自己的随机盐:只比较各 key 的计数值(排序后)
      const sig = async (f: TickFx): Promise<unknown> =>
        Object.values(((await rsiJson(f, 'counts.json'))?.['per_key'] ?? {}) as object)
          .map((v) => JSON.stringify(v))
          .sort();
      const want = await sig(ref);
      for (let k = 1; k <= n; k++) {
        const f = await mk(`tk-crash-${name}-${k}-`);
        let seen = 0;
        const first = await tick(f, ['--write'], {
          run: {
            beforeWrite: async () => {
              if (++seen === k) throw new Error('crash');
            },
          },
        });
        expect(first.code, `k=${k}`).toBe(3); // 未识别的异常 → internal
        const second = await tick(f, ['--write']);
        expect(second.code, `k=${k} 重跑`).toBe(0);
        expect(await consistent(f), `k=${k} 快照一致`).toBe(true);
        expect(await sig(f), `k=${k} 计数与参照一致`).toEqual(want);
      }
    }, 240_000);
  }
});

describe('零写入的真实 main() 路径', () => {
  it('rsi tick(干跑)经真实 main():退 0、写审计为 0;--write 在配置 off 时退 4 且零写入', async () => {
    const f = await makeTickFx('tk-main-', { confirmed: true });
    const d = await runMain(f, ['rsi', 'tick', '--json']);
    expect(d.code).toBe(0);
    expect(d.audit).toEqual([]);
    await writeCfg(f, '[rsi]\nenabled = false\n');
    const w = await runMain(f, ['rsi', 'tick', '--write']);
    expect([w.code, w.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(w.audit).toEqual([]);
    void mkProject;
    void writeKinds;
  });
});
