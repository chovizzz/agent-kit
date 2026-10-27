/**
 * R20-A2 B3c:持锁提交 / 快照服务(R20-4.5 / R20-5.6 / R20-6.9)与锁内顺序。对着真实目录、真实锁、真实快照清单。
 *  - counts 投影是**目标值语义**;
 *  - 日志先于清单、清单是最后一步;坏数据不被清单背书;
 *  - 每个写点各丢一次锁 / 各崩一次,重跑幂等。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_COUNTS_MAX_STAGED, RsiCountsSchema } from '../../src/contracts/rsi.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { remove, rename as safeRename, writeFile } from '../../src/io/safe-fs.js';
import { DEFAULT_MIN_RETRY_SESSIONS } from '../../src/reflect/cluster.js';
import { loadRsiConfig } from '../../src/rsi/config.js';
import { privacyGate } from '../../src/rsi/gate.js';
import { RsiLockError } from '../../src/rsi/lock.js';
import {
  RSI_CLUSTER_MIN_DEFAULT,
  commitUnderLock,
  commitUnderLockWith,
  recoverUnderLock,
  writeCountsProjection,
  writeCountsProjectionWith,
} from '../../src/rsi/services/commit.js';
import { immediateGate } from '../../src/rsi/services/immediate-gate.js';
import { resumeTaint } from '../../src/rsi/services/taint.js';
import { RsiSnapshotError, inspectSnapshot, readSnapshot } from '../../src/rsi/snapshot.js';
import { RsiFailClosedError, type RsiServiceCtx } from '../../src/rsi/types.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { withRsiLockIfGated } from '../../src/rsi/with-lock.js';
import {
  CrashError,
  KEY_A,
  KEY_B,
  SALT,
  SALT_FP,
  addSignals,
  countsDoc,
  crashAt,
  makeSvc,
  put,
  runDirOf,
  stageRun,
  withLock,
  writeCountsRaw,
  type Svc,
} from './services-fixture.js';

const STATE_DOC = {
  schema_version: 1,
  confirm: null,
  projects_ack_generation: 0,
  attempt: null,
  last_tick: null,
  consecutive_failures: 0,
  breaker: null,
};
const CURSOR_DOC = {
  schema_version: 1,
  fingerprint: createHash('sha256').update('fp').digest('hex'),
  full_scan: { epoch: 0, started_at: null, done: false, last_completed_at: null },
  files: {},
};

const countsFile = (s: Svc): string => path.join(s.rsi, 'counts.json');
const logFile = (s: Svc): string => path.join(s.rsi, 'log.jsonl');
const snapFile = (s: Svc): string => path.join(s.rsi, 'snapshot.json');
const readCounts = async (s: Svc): Promise<ReturnType<typeof RsiCountsSchema.parse>> =>
  RsiCountsSchema.parse(JSON.parse(await readText(countsFile(s))));
const staged = (
  id: string,
  evidence: string[] = [KEY_A],
): { run_id: string; proposals: number; evidence_keys: string[]; tainted: boolean } => ({
  run_id: id,
  proposals: 1,
  evidence_keys: evidence,
  tainted: false,
});
const perKey = (
  n: number,
): Record<
  string,
  { signals_total: number; sessions: number; signals_by_day: Record<string, number> }
> => ({
  [KEY_A]: { signals_total: n, sessions: 1, signals_by_day: { '2026-10-26': n } },
});
/** 审计里去掉锁文件自身的写(拿锁 / 释放锁) */
const noLock = (a: readonly string[]): string[] => a.filter((x) => !x.endsWith('/lock'));

describe('writeCountsProjection:目标值语义(R20-4.5)', () => {
  it('重复提交同一份输入不重复累加;generation 推进;没给的段保留;给了(含空)的段整段替换', async () => {
    const s = await makeSvc('counts-target-');
    const input = { staged: [staged('run-a')], perKey: perKey(5), unknownKeysSignals: 3 };
    await withLock(s, (l) => writeCountsProjection(s.ctx, l, input));
    const c1 = await readCounts(s);
    expect(c1.generation).toBe(1);
    expect(c1.salt_fp).toBe(SALT_FP);
    expect(c1.computed_at).toBe('2026-10-26T12:00:00.000Z');
    expect(c1.staged.map((x) => x.run_id)).toEqual(['run-a']);
    await withLock(s, (l) => writeCountsProjection(s.ctx, l, input));
    const c2 = await readCounts(s);
    expect(c2.generation).toBe(2);
    expect({ ...c2, generation: 0, computed_at: '' }).toEqual({
      ...c1,
      generation: 0,
      computed_at: '',
    }); // 业务投影相同,不累加
    expect(c2.per_key[KEY_A]?.signals_total).toBe(5);
    expect(c2.unknown_keys_signals).toBe(3);
    // 只给 clusters:其它段保留
    const clusters = [{ cluster_id: 'c1', evidence_by_key: { [KEY_A]: 2 } }];
    await withLock(s, (l) => writeCountsProjection(s.ctx, l, { clusters }));
    const c3 = await readCounts(s);
    expect(c3.clusters).toEqual(clusters);
    expect(c3.staged.map((x) => x.run_id)).toEqual(['run-a']);
    expect(c3.per_key[KEY_A]?.signals_total).toBe(5);
    // 整段替换:空数组 / 空对象 / 0 都是「给了」,必须清空旧值
    await withLock(s, (l) =>
      writeCountsProjection(s.ctx, l, { staged: [], perKey: {}, unknownKeysSignals: 0 }),
    );
    const c4 = await readCounts(s);
    expect(c4.staged).toEqual([]);
    expect(c4.per_key).toEqual({});
    expect(c4.unknown_keys_signals).toBe(0);
    expect(c4.clusters).toEqual(clusters); // 没给的 clusters 仍保留
    expect(c4.generation).toBe(4);
  });

  it('cluster_min:首次取 reflect 干跑门槛常量(两个常量钉住相等),之后保留现值', async () => {
    expect(RSI_CLUSTER_MIN_DEFAULT).toBe(DEFAULT_MIN_RETRY_SESSIONS);
    const s = await makeSvc('counts-min-');
    await withLock(s, (l) => writeCountsProjection(s.ctx, l, {}));
    expect((await readCounts(s)).cluster_min).toBe(RSI_CLUSTER_MIN_DEFAULT);
    await writeCountsRaw(s, countsDoc(SALT_FP, { cluster_min: 7 }));
    await withLock(s, (l) => writeCountsProjection(s.ctx, l, { staged: [] }));
    expect((await readCounts(s)).cluster_min).toBe(7);
  });

  it('前置条件:盐缺失 / 盐权限宽 / 盐格式非法 → salt_invalid(不回退到旧 counts);现有 counts 损坏 → counts_invalid', async () => {
    const s = await makeSvc('counts-pre-', { salt: false });
    await expect(withLock(s, (l) => writeCountsProjection(s.ctx, l, {}))).rejects.toMatchObject({
      reason: 'salt_invalid',
    });
    await writeCountsRaw(s, countsDoc());
    await expect(withLock(s, (l) => writeCountsProjection(s.ctx, l, {}))).rejects.toMatchObject({
      reason: 'salt_invalid',
    }); // 有旧 counts 也不回退
    const saltFile = path.join(s.state, 'salt');
    await put(s, saltFile, SALT, 0o644);
    await expect(withLock(s, (l) => writeCountsProjection(s.ctx, l, {}))).rejects.toMatchObject({
      reason: 'salt_invalid',
    });
    await put(s, saltFile, 'zz', 0o600);
    await expect(withLock(s, (l) => writeCountsProjection(s.ctx, l, {}))).rejects.toMatchObject({
      reason: 'salt_invalid',
    });
    await put(s, saltFile, SALT, 0o600);
    await put(s, countsFile(s), '{broken');
    await expect(withLock(s, (l) => writeCountsProjection(s.ctx, l, {}))).rejects.toMatchObject({
      reason: 'counts_invalid',
    });
  });

  it('盐指纹与现有 counts 不符:只给部分段 → counts_invalid;四段全给(全量重算)才允许覆盖', async () => {
    const s = await makeSvc('counts-saltmismatch-');
    await writeCountsRaw(s, countsDoc('0'.repeat(12), { unknown_keys_signals: 9 }));
    await expect(
      withLock(s, (l) => writeCountsProjection(s.ctx, l, { staged: [] })),
    ).rejects.toMatchObject({ reason: 'counts_invalid' });
    expect((await readCounts(s)).salt_fp).toBe('0'.repeat(12)); // 没被动
    await withLock(s, (l) =>
      writeCountsProjection(s.ctx, l, {
        staged: [],
        clusters: [],
        perKey: {},
        unknownKeysSignals: 0,
      }),
    );
    const c = await readCounts(s);
    expect(c.salt_fp).toBe(SALT_FP);
    expect(c.unknown_keys_signals).toBe(0);
  });

  it('上限与重复:合成后 staged > 5000 → staging_too_large;重复 run_id / 非法 key → counts_invalid', async () => {
    const s = await makeSvc('counts-limits-');
    const many = Array.from({ length: RSI_COUNTS_MAX_STAGED + 1 }, (_, i) => staged(`run-${i}`));
    await expect(
      withLock(s, (l) => writeCountsProjection(s.ctx, l, { staged: many })),
    ).rejects.toMatchObject({ reason: 'staging_too_large' });
    await expect(
      withLock(s, (l) => writeCountsProjection(s.ctx, l, { staged: [staged('r'), staged('r')] })),
    ).rejects.toMatchObject({ reason: 'counts_invalid' });
    await expect(
      withLock(s, (l) =>
        writeCountsProjection(s.ctx, l, {
          perKey: { bad_key: { signals_total: 1, sessions: 1, signals_by_day: {} } } as never,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'counts_invalid' });
    expect(await exists(countsFile(s))).toBe(false);
    // 对照:恰好 5000 项放行
    await withLock(s, (l) =>
      writeCountsProjection(s.ctx, l, { staged: many.slice(0, RSI_COUNTS_MAX_STAGED) }),
    );
    expect((await readCounts(s)).staged).toHaveLength(RSI_COUNTS_MAX_STAGED);
  });
});

describe('writeCountsProjection:锁与崩溃', () => {
  it('句柄属于性 / 锁已丢:拒写、counts 不变', async () => {
    const a = await makeSvc('counts-lock-a-');
    const b = await makeSvc('counts-lock-b-');
    await expect(
      withLock(a, (lockA) => writeCountsProjection(b.ctx, lockA, {})),
    ).rejects.toBeInstanceOf(RsiFailClosedError);
    expect(await exists(countsFile(b))).toBe(false);
    await expect(
      withLock(a, async (l) => {
        await remove(a.f.fx, path.join(a.rsi, 'lock'));
        return writeCountsProjection(a.ctx, l, {});
      }),
    ).rejects.toMatchObject({ kind: 'lock_lost' });
    expect(await exists(countsFile(a))).toBe(false);
  });

  it('每个写点(tmp-remove / tmp-write / rename)各丢一次锁 → lock_lost,该点之后零写入;各崩一次 → 新锁重跑得到正确终态,陈旧临时文件被清', async () => {
    const base = await makeSvc('counts-pts-base-');
    const marks: { name: string; writes: number }[] = [];
    await withLock(base, (l) =>
      writeCountsProjectionWith(
        base.ctx,
        l,
        { staged: [staged('run-a')] },
        {
          point: (n) =>
            void (n.startsWith('before:') && marks.push({ name: n, writes: base.audit.length })),
        },
      ),
    );
    expect(marks.map((m) => m.name)).toEqual([
      'before:tmp-remove:counts.json',
      'before:tmp-write:counts.json',
      'before:rename:counts.json',
    ]);
    for (const [i, m] of marks.entries()) {
      const s = await makeSvc(`counts-pts-lost-${i}-`);
      let n = 0;
      let at = -1;
      await expect(
        withLock(s, (l) =>
          writeCountsProjectionWith(
            s.ctx,
            l,
            { staged: [staged('run-a')] },
            {
              point: async (name) => {
                if (!name.startsWith('before:') || ++n !== i + 1) return;
                at = s.audit.length;
                await remove(s.f.fx, path.join(s.rsi, 'lock'));
              },
            },
          ),
        ),
        m.name,
      ).rejects.toMatchObject({ kind: 'lock_lost' });
      expect(at, m.name).toBe(m.writes);
      expect(s.audit.length, `${m.name} 之后零写入`).toBe(at);
      expect(await exists(countsFile(s)), `${m.name}:counts.json 未被提交`).toBe(false);
    }
    // 崩溃:每个点(前 / 后)
    for (let k = 1; k <= 6; k++) {
      const s = await makeSvc(`counts-pts-crash-${k}-`);
      await writeCountsRaw(s, countsDoc(SALT_FP, { unknown_keys_signals: 1 }));
      let n = 0;
      await expect(
        withLock(s, (l) =>
          writeCountsProjectionWith(
            s.ctx,
            l,
            { staged: [staged('run-a')] },
            {
              point: () => {
                if (++n === k) throw new CrashError('x');
              },
            },
          ),
        ),
      ).rejects.toBeInstanceOf(CrashError);
      // 崩在 rename 之前 = 旧的完整文件;之后 = 新的完整文件,没有半个文件
      const mid = RsiCountsSchema.parse(JSON.parse(await readText(countsFile(s))));
      expect(mid.generation === 1 || mid.generation === 2).toBe(true);
      await withLock(s, (l) => writeCountsProjection(s.ctx, l, { staged: [staged('run-a')] }));
      const end = await readCounts(s);
      expect(end.staged.map((x) => x.run_id)).toEqual(['run-a']);
      expect(end.unknown_keys_signals).toBe(1);
      expect(await exists(`${countsFile(s)}.tmp`)).toBe(false);
    }
  });
});

/** counts → state → cursor 三个数据文件(R20-6.9 的前三步),给提交测试用 */
async function writeData(s: Svc): Promise<void> {
  await withLock(s, async (l) => {
    await writeCountsProjection(s.ctx, l, { staged: [staged('run-a')] });
    await put(s, path.join(s.rsi, 'state.json'), canonicalJson(STATE_DOC));
    await put(s, path.join(s.rsi, 'cursor.json'), canonicalJson(CURSOR_DOC));
  });
}

describe('commitUnderLock', () => {
  it('追加日志(canonical 单行)→ 清单最后;generation 1、2;不给 log 不建日志文件', async () => {
    const s = await makeSvc('commit-basic-');
    await writeData(s);
    const r1 = await withLock(s, (l) => commitUnderLock(s.ctx, l, { trigger: 'tick' }));
    expect(r1).toEqual({ kind: 'committed', generation: 1 });
    expect(await exists(logFile(s))).toBe(false);
    const r2 = await withLock(s, (l) =>
      commitUnderLock(s.ctx, l, {
        trigger: 'tick',
        log: { action: 'completed', code: 'ok', counts: { files: 3 }, duration_ms: 12 },
      }),
    );
    expect(r2).toEqual({ kind: 'committed', generation: 2 });
    const text = await readText(logFile(s));
    const lines = text.split('\n').filter((x) => x !== '');
    expect(lines).toHaveLength(1);
    expect(text).toBe(`${lines[0]}\n`);
    expect(JSON.parse(lines[0] as string)).toEqual({
      at: '2026-10-26T12:00:00.000Z',
      trigger: 'tick',
      action: 'completed',
      code: 'ok',
      counts: { files: 3 },
      duration_ms: 12,
    });
    const snap = await readSnapshot(s.io);
    expect(snap.kind === 'ok' && snap.snapshot.files.map((f) => f.name)).toEqual([
      'counts.json',
      'cursor.json',
      'state.json',
    ]);
    expect(await inspectSnapshot(s.io, productionSnapshotValidator)).toBe('consistent');
  });

  it('提交顺序:日志先于清单(在清单 rename 前的钩子里,日志已在、旧清单还在);清单是最后一步(其后无任何写)', async () => {
    const s = await makeSvc('commit-order-');
    await writeData(s);
    await withLock(s, (l) => commitUnderLock(s.ctx, l, { trigger: 'kit' }));
    let logAtRename = '';
    let genAtRename = -1;
    await withLock(s, (l) =>
      commitUnderLockWith(
        s.ctx,
        l,
        { trigger: 'kit', log: { action: 'completed', code: 'ok' } },
        {
          point: async (n) => {
            if (n !== 'before:snapshot-rename') return;
            logAtRename = (await exists(logFile(s))) ? await readText(logFile(s)) : '';
            const snap = await readSnapshot(s.io);
            genAtRename = snap.kind === 'ok' ? snap.snapshot.generation : -1;
          },
        },
      ),
    );
    expect(logAtRename).toContain('"action":"completed"');
    expect(genAtRename).toBe(1); // 旧清单
    const snap = await readSnapshot(s.io);
    expect(snap.kind === 'ok' && snap.snapshot.generation).toBe(2);
    // 审计里最后一个(非锁文件的)写是清单的 rename
    const w = noLock(s.audit);
    expect(w.at(-1)).toBe(`rename ${snapFile(s)}`);
    expect(w.findIndex((x) => x.startsWith('appendFile'))).toBeLessThan(
      w.lastIndexOf(`rename ${snapFile(s)}`),
    );
  });

  it('坏数据不被清单背书:counts.json 损坏 / 月文件有坏行 → 抛 counts_invalid / 快照错误,不追加日志、不写清单', async () => {
    const s = await makeSvc('commit-bad-');
    await writeData(s);
    await withLock(s, (l) => commitUnderLock(s.ctx, l, { trigger: 'kit' }));
    const snapBefore = await readText(snapFile(s));
    await put(s, countsFile(s), '{broken');
    await expect(
      withLock(s, (l) =>
        commitUnderLock(s.ctx, l, { trigger: 'kit', log: { action: 'completed', code: 'ok' } }),
      ),
    ).rejects.toMatchObject({ reason: 'counts_invalid' });
    expect(await exists(logFile(s))).toBe(false);
    expect(await readText(snapFile(s))).toBe(snapBefore);
    await writeCountsRaw(s, countsDoc());
    await put(s, path.join(s.state, 'signals', 'claude', '202610.jsonl'), 'not json\n');
    await expect(
      withLock(s, (l) => commitUnderLock(s.ctx, l, { trigger: 'kit' })),
    ).rejects.toBeInstanceOf(RsiSnapshotError);
    expect(await readText(snapFile(s))).toBe(snapBefore);
  });

  it('句柄属于性与 assertHeld:持 A 的锁提交 B → internal;锁已丢 → lock_lost;都不写', async () => {
    const a = await makeSvc('commit-lock-a-');
    const b = await makeSvc('commit-lock-b-');
    await writeData(b);
    await expect(
      withLock(a, (lockA) => commitUnderLock(b.ctx, lockA, { trigger: 'kit' })),
    ).rejects.toBeInstanceOf(RsiFailClosedError);
    expect(await exists(snapFile(b))).toBe(false);
    await writeData(a);
    await expect(
      withLock(a, async (l) => {
        await remove(a.f.fx, path.join(a.rsi, 'lock'));
        return commitUnderLock(a.ctx, l, {
          trigger: 'kit',
          log: { action: 'completed', code: 'ok' },
        });
      }),
    ).rejects.toBeInstanceOf(RsiLockError);
    expect(await exists(snapFile(a))).toBe(false);
    expect(await exists(logFile(a))).toBe(false);
  });

  it('assertHeld 先于任何磁盘访问:锁已丢且数据同时损坏时,报的是 lock_lost 而不是快照错误', async () => {
    const s = await makeSvc('commit-lock-first-');
    await writeData(s);
    await put(s, path.join(s.state, 'signals', 'claude', '202610.jsonl'), 'not json\n');
    await expect(
      withLock(s, async (l) => {
        await remove(s.f.fx, path.join(s.rsi, 'lock'));
        return commitUnderLock(s.ctx, l, { trigger: 'kit' });
      }),
    ).rejects.toMatchObject({ kind: 'lock_lost' });
    await expect(
      withLock(s, async (l) => {
        await remove(s.f.fx, path.join(s.rsi, 'lock'));
        return recoverUnderLock(s.ctx, l);
      }),
    ).rejects.toMatchObject({ kind: 'lock_lost' });
  });

  it('每个写点各丢一次锁:log-append 前 / 清单 rename 前 → lock_lost,该点之后零写入,清单与日志都不动', async () => {
    const mk = async (prefix: string): Promise<Svc> => {
      const s = await makeSvc(prefix);
      await writeData(s);
      await withLock(s, (l) => commitUnderLock(s.ctx, l, { trigger: 'kit' }));
      return s;
    };
    const plan = { trigger: 'kit' as const, log: { action: 'completed' as const, code: 'ok' } };
    const base = await mk('commit-pts-base-');
    const marks: { name: string; writes: number }[] = [];
    await withLock(base, (l) =>
      commitUnderLockWith(base.ctx, l, plan, {
        point: (n) =>
          void (n.startsWith('before:') && marks.push({ name: n, writes: base.audit.length })),
      }),
    );
    expect(marks.map((m) => m.name)).toEqual(['before:log-append', 'before:snapshot-rename']);
    for (const [i, m] of marks.entries()) {
      const s = await mk(`commit-pts-lost-${i}-`);
      const snapBefore = await readText(snapFile(s));
      let n = 0;
      let at = -1;
      await expect(
        withLock(s, (l) =>
          commitUnderLockWith(s.ctx, l, plan, {
            point: async (name) => {
              if (!name.startsWith('before:') || ++n !== i + 1) return;
              at = s.audit.length;
              await remove(s.f.fx, path.join(s.rsi, 'lock'));
            },
          }),
        ),
        m.name,
      ).rejects.toMatchObject({ kind: 'lock_lost' });
      expect(at, m.name).toBe(m.writes);
      expect(s.audit.length, `${m.name} 之后零写入`).toBe(at);
      expect(await readText(snapFile(s)), `${m.name}:清单未换`).toBe(snapBefore);
    }
  });
});

describe('崩溃恢复:每个提交边界崩溃后重跑幂等', () => {
  const finish = async (s: Svc): Promise<void> => {
    await withLock(s, async (l) => {
      await recoverUnderLock(s.ctx, l);
      await writeCountsProjection(s.ctx, l, { staged: [staged('run-a')] });
      await put(s, path.join(s.rsi, 'state.json'), canonicalJson(STATE_DOC));
      await put(s, path.join(s.rsi, 'cursor.json'), canonicalJson(CURSOR_DOC));
      await commitUnderLock(s.ctx, l, { trigger: 'kit' });
    });
    expect(await inspectSnapshot(s.io, productionSnapshotValidator)).toBe('consistent');
    expect(await exists(`${snapFile(s)}.tmp`)).toBe(false);
  };

  it('counts 已写、cursor 未写:无清单时 recover = absent(数据有效不当空);补完后一致', async () => {
    const s = await makeSvc('crash-cursor-');
    // 「崩溃」:state / cursor / 清单都没写
    await withLock(s, (l) => writeCountsProjection(s.ctx, l, { staged: [staged('run-a')] }));
    expect(await withLock(s, (l) => recoverUnderLock(s.ctx, l))).toBe('absent');
    await finish(s);
  });

  it('数据已写、清单未换(崩在清单 rename 之前):遗留 snapshot.json.tmp,旧清单还在;recover = rebuilt;再提交一致', async () => {
    const s = await makeSvc('crash-prerename-');
    await writeData(s);
    await withLock(s, (l) => commitUnderLock(s.ctx, l, { trigger: 'kit' }));
    await withLock(s, (l) => writeCountsProjection(s.ctx, l, { staged: [staged('run-b')] }));
    const hook = crashAt('before:snapshot-rename');
    await expect(
      withLock(s, (l) => commitUnderLockWith(s.ctx, l, { trigger: 'kit' }, hook)),
    ).rejects.toBeInstanceOf(CrashError);
    expect(await exists(`${snapFile(s)}.tmp`)).toBe(true);
    expect(await inspectSnapshot(s.io, productionSnapshotValidator)).toBe('needs_rebuild');
    expect(await withLock(s, (l) => recoverUnderLock(s.ctx, l))).toBe('rebuilt');
    expect(await exists(`${snapFile(s)}.tmp`)).toBe(false);
    expect(await withLock(s, (l) => recoverUnderLock(s.ctx, l))).toBe('consistent');
    await finish(s);
  });

  it('崩在日志追加之后、清单之前:重跑再提交成功;日志多一行(如实:不丢提交记录)', async () => {
    const s = await makeSvc('crash-afterlog-');
    await writeData(s);
    const plan = { trigger: 'tick' as const, log: { action: 'completed' as const, code: 'ok' } };
    await expect(
      withLock(s, (l) => commitUnderLockWith(s.ctx, l, plan, crashAt('after:log-append'))),
    ).rejects.toBeInstanceOf(CrashError);
    expect(await exists(snapFile(s))).toBe(false);
    await withLock(s, (l) => commitUnderLock(s.ctx, l, plan));
    expect((await readText(logFile(s))).split('\n').filter((x) => x !== '')).toHaveLength(2);
    expect(await inspectSnapshot(s.io, productionSnapshotValidator)).toBe('consistent');
  });

  it('第二个月文件重写前后崩溃(purge 式「逐文件临时文件 + rename」):每个点 recover 都能重建,补完后一致且幂等', async () => {
    for (const stage of ['month1-renamed', 'month2-renamed'] as const) {
      const s = await makeSvc(`crash-months-${stage}-`);
      await addSignals(s, [{ id: '1111111111111111', key: KEY_A }], '202609');
      await addSignals(s, [{ id: '2222222222222222', key: KEY_B }], '202610');
      await writeData(s);
      await withLock(s, (l) => commitUnderLock(s.ctx, l, { trigger: 'purge' }));
      const m1 = path.join(s.state, 'signals', 'claude', '202609.jsonl');
      const m2 = path.join(s.state, 'signals', 'claude', '202610.jsonl');
      // 重写第一个月文件(临时文件 + rename),「崩溃」
      await put(s, `${m1}.tmp`, '');
      await safeRename(s.f.fx, `${m1}.tmp`, m1);
      if (stage === 'month2-renamed') {
        await put(s, `${m2}.tmp`, '');
        await safeRename(s.f.fx, `${m2}.tmp`, m2);
      }
      expect(await inspectSnapshot(s.io, productionSnapshotValidator)).toBe('needs_rebuild');
      expect(await withLock(s, (l) => recoverUnderLock(s.ctx, l))).toBe('rebuilt');
      expect(await withLock(s, (l) => recoverUnderLock(s.ctx, l))).toBe('consistent');
      // 第二个月文件尚未重写的那种中间态也是合法的完整提交
      await withLock(s, (l) => commitUnderLock(s.ctx, l, { trigger: 'purge' }));
      expect(await inspectSnapshot(s.io, productionSnapshotValidator)).toBe('consistent');
    }
  });

  it('无副作用复检先于 recover:月文件有坏行时,recoverUnderLock 在写任何东西之前就抛(预置的陈旧 snapshot.json.tmp 原封不动)', async () => {
    const s = await makeSvc('recover-noside-');
    await writeData(s);
    await withLock(s, (l) => commitUnderLock(s.ctx, l, { trigger: 'kit' }));
    await put(s, path.join(s.state, 'signals', 'claude', '202610.jsonl'), 'not json\n');
    await put(s, `${snapFile(s)}.tmp`, 'stale');
    await withLock(s, async (l) => {
      const afterLock = s.audit.length;
      await expect(recoverUnderLock(s.ctx, l)).rejects.toBeInstanceOf(RsiSnapshotError);
      expect(s.audit.length, '拒绝之前零写入').toBe(afterLock);
    });
    expect(await readText(`${snapFile(s)}.tmp`)).toBe('stale');
  });
});

describe('锁内顺序(冻结:privacyGate → lockGate → recover → resumeTaint → immediateGate → 业务 → counts → … → commitUnderLock)', () => {
  interface Run {
    order: string[];
    result: 'done' | 'denied' | 'gate_blocked';
  }

  /** 按 types.ts 头注释第二条冻结顺序组装一个现有写入方(reflect / judge / promote 形状);只用服务层与 B2 的闸 */
  async function writerFlow(s: Svc): Promise<Run> {
    const order: string[] = [];
    const cfg = await loadRsiConfig({ home: s.f.home });
    const gate = privacyGate(cfg);
    order.push('privacyGate');
    if (gate.kind === 'deny') return { order, result: 'denied' };
    if (cfg.status !== 'on') throw new Error('unexpected off');
    const ctx: RsiServiceCtx = { ...s.ctx, config: cfg };
    return withRsiLockIfGated({ io: s.io, config: cfg }, async (lock) => {
      if (lock === null) throw new Error('expected lock');
      order.push('lock');
      await recoverUnderLock(ctx, lock);
      order.push('recover');
      await resumeTaint(ctx, lock);
      order.push('resumeTaint');
      const g = await immediateGate(ctx, { kind: 'judge', runId: 'run-1' });
      order.push('immediateGate');
      if (g.kind !== 'allow') return { order, result: 'gate_blocked' as const };
      order.push('business');
      await writeCountsProjection(ctx, lock, { staged: [staged('run-1')] });
      order.push('counts');
      await put(s, path.join(s.rsi, 'state.json'), canonicalJson(STATE_DOC));
      await put(s, path.join(s.rsi, 'cursor.json'), canonicalJson(CURSOR_DOC));
      order.push('state+cursor');
      await commitUnderLock(ctx, lock, {
        trigger: 'kit',
        log: { action: 'completed', code: 'ok' },
      });
      order.push('commit');
      return { order, result: 'done' as const };
    });
  }

  it('闸非 allow 短路:recover 与 resumeTaint 已在闸之前做完(带标记的 run 被清),业务与提交不发生', async () => {
    const s = await makeSvc('order-blocked-');
    await writeCountsRaw(s, countsDoc());
    await stageRun(s, 'run-1', ['aaaaaaaaaaaaaaa1']);
    // run-1 带标记且还没清:resumeTaint 必须在闸之前清掉
    await put(
      s,
      path.join(runDirOf(s, 'run-1'), 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    const r = await writerFlow(s);
    expect(r.result).toBe('gate_blocked');
    expect(r.order).toEqual(['privacyGate', 'lock', 'recover', 'resumeTaint', 'immediateGate']);
    expect(await exists(path.join(runDirOf(s, 'run-1'), 'apply.patch'))).toBe(false);
    expect((await readCounts(s)).generation).toBe(1); // 业务与提交没发生
    expect(await exists(snapFile(s))).toBe(false);
  });

  it('正常:顺序如冻结;磁盘上的写入顺序同样是 counts → 日志 → 清单(清单最后)', async () => {
    const s = await makeSvc('order-ok-');
    await writeCountsRaw(s, countsDoc());
    await put(s, path.join(s.state, 'reflect', 'run-1', 'report.json'), '{}\n');
    const ok = await writerFlow(s);
    expect(ok.result).toBe('done');
    expect(ok.order).toEqual([
      'privacyGate',
      'lock',
      'recover',
      'resumeTaint',
      'immediateGate',
      'business',
      'counts',
      'state+cursor',
      'commit',
    ]);
    const w = noLock(s.audit);
    const idx = (needle: string): number => w.findIndex((x) => x === needle);
    expect(idx(`rename ${countsFile(s)}`)).toBeGreaterThan(-1);
    expect(idx(`rename ${countsFile(s)}`)).toBeLessThan(idx(`appendFile ${logFile(s)}`));
    expect(idx(`appendFile ${logFile(s)}`)).toBeLessThan(idx(`rename ${snapFile(s)}`));
    expect(w.at(-1)).toBe(`rename ${snapFile(s)}`); // 清单是最后一步
    expect(await inspectSnapshot(s.io, productionSnapshotValidator)).toBe('consistent');
  });

  it('deny 路径(privacyGate deny):recover 不触发、不拿锁、写审计零调用(预置的陈旧 snapshot.json.tmp 原封不动)', async () => {
    const s = await makeSvc('order-deny-');
    await put(s, `${snapFile(s)}.tmp`, 'stale');
    // cfg_schema
    await writeFile(s.f.fx, s.f.cfgFile, '[rsi]\nenabled = true\nunknown_key = 1\n', {
      mode: 0o600,
    });
    const before = s.audit.length;
    const r = await writerFlow(s);
    expect(r).toEqual({ order: ['privacyGate'], result: 'denied' });
    expect(s.audit.length).toBe(before);
    expect(await readText(`${snapFile(s)}.tmp`)).toBe('stale');
    expect(await exists(path.join(s.rsi, 'lock'))).toBe(false);
  });
});
