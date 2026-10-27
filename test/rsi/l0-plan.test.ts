/**
 * R20-A2 B4c2:`planL0`(干跑,零写入)、`state-mutate`(armed_listing / baseline / confirm 不变量)、`runArmedUnderLock`(D3)、`rebuild-gate`。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RsiConfirm, RsiState } from '../../src/contracts/rsi.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { planL0 } from '../../src/rsi/l0/plan.js';
import { recomputeCounts } from '../../src/rsi/l0/counts-recompute.js';
import { planRebuildForWrite, rebuildWriteVerdict } from '../../src/rsi/l0/rebuild-gate.js';
import { runArmedUnderLock } from '../../src/rsi/l0/run.js';
import {
  ackBaseline,
  applyArmedListing,
  armedListingField,
  carryConfirm,
  clearArmedListing,
} from '../../src/rsi/l0/state-mutate.js';
import { RsiSnapshotBusyError } from '../../src/rsi/exit.js';
import { planSessionStats, sessionsPerKey } from '../../src/signals/session-stats.js';
import { readSnapshot } from '../../src/rsi/snapshot.js';
import { treeOf } from './rsi-fixture.js';
import { put, withLock } from './services-fixture.js';
import {
  emptyState,
  inputOf,
  makeRunFx,
  mutator,
  rsiFile,
  runL0,
  type RunFx,
} from './l0-run-fixture.js';

const planOf = (
  fx: RunFx,
  mode: 'armed' | 'confirmed',
  deps: Record<string, unknown> = {},
  limits?: { maxFiles: number },
) =>
  planL0(
    fx.s.io,
    fx.s.cfg,
    { mode, ...(limits ? { limits } : {}) },
    { now: fx.s.ctx.now as () => Date, piDirSet: false, ...deps },
  );

describe('planL0:零写入', () => {
  it('confirmed:写审计 0 + 前后目录树无差异;files_planned 与随后的真跑一致;signals_new / sessions_new 为 null(D14);fingerprint 匹配', async () => {
    const fx = await makeRunFx('l0p-conf-');
    await fx.claude(1, await fx.work('alpha'));
    await runL0(fx);
    await fx.claude(2, await fx.work('beta'));
    const before = [...(await treeOf(fx.s.state)), ...(await treeOf(path.join(fx.s.f.home)))];
    const auditBefore = fx.s.audit.length;
    const plan = await planOf(fx, 'confirmed');
    expect(fx.s.audit.length).toBe(auditBefore); // 写审计 0
    expect([...(await treeOf(fx.s.state)), ...(await treeOf(path.join(fx.s.f.home)))]).toEqual(
      before,
    );
    expect(plan).toMatchObject({ mode: 'confirmed', salt: 'persisted', armed: null });
    expect(plan.summary).toMatchObject({
      files_planned: 1,
      files_read: 0,
      signals_new: null,
      sessions_new: null,
      projects: { collecting: 1, excluded: 0, new: 1 }, // 没有 ack 过基线:索引条目都算「新增」
    });
    expect(plan.summary.cursor.fingerprint_match).toBe(true);
    expect(plan.summary.skipped.unchanged).toBe(1);
    expect(plan.bytesPlanned).toBeGreaterThan(0);
    // 正向对照:真跑确实会写(审计能看到),且读到的文件数与计划一致
    const real = await runL0(fx);
    expect(fx.s.audit.length).toBeGreaterThan(auditBefore);
    expect(real.summary.files_read).toBe(plan.summary.files_planned);
  });

  it('盐不存在:临时盐(salt none),不建 .state、不输出依赖 key 的计数、fingerprint_match null;全部文件都算将读;预算与采集共用', async () => {
    const fx = await makeRunFx('l0p-nosalt-', { salt: false });
    await fx.claude(1, await fx.work('alpha'));
    await fx.claude(2, await fx.work('beta'));
    await fx.claude(3, await fx.work('gamma'));
    const a0 = fx.s.audit.length;
    const plan = await planOf(fx, 'confirmed', {}, { maxFiles: 2 });
    expect(fx.s.audit.length).toBe(a0);
    expect(await exists(fx.s.state)).toBe(false);
    expect(plan.salt).toBe('none');
    expect(plan.summary).toMatchObject({
      files_planned: 2,
      projects: null,
      unknown_signals: null,
      signals_new: null,
      outcome: 'ok_partial',
    });
    expect(plan.summary.limits_hit).toContain('RSI_LIMIT_FILES');
    expect(plan.summary.cursor.fingerprint_match).toBeNull();
  });

  it('快照与清单不一致(并发写入方正在提交)→ RsiSnapshotBusyError(命令层退出 4),而不是读到半新半旧', async () => {
    const fx = await makeRunFx('l0p-busy-');
    await fx.claude(1, await fx.work('alpha'));
    await runL0(fx);
    // 篡改 counts.json(清单里记的是旧摘要)且每次读都不一致
    await put(
      fx.s,
      path.join(fx.s.rsi, 'counts.json'),
      `${canonicalJson({ ...((await rsiFile(fx.s, 'counts.json')) as object), generation: 99 })}`,
    );
    await expect(planOf(fx, 'confirmed')).rejects.toBeInstanceOf(RsiSnapshotBusyError);
  });

  it('armed:不建盐、不写;清单计数按路径口径(P / X / U);目录项上限 → complete=false', async () => {
    const fx = await makeRunFx('l0p-armed-', { salt: false });
    await fx.claude(1, await fx.work('alpha'));
    await fx.claude(2, await fx.work('beta'));
    const a0 = fx.s.audit.length;
    const plan = await planOf(fx, 'armed');
    expect(fx.s.audit.length).toBe(a0);
    expect(await exists(path.join(fx.s.state, 'salt'))).toBe(false);
    expect(plan).toMatchObject({
      mode: 'armed',
      salt: 'none',
      armed: { projects: 2, excluded: 0, complete: true },
    });
    const cut = await planOf(fx, 'armed', { limits: { maxDirEntries: 1 } });
    expect(cut.armed?.complete).toBe(false);
  });
});

describe('state-mutate:不变量', () => {
  const rows = (
    n: number,
    ex = 0,
  ): { name: string; sessions: number; path: string; excluded: boolean }[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `d${i}`,
      sessions: 1,
      path: `/x/d${i}`,
      excluded: i < ex,
    }));
  const field = armedListingField(
    { rows: rows(3, 1), unknownSessions: 4 },
    '2026-10-26T00:00:00.000Z',
    'c'.repeat(64),
    ['pi', 'claude'],
  );

  it('armedListingField:完整 → 计数字段(agents 升序);complete === false → undefined(不持久化);complete 缺省视为完整', () => {
    expect(field).toEqual({
      at: '2026-10-26T00:00:00.000Z',
      policy_fp: 'c'.repeat(64),
      agents: ['claude', 'pi'],
      projects: 2,
      excluded: 1,
      unknown_sessions: 4,
    });
    expect(
      armedListingField(
        { rows: rows(1), unknownSessions: 0, complete: false },
        'x',
        'c'.repeat(64),
        ['claude'],
      ),
    ).toBeUndefined();
    expect(
      armedListingField(
        { rows: rows(1), unknownSessions: 0, complete: true },
        '2026-10-26T00:00:00.000Z',
        'c'.repeat(64),
        ['claude'],
      ),
    ).toBeDefined();
  });

  it('applyArmedListing:给了字段就写;不完整 → 一律还原为磁盘原值(没有就不写),mutator 自己塞的值无效', () => {
    const prev: RsiState = { ...emptyState(), armed_listing: { ...field!, projects: 9 } };
    const smuggled: RsiState = { ...emptyState(), armed_listing: { ...field!, projects: 77 } };
    expect(applyArmedListing(smuggled, prev, field).armed_listing?.projects).toBe(2);
    expect(applyArmedListing(smuggled, prev, undefined).armed_listing?.projects).toBe(9);
    expect('armed_listing' in applyArmedListing(smuggled, emptyState(), undefined)).toBe(false);
    expect('armed_listing' in applyArmedListing(smuggled, null, undefined)).toBe(false);
  });

  it('clearArmedListing 删除该键;ackBaseline 只 true → false 且幂等;carryConfirm 把 confirm 换回磁盘值', () => {
    const withListing: RsiState = { ...emptyState(), armed_listing: field! };
    expect('armed_listing' in clearArmedListing(withListing)).toBe(false);
    const confirm: RsiConfirm = {
      confirmed_at: '2026-10-20T00:00:00.000Z',
      kit_major: 0,
      agents: ['claude'],
      exclude_hashes: [],
      repo_sha256: 'a'.repeat(64),
      repo_dev_ino: { dev: 1, ino: 1 },
      overlay_sha256: null,
      policy_fp: 'b'.repeat(64),
      baseline_pending: true,
    };
    const pending: RsiState = { ...emptyState(), confirm };
    const acked = ackBaseline(pending, 7);
    expect(acked.confirm?.baseline_pending).toBe(false);
    expect(acked.projects_ack_generation).toBe(7);
    expect(ackBaseline(acked, 9)).toBe(acked); // 已经是 false:原样返回,不推进
    expect(ackBaseline(emptyState(), 9).projects_ack_generation).toBe(0); // 没有 confirm:不动
    const tried: RsiState = { ...acked, confirm: { ...confirm, baseline_pending: true } };
    expect(carryConfirm(acked, tried).confirm?.baseline_pending).toBe(false);
    expect(carryConfirm(null, tried).confirm).toBeNull();
  });
});

describe('runArmedUnderLock(D3)', () => {
  const runArmed = (
    fx: RunFx,
    over: Parameters<typeof inputOf>[0] = {},
    deps: Parameters<typeof runArmedUnderLock>[3] = {},
  ) =>
    withLock(fx.s, (lock) =>
      runArmedUnderLock(fx.s.ctx, lock, inputOf(over), { l0: { piDirSet: false }, ...deps }),
    );

  it('首次 armed:不建盐、不写信号 / 会话计数 / 索引 / cursor / counts;只写 state(armed_listing)+ 日志 + 快照', async () => {
    const fx = await makeRunFx('l0armed-', { salt: false });
    await fx.claude(1, await fx.work('alpha'));
    await fx.claude(2, await fx.work('beta'));
    const r = await runArmed(fx);
    expect(r.outcome).toBe('ok');
    const s = fx.s;
    expect(await exists(path.join(s.state, 'salt'))).toBe(false);
    expect(await exists(path.join(s.state, 'signals'))).toBe(false);
    expect(await exists(path.join(s.state, 'sessions'))).toBe(false);
    for (const f of ['projects.json', 'cursor.json', 'counts.json'])
      expect(await exists(path.join(s.rsi, f)), f).toBe(false);
    const st = (await rsiFile(s, 'state.json')) as RsiState;
    expect(st.armed_listing).toMatchObject({ projects: 2, excluded: 0, unknown_sessions: 0 });
    expect(st.last_tick?.outcome).toBe('ok');
    const log = (await readText(path.join(s.rsi, 'log.jsonl'))).trim().split('\n');
    expect(log).toHaveLength(1);
    expect((await readSnapshot(s.io)).kind).toBe('ok');
    // 写入的文件恰好是 state / 日志 / 清单(不含任何数据文件)
    const names = (await treeOf(s.rsi))
      .map((l) => l.split(' ')[0])
      .filter((n) => !n?.endsWith('/'));
    expect(names.sort()).toEqual(['log.jsonl', 'snapshot.json', 'state.json']); // 锁已释放
  });

  it('列举不完整(complete === false):不持久化 armed_listing;磁盘上原有的值保持不变(没有就不写)', async () => {
    const fx = await makeRunFx('l0armed-inc-', { salt: false });
    await fx.claude(1, await fx.work('alpha'));
    await fx.claude(2, await fx.work('beta'));
    const cut = { l0: { piDirSet: false, limits: { maxDirEntries: 1 } } };
    await runArmed(fx, {}, cut);
    expect('armed_listing' in ((await rsiFile(fx.s, 'state.json')) as object)).toBe(false); // 没有就不写
    await runArmed(fx); // 完整:写入
    const good = ((await rsiFile(fx.s, 'state.json')) as RsiState).armed_listing;
    expect(good?.projects).toBe(2);
    // 不完整:保持上一次完整的那份;mutator 想塞别的值也无效
    await runArmed(
      fx,
      {
        stateMutator: (prev, s) => ({
          ...mutator(prev, s),
          armed_listing: { ...good!, projects: 99 },
        }),
      },
      cut,
    );
    expect(((await rsiFile(fx.s, 'state.json')) as RsiState).armed_listing).toEqual(good);
  });

  it('坏 confirm 原样透传:armed 回写时 confirm 的原始 JSON 值不变,armed_listing 照常写入', async () => {
    const fx = await makeRunFx('l0armed-bad-', { salt: false });
    await fx.claude(1, await fx.work('alpha'));
    const bad = { nonsense: [1, 2, { z: null }] };
    await put(
      fx.s,
      path.join(fx.s.rsi, 'state.json'),
      canonicalJson({ ...emptyState(), confirm: bad }),
    );
    await runArmed(fx);
    const raw = JSON.parse(await readText(path.join(fx.s.rsi, 'state.json'))) as Record<
      string,
      unknown
    >;
    expect(raw['confirm']).toEqual(bad);
    expect((raw['armed_listing'] as { projects: number }).projects).toBe(1);
  });
});

describe('rebuild-gate', () => {
  it('rebuildWriteVerdict:列举不完整且旧索引无效 → 不写;其余都允许', () => {
    expect(rebuildWriteVerdict({ complete: false }, false)).toEqual({
      write: false,
      reason: 'listing_incomplete_no_valid_index',
    });
    expect(rebuildWriteVerdict({ complete: false }, true)).toEqual({ write: true });
    expect(rebuildWriteVerdict({ complete: true }, false)).toEqual({ write: true });
    expect(rebuildWriteVerdict({ complete: true }, true)).toEqual({ write: true });
  });

  it('planRebuildForWrite:真实规划的 complete / 旧索引有效性接进判定(三种组合)', async () => {
    const cut = { piDirSet: false, now: undefined as never };
    void cut;
    const mk = async (prefix: string, committed: boolean): Promise<RunFx> => {
      const fx = await makeRunFx(prefix);
      await fx.claude(1, await fx.work('alpha'));
      await fx.claude(2, await fx.work('beta'));
      if (committed) await runL0(fx);
      return fx;
    };
    const deps = (over: object = {}): { piDirSet: boolean } => ({ piDirSet: false, ...over });
    // 不完整 + 没有旧索引 → 不写
    const a = await mk('l0rg-a-', false);
    const ra = await planRebuildForWrite(a.s.io, a.s.cfg, deps({ limits: { maxDirEntries: 1 } }));
    expect(ra.plan.complete).toBe(false);
    expect(ra.oldIndexValid).toBe(false);
    expect(ra.verdict).toEqual({ write: false, reason: 'listing_incomplete_no_valid_index' });
    // 不完整 + 旧索引有效 → 可写(合并保留旧条目)
    const b = await mk('l0rg-b-', true);
    const rb = await planRebuildForWrite(b.s.io, b.s.cfg, deps({ limits: { maxDirEntries: 1 } }));
    expect(rb.plan.complete).toBe(false);
    expect(rb.oldIndexValid).toBe(true);
    expect(rb.verdict).toEqual({ write: true });
    // 完整 + 没有旧索引 → 可写
    const c = await mk('l0rg-c-', false);
    const rc = await planRebuildForWrite(c.s.io, c.s.cfg, deps());
    expect(rc.plan.complete).toBe(true);
    expect(rc.oldIndexValid).toBe(false);
    expect(rc.verdict).toEqual({ write: true });
  });
});

describe('sessionsPerKey', () => {
  it('与磁盘重算(recomputeCounts)的 per_key[k].sessions 交叉核对一致', async () => {
    const fx = await makeRunFx('l0spk-');
    const a = await fx.work('alpha');
    await fx.claude(1, a);
    await fx.claude(2, a);
    await fx.claude(3, await fx.work('beta'));
    await runL0(fx);
    const plan = await planSessionStats(fx.s.io, 'claude', []);
    const mem = sessionsPerKey(plan);
    const disk = await recomputeCounts(fx.s.io, fx.s.cfg, new Date(fx.s.clock.t));
    expect(mem.size).toBe(2);
    for (const [k, n] of mem) expect(disk.perKey[k]?.sessions, k).toBe(n);
    expect([...mem.values()].sort()).toEqual([1, 2]);
  });
});
