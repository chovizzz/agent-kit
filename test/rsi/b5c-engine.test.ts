/**
 * R20-A2 B5c:purge 阶段机(`services/purge-engine.ts`)。覆盖方案 §11「R20-3.8.4」「§0.5 R5 done」「R20-4.7 taint 时机」「失锁」中归 B5c 的行:
 * 五阶段每阶段崩溃后续做完成且结果相同、每个月文件重写写点崩溃、每个写点失锁 k 遍历零写入、`done` 阶段只 commit + 删 journal(不重写月文件)、
 * 续做按 journal 已记下的集合(不重推)、taint 完整(promote.patch / pr-body.md)、月文件永不删除。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RsiPurgeJournalSchema } from '../../src/contracts/rsi.js';
import { exists, lstat, readBytes, readText } from '../../src/io/read-fs.js';
import { mkdirp, remove } from '../../src/io/safe-fs.js';
import { commitSnapshot } from '../../src/rsi/snapshot.js';
import { recoverUnderLock } from '../../src/rsi/services/commit.js';
import {
  resumePurgeUnderLock,
  runPurgeUnderLock,
  type PurgeDeps,
  type PurgeResult,
} from '../../src/rsi/services/purge-engine.js';
import { readPurgeJournal, writePurgeJournal } from '../../src/rsi/services/purge-journal.js';
import { planPurgeTargets } from '../../src/rsi/services/purge-plan.js';
import { resumeTaintWith } from '../../src/rsi/services/taint.js';
import { RsiFailClosedError } from '../../src/rsi/types.js';
import { rewriteMonthFileWithout } from '../../src/signals/store-rewrite.js';
import { listMonthFiles, projectKeyOf } from '../../src/signals/store-scan.js';
import {
  CrashError,
  KEY_A,
  KEY_B,
  KEY_C,
  allText,
  crashAt,
  listFiles,
  promoteDirOf,
  put,
  runDirOf,
  signalObj,
  withLock,
  EXCERPT_MARK,
} from './services-fixture.js';
import { KEY_D, consistent, dataFingerprint, makeSc, sid, type Sc } from './b5c-fixture.js';

const KEYS = [KEY_A, KEY_D].sort();

/** 在锁内跑一次完整的新 purge(与命令同序:recover → resumeTaint → 规划 → 引擎) */
async function runFull(sc: Sc, deps: PurgeDeps = {}): Promise<PurgeResult> {
  const { s } = sc;
  return withLock(s, async (lock) => {
    await recoverUnderLock(s.ctx, lock);
    await resumeTaintWith(s.ctx, lock);
    const targets = await planPurgeTargets(s.io, KEYS);
    return runPurgeUnderLock(s.ctx, lock, { keys: KEYS, targets }, deps);
  });
}

async function resume(sc: Sc, deps: PurgeDeps = {}): Promise<PurgeResult> {
  const { s } = sc;
  return withLock(s, async (lock) => {
    await recoverUnderLock(s.ctx, lock);
    await resumeTaintWith(s.ctx, lock);
    return resumePurgeUnderLock(s.ctx, lock, deps);
  });
}

async function reference(): Promise<string[]> {
  const ref = await makeSc('eng-ref-');
  await runFull(ref);
  return dataFingerprint(ref.s);
}

const phaseOf = async (sc: Sc): Promise<string> => {
  const r = await readPurgeJournal(sc.s.io);
  return r.state === 'present' ? r.journal.phase : r.state;
};

describe('五阶段:完整运行', () => {
  it('结果计数、文件内容、taint、索引 / cursor / counts、清单一致、journal 已删', async () => {
    const sc = await makeSc('eng-full-');
    const { s } = sc;
    const keepRun = await allText(runDirOf(s, 'run-ok'));
    const keepPromo = await allText(promoteDirOf(s, 'promo-ok'));
    const before = {
      signals: await listMonthFiles(s.io, 'signals'),
      sessions: await listMonthFiles(s.io, 'sessions'),
    };
    const r = await runFull(sc);
    expect(r).toEqual({
      keys: 2,
      signalsRemoved: 4,
      sessionRowsRemoved: 2,
      cursorRemoved: 2,
      indexRemoved: 2,
      runsTainted: 1,
      promotesTainted: 1,
    });
    // 月文件永不删除:文件清单与之前相同(202609 的信号库只含 A,被重写成空文件)
    expect(await listMonthFiles(s.io, 'signals')).toEqual(before.signals);
    expect(await listMonthFiles(s.io, 'sessions')).toEqual(before.sessions);
    const sig09 = path.join(s.state, 'signals', 'claude', '202609.jsonl');
    expect(await exists(sig09)).toBe(true);
    expect((await readBytes(sig09)).length).toBe(0);
    const sig10 = (await readText(path.join(s.state, 'signals', 'claude', '202610.jsonl')))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => (JSON.parse(l) as { sig_id: string }).sig_id);
    expect(sig10).toEqual([`sig_${sid(4)}`, `sig_${sid(6)}`, `sig_${sid(7)}`]); // 原顺序
    // cursor / 索引
    const cursor = JSON.parse(await readText(path.join(s.rsi, 'cursor.json'))) as {
      files: Record<string, { project_key: string | null }>;
    };
    expect(
      Object.values(cursor.files)
        .map((f) => f.project_key)
        .sort(),
    ).toEqual([KEY_B, null].sort());
    const index = JSON.parse(await readText(path.join(s.rsi, 'projects.json'))) as {
      generation: number;
      entries: { key: string }[];
    };
    expect(index.entries.map((e) => e.key)).toEqual([KEY_B, KEY_C]);
    expect(index.generation).toBe(2);
    // counts:四段重算,A / D 不再出现
    const counts = JSON.parse(await readText(path.join(s.rsi, 'counts.json'))) as {
      per_key: Record<string, unknown>;
    };
    expect(Object.keys(counts.per_key).sort()).toEqual([KEY_B, KEY_C]);
    // taint:run-ex 全部摘录为空、apply.patch 没了;promo-ex 只剩 TAINTED 与 report.json(promote.patch / pr-body.md 被删)
    expect(await allText(runDirOf(s, 'run-ex'))).not.toContain(EXCERPT_MARK);
    expect(await exists(path.join(runDirOf(s, 'run-ex'), 'TAINTED'))).toBe(true);
    expect(await exists(path.join(runDirOf(s, 'run-ex'), 'apply.patch'))).toBe(false);
    expect((await listFiles(promoteDirOf(s, 'promo-ex'))).sort()).toEqual([
      'TAINTED',
      'report.json',
    ]);
    // 未命中的 run / promote 字节不变
    expect(await allText(runDirOf(s, 'run-ok'))).toBe(keepRun);
    expect(await allText(promoteDirOf(s, 'promo-ok'))).toBe(keepPromo);
    expect(keepRun).toContain(EXCERPT_MARK); // 正向前提:run-ok 确有摘录
    // journal 已删;清单一致;state.json 没被写
    expect(await readPurgeJournal(s.io)).toEqual({ state: 'absent' });
    expect(await consistent(s)).toBe(true);
    expect(await exists(path.join(s.rsi, 'state.json'))).toBe(false);
    // 日志:一行 purged,counts 全是整数
    const lines = (await readText(path.join(s.rsi, 'log.jsonl'))).trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    expect(last).toMatchObject({ trigger: 'purge', action: 'purged', code: 'ok' });
    expect(last['counts']).toEqual({
      keys: 2,
      signals_removed: 4,
      session_rows_removed: 2,
      cursor_removed: 2,
      index_removed: 2,
      runs_tainted: 1,
      promotes_tainted: 1,
    });
  });

  it('写点顺序:月文件 → cursor → 索引 → counts → 清单 → journal done → 删 journal;journal 先于一切删除(planned 最早)', async () => {
    const sc = await makeSc('eng-order-');
    const names: string[] = [];
    await runFull(sc, { hooks: { point: (n) => void names.push(n) } });
    const at = (n: string): number => names.indexOf(n);
    const firstMonth = names.findIndex((n) => n.startsWith('before:month:'));
    const lastMonth = names.map((n) => n.startsWith('before:month:')).lastIndexOf(true);
    expect(at('before:rename:purge-journal')).toBeLessThan(firstMonth); // planned 先写
    expect(lastMonth).toBeLessThan(at('before:rename:cursor.json'));
    expect(at('before:rename:cursor.json')).toBeLessThan(at('before:rename:projects.json'));
    expect(at('before:rename:projects.json')).toBeLessThan(at('before:rename:counts.json'));
    expect(at('before:rename:counts.json')).toBeLessThan(at('before:snapshot-rename'));
    expect(at('before:snapshot-rename')).toBeLessThan(at('before:remove:purge-journal'));
    // journal 共 5 次 rename:planned / tainted / signals_rewritten / indexed / done
    expect(names.filter((n) => n === 'before:rename:purge-journal').length).toBe(5);
    expect(names.filter((n) => n.startsWith('before:month:') && n.endsWith(':rename')).length).toBe(
      4,
    );
  });

  it('journal 内容(planned):mode / phase / keys / taint_targets 升序,合规 schema,0600', async () => {
    const sc = await makeSc('eng-journal-');
    await expect(
      runFull(sc, {
        beforeWrite: (stage) => {
          if (stage === 'tainted') throw new CrashError('x');
        },
      }),
    ).rejects.toBeInstanceOf(CrashError);
    const r = await readPurgeJournal(sc.s.io);
    if (r.state !== 'present') throw new Error('journal 应在场');
    expect(RsiPurgeJournalSchema.safeParse(r.journal).success).toBe(true);
    expect(r.journal).toMatchObject({
      mode: 'purge',
      phase: 'planned',
      keys: KEYS,
      taint_targets: { runs: ['run-ex'], promotes: ['promo-ex'] },
    });
    expect(
      ((await lstat(path.join(sc.s.rsi, 'purge-journal.json'))).mode & 0o777).toString(8),
    ).toBe('600');
  });
});

describe('每阶段崩溃后续做完成,结果与不崩溃相同', () => {
  const stages: [string, string][] = [
    ['planned', 'absent'], // journal 写入之前崩溃:没有 journal
    ['tainted', 'planned'],
    ['signals_rewritten', 'tainted'],
    ['indexed', 'signals_rewritten'],
    ['done', 'indexed'], // commit 之后、journal 写 done 之前
  ];
  for (const [stage, expectPhase] of stages) {
    it(`崩在「${stage}」阶段结束、写 journal 之前 → journal 阶段 = ${expectPhase};续做完成,数据与基准一致,清单一致`, async () => {
      const ref = await reference();
      const sc = await makeSc(`eng-crash-${stage}-`);
      await expect(
        runFull(sc, {
          beforeWrite: (st) => {
            if (st === stage) throw new CrashError(stage);
          },
        }),
      ).rejects.toBeInstanceOf(CrashError);
      expect(await phaseOf(sc), '崩溃后的 journal 阶段').toBe(expectPhase);
      if (expectPhase === 'absent') {
        await runFull(sc); // 没有 journal:重新发起即可
      } else {
        await resume(sc);
      }
      expect(await dataFingerprint(sc.s)).toEqual(ref);
      expect(await readPurgeJournal(sc.s.io)).toEqual({ state: 'absent' });
      expect(await consistent(sc.s)).toBe(true);
    });
  }

  it('崩在 journal 写 done 之后、删除之前 → 续做只 commit + 删 journal,结果一致', async () => {
    const ref = await reference();
    const sc = await makeSc('eng-crash-prerm-');
    await expect(
      runFull(sc, { hooks: crashPoint('before:remove:purge-journal') }),
    ).rejects.toBeInstanceOf(CrashError);
    expect(await phaseOf(sc)).toBe('done');
    await resume(sc);
    expect(await dataFingerprint(sc.s)).toEqual(ref);
    expect(await phaseOf(sc)).toBe('absent');
  });
});

function crashPoint(name: string, nth = 1): { point: (n: string) => void } {
  const c = crashAt(name, nth);
  return { point: c.point };
}

describe('月文件每个写点崩溃 / 失锁', () => {
  it('第 k 个月文件写点崩溃:cursor / 索引此刻仍是原样(信号库先于 cursor),续做完成且与基准一致', async () => {
    const ref = await reference();
    const rec = await makeSc('eng-mk-rec-');
    const names: string[] = [];
    await runFull(rec, { hooks: { point: (n) => void names.push(n) } });
    const months = names.filter((n) => n.startsWith('before:month:'));
    expect(months.length, '正向前提:4 个有命中的月文件;全删光的 2 个没有追加写点,共 3+3+4+4').toBe(
      14,
    );
    for (let k = 1; k <= months.length; k++) {
      const sc = await makeSc(`eng-mk-${k}-`);
      const cursorBefore = await readText(path.join(sc.s.rsi, 'cursor.json'));
      const indexBefore = await readText(path.join(sc.s.rsi, 'projects.json'));
      let n = 0;
      await expect(
        runFull(sc, {
          hooks: {
            point: (name) => {
              if (name.startsWith('before:month:') && ++n === k) throw new CrashError(`k=${k}`);
            },
          },
        }),
      ).rejects.toBeInstanceOf(CrashError);
      expect(await phaseOf(sc), `k=${k}`).toBe('tainted');
      expect(await readText(path.join(sc.s.rsi, 'cursor.json')), `k=${k}`).toBe(cursorBefore);
      expect(await readText(path.join(sc.s.rsi, 'projects.json')), `k=${k}`).toBe(indexBefore);
      await resume(sc);
      expect(await dataFingerprint(sc.s), `k=${k}`).toEqual(ref);
      expect(await consistent(sc.s), `k=${k}`).toBe(true);
    }
  }, 180_000);

  it('每个写点(含 recover / 标记 / 月文件 / cursor / 索引 / counts / 日志 / 清单 / journal)之前失锁 → lock_lost,之后零写入;续做完成且一致', async () => {
    const ref = await reference();
    const rec = await makeSc('eng-lk-rec-');
    const names: string[] = [];
    await runFull(rec, { hooks: { point: (n) => void names.push(n) } });
    const before = names.filter((n) => n.startsWith('before:'));
    expect(before.length, '正向前提:写点清单足够长').toBeGreaterThan(40);
    for (let k = 1; k <= before.length; k++) {
      const sc = await makeSc(`eng-lk-${k}-`);
      let n = 0;
      let auditAtLoss = -1;
      const deps: PurgeDeps = {
        hooks: {
          point: async (name) => {
            if (name.startsWith('before:') && ++n === k) {
              auditAtLoss = sc.s.audit.length;
              await remove(sc.s.f.fx, path.join(sc.s.rsi, 'lock')); // 失锁:下一次 assertHeld 抛错
            }
          },
        },
      };
      let thrown: unknown;
      try {
        await runFull(sc, deps);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `k=${k} ${before[k - 1]}`).toBeDefined();
      expect(auditAtLoss, `k=${k}`).toBeGreaterThanOrEqual(0);
      expect(sc.s.audit.length, `k=${k} ${before[k - 1]}:失锁之后零写入`).toBe(auditAtLoss);
      // 重新拿锁续做 / 重新发起,最终与基准一致
      await mkdirp(sc.s.f.fx, sc.s.rsi, 0o700);
      const ph = await phaseOf(sc);
      if (ph === 'absent' || ph === 'invalid') {
        if (ph === 'invalid') throw new Error(`k=${k}:journal 不应处于 invalid`);
        await runFull(sc);
      } else await resume(sc);
      expect(await dataFingerprint(sc.s), `k=${k}`).toEqual(ref);
      expect(await consistent(sc.s), `k=${k}`).toBe(true);
    }
  }, 240_000);
});

describe('§0.5 R5 done 阶段不变量', () => {
  it('journal 在 done 阶段时续做:只有日志追加 / 清单 rename / journal 删除;不碰月文件、cursor、索引、counts(重新放回一条命中行也不会被删)', async () => {
    const sc = await makeSc('eng-done-');
    const { s } = sc;
    await expect(
      runFull(sc, { hooks: crashPoint('before:remove:purge-journal') }),
    ).rejects.toBeInstanceOf(CrashError);
    expect(await phaseOf(sc)).toBe('done');
    // 重新放回一条 K 的信号:done 阶段若重扫月文件就会把它删掉
    const f = path.join(s.state, 'signals', 'claude', '202610.jsonl');
    const text = await readText(f);
    const extra = `${JSON.stringify(signalObj(sid(9), KEY_A))}\n`;
    await put(s, f, text + extra);
    const files0 = await dataFingerprint(s);
    s.audit.length = 0;
    await resume(sc);
    expect(await readText(f)).toBe(text + extra);
    expect((await dataFingerprint(s)).filter((l) => l.startsWith('signals/'))).toEqual(
      files0.filter((l) => l.startsWith('signals/')),
    );
    const touched = s.audit.map((a) => path.basename(a.split(' ').slice(1).join(' ')));
    for (const bad of [
      'cursor.json',
      'projects.json',
      'counts.json',
      '202610.jsonl',
      '202609.jsonl',
    ]) {
      expect(touched, bad).not.toContain(bad);
    }
    const ops = s.audit.map((a) => a.split(' ')[0]);
    expect(ops).toContain('appendFile'); // 日志
    expect(s.audit.some((a) => a.includes('snapshot.json'))).toBe(true);
    expect(s.audit.some((a) => a.startsWith('remove ') && a.includes('purge-journal.json'))).toBe(
      true,
    );
    expect(await readPurgeJournal(s.io)).toEqual({ state: 'absent' });
  });
});

describe('续做按 journal 已记下的集合,不从信号库重推(R20-3.8.4)', () => {
  it('journal(planned)列出的 run / promote 在信号已被删光之后仍被 taint 并清理', async () => {
    const sc = await makeSc('eng-journal-set-');
    const { s } = sc;
    const targets = await planPurgeTargets(s.io, KEYS);
    expect(targets.runs, '正向前提:此刻能推出 run-ex').toEqual(['run-ex']);
    // 先把 K 的信号全部删掉(模拟「信号已删、journal 还在 planned」),此后从信号库再推只会得到空集
    for (const kind of ['signals', 'sessions'] as const) {
      for (const f of await listMonthFiles(s.io, kind)) {
        await rewriteMonthFileWithout(s.io, f, new Set(KEYS), projectKeyOf, () =>
          Promise.resolve(),
        );
      }
    }
    expect((await planPurgeTargets(s.io, KEYS)).runs, '对照:现在重推得到空集').toEqual([]);
    await withLock(s, (lock) =>
      writePurgeJournal(s.ctx, lock, {
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        mode: 'purge',
        phase: 'planned',
        keys: KEYS,
        taint_targets: { runs: targets.runs, promotes: targets.promotes },
      }),
    );
    // 直接调引擎(不先跑 resumeTaint:它本身就是按 journal 的,会遮住「引擎从信号库重推」这类缺陷)
    await withLock(s, async (lock) => {
      await recoverUnderLock(s.ctx, lock);
      await resumePurgeUnderLock(s.ctx, lock);
    });
    expect(await exists(path.join(runDirOf(s, 'run-ex'), 'TAINTED'))).toBe(true);
    expect(await allText(runDirOf(s, 'run-ex'))).not.toContain(EXCERPT_MARK);
    expect((await listFiles(promoteDirOf(s, 'promo-ex'))).sort()).toEqual([
      'TAINTED',
      'report.json',
    ]);
    expect(await exists(path.join(runDirOf(s, 'run-ok'), 'TAINTED'))).toBe(false);
  });
});

describe('边界与拒绝', () => {
  it('新 purge 遇到已有 journal(合规 / invalid)→ purge_incomplete / journal_invalid,零写入', async () => {
    const sc = await makeSc('eng-q-j-');
    await expect(
      runFull(sc, {
        beforeWrite: (st) => {
          if (st === 'tainted') throw new CrashError('x');
        },
      }),
    ).rejects.toBeInstanceOf(CrashError);
    sc.s.audit.length = 0;
    const reasonOf = async (): Promise<string> => {
      try {
        await withLock(sc.s, (lock) =>
          runPurgeUnderLock(sc.s.ctx, lock, {
            keys: KEYS,
            targets: { keys: KEYS, runs: [], promotes: [] },
          }),
        );
      } catch (e) {
        return (e as RsiFailClosedError).reason;
      }
      return 'no-throw';
    };
    expect(await reasonOf()).toBe('purge_incomplete');
    await put(sc.s, path.join(sc.s.rsi, 'purge-journal.json'), '{"nope":1}');
    sc.s.audit.length = 0;
    expect(await reasonOf()).toBe('journal_invalid');
    // 只有锁文件的建 / 删(withLock)
    expect(sc.s.audit.map((a) => a.split(' ')[0]).filter((o) => o !== 'mkdirp')).toEqual([
      'createExclusive',
      'remove',
    ]);
  });

  it('resume:journal absent → internal;invalid → journal_invalid;unreadable(目录冒充)→ purge_incomplete', async () => {
    const sc = await makeSc('eng-resume-bad-');
    const reasonOf = async (): Promise<string> => {
      try {
        await withLock(sc.s, (lock) => resumePurgeUnderLock(sc.s.ctx, lock));
      } catch (e) {
        return (e as RsiFailClosedError).reason;
      }
      return 'no-throw';
    };
    expect(await reasonOf()).toBe('internal');
    await put(sc.s, path.join(sc.s.rsi, 'purge-journal.json'), 'garbage');
    expect(await reasonOf()).toBe('journal_invalid');
    await remove(sc.s.f.fx, path.join(sc.s.rsi, 'purge-journal.json'));
    await mkdirp(sc.s.f.fx, path.join(sc.s.rsi, 'purge-journal.json'), 0o700);
    expect(await reasonOf()).toBe('purge_incomplete');
  });

  it('.state/rsi/digests/ 在场(P0 没有它的清理实现)→ internal,journal 都不写', async () => {
    const sc = await makeSc('eng-digests-');
    await mkdirp(sc.s.f.fx, path.join(sc.s.rsi, 'digests'), 0o700);
    sc.s.audit.length = 0;
    await expect(runFull(sc)).rejects.toMatchObject({ reason: 'internal' });
    expect(await readPurgeJournal(sc.s.io)).toEqual({ state: 'absent' });
    // 写审计里没有 journal 与月文件的写(recover / resumeTaint 无事可做)
    expect(sc.s.audit.filter((a) => a.includes('purge-journal') || a.includes('.jsonl'))).toEqual(
      [],
    );
  });

  it('索引无效:跳过索引阶段(不改 projects.json),其余阶段照常完成', async () => {
    const sc = await makeSc('eng-idx-bad-');
    await put(sc.s, path.join(sc.s.rsi, 'projects.json'), '{"nope":1}');
    const r = await runFull(sc);
    expect(r.indexRemoved).toBe(0);
    expect(r.signalsRemoved).toBe(4);
    expect(await readText(path.join(sc.s.rsi, 'projects.json'))).toBe('{"nope":1}');
    expect(await phaseOf(sc)).toBe('absent');
  });

  it('没有 cursor / 没有命中月文件:各阶段空转完成', async () => {
    const sc = await makeSc('eng-nocursor-');
    await remove(sc.s.f.fx, path.join(sc.s.rsi, 'cursor.json'));
    await withLock(sc.s, (lock) => commitSnapshot(sc.s.io, lock)); // 清单跟上(cursor 缺失而清单有它 = 损坏)
    const targets = await planPurgeTargets(sc.s.io, [KEY_C]);
    const r = await withLock(sc.s, async (lock) => {
      await recoverUnderLock(sc.s.ctx, lock);
      return runPurgeUnderLock(sc.s.ctx, lock, { keys: [KEY_C], targets });
    });
    expect(r).toMatchObject({
      keys: 1,
      signalsRemoved: 1,
      sessionRowsRemoved: 1,
      cursorRemoved: 0,
      indexRemoved: 1,
    });
  });
});
