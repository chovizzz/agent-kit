/**
 * R20-A2 B5c:`rsi purge` 命令(R20-3.8)。覆盖方案 §11 中归 B5c 的行:R20-3.8.1 未排除预检、R20-3.8.4 崩溃后 `--resume` 完成且第二遍零写入、Q-J、
 * D2 锁内顺序(锁后拒绝只豁免锁文件)、§0.5 R2 判据分工、零写入(干跑 / 拒绝)、purge 不删 STOP / 不写 state.json、配置来源一致性两个维度。
 * 全部在假 HOME / KIT_TMP 内;写审计由外部数组累计。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readBytes, readText } from '../../src/io/read-fs.js';
import { hardlink, mkdirp, remove, writeFile } from '../../src/io/safe-fs.js';
import { readPurgeJournal } from '../../src/rsi/services/purge-journal.js';
import { treeOf, writeCfg } from './rsi-fixture.js';
import { CrashError, KEY_A, KEY_B, KEY_C, put, setRsiToml, signalObj } from './services-fixture.js';
import {
  STOP_DOC,
  consistent,
  dataFingerprint,
  json,
  makeSc,
  purge,
  sid,
  type Sc,
} from './b5c-fixture.js';

const OUT_KEYS = [
  'cursor_entries',
  'done',
  'index_entries',
  'keys',
  'mode',
  'phase',
  'session_rows',
  'signals',
  'taint_promotes',
  'taint_runs',
].sort();
const NOTE = '已合进 git、发成 PR 或 git apply 到工作树的内容不在 kit 管辖范围';

const lockOnly = (sc: Sc): string[] =>
  sc.cf.audit.filter((a) => a.op !== 'mkdirp').map((a) => a.op);

async function referenceFingerprint(): Promise<string[]> {
  const ref = await makeSc('cmd-ref-');
  const r = await purge(ref, ['--excluded', '--write']);
  expect(r.code).toBe(0);
  return dataFingerprint(ref.s);
}

describe('参数与前置(零写入)', () => {
  const usage: [string[], string][] = [
    [[], 'mode_conflict'],
    [['--json'], 'mode_conflict'],
    [['--excluded', '--resume'], 'mode_conflict'],
    [['--project', '/x', '--excluded'], 'mode_conflict'],
    [['--project'], 'bad_path'],
    [['--project', 'relative/dir'], 'bad_path'],
    [['--project', '--excluded'], 'bad_path'],
    [['--project', '/a', '--project', '/b'], 'unknown_arg'],
    [['--excluded', '--excluded'], 'unknown_arg'],
    [['--excluded', '--write', '--write'], 'unknown_arg'],
    [['--excluded', '--x'], 'unknown_arg'],
    [['--excluded=1'], 'unknown_arg'],
    [['positional'], 'unknown_arg'],
  ];
  for (const [argv, reason] of usage) {
    it(`${JSON.stringify(argv)} → 2 ${reason}`, async () => {
      const sc = await makeSc('cmd-usage-');
      const before = await treeOf(sc.s.f.dir);
      const r = await purge(sc, argv);
      expect([r.code, r.err, r.out]).toEqual([2, `RSI_USAGE reason=${reason}\n`, '']);
      expect(sc.cf.audit).toEqual([]);
      expect(await treeOf(sc.s.f.dir)).toEqual(before);
    });
  }

  it('--write 非 TTY → 2 not_tty,先于任何读(配置 off 时也是 not_tty 而不是 off),零写入', async () => {
    const sc = await makeSc('cmd-nottty-');
    await writeCfg(sc.s.f, '[rsi]\nenabled = false\n');
    const r = await purge(sc, ['--excluded', '--write'], {}, { isTty: false });
    expect([r.code, r.err]).toEqual([2, 'RSI_USAGE reason=not_tty\n']);
    expect(sc.cf.audit).toEqual([]);
    // 对照:干跑不要求 TTY(配置 off → 4 off)
    const d = await purge(sc, ['--excluded'], {}, { isTty: false });
    expect([d.code, d.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
  });

  it('配置 off → 4 off(干跑与 --write 都是);没有盐 → 4 not_confirmed', async () => {
    const sc = await makeSc('cmd-off-');
    const salt = path.join(sc.s.state, 'salt');
    await remove(sc.s.f.fx, salt);
    for (const argv of [['--excluded'], ['--excluded', '--write'], ['--resume']]) {
      const r = await purge(sc, argv);
      expect([r.code, r.err], argv.join(' ')).toEqual([4, 'RSI_NOT_RUN reason=not_confirmed\n']);
    }
    await writeCfg(sc.s.f, '[rsi]\nenabled = false\n');
    const r = await purge(sc, ['--excluded', '--write']);
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(sc.cf.audit).toEqual([]);
  });

  it('盐文件违规(权限过宽)→ 3 salt_invalid', async () => {
    const sc = await makeSc('cmd-salt-bad-');
    await put(sc.s, path.join(sc.s.state, 'salt'), 'ab'.repeat(32), 0o644);
    const r = await purge(sc, ['--excluded']);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=salt_invalid\n']);
  });
});

describe('干跑:零写入、计数、固定说明', () => {
  for (const state of ['armed', 'confirmed', 'stopped'] as const) {
    it(`${state}:--excluded 干跑 → 0,计数与夹具手算一致,写审计为 0,目录树不变`, async () => {
      const sc = await makeSc(`cmd-dry-${state}-`, { state });
      const before = await treeOf(sc.s.f.dir);
      const r = await purge(sc, ['--excluded']);
      expect(r.code).toBe(0);
      expect(r.out.split('\n')).toEqual([
        'cursor_entries=2',
        'done=false',
        'index_entries=2',
        'keys=2',
        'mode=dry',
        'phase=-',
        'session_rows=2',
        'signals=4',
        'taint_promotes=1',
        'taint_runs=1',
        NOTE,
        '',
      ]);
      expect(sc.cf.audit).toEqual([]);
      expect(await treeOf(sc.s.f.dir)).toEqual(before);
    });
  }

  it('--json 键集合固定;不含路径 / key / 项目名', async () => {
    const sc = await makeSc('cmd-dry-json-');
    const r = await purge(sc, ['--excluded', '--json']);
    const o = json(r.out);
    expect(Object.keys(o).sort()).toEqual(OUT_KEYS);
    expect(o).toMatchObject({ mode: 'dry', phase: null, keys: 2, signals: 4, done: false });
    expect(r.out).not.toContain(sc.s.f.dir);
    expect(r.out).not.toContain(KEY_A);
    expect(sc.cf.audit).toEqual([]);
  });

  it('--project <ex/sub> 只算 D;未排除 → 1 RSI_PURGE_NOT_EXCLUDED,stdout 空、零写入', async () => {
    const sc = await makeSc('cmd-dry-proj-');
    const ok = json((await purge(sc, ['--project', sc.roots.sub, '--json'])).out);
    expect(ok).toMatchObject({ keys: 1, signals: 1, session_rows: 0, index_entries: 1 });
    const bad = await purge(sc, ['--project', sc.roots.ok]);
    expect([bad.code, bad.err, bad.out]).toEqual([1, 'RSI_PURGE_NOT_EXCLUDED\n', '']);
    expect(sc.cf.audit).toEqual([]);
  });

  it('K 为空 → 0 并输出全 0 计数(done=false),零写入', async () => {
    const sc = await makeSc('cmd-dry-empty-');
    const r = await purge(sc, ['--project', path.join(sc.roots.ok, 'not-indexed'), '--json']);
    expect([r.code, json(r.out)]).toEqual([
      0,
      {
        mode: 'dry',
        phase: null,
        keys: 0,
        signals: 0,
        session_rows: 0,
        cursor_entries: 0,
        index_entries: 0,
        taint_runs: 0,
        taint_promotes: 0,
        done: false,
      },
    ]);
    expect(sc.cf.audit).toEqual([]);
  });

  it('索引损坏 → 3 index_invalid(干跑也一样)', async () => {
    const sc = await makeSc('cmd-dry-idx-');
    await put(sc.s, path.join(sc.s.rsi, 'projects.json'), '{"nope":1}');
    const r = await purge(sc, ['--excluded']);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=index_invalid\n']);
    expect(sc.cf.audit).toEqual([]);
  });
});

describe('Q-J 与 --resume 的 journal 前置(零写入)', () => {
  type Mk = (sc: Sc) => Promise<void>;
  const states: [string, Mk, string][] = [
    [
      'invalid',
      async (sc) => put(sc.s, path.join(sc.s.rsi, 'purge-journal.json'), '{"nope":1}'),
      'purge_incomplete',
    ],
    [
      'unreadable(目录冒充)',
      async (sc) => mkdirp(sc.s.f.fx, path.join(sc.s.rsi, 'purge-journal.json'), 0o700),
      'purge_incomplete',
    ],
  ];

  for (const [name, mk, reason] of states) {
    it(`新 purge 遇到 ${name} journal → 3 ${reason}(干跑与 --write),零写入`, async () => {
      const sc = await makeSc(`cmd-qj-${name.slice(0, 3)}-`);
      await mk(sc);
      for (const argv of [
        ['--excluded'],
        ['--excluded', '--write'],
        ['--project', sc.roots.ex, '--write'],
      ]) {
        const r = await purge(sc, argv);
        expect([r.code, r.err], argv.join(' ')).toEqual([3, `RSI_FAIL_CLOSED reason=${reason}\n`]);
      }
      expect(sc.cf.audit).toEqual([]);
    });
  }

  it('新 purge 遇到合规 journal(崩溃遗留)→ 3 purge_incomplete,必须先 --resume;journal 字节不变', async () => {
    const sc = await makeSc('cmd-qj-valid-');
    const c = await purge(sc, ['--excluded', '--write'], {
      beforePhase: (st) => {
        if (st === 'tainted') throw new CrashError('x');
      },
    });
    expect(c.code).toBe(3);
    const jf = path.join(sc.s.rsi, 'purge-journal.json');
    const before = await readText(jf);
    sc.cf.audit.length = 0;
    for (const argv of [['--excluded'], ['--excluded', '--write']]) {
      const r = await purge(sc, argv);
      expect([r.code, r.err], argv.join(' ')).toEqual([
        3,
        'RSI_FAIL_CLOSED reason=purge_incomplete\n',
      ]);
    }
    expect(sc.cf.audit).toEqual([]);
    expect(await readText(jf)).toBe(before);
  });

  it('--resume 没有 journal → 4 no_journal(干跑与 --write),零写入;journal unreadable → 3 purge_incomplete,零写入', async () => {
    const sc = await makeSc('cmd-resume-none-');
    for (const argv of [['--resume'], ['--resume', '--write']]) {
      const r = await purge(sc, argv);
      expect([r.code, r.err], argv.join(' ')).toEqual([4, 'RSI_NOT_RUN reason=no_journal\n']);
    }
    expect(sc.cf.audit).toEqual([]);
    await mkdirp(sc.s.f.fx, path.join(sc.s.rsi, 'purge-journal.json'), 0o700);
    for (const argv of [['--resume'], ['--resume', '--write']]) {
      const r = await purge(sc, argv);
      expect([r.code, r.err], argv.join(' ')).toEqual([
        3,
        'RSI_FAIL_CLOSED reason=purge_incomplete\n',
      ]);
    }
    expect(sc.cf.audit).toEqual([]);
  });

  it('--resume 干跑:合规 journal → 打印 journal 阶段与目标数;invalid → phase=invalid、将 taint 全部暂存目录;均零写入', async () => {
    const sc = await makeSc('cmd-resume-dry-');
    await purge(sc, ['--excluded', '--write'], {
      beforePhase: (st) => {
        if (st === 'tainted') throw new CrashError('x');
      },
    });
    sc.cf.audit.length = 0;
    const r = json((await purge(sc, ['--resume', '--json'])).out);
    expect(r).toMatchObject({
      mode: 'resume',
      phase: 'planned',
      keys: 2,
      taint_runs: 1,
      taint_promotes: 1,
      done: false,
    });
    // 信号库此刻还没重写:剩余计数 = 4 条信号
    expect(r['signals']).toBe(4);
    await put(sc.s, path.join(sc.s.rsi, 'purge-journal.json'), 'garbage');
    sc.cf.audit.length = 0;
    const inv = await purge(sc, ['--resume', '--json']);
    expect(json(inv.out)).toMatchObject({
      mode: 'resume',
      phase: 'invalid',
      keys: 0,
      signals: 0,
      taint_runs: 2,
      taint_promotes: 2,
      done: false,
    });
    expect(sc.cf.audit).toEqual([]);
    expect((await purge(sc, ['--resume'])).out).toContain('未删除任何信号');
  });
});

describe('--write:新 purge', () => {
  for (const state of ['armed', 'confirmed', 'stopped'] as const) {
    it(`${state}:完成,journal 已删,清单一致;不删 STOP、不写 state.json`, async () => {
      const sc = await makeSc(`cmd-w-${state}-`, { state });
      const { s } = sc;
      const stopBefore = (await exists(path.join(s.rsi, 'STOP')))
        ? await readText(path.join(s.rsi, 'STOP'))
        : null;
      const stateBefore = (await exists(path.join(s.rsi, 'state.json')))
        ? await readBytes(path.join(s.rsi, 'state.json'))
        : null;
      const r = await purge(sc, ['--excluded', '--write', '--json']);
      expect(r.code, r.err).toBe(0);
      expect(Object.keys(json(r.out)).sort()).toEqual(OUT_KEYS);
      expect(json(r.out)).toMatchObject({
        mode: 'write',
        phase: 'done',
        keys: 2,
        signals: 4,
        session_rows: 2,
        cursor_entries: 2,
        index_entries: 2,
        taint_runs: 1,
        taint_promotes: 1,
        done: true,
      });
      expect(await readPurgeJournal(s.io)).toEqual({ state: 'absent' });
      expect(await consistent(s)).toBe(true);
      expect(state === 'stopped' ? await readText(path.join(s.rsi, 'STOP')) : null).toBe(
        stopBefore === null ? null : STOP_DOC,
      );
      const stateAfter = (await exists(path.join(s.rsi, 'state.json')))
        ? await readBytes(path.join(s.rsi, 'state.json'))
        : null;
      expect(stateAfter === null ? null : Buffer.from(stateAfter).toString()).toBe(
        stateBefore === null ? null : Buffer.from(stateBefore).toString(),
      );
      // 写入范围:只落在 .state 内,且不碰盐
      for (const a of sc.cf.audit) expect(a.path.startsWith(s.state), a.path).toBe(true);
      expect(sc.cf.audit.some((a) => a.path.endsWith(`${path.sep}salt`))).toBe(false);
    });
  }

  it('文本输出带固定说明;--project 只删命中项目(D),A 不动', async () => {
    const sc = await makeSc('cmd-w-proj-');
    const r = await purge(sc, ['--project', sc.roots.sub, '--write']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(NOTE);
    expect(r.out).toContain('keys=1');
    const sig = await readText(path.join(sc.s.state, 'signals', 'claude', '202610.jsonl'));
    expect(sig).toContain(`sig_${sid(3)}`); // A 的信号还在
    expect(sig).not.toContain(`sig_${sid(5)}`); // D 的被删
    const idx = JSON.parse(await readText(path.join(sc.s.rsi, 'projects.json'))) as {
      entries: { key: string }[];
    };
    expect(idx.entries.map((e) => e.key)).toEqual([KEY_A, KEY_B, KEY_C]);
  });

  it('锁前预检:未排除 → 1、K 为空 → 0,都是零写入(没有拿锁)', async () => {
    const sc = await makeSc('cmd-w-pre-');
    const bad = await purge(sc, ['--project', sc.roots.inc, '--write']);
    expect([bad.code, bad.err, bad.out]).toEqual([1, 'RSI_PURGE_NOT_EXCLUDED\n', '']);
    const empty = await purge(sc, [
      '--project',
      path.join(sc.roots.ok, 'nope'),
      '--write',
      '--json',
    ]);
    expect(empty.code).toBe(0);
    expect(json(empty.out)).toMatchObject({ mode: 'write', keys: 0, done: false });
    expect(sc.cf.audit).toEqual([]);
  });

  it('D2 / R2:锁后(拿锁之后改配置)变成未排除 → 1;审计恰好是锁文件的建与删;预置的 snapshot.json.tmp 与未完成提交(清单不一致)原样保留', async () => {
    const sc = await makeSc('cmd-w-d2-');
    const { s } = sc;
    await put(s, path.join(s.rsi, 'snapshot.json.tmp'), 'leftover');
    // 未完成提交:数据变了而清单没跟上
    const f = path.join(s.state, 'signals', 'claude', '202610.jsonl');
    await put(s, f, (await readText(f)) + `${JSON.stringify(signalObj(sid(8), KEY_B))}\n`);
    const before = await treeOf(s.f.dir);
    const r = await purge(sc, ['--project', sc.roots.ex, '--write'], {
      afterLock: () => setRsiToml(s, ''), // 去掉排除项:A、D 现在不是 X
    });
    expect([r.code, r.err, r.out]).toEqual([1, 'RSI_PURGE_NOT_EXCLUDED\n', '']);
    expect(lockOnly(sc)).toEqual(['createExclusive', 'remove']);
    expect(await exists(path.join(s.rsi, 'snapshot.json.tmp'))).toBe(true);
    expect(await readText(path.join(s.rsi, 'snapshot.json.tmp'))).toBe('leftover');
    // 目录树(排除配置文件自身的变化)不变
    const after = (await treeOf(s.f.dir)).filter((l) => !l.startsWith('home/'));
    expect(after).toEqual(before.filter((l) => !l.startsWith('home/')));
    expect(await readPurgeJournal(s.io)).toEqual({ state: 'absent' });
  });

  it('R2:清单本身损坏 + 锁后拒绝 → 仍是 1(拒绝先于快照检查);同一夹具不被拒绝 → 3 snapshot_invalid', async () => {
    const mk = async (): Promise<Sc> => {
      const sc = await makeSc('cmd-w-r2-');
      await put(sc.s, path.join(sc.s.rsi, 'snapshot.json'), 'garbage');
      sc.cf.audit.length = 0;
      return sc;
    };
    const rej = await mk();
    const r1 = await purge(rej, ['--project', rej.roots.ex, '--write'], {
      afterLock: () => setRsiToml(rej.s, ''),
    });
    expect([r1.code, r1.err]).toEqual([1, 'RSI_PURGE_NOT_EXCLUDED\n']);
    const ok = await mk();
    const r2 = await purge(ok, ['--excluded', '--write']);
    expect(r2.code).toBe(3);
    expect(r2.err).toMatch(/^RSI_FAIL_CLOSED reason=snapshot_invalid\n$/);
    expect(lockOnly(ok), '拒绝在 recover 之前:此时除锁文件外零写入').toEqual([
      'createExclusive',
      'remove',
    ]);
  });

  it('锁后配置变 off → 4 off;state.json 整份不合规 → 3 state_invalid;都先于 recover(零写入)', async () => {
    const off = await makeSc('cmd-w-off-');
    const r1 = await purge(off, ['--excluded', '--write'], {
      afterLock: () => writeCfg(off.s.f, '[rsi]\nenabled = false\n'),
    });
    expect([r1.code, r1.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(lockOnly(off)).toEqual(['createExclusive', 'remove']);
    const bad = await makeSc('cmd-w-badstate-');
    await put(bad.s, path.join(bad.s.rsi, 'state.json'), '{"nope":1}');
    bad.cf.audit.length = 0;
    const r2 = await purge(bad, ['--excluded', '--write']);
    expect([r2.code, r2.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=state_invalid\n']);
    expect(lockOnly(bad)).toEqual(['createExclusive', 'remove']);
  });

  it('拿不到锁 → 4 locked,零写入(另一个进程持锁)', async () => {
    const sc = await makeSc('cmd-w-locked-');
    const lockFile = path.join(sc.s.rsi, 'lock');
    await writeFile(
      sc.s.f.fx,
      lockFile,
      JSON.stringify({
        pid: process.ppid,
        started_at: new Date().toISOString(),
        nonce: 'f'.repeat(16),
        kit_version: '0.0.0',
      }),
      { mode: 0o600 },
    );
    const before = await treeOf(sc.s.f.dir);
    const r = await purge(sc, ['--excluded', '--write']);
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=locked\n']);
    expect(await treeOf(sc.s.f.dir)).toEqual(before);
    expect(sc.cf.audit.filter((a) => a.op !== 'mkdirp' && a.path !== lockFile)).toEqual([]);
  });

  it('digests 目录在场 → 3 internal(P0 没有它的清理实现),journal 不写', async () => {
    const sc = await makeSc('cmd-w-digests-');
    await mkdirp(sc.s.f.fx, path.join(sc.s.rsi, 'digests'), 0o700);
    const r = await purge(sc, ['--excluded', '--write']);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=internal\n']);
    expect(await readPurgeJournal(sc.s.io)).toEqual({ state: 'absent' });
  });

  it('overlay 不合规(counts 重算要用脱敏器)→ 3 overlay_invalid,在写 journal 之前失败:journal 不建、信号库不动、除锁文件外零写入', async () => {
    const sc = await makeSc('cmd-w-overlay-');
    await setRsiToml(
      sc.s,
      `exclude_dirs = [${JSON.stringify(sc.roots.ex)}]\noverlay = "/nonexistent/overlay.toml"\n`,
    );
    const fp = await dataFingerprint(sc.s);
    sc.cf.audit.length = 0;
    const r = await purge(sc, ['--excluded', '--write']);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=overlay_invalid\n']);
    expect(await readPurgeJournal(sc.s.io)).toEqual({ state: 'absent' });
    expect(await dataFingerprint(sc.s)).toEqual(fp);
    expect(lockOnly(sc).slice(0, 1), '正向前提:确实拿过锁').toEqual(['createExclusive']);
    expect(sc.cf.audit.some((a) => a.path.includes('purge-journal'))).toBe(false);
    expect(sc.cf.audit.some((a) => a.path.endsWith('.jsonl'))).toBe(false);
  });

  it('taint 阻断(暂存目录里有硬链接等)→ 3 staging_unsafe_entry,journal 保留', async () => {
    const sc = await makeSc('cmd-w-blocked-');
    const run = path.join(sc.s.state, 'reflect', 'run-ex');
    await hardlink(sc.s.f.fx, path.join(run, 'report.json'), path.join(run, 'stray.bin'));
    const r = await purge(sc, ['--excluded', '--write']);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=staging_unsafe_entry\n']);
    expect((await readPurgeJournal(sc.s.io)).state).toBe('present');
  });
});

describe('崩溃 → --resume --write 完成 → 第二遍零写入(R20-3.8.4)', () => {
  const stages = ['planned', 'tainted', 'signals_rewritten', 'indexed', 'done'];
  for (const stage of stages) {
    it(`崩在「${stage}」:--resume --write(无 journal 时重新发起)完成且与基准一致;再 --resume → 4 no_journal,写审计为 0`, async () => {
      const ref = await referenceFingerprint();
      const sc = await makeSc(`cmd-crash-${stage}-`);
      const c = await purge(sc, ['--excluded', '--write'], {
        beforePhase: (st) => {
          if (st === stage) throw new CrashError(stage);
        },
      });
      expect([c.code, c.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=internal\n']);
      const j = await readPurgeJournal(sc.s.io);
      if (stage === 'planned') {
        expect(j.state).toBe('absent');
        expect((await purge(sc, ['--excluded', '--write'])).code).toBe(0);
      } else {
        expect(j.state).toBe('present');
        const r = await purge(sc, ['--resume', '--write', '--json']);
        expect(r.code, r.err).toBe(0);
        expect(json(r.out)).toMatchObject({ mode: 'resume', phase: 'done', done: true });
      }
      expect(await dataFingerprint(sc.s)).toEqual(ref);
      expect(await consistent(sc.s)).toBe(true);
      sc.cf.audit.length = 0;
      const again = await purge(sc, ['--resume', '--write']);
      expect([again.code, again.err]).toEqual([4, 'RSI_NOT_RUN reason=no_journal\n']);
      expect(sc.cf.audit, '第二遍零写入').toEqual([]);
    });
  }

  it('崩在 journal done 之后、删除之前:续做只提交 + 删 journal(写审计里没有月文件 / cursor / 索引 / counts)', async () => {
    const sc = await makeSc('cmd-crash-done-rm-');
    const c = await purge(sc, ['--excluded', '--write'], {
      beforeWrite: (op) => {
        if (op === 'remove:purge-journal') return Promise.reject(new CrashError('x'));
        return Promise.resolve();
      },
    });
    expect(c.code).toBe(3);
    const j = await readPurgeJournal(sc.s.io);
    expect(j.state === 'present' ? j.journal.phase : j.state).toBe('done');
    sc.cf.audit.length = 0;
    const r = await purge(sc, ['--resume', '--write']);
    expect(r.code, r.err).toBe(0);
    const bases = sc.cf.audit.map((a) => path.basename(a.path));
    for (const bad of [
      'cursor.json',
      'projects.json',
      'counts.json',
      '202609.jsonl',
      '202610.jsonl',
    ]) {
      expect(bases, bad).not.toContain(bad);
    }
    expect(bases).toContain('log.jsonl');
  });

  it('命令级失锁:月文件写点与 journal 写点之前失锁 → 3 lock_lost,之后零写入', async () => {
    const rec = await makeSc('cmd-lk-rec-');
    const ops: string[] = [];
    await purge(rec, ['--excluded', '--write'], {
      beforeWrite: (op) => {
        ops.push(op);
        return Promise.resolve();
      },
    });
    expect(ops.length).toBeGreaterThan(40);
    const picks = [
      1,
      5,
      ops.findIndex((o) => o.startsWith('month:')) + 1,
      ops.indexOf('rename:cursor.json') + 1,
      ops.indexOf('snapshot-rename') + 1,
      ops.length,
    ];
    for (const k of picks) {
      const sc = await makeSc(`cmd-lk-${k}-`);
      let n = 0;
      let at = -1;
      const r = await purge(sc, ['--excluded', '--write'], {
        beforeWrite: async (op) => {
          if (++n === k) {
            at = sc.cf.audit.length;
            await remove(sc.s.f.fx, path.join(sc.s.rsi, 'lock'));
          }
          void op;
        },
      });
      expect(r.code, `k=${k} ${ops[k - 1]}`).toBe(3);
      expect(r.err, `k=${k}`).toBe('RSI_FAIL_CLOSED reason=lock_lost\n');
      expect(sc.cf.audit.length, `k=${k}:失锁之后零写入`).toBe(at);
    }
  }, 120_000);
});

describe('配置来源一致性(§0.5 R10 / §2.1):排除项与状态目录两个维度', () => {
  it('状态目录:env 带 KIT_STATE_DIR / KIT_WRITE_ROOTS 指向别处、HOME 与 KIT_REAL_HOME_OVERRIDE 不同 → 仍只读写 [rsi] repo/.state;读的是同一份配置', async () => {
    const sc = await makeSc('cmd-src-state-');
    const { s } = sc;
    const elsewhere = path.join(s.f.dir, 'elsewhere');
    const otherHome = path.join(s.f.dir, 'other-home');
    await mkdirp(s.f.fx, path.join(otherHome, '.config', 'agent-kit'), 0o755);
    await writeFile(
      s.f.fx,
      path.join(otherHome, '.config', 'agent-kit', 'config.toml'),
      '[rsi]\nenabled = false\n',
      { mode: 0o600 },
    );
    const r = await purge(
      sc,
      ['--excluded', '--write'],
      {},
      {
        env: {
          KIT_STATE_DIR: elsewhere,
          KIT_WRITE_ROOTS: elsewhere,
          HOME: otherHome,
          KIT_TMP: undefined,
        },
      },
    );
    expect(r.code, r.err).toBe(0);
    expect(sc.cf.audit.length, '正向前提:有写入').toBeGreaterThan(20);
    for (const a of sc.cf.audit) {
      expect(a.path.startsWith(s.state), a.path).toBe(true);
      expect(a.path.startsWith(elsewhere), a.path).toBe(false);
    }
    expect(await exists(elsewhere)).toBe(false);
  });

  it('排除项:命令侧配置(KIT_REAL_HOME_OVERRIDE)排除 ex、另一份 HOME 的配置不排除 → 按命令侧判定,taint 不依赖另一份;反向:命令侧不排除、另一份排除 → K 为空,什么都不删', async () => {
    const sc = await makeSc('cmd-src-excl-');
    const { s } = sc;
    const altHome = path.join(s.f.dir, 'alt-home');
    const writeAlt = async (toml: string): Promise<void> => {
      await mkdirp(s.f.fx, path.join(altHome, '.config', 'agent-kit'), 0o755);
      await writeFile(s.f.fx, path.join(altHome, '.config', 'agent-kit', 'config.toml'), toml, {
        mode: 0o600,
      });
    };
    // 正向前提:两份配置的结论确实不同
    await writeAlt(`[rsi]\nenabled = true\nrepo = ${JSON.stringify(s.f.repo)}\n`);
    const dry = await purge(sc, ['--excluded', '--json'], {}, { env: { HOME: altHome } });
    expect(json(dry.out)).toMatchObject({ keys: 2 }); // 命令侧(S)排除了 ex
    const w = await purge(sc, ['--excluded', '--write', '--json'], {}, { env: { HOME: altHome } });
    expect(json(w.out)).toMatchObject({ keys: 2, taint_runs: 1, done: true });
    expect(await exists(path.join(s.state, 'reflect', 'run-ex', 'TAINTED'))).toBe(true);
    // 反向:命令侧配置(S)不排除任何东西
    const sc2 = await makeSc('cmd-src-excl2-');
    await setRsiToml(sc2.s, '');
    const altHome2 = path.join(sc2.s.f.dir, 'alt-home');
    await mkdirp(sc2.s.f.fx, path.join(altHome2, '.config', 'agent-kit'), 0o755);
    await writeFile(
      sc2.s.f.fx,
      path.join(altHome2, '.config', 'agent-kit', 'config.toml'),
      `[rsi]\nenabled = true\nrepo = ${JSON.stringify(sc2.s.f.repo)}\nexclude_dirs = [${JSON.stringify(sc2.roots.ex)}]\n`,
      { mode: 0o600 },
    );
    const fp = await dataFingerprint(sc2.s);
    const w2 = await purge(
      sc2,
      ['--excluded', '--write', '--json'],
      {},
      { env: { HOME: altHome2 } },
    );
    expect(json(w2.out)).toMatchObject({ keys: 0, done: false });
    expect(await dataFingerprint(sc2.s)).toEqual(fp);
    expect(sc2.cf.audit).toEqual([]);
  });
});
