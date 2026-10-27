/**
 * R20-A2 B4c2:崩溃与恢复矩阵(B4 方案 §4.2)。在第 k 个写点之前崩溃(k 遍历全部写点,含第二个月文件重写前后、counts 已写 cursor 未写、数据已写快照未换、盐首建),
 * 之后用新锁重跑:终态正确;再跑两次幂等(signals_new = 0、三段 counts 不变、索引条目不变)。另测盐首建后空文件的 D15。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RsiCountsSchema,
  RsiCursorSchema,
  RsiProjectIndexSchema,
} from '../../src/contracts/rsi.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { remove } from '../../src/io/safe-fs.js';
import { RsiFailClosedError } from '../../src/rsi/types.js';
import { reclaimEmptySalt } from '../../src/rsi/services/fixed-write.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { treeOf } from './rsi-fixture.js';
import { put, withLock } from './services-fixture.js';
import {
  inputOf,
  loseLock,
  recordOps,
  rsiFile,
  runL0,
  scenario,
  type RunFx,
  type ScenarioKind,
} from './l0-run-fixture.js';

async function finalShape(fx: RunFx): Promise<{
  perKey: number[][];
  clusters: number;
  indexKeys: string[];
  cursorFiles: number;
}> {
  const c = RsiCountsSchema.parse(await rsiFile(fx.s, 'counts.json'));
  const i = RsiProjectIndexSchema.parse(await rsiFile(fx.s, 'projects.json'));
  const cur = RsiCursorSchema.parse(await rsiFile(fx.s, 'cursor.json'));
  return {
    perKey: Object.values(c.per_key)
      .map((v) => [v.signals_total, v.sessions] as number[])
      .sort(),
    clusters: c.clusters.length,
    indexKeys: i.entries.map((e) => e.key),
    cursorFiles: Object.keys(cur.files).length,
  };
}

const EXPECT: Record<ScenarioKind, { projects: number }> = {
  first: { projects: 2 },
  incremental: { projects: 4 },
};

describe.each(['first', 'incremental'] as const)('崩溃矩阵:场景 %s', (kind: ScenarioKind) => {
  it('每个写点之前崩溃一次 → 新锁重跑得到正确终态;再跑两次幂等;没有残留的 .tmp', async () => {
    const { ops } = await recordOps(kind, `l0cm-rec-${kind}-`, { salt: kind === 'incremental' });
    const N = ops.length;
    expect(N).toBeGreaterThan(20);
    for (let k = 1; k <= N; k++) {
      const fx = await scenario(kind, `l0cm-${kind}-${k}-`, { salt: kind === 'incremental' });
      let seen = 0;
      await expect(
        runL0(fx, inputOf(), {
          beforeWrite: async () => {
            if (++seen === k) throw new Error('crash');
          },
        }),
        `k=${k} ${ops[k - 1]?.op}`,
      ).rejects.toThrow('crash');
      const r1 = await runL0(fx);
      expect(r1.outcome, `k=${k} 重跑`).toBe('ok');
      const shape1 = await finalShape(fx);
      const want = EXPECT[kind].projects;
      expect(shape1.perKey, `k=${k}`).toEqual(Array.from({ length: want }, () => [2, 1]));
      expect(shape1.clusters, `k=${k}`).toBe(1);
      expect(shape1.indexKeys, `k=${k}`).toHaveLength(want);
      expect(shape1.cursorFiles, `k=${k}`).toBe(want);
      // 再跑两次:幂等
      for (let i = 0; i < 2; i++) {
        const r = await runL0(fx);
        expect(r, `k=${k} 幂等 #${i}`).toMatchObject({
          outcome: 'ok',
          signalsNew: 0,
          sessionsNew: 0,
        });
        expect(await finalShape(fx), `k=${k} 幂等 #${i}`).toEqual(shape1);
      }
      expect(await inspectSnapshot(fx.s.io, productionSnapshotValidator), `k=${k}`).toBe(
        'consistent',
      );
      const leftovers = [...(await treeOf(fx.s.state))].filter((l) => /\.tmp( |$)/.test(l));
      expect(leftovers, `k=${k}:无残留 .tmp`).toEqual([]);
    }
  }, 300_000);
});

describe('崩溃矩阵:点名的提交边界', () => {
  const crashAt = async (fx: RunFx, pick: (op: string, p: string) => boolean): Promise<void> => {
    await expect(
      runL0(fx, inputOf(), {
        beforeWrite: async (op, p) => {
          if (pick(op, p)) throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
  };

  it('counts 已写、cursor 未写:崩在 cursor 的 tmp-write 之前 → counts.json 在、cursor.json 不在;重跑 cursor 追平且信号不重复', async () => {
    const fx = await scenario('first', 'l0cm-cur-');
    await crashAt(fx, (op) => op === 'tmp-write:cursor.json');
    expect(await exists(path.join(fx.s.rsi, 'counts.json'))).toBe(true);
    expect(await exists(path.join(fx.s.rsi, 'cursor.json'))).toBe(false);
    const r = await runL0(fx);
    expect(r).toMatchObject({ outcome: 'ok', signalsNew: 0, cursorWritten: true });
    expect(await exists(path.join(fx.s.rsi, 'cursor.json'))).toBe(true);
  });

  it('数据已写、快照未换:崩在 snapshot-rename 之前 → 全部数据文件都在、清单不在(首次);重跑后清单与数据一致', async () => {
    const fx = await scenario('first', 'l0cm-snap-');
    await crashAt(fx, (op) => op === 'snapshot-rename');
    for (const f of ['projects.json', 'counts.json', 'state.json', 'cursor.json']) {
      expect(await exists(path.join(fx.s.rsi, f)), f).toBe(true);
    }
    expect(await exists(path.join(fx.s.rsi, 'snapshot.json'))).toBe(false);
    expect((await runL0(fx)).outcome).toBe('ok');
    expect(await inspectSnapshot(fx.s.io, productionSnapshotValidator)).toBe('consistent');
  });

  it('第二个月文件重写前 / 后崩溃:信号库一个月文件已换、另一个没换 → 重跑去重补齐,两个月文件内容最终相同', async () => {
    const ref = await scenario('first', 'l0cm-month-ref-');
    await runL0(ref);
    const refText = async (fx: RunFx, m: string): Promise<string> =>
      readText(path.join(fx.s.state, 'signals', 'claude', `${m}.jsonl`));
    const sigRenames = (await recordOps('first', 'l0cm-month-rec-')).ops
      .filter((o) => o.op === 'rename' && o.path.includes(`${path.sep}signals${path.sep}`))
      .map((o) => path.basename(o.path));
    expect(sigRenames).toEqual(['202609.jsonl', '202610.jsonl']);
    for (const phase of ['before', 'after'] as const) {
      const fx = await scenario('first', `l0cm-month-${phase}-`);
      let sawFirst = false;
      await expect(
        runL0(fx, inputOf(), {
          beforeWrite: async (op, p) => {
            if (op === 'rename' && p.endsWith('202609.jsonl')) sawFirst = true;
            // before:第二个月文件 rename 之前;after:第二个月文件 rename 之后的第一个写点(chmod-final)
            if (phase === 'before' && op === 'rename' && p.endsWith('202610.jsonl'))
              throw new Error('crash');
            if (phase === 'after' && op === 'chmod-final' && p.endsWith('202610.jsonl'))
              throw new Error('crash');
          },
        }),
      ).rejects.toThrow('crash');
      expect(sawFirst).toBe(true);
      expect(await exists(path.join(fx.s.state, 'signals', 'claude', '202609.jsonl'))).toBe(true);
      const second = await exists(path.join(fx.s.state, 'signals', 'claude', '202610.jsonl'));
      expect(second, phase).toBe(phase === 'after');
      const r = await runL0(fx);
      expect(r.outcome).toBe('ok');
      // 两个月文件的行数与对照(完整的一次提交)一致:每行一个信号、没有重复
      for (const m of ['202609', '202610']) {
        expect((await refText(fx, m)).trim().split('\n').length, `${phase}:${m}`).toBe(
          (await refText(ref, m)).trim().split('\n').length,
        );
      }
    }
  });
});

describe('D15:盐首建崩溃留下空文件', () => {
  const emptySalt = async (fx: RunFx): Promise<string> => {
    const p = path.join(fx.s.state, 'salt');
    await put(fx.s, p, '');
    return p;
  };

  it('持锁 + 空普通文件 + mtime 已满 10 秒 → 删除重建,采集继续;不足 10 秒 → salt_invalid(不删)', async () => {
    const young = await scenario('first', 'l0d15-young-', { salt: false });
    const youngSalt = await emptySalt(young);
    young.s.clock.t = Date.now() + 2_000;
    await expect(runL0(young)).rejects.toMatchObject({ reason: 'salt_invalid' });
    expect(await exists(youngSalt)).toBe(true); // 不足宽限:不删
    expect(await readText(youngSalt)).toBe('');

    const old = await scenario('first', 'l0d15-old-', { salt: false });
    const oldSalt = await emptySalt(old);
    old.s.clock.t = Date.now() + 20_000;
    const r = await runL0(old);
    expect(r.outcome).toBe('ok');
    expect(await readText(oldSalt)).toMatch(/^[0-9a-f]{64}\n$/);
  });

  it('不持锁不删:锁已丢时 reclaimEmptySalt 报 lock_lost,空盐文件原样保留', async () => {
    const fx = await scenario('first', 'l0d15-nolock-', { salt: false });
    const p = await emptySalt(fx);
    fx.s.clock.t = Date.now() + 20_000;
    await expect(
      withLock(fx.s, async (lock) => {
        await loseLock(fx.s);
        return reclaimEmptySalt(fx.s.ctx, lock, fx.s.clock.t);
      }),
    ).rejects.toMatchObject({ kind: 'lock_lost' });
    expect(await exists(p)).toBe(true);
    // 正向对照:持锁时同样的调用会删
    const ok = await withLock(fx.s, (lock) => reclaimEmptySalt(fx.s.ctx, lock, fx.s.clock.t));
    expect(ok).toBe('reclaimed');
    expect(await exists(p)).toBe(false);
  });

  it('remove 紧邻再确认:首次 lstat 之后(钩子里)同锁并发写入内容 → 不删、返回 not_empty、内容保留;对照:无并发写入时删除', async () => {
    const fx = await scenario('first', 'l0d15-recheck-', { salt: false });
    const p = await emptySalt(fx);
    fx.s.clock.t = Date.now() + 20_000;
    const content = `${'cd'.repeat(32)}\n`;
    const r = await withLock(fx.s, (lock) =>
      reclaimEmptySalt(fx.s.ctx, lock, fx.s.clock.t, {
        point: async (name) => {
          if (name === 'before:salt-remove') await put(fx.s, p, content);
        },
      }),
    );
    expect(r).toBe('not_empty');
    expect(await readText(p)).toBe(content);
    // 对照
    await put(fx.s, p, '');
    const ok = await withLock(fx.s, (lock) => reclaimEmptySalt(fx.s.ctx, lock, fx.s.clock.t));
    expect(ok).toBe('reclaimed');
  });

  it('盐首建的每个写点(mkdirp / chmod / salt-create)之前失锁 → lock_lost,之后零写入,盐文件不存在', async () => {
    const rec = await recordOps('first', 'l0d15-rec-', { salt: false });
    const saltOps = rec.ops
      .filter((o) => ['mkdirp', 'chmod', 'salt-create'].includes(o.op))
      .slice(0, 3);
    expect(saltOps.map((o) => o.op)).toEqual(['mkdirp', 'chmod', 'salt-create']);
    for (const [k, o] of saltOps.entries()) {
      const fx = await scenario('first', `l0d15-lost-${k}-`, { salt: false });
      let seen = 0;
      let atHook = -1;
      await expect(
        runL0(fx, inputOf(), {
          beforeWrite: async () => {
            if (++seen !== k + 1) return;
            atHook = fx.s.audit.length;
            await loseLock(fx.s);
          },
        }),
        o.op,
      ).rejects.toMatchObject({ kind: 'lock_lost' });
      expect(fx.s.audit.length).toBe(atHook);
      expect(await exists(path.join(fx.s.state, 'salt')), o.op).toBe(false);
    }
  });

  it('非空盐 / 违规盐不会被回收:reclaimEmptySalt 返回 not_empty(正常盐)或 salt_invalid(宽权限)', async () => {
    const fx = await scenario('first', 'l0d15-keep-');
    fx.s.clock.t = Date.now() + 20_000;
    expect(await withLock(fx.s, (l) => reclaimEmptySalt(fx.s.ctx, l, fx.s.clock.t))).toBe(
      'not_empty',
    );
    await remove(fx.s.f.fx, path.join(fx.s.state, 'salt'));
    await put(fx.s, path.join(fx.s.state, 'salt'), `${'ab'.repeat(32)}\n`, 0o644);
    await expect(
      withLock(fx.s, (l) => reclaimEmptySalt(fx.s.ctx, l, fx.s.clock.t)),
    ).rejects.toBeInstanceOf(RsiFailClosedError);
  });
});
