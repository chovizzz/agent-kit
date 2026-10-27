/**
 * R20-A2 B5c:Q-A salvage 阶段机(journal invalid 时的出路,方案 §0.5 R1)与 purge 进行中的联动(tick 续做、其它写入方被拦、STOP / journal 不在清单内)。
 * 判据:每步崩溃 / 失锁都可重入(`--resume --write`)、不丢 taint 保证(其它写入方的 `resumeTaint` 能推进)、不删任何信号、第二遍零写入、
 * 暂存超过 5000 → 3 `staging_too_large` 且零写入、unreadable 保持拒绝、tick 不做 salvage(只有前台 `--resume --write` 能做)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { hardlink, mkdirp, remove } from '../../src/io/safe-fs.js';
import { immediateGate } from '../../src/rsi/services/immediate-gate.js';
import { salvageInvalidJournal } from '../../src/rsi/services/purge-engine.js';
import { readPurgeJournal } from '../../src/rsi/services/purge-journal.js';
import {
  assertNoPurgeInProgress,
  detectPurgeJournal,
  resumeTaintWith,
} from '../../src/rsi/services/taint.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { runTick } from '../../src/rsi/tick.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { RsiFailClosedError } from '../../src/rsi/types.js';
import { runCmd } from './b5a-fixture.js';
import {
  EXCERPT_MARK,
  CrashError,
  allText,
  listFiles,
  promoteDirOf,
  put,
  runDirOf,
  withLock,
} from './services-fixture.js';
import {
  STOP_DOC,
  consistent,
  dataFingerprint,
  fixedNow,
  json,
  makeSc,
  purge,
  type Sc,
} from './b5c-fixture.js';

const NOTE_SALVAGE = '未删除任何信号;请重新运行 rsi purge --excluded --write';
const JF = (sc: Sc): string => path.join(sc.s.rsi, 'purge-journal.json');
const ALL_RUNS = ['run-ex', 'run-ok'];
const ALL_PROMOTES = ['promo-ex', 'promo-ok'];

async function withInvalid(prefix: string, o: Parameters<typeof makeSc>[1] = {}): Promise<Sc> {
  const sc = await makeSc(prefix, o);
  await put(sc.s, JF(sc), 'garbage');
  sc.cf.audit.length = 0;
  return sc;
}

const stores = (fp: string[]): string[] =>
  fp.filter(
    (l) =>
      l.startsWith('signals/') ||
      l.startsWith('sessions/') ||
      l.startsWith('cursor.json') ||
      l.startsWith('projects.json'),
  );

async function salvageRef(): Promise<string[]> {
  const sc = await withInvalid('sv-ref-');
  const r = await purge(sc, ['--resume', '--write']);
  expect(r.code, r.err).toBe(0);
  return dataFingerprint(sc.s);
}

const phaseOf = async (sc: Sc): Promise<string> => {
  const r = await readPurgeJournal(sc.s.io);
  return r.state === 'present' ? `${r.journal.mode}:${r.journal.phase}` : r.state;
};

describe('salvage:完整运行', () => {
  it('invalid journal → 0;全部暂存 run / promote 被 taint 且清空;信号 / 会话计数 / cursor / 索引一个字节都不动;journal 已删;清单一致', async () => {
    const sc = await withInvalid('sv-full-', { state: 'stopped' });
    const { s } = sc;
    const before = stores(await dataFingerprint(s));
    expect(before.length, '正向前提:有数据').toBeGreaterThan(5);
    const r = await purge(sc, ['--resume', '--write', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(json(r.out)).toEqual({
      mode: 'resume',
      phase: 'salvaged',
      keys: 0,
      signals: 0,
      session_rows: 0,
      cursor_entries: 0,
      index_entries: 0,
      taint_runs: 2,
      taint_promotes: 2,
      done: true,
    });
    expect(stores(await dataFingerprint(s))).toEqual(before);
    for (const id of ALL_RUNS) {
      expect(await exists(path.join(runDirOf(s, id), 'TAINTED')), id).toBe(true);
      expect(await allText(runDirOf(s, id)), id).not.toContain(EXCERPT_MARK);
    }
    for (const id of ALL_PROMOTES) {
      expect((await listFiles(promoteDirOf(s, id))).sort(), id).toEqual(['TAINTED', 'report.json']);
    }
    expect(await readPurgeJournal(s.io)).toEqual({ state: 'absent' });
    expect(await consistent(s)).toBe(true);
    expect(await readText(path.join(s.rsi, 'STOP'))).toBe(STOP_DOC);
    const text = await purge(sc, ['--resume']); // 已无 journal
    expect(text.code).toBe(4);
    // 文本输出带固定提示
    const sc2 = await withInvalid('sv-text-');
    expect((await purge(sc2, ['--resume', '--write'])).out).toContain(NOTE_SALVAGE);
    // 日志:一行 purged / journal_salvaged
    const lines = (await readText(path.join(s.rsi, 'log.jsonl'))).trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1] as string)).toMatchObject({
      trigger: 'purge',
      action: 'purged',
      code: 'journal_salvaged',
      counts: { runs_tainted: 2, promotes_tainted: 2 },
    });
  });

  it('invalid 的各种形态都走 salvage:salvage 的 keys 非空 / 未知 mode / 阶段越界 / 超大文件', async () => {
    const bodies = [
      JSON.stringify({
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        mode: 'salvage',
        phase: 'planned',
        keys: ['p_aaaaaaaaaaaaaaaa'],
        taint_targets: { runs: [], promotes: [] },
      }),
      JSON.stringify({
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        mode: 'weird',
        phase: 'planned',
        keys: [],
        taint_targets: { runs: [], promotes: [] },
      }),
      JSON.stringify({
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        mode: 'salvage',
        phase: 'indexed',
        keys: [],
        taint_targets: { runs: [], promotes: [] },
      }),
      '',
    ];
    for (const [i, body] of bodies.entries()) {
      const sc = await makeSc(`sv-shape-${i}-`);
      await put(sc.s, JF(sc), body);
      sc.cf.audit.length = 0;
      const dry = json((await purge(sc, ['--resume', '--json'])).out);
      expect(dry, `shape ${i}`).toMatchObject({ phase: 'invalid', taint_runs: 2 });
      const r = await purge(sc, ['--resume', '--write']);
      expect(r.code, `shape ${i}`).toBe(0);
      expect(await phaseOf(sc)).toBe('absent');
    }
  });
});

describe('salvage:每步崩溃 / 失锁都可重入', () => {
  it('每个写点崩溃(k 遍历):崩溃后 journal 要么仍是 invalid、要么是合法 salvage;--resume --write 完成且与基准一致;第二遍 no_journal 零写入;信号不动', async () => {
    const ref = await salvageRef();
    const rec = await withInvalid('sv-k-rec-');
    const ops: string[] = [];
    await purge(rec, ['--resume', '--write'], {
      beforeWrite: (op) => {
        ops.push(op);
        return Promise.resolve();
      },
    });
    expect(ops.length, '正向前提').toBeGreaterThan(25);
    expect(
      ops.filter((o) => o === 'rename:purge-journal').length,
      'S1 / tainted / done 三次 journal 替换',
    ).toBe(3);
    for (let k = 1; k <= ops.length; k++) {
      const sc = await withInvalid(`sv-k-${k}-`);
      const sigBefore = stores(await dataFingerprint(sc.s));
      let n = 0;
      const c = await purge(sc, ['--resume', '--write'], {
        beforeWrite: (op) => {
          void op;
          if (++n === k) return Promise.reject(new CrashError(`k=${k}`));
          return Promise.resolve();
        },
      });
      expect(c.code, `k=${k} ${ops[k - 1]}`).toBe(3);
      const ph = await phaseOf(sc);
      expect(
        ['invalid', 'salvage:planned', 'salvage:tainted', 'salvage:done', 'absent'],
        `k=${k} ${ops[k - 1]}:${ph}`,
      ).toContain(ph);
      // absent = 已在「删 journal」之后崩溃(只剩删临时文件那一步):工作已全部完成
      const r = await purge(sc, ['--resume', '--write']);
      expect(r.code, `k=${k} ${r.err}`).toBe(ph === 'absent' ? 4 : 0);
      expect(await dataFingerprint(sc.s), `k=${k}`).toEqual(ref);
      expect(stores(await dataFingerprint(sc.s)), `k=${k}:信号不动`).toEqual(sigBefore);
      expect(await consistent(sc.s), `k=${k}`).toBe(true);
      sc.cf.audit.length = 0;
      const again = await purge(sc, ['--resume', '--write']);
      expect([again.code, again.err], `k=${k}`).toEqual([4, 'RSI_NOT_RUN reason=no_journal\n']);
      expect(sc.cf.audit, `k=${k}:第二遍零写入`).toEqual([]);
    }
  }, 240_000);

  it('每个写点之前失锁(k 遍历):lock_lost,之后零写入;重新 --resume --write 完成', async () => {
    const ref = await salvageRef();
    const rec = await withInvalid('sv-lk-rec-');
    const ops: string[] = [];
    await purge(rec, ['--resume', '--write'], {
      beforeWrite: (op) => {
        ops.push(op);
        return Promise.resolve();
      },
    });
    for (let k = 1; k <= ops.length; k++) {
      const sc = await withInvalid(`sv-lk-${k}-`);
      let n = 0;
      let at = -1;
      const r = await purge(sc, ['--resume', '--write'], {
        beforeWrite: async () => {
          if (++n === k) {
            at = sc.cf.audit.length;
            await remove(sc.s.f.fx, path.join(sc.s.rsi, 'lock'));
          }
        },
      });
      expect([r.code, r.err], `k=${k} ${ops[k - 1]}`).toEqual([
        3,
        'RSI_FAIL_CLOSED reason=lock_lost\n',
      ]);
      expect(sc.cf.audit.length, `k=${k} ${ops[k - 1]}:失锁之后零写入`).toBe(at);
      const ph = await phaseOf(sc);
      const again = await purge(sc, ['--resume', '--write']);
      expect(again.code, `k=${k} ${ph}`).toBe(ph === 'absent' ? 4 : 0);
      expect(await dataFingerprint(sc.s), `k=${k}`).toEqual(ref);
    }
  }, 240_000);

  it('S1 的 rename 之前崩溃:journal 仍是 invalid(原样);之后崩溃:已是合法 salvage journal,其它写入方报 purge_incomplete 而不是 journal_invalid', async () => {
    const reasonOf = async (sc: Sc): Promise<string> => {
      try {
        await assertNoPurgeInProgress(sc.s.ctx);
      } catch (e) {
        return (e as RsiFailClosedError).reason;
      }
      return 'no-throw';
    };
    const pre = await withInvalid('sv-s1-pre-');
    await purge(pre, ['--resume', '--write'], {
      beforePhase: (st) => {
        if (st === 'salvage_planned') throw new CrashError('x');
      },
    });
    expect(await readText(JF(pre))).toBe('garbage');
    expect(await reasonOf(pre)).toBe('journal_invalid');
    const post = await withInvalid('sv-s1-post-');
    await purge(post, ['--resume', '--write'], {
      beforePhase: (st) => {
        if (st === 'salvage_tainted') throw new CrashError('x');
      },
    });
    expect(await phaseOf(post)).toBe('salvage:planned');
    expect(await reasonOf(post)).toBe('purge_incomplete');
    expect((await detectPurgeJournal(post.s.ctx)).state).toBe('present');
    // 即时闸:journal 在场且 run 尚未被 taint(崩在第一个标记之前)→ fail_closed purge_incomplete
    const early = await withInvalid('sv-s1-gate-');
    await purge(early, ['--resume', '--write'], {
      beforeWrite: (op) =>
        op.startsWith('mark:') ? Promise.reject(new CrashError('x')) : Promise.resolve(),
    });
    const g = await immediateGate(early.s.ctx, { kind: 'judge', runId: 'run-ok' });
    expect(g).toMatchObject({ kind: 'fail_closed', reason: 'purge_incomplete' });
  });

  it('不丢 taint 保证:S1 之后、taint 之前崩溃,任何持锁写入方的 resumeTaint 都能按 salvage journal 推进 taint', async () => {
    const sc = await withInvalid('sv-taint-guarantee-');
    const c = await purge(sc, ['--resume', '--write'], {
      beforeWrite: (op) =>
        op.startsWith('mark:') ? Promise.reject(new CrashError('x')) : Promise.resolve(),
    });
    expect(c.code).toBe(3);
    expect(await phaseOf(sc)).toBe('salvage:planned');
    expect(
      await exists(path.join(runDirOf(sc.s, 'run-ok'), 'TAINTED')),
      '正向前提:还没 taint',
    ).toBe(false);
    await withLock(sc.s, (lock) => resumeTaintWith(sc.s.ctx, lock));
    for (const id of ALL_RUNS)
      expect(await exists(path.join(runDirOf(sc.s, id), 'TAINTED')), id).toBe(true);
    for (const id of ALL_PROMOTES)
      expect(await exists(path.join(promoteDirOf(sc.s, id), 'TAINTED')), id).toBe(true);
    expect((await purge(sc, ['--resume', '--write'])).code).toBe(0);
    expect(await phaseOf(sc)).toBe('absent');
  });
});

describe('salvage:边界', () => {
  it('暂存 run 超过 5000 → 3 staging_too_large(干跑与 --write),journal 仍是原样的 invalid,除锁文件外零写入', async () => {
    const sc = await withInvalid('sv-5000-');
    const { s } = sc;
    const reflect = path.join(s.state, 'reflect');
    for (let i = 0; i < 4999; i++)
      await mkdirp(s.f.fx, path.join(reflect, `bulk-${String(i).padStart(5, '0')}`), 0o755);
    // 4999 + 已有 2 个 = 5001 > 5000
    const dry = await purge(sc, ['--resume']);
    expect([dry.code, dry.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=staging_too_large\n']);
    const w = await purge(sc, ['--resume', '--write']);
    expect([w.code, w.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=staging_too_large\n']);
    expect(await readText(JF(sc))).toBe('garbage');
    expect(sc.cf.audit.filter((a) => a.op !== 'mkdirp').map((a) => a.op)).toEqual([
      'createExclusive',
      'remove',
    ]);
    // 对照:清到 5000 以内 → 完成(前提确实是数量门槛)
    for (let i = 0; i < 3; i++)
      await remove(s.f.fx, path.join(reflect, `bulk-${String(i).padStart(5, '0')}`));
    sc.cf.audit.length = 0;
    expect((await purge(sc, ['--resume', '--write'])).code).toBe(0);
  }, 120_000);

  it('引擎本身也拦 > 5000(不依赖命令层的预检):salvageInvalidJournal 抛 staging_too_large,journal 仍是 invalid、零写入', async () => {
    const sc = await withInvalid('sv-5000-engine-');
    const { s } = sc;
    const reflect = path.join(s.state, 'reflect');
    for (let i = 0; i < 4999; i++) {
      await mkdirp(s.f.fx, path.join(reflect, `bulk-${String(i).padStart(5, '0')}`), 0o755);
    }
    s.audit.length = 0;
    await expect(withLock(s, (lock) => salvageInvalidJournal(s.ctx, lock))).rejects.toMatchObject({
      reason: 'staging_too_large',
    });
    expect(await readText(JF(sc))).toBe('garbage');
    expect(
      s.audit.filter((a) => !a.includes('/lock')).filter((a) => !a.startsWith('mkdirp')),
    ).toEqual([]);
  }, 120_000);

  it('journal unreadable(硬链接)→ 3 purge_incomplete,零写入;不会被 salvage', async () => {
    const sc = await makeSc('sv-unreadable-');
    await put(sc.s, JF(sc), 'garbage');
    await hardlink(sc.s.f.fx, JF(sc), path.join(sc.s.rsi, 'other-name'));
    sc.cf.audit.length = 0;
    for (const argv of [['--resume'], ['--resume', '--write']]) {
      const r = await purge(sc, argv);
      expect([r.code, r.err], argv.join(' ')).toEqual([
        3,
        'RSI_FAIL_CLOSED reason=purge_incomplete\n',
      ]);
    }
    expect(sc.cf.audit).toEqual([]);
    expect(await readText(JF(sc))).toBe('garbage');
  });
});

describe('purge 进行中的联动', () => {
  it('journal 在场期间:新建暂存的写入方 assertNoPurgeInProgress → purge_incomplete;即时闸 → fail_closed purge_incomplete;status 的 journal 探测为 present', async () => {
    const sc = await makeSc('lk-others-');
    const c = await purge(sc, ['--excluded', '--write'], {
      beforePhase: (st) => {
        if (st === 'tainted') throw new CrashError('x');
      },
    });
    expect(c.code).toBe(3);
    await expect(assertNoPurgeInProgress(sc.s.ctx)).rejects.toMatchObject({
      reason: 'purge_incomplete',
    });
    expect(await immediateGate(sc.s.ctx, { kind: 'judge', runId: 'run-ok' })).toMatchObject({
      kind: 'fail_closed',
      reason: 'purge_incomplete',
    });
    expect(await detectPurgeJournal(sc.s.ctx)).toEqual({ state: 'present', phase: 'planned' });
  });

  it('STOP 与 journal 都不在快照清单里:journal 在场时、删掉 journal 之后、删掉 STOP 之后,inspectSnapshot 仍是 consistent', async () => {
    const sc = await makeSc('lk-manifest-', { state: 'stopped' });
    const c = await purge(sc, ['--excluded', '--write'], {
      beforePhase: (st) => {
        if (st === 'tainted') throw new CrashError('x');
      },
    });
    expect(c.code).toBe(3);
    const insp = (): Promise<string> => inspectSnapshot(sc.s.io, productionSnapshotValidator);
    expect(await exists(JF(sc)), '正向前提:journal 在场').toBe(true);
    expect(await exists(path.join(sc.s.rsi, 'STOP')), '正向前提:STOP 在场').toBe(true);
    expect(await insp()).toBe('consistent');
    expect((await purge(sc, ['--resume', '--write'])).code).toBe(0);
    expect(await exists(JF(sc))).toBe(false);
    expect(await insp()).toBe('consistent');
    await remove(sc.s.f.fx, path.join(sc.s.rsi, 'STOP'));
    expect(await insp()).toBe('consistent');
  });
});

describe('tick 与 purge journal(R20-3.8.5 ②;替换 B5a 的临时 fail-closed)', () => {
  const tick = (sc: Sc, argv: string[] = ['--write']): ReturnType<typeof runCmd> =>
    runCmd(sc.cf, runTick, argv, { now: fixedNow });

  it('confirmed + 合规 journal(崩在 signals_rewritten 之后)→ tick --write 先续做完成再采集:journal 已删,K 已清', async () => {
    const sc = await makeSc('tk-resume-', { state: 'confirmed' });
    const c = await purge(sc, ['--excluded', '--write'], {
      beforePhase: (st) => {
        if (st === 'indexed') throw new CrashError('x');
      },
    });
    expect(c.code).toBe(3);
    expect(await phaseOf(sc)).toBe('purge:signals_rewritten');
    const r = await tick(sc);
    expect(r.code, r.err).toBe(0);
    expect(await phaseOf(sc)).toBe('absent');
    const idx = JSON.parse(await readText(path.join(sc.s.rsi, 'projects.json'))) as {
      entries: { key: string }[];
    };
    expect(idx.entries.map((e) => e.key).sort()).not.toContain('p_aaaaaaaaaaaaaaaa');
    expect(await consistent(sc.s)).toBe(true);
  });

  it('confirmed + salvage journal(崩在 S2 之前)→ tick 续做完成(salvage 也能被 resumePurgeUnderLock 分派)', async () => {
    const sc = await withInvalid('tk-salvage-resume-', { state: 'confirmed' });
    const c = await purge(sc, ['--resume', '--write'], {
      beforeWrite: (op) =>
        op.startsWith('mark:') ? Promise.reject(new CrashError('x')) : Promise.resolve(),
    });
    expect(c.code).toBe(3);
    expect(await phaseOf(sc)).toBe('salvage:planned');
    const r = await tick(sc);
    expect(r.code, r.err).toBe(0);
    expect(await phaseOf(sc)).toBe('absent');
    for (const id of ALL_RUNS)
      expect(await exists(path.join(runDirOf(sc.s, id), 'TAINTED')), id).toBe(true);
  });

  it('confirmed + invalid journal → tick 不做 salvage:3 journal_invalid,journal 字节不变(后台不得静默清空暂存摘录)', async () => {
    const sc = await withInvalid('tk-invalid-', { state: 'confirmed' });
    const keepOk = await allText(runDirOf(sc.s, 'run-ok'));
    const r = await tick(sc);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=journal_invalid\n']);
    expect(await readText(JF(sc))).toBe('garbage');
    expect(await allText(runDirOf(sc.s, 'run-ok'))).toBe(keepOk);
  });

  it('confirmed + 合规 journal 但续做失败(digests 目录在场)→ tick 报 3 purge_incomplete(契约:其它写入方遇到无法完成的 journal);journal 保留', async () => {
    const sc = await makeSc('tk-resume-fail-', { state: 'confirmed' });
    const c = await purge(sc, ['--excluded', '--write'], {
      beforePhase: (st) => {
        if (st === 'tainted') throw new CrashError('x');
      },
    });
    expect(c.code).toBe(3);
    await mkdirp(sc.s.f.fx, path.join(sc.s.rsi, 'digests'), 0o700);
    const r = await tick(sc);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=purge_incomplete\n']);
    expect(await phaseOf(sc)).toBe('purge:planned');
  });

  it('armed + 合规 journal → tick 不续做 purge(自动写禁令:armed 下只补 taint),journal 保留,退出 0', async () => {
    const sc = await makeSc('tk-armed-');
    const c = await purge(sc, ['--excluded', '--write'], {
      beforePhase: (st) => {
        if (st === 'tainted') throw new CrashError('x');
      },
    });
    expect(c.code).toBe(3);
    const r = await tick(sc);
    expect(r.code, r.err).toBe(0);
    expect(await phaseOf(sc)).toBe('purge:planned');
  });
});
