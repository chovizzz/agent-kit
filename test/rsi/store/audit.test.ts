/**
 * B1a:审计追加器与分类函数——first / replay 区分(`compacted` 负向)、`appendObservation`、`idem_key`、坏行 / 撕裂尾 / 重复键 / 同键冲突(含 `at`)、R5 例外、容量。
 * 追加器测试内存假件与真文件系统同跑;分类函数是纯函数。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyAuditFile,
  isNoopObservation,
  sameRowForKey,
} from '../../../src/rsi/store/audit-classify.js';
import { AuditKeyConflict, AuditSealedError, StoreError } from '../../../src/rsi/store/errors.js';
import type {
  AuthoritativeEvent,
  ReconcileSource,
  SealRegion,
} from '../../../src/rsi/store/ports.js';
import { unwiredReconcileSource } from '../../../src/rsi/store/reconcile.js';
import {
  AT1,
  FILES,
  ID,
  compactionDoc,
  faulty,
  hex16,
  jsonLine,
  makeWorld,
  noopRow,
  obsRow,
  rawAppend,
  seed,
  trow,
  type FsKind,
  type World,
} from './store-fixture.js';

const KINDS: readonly FsKind[] = ['mem', 'real'];
const REPLAY = { kind: 'replay', source: { kind: 'test', ref: 'r' } } as const;
const text = async (w: World): Promise<string> =>
  (await w.bytes(FILES.audit))?.toString('utf8') ?? '';
const rejects = async (p: Promise<unknown>): Promise<StoreError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected rejection');
};
const fullAudit = (): string =>
  Array.from({ length: 20000 }, (_, i) => jsonLine(trow(hex16(i + 1)))).join('');
const resolverOf = (
  map: Record<string, AuthoritativeEvent | null>,
): Pick<ReconcileSource, 'resolve'> => ({
  resolve: async (_loc, key) => map[key] ?? null,
});

describe('classifyAuditFile(纯函数)', () => {
  it('空文件 / 合法行 = ok;带键行进 byKey', () => {
    expect(classifyAuditFile('')).toEqual({ kind: 'ok', rows: [], byKey: new Map() });
    const c = classifyAuditFile(jsonLine(trow(hex16(1))) + jsonLine(obsRow()));
    expect(c.kind).toBe('ok');
    if (c.kind !== 'ok') return;
    expect(c.rows).toHaveLength(2);
    expect([...c.byKey.keys()]).toEqual([hex16(1)]);
  });

  it('无结尾换行的片段 = torn_tail,goodText 是其前的合法前缀;完整 JSON 但缺换行同样算撕裂尾(对照:补上换行即 ok)', () => {
    const good = jsonLine(trow(hex16(1)));
    const torn = classifyAuditFile(`${good}{"at":"2026-11-15T08:00`);
    expect(torn).toMatchObject({ kind: 'torn_tail', goodText: good });
    const whole = JSON.stringify(trow(hex16(2)));
    expect(classifyAuditFile(good + whole)).toMatchObject({ kind: 'torn_tail', goodText: good });
    expect(classifyAuditFile(`${good}${whole}\n`).kind).toBe('ok');
  });

  it('中间坏行 / schema 非法行 / 空行 / 重复键 = bad,带行号与具体原因', () => {
    const g = jsonLine(trow(hex16(1)));
    expect(classifyAuditFile(`${g}nope\n${g}`)).toEqual({
      kind: 'bad',
      cause: 'audit_bad_line',
      line: 2,
      detail: 'json',
    });
    expect(classifyAuditFile(`${g}{"at":"x"}\n`)).toEqual({
      kind: 'bad',
      cause: 'audit_bad_line',
      line: 2,
      detail: 'schema',
    });
    expect(classifyAuditFile(`${g}\n${g}`)).toMatchObject({ kind: 'bad', line: 2 });
    expect(classifyAuditFile(g + jsonLine(trow(hex16(1), '2026-11-15T09:00:00.000Z')))).toEqual({
      kind: 'bad',
      cause: 'audit_dup_key',
      line: 2,
      detail: hex16(1),
    });
  });

  it('同键内容规则:默认含 at;唯一例外是终态空操作行(排除 at);其它字段不同仍冲突', () => {
    expect(sameRowForKey(trow(hex16(1)), trow(hex16(1)))).toBe(true);
    expect(sameRowForKey(trow(hex16(1)), trow(hex16(1), '2026-11-15T09:00:00.000Z'))).toBe(false);
    expect(sameRowForKey(noopRow(hex16(2)), noopRow(hex16(2), '2026-11-15T09:00:00.000Z'))).toBe(
      true,
    );
    expect(sameRowForKey(noopRow(hex16(2)), { ...noopRow(hex16(2)), reason: 'noop:other' })).toBe(
      false,
    );
    // 判别式:自环但不是终态 = 不算 R5(rolling_back 自环有条目、有权威源)
    const selfLoop = trow(hex16(3), AT1, { from: 'rolling_back', to: 'rolling_back' });
    expect(isNoopObservation(selfLoop)).toBe(false);
    expect(sameRowForKey(selfLoop, { ...selfLoop, at: '2026-11-15T09:00:00.000Z' })).toBe(false);
    expect(isNoopObservation(noopRow(hex16(4)))).toBe(true);
  });
});

describe.each(KINDS)('appendKeyed replay / appendObservation(%s)', (kind) => {
  it('replay:首次 appended,同键同内容 already(不重复追加),文件恰一行', async () => {
    const w = await makeWorld(kind);
    expect(await w.store.appender.appendKeyed([trow(hex16(1))], REPLAY)).toEqual(['appended']);
    const once = await text(w);
    expect(await w.store.appender.appendKeyed([trow(hex16(1))], REPLAY)).toEqual(['already']);
    expect(await text(w)).toBe(once);
    expect(once.split('\n').filter((l) => l !== '')).toHaveLength(1);
  });

  it('audit_key_conflict_includes_at:同键 at 不同 = AuditKeyConflict,零写入;对照:同键同内容 already', async () => {
    const w = await makeWorld(kind);
    await w.store.appender.appendKeyed([trow(hex16(1))], REPLAY);
    const before = await text(w);
    const e = await rejects(
      w.store.appender.appendKeyed([trow(hex16(1), '2026-11-15T09:00:00.000Z')], REPLAY),
    );
    expect(e).toBeInstanceOf(AuditKeyConflict);
    expect([e.code, e.detail, e.reason]).toEqual(['audit_key_conflict', hex16(1), 'audit_invalid']);
    expect(await text(w)).toBe(before);
    const e2 = await rejects(
      w.store.appender.appendKeyed([trow(hex16(1), AT1, { reason: 'other' })], REPLAY),
    );
    expect(e2.code).toBe('audit_key_conflict');
  });

  it('r5_conflict_ignores_at:终态空操作行同键异 at = already;异 reason = 冲突', async () => {
    const w = await makeWorld(kind);
    await w.store.appender.appendKeyed([noopRow(hex16(2))], REPLAY);
    expect(
      await w.store.appender.appendKeyed([noopRow(hex16(2), '2026-11-15T10:00:00.000Z')], REPLAY),
    ).toEqual(['already']);
    const e = await rejects(
      w.store.appender.appendKeyed([{ ...noopRow(hex16(2)), reason: 'noop:other' }], REPLAY),
    );
    expect(e.code).toBe('audit_key_conflict');
  });

  it('批内:同键同内容 = 第二项 already;同键异内容 = 冲突且整批零写入;缺 idem_key = audit_key_missing', async () => {
    const w = await makeWorld(kind);
    expect(
      await w.store.appender.appendKeyed([trow(hex16(1)), trow(hex16(1)), trow(hex16(2))], REPLAY),
    ).toEqual(['appended', 'already', 'appended']);
    const w2 = await makeWorld(kind);
    const e = await rejects(
      w2.store.appender.appendKeyed(
        [trow(hex16(5)), trow(hex16(1)), trow(hex16(1), '2026-11-15T09:00:00.000Z')],
        REPLAY,
      ),
    );
    expect(e.detail).toBe(`batch:${hex16(1)}`);
    expect(await text(w2)).toBe('');
    const { idem_key: _k, ...noKey } = trow(hex16(9));
    void _k;
    expect((await rejects(w2.store.appender.appendKeyed([noKey], REPLAY))).code).toBe(
      'audit_key_missing',
    );
    expect(await text(w2)).toBe('');
  });

  it('item 不过 schema = audit_bad_line(item_schema)', async () => {
    const w = await makeWorld(kind);
    const bad = { ...trow(hex16(1)), idem_key: 'short' };
    expect((await rejects(w.store.appender.appendKeyed([bad], REPLAY))).detail).toBe('item_schema');
  });

  it('audit_midfile_bad_failclosed:中间坏行 / 重复键 = fail-closed,文件逐字节不变;对照:干净文件可追加', async () => {
    const g = jsonLine(trow(hex16(1)));
    const cases: [string, string, string, string][] = [
      ['bad json', `${g}garbage\n${jsonLine(trow(hex16(2)))}`, 'audit_bad_line', 'line:2:json'],
      ['bad schema', `${g}${jsonLine({ at: 'x' })}`, 'audit_bad_line', 'line:2:schema'],
      [
        'dup key',
        g + jsonLine(trow(hex16(1), '2026-11-15T09:00:00.000Z')),
        'audit_dup_key',
        `line:2:${hex16(1)}`,
      ],
    ];
    for (const [name, content, code, detail] of cases) {
      const w = await makeWorld(kind);
      await seed(w, FILES.audit, content);
      const e = await rejects(w.store.appender.appendKeyed([trow(hex16(7))], REPLAY));
      expect([name, e.code, e.detail]).toEqual([name, code, detail]);
      expect((await rejects(w.store.appender.appendObservation(obsRow()))).code).toBe(code);
      expect(await text(w)).toBe(content);
    }
    const ok = await makeWorld(kind);
    await seed(ok, FILES.audit, g);
    expect(await ok.store.appender.appendKeyed([trow(hex16(7))], REPLAY)).toEqual(['appended']);
  });

  it('撕裂尾:追加前先修尾(丢弃片段),再追加;冲突时零写入(不修尾)', async () => {
    const g = jsonLine(trow(hex16(1)));
    const w = await makeWorld(kind);
    await seed(w, FILES.audit, `${g}{"at":"2026-11-15T08:`);
    expect(await w.store.appender.appendKeyed([trow(hex16(2))], REPLAY)).toEqual(['appended']);
    expect(await text(w)).toBe(g + jsonLine(trow(hex16(2))));
    expect(await w.tmpFiles()).toEqual([]);
    // 冲突 → 零写入:撕裂尾原样保留
    const w2 = await makeWorld(kind);
    const torn = `${g}{"at":"2026-11-15T08:`;
    await seed(w2, FILES.audit, torn);
    await rejects(
      w2.store.appender.appendKeyed([trow(hex16(1), '2026-11-15T09:00:00.000Z')], REPLAY),
    );
    expect(await text(w2)).toBe(torn);
    // 全部 already 也不修尾(没有要追加的行)
    expect(await w2.store.appender.appendKeyed([trow(hex16(1))], REPLAY)).toEqual(['already']);
    expect(await text(w2)).toBe(torn);
  });

  it('audit_full:20000 行再追加 = audit_full(reason=audit_full),文件不变;已存在的键仍 already(对照)', async () => {
    const w = await makeWorld(kind);
    await seed(w, FILES.audit, fullAudit());
    const before = await text(w);
    const e = await rejects(w.store.appender.appendKeyed([trow(hex16(99999))], REPLAY));
    expect([e.code, e.reason]).toEqual(['audit_full', 'audit_full']);
    expect((await rejects(w.store.appender.appendObservation(obsRow()))).code).toBe('audit_full');
    expect(await text(w)).toBe(before);
    expect(await w.store.appender.appendKeyed([trow(hex16(1))], REPLAY)).toEqual(['already']);
  });

  it('appendObservation:无键行追加;带键 / transition / 保护标记行被拒;日 ≤ W = clock_regressed(日 == W+1 通过)', async () => {
    const w = await makeWorld(kind);
    expect(await w.store.appender.appendObservation(obsRow())).toBe('appended');
    expect(await text(w)).toBe(jsonLine(obsRow()));
    expect(
      (await rejects(w.store.appender.appendObservation({ ...obsRow(), idem_key: hex16(1) })))
        .detail,
    ).toBe('observation_has_key');
    const { idem_key: _k, ...keyless } = trow(hex16(1));
    void _k;
    expect((await rejects(w.store.appender.appendObservation(keyless))).code).toBe(
      'audit_key_missing',
    );
    const mark = { at: AT1, kind: 'reconcile' as const, id: ID, reason: 'protection_unclassified' };
    expect((await rejects(w.store.appender.appendObservation(mark))).code).toBe(
      'audit_key_missing',
    );
    // 普通 reconcile 行(非保护标记)可走观察入口(对照)
    expect(
      await w.store.appender.appendObservation({
        at: AT1,
        kind: 'reconcile',
        id: ID,
        reason: 'other',
      }),
    ).toBe('appended');
    await seed(w, FILES.compaction, JSON.stringify(compactionDoc('2026-11-14')));
    const e = await rejects(
      w.store.appender.appendObservation({ ...obsRow('2026-11-14T23:59:59.999Z') }),
    );
    expect([e.code, e.detail]).toEqual(['clock_regressed', '2026-11-14<=2026-11-14']);
    expect(await w.store.appender.appendObservation(obsRow('2026-11-15T00:00:00.000Z'))).toBe(
      'appended',
    );
  });

  it('already_audit_under_watermark_suppressed:水位线之下的 replay —— 无源 / 源缺失 / 源内容不符 = sealed_unknown_event(零写入);源逐字段相等才 compacted', async () => {
    const old = trow(hex16(1), '2026-11-10T08:00:00.000Z');
    const same: AuthoritativeEvent = { idem_key: hex16(1), row: old };
    const mk = async (map: Record<string, AuthoritativeEvent | null>): Promise<World> => {
      const w = await makeWorld(kind, { reconcile: resolverOf(map) });
      await seed(w, FILES.compaction, JSON.stringify(compactionDoc('2026-11-14')));
      return w;
    };
    // 逐字段相等 → compacted,文件不写
    const w = await mk({ [hex16(1)]: same });
    expect(await w.store.appender.appendKeyed([old], REPLAY)).toEqual(['compacted']);
    expect(await w.bytes(FILES.audit)).toBeNull();
    // 对照:水位线之后(11-15)照常追加
    expect(await w.store.appender.appendKeyed([trow(hex16(2), AT1)], REPLAY)).toEqual(['appended']);
    // 无 reconcile 接线
    const bare = await makeWorld(kind);
    await seed(bare, FILES.compaction, JSON.stringify(compactionDoc('2026-11-14')));
    expect((await rejects(bare.store.appender.appendKeyed([old], REPLAY))).code).toBe(
      'sealed_unknown_event',
    );
    expect(await bare.bytes(FILES.audit)).toBeNull();
    // 源里没有 / 源里同键但 at 或内容不同
    const diffs: Record<string, AuthoritativeEvent | null> = {
      missing: null,
      at: { idem_key: hex16(1), row: { ...old, at: '2026-11-10T09:00:00.000Z' } },
      reason: { idem_key: hex16(1), row: { ...old, reason: 'x' } },
      to: { idem_key: hex16(1), row: { ...old, to: 'canary' } },
      key: { idem_key: hex16(2), row: old },
    };
    for (const [name, ev] of Object.entries(diffs)) {
      const d = await mk({ [hex16(1)]: ev });
      const e = await rejects(d.store.appender.appendKeyed([old], REPLAY));
      expect([name, e.code, e instanceof AuditSealedError]).toEqual([
        name,
        'sealed_unknown_event',
        true,
      ]);
      expect(await d.bytes(FILES.audit)).toBeNull();
    }
  });

  it('水位线之下但文件里已有同键行(残留):already,不看源', async () => {
    const old = trow(hex16(1), '2026-11-10T08:00:00.000Z');
    const w = await makeWorld(kind);
    await seed(w, FILES.audit, jsonLine(old));
    await seed(w, FILES.compaction, JSON.stringify(compactionDoc('2026-11-14')));
    expect(await w.store.appender.appendKeyed([old], REPLAY)).toEqual(['already']);
  });

  it('未接线的 ReconcileSource:所有方法 = compact_unwired(fail-closed,不得以空扫描通过)', async () => {
    for (const call of [
      () => unwiredReconcileSource.entriesThrough('2026-11-01'),
      () => unwiredReconcileSource.batchesThrough('2026-11-01'),
      () => unwiredReconcileSource.derivedThrough('2026-11-01'),
      () => unwiredReconcileSource.resolve({ kind: 'k', ref: 'r' }, hex16(1)),
    ]) {
      expect((await rejects(call())).code).toBe('compact_unwired');
    }
  });
});

describe.each(KINDS)('appendKeyed first(%s)', (kind) => {
  const regionOf = async (w: World, now = AT1): Promise<SealRegion> => {
    const r = await w.store.seal.open(w.personal);
    r.stampFirst(() => new Date(now));
    return r;
  };

  it('first:appended / already;返回值恒不含 compacted;尝试结束后区域自动关闭', async () => {
    const w = await makeWorld(kind);
    const region = await regionOf(w);
    expect(region.state).toBe('stamped');
    const res = await w.store.appender.appendKeyed([trow(hex16(1)), trow(hex16(2))], {
      kind: 'first',
      region,
    });
    expect(res).toEqual(['appended', 'appended']);
    expect(res.every((r) => r === 'appended' || r === 'already')).toBe(true);
    expect(region.state).toBe('closed');
    const r2 = await regionOf(w);
    expect(
      await w.store.appender.appendKeyed([trow(hex16(1))], { kind: 'first', region: r2 }),
    ).toEqual(['already']);
  });

  it('first_has_no_compacted_return / compacted_requires_replay_source:stamp 之后 W 被推过(伪造 / 竞态)→ sealed_interval,零写入,不返回 compacted', async () => {
    const w = await makeWorld(kind, {
      reconcile: resolverOf({
        [hex16(1)]: { idem_key: hex16(1), row: trow(hex16(1), '2026-11-10T08:00:00.000Z') },
      }),
    });
    const region = await regionOf(w, '2026-11-10T08:00:00.000Z'); // 打 stamp 时尚无水位线
    await seed(w, FILES.compaction, JSON.stringify(compactionDoc('2026-11-14'))); // 之后被推过
    const e = await rejects(
      w.store.appender.appendKeyed([trow(hex16(1), '2026-11-10T08:00:00.000Z')], {
        kind: 'first',
        region,
      }),
    );
    expect([e.code, e instanceof AuditSealedError]).toEqual(['sealed_interval', true]);
    expect(await w.bytes(FILES.audit)).toBeNull();
    expect(region.state).toBe('closed'); // 失败也结束区域
  });

  it('first_append_after_region_closed_refused:关闭后再用同一区域 = region_closed;未 stamp 的区域同样拒绝', async () => {
    const w = await makeWorld(kind);
    const region = await regionOf(w);
    await w.store.appender.appendKeyed([trow(hex16(1))], { kind: 'first', region });
    const e = await rejects(
      w.store.appender.appendKeyed([trow(hex16(2))], { kind: 'first', region }),
    );
    expect([e.code, e.detail]).toEqual(['region_closed', 'audit:closed']);
    const fresh = await w.store.seal.open(w.personal); // 未 stamp
    const e2 = await rejects(
      w.store.appender.appendKeyed([trow(hex16(3))], { kind: 'first', region: fresh }),
    );
    expect([e2.code, e2.detail]).toEqual(['region_closed', 'audit:open']);
    expect(await text(w)).toBe(jsonLine(trow(hex16(1))));
  });

  it('不是本模块创建的区域 = region_closed(foreign_region)', async () => {
    const w = await makeWorld(kind);
    const foreign: SealRegion = {
      state: 'stamped',
      watermark: null,
      stampFirst: () => AT1,
      markSourceCommitted: () => undefined,
      close: () => undefined,
    };
    const e = await rejects(
      w.store.appender.appendKeyed([trow(hex16(1))], { kind: 'first', region: foreign }),
    );
    expect([e.code, e.detail]).toEqual(['region_closed', 'foreign_region']);
  });
});

describe.each(KINDS)('审计追加的故障注入(%s)', (kind) => {
  it('追加前失败(EACCES / ENOSPC):抛 store_io(detail=errno),文件不变', async () => {
    for (const code of ['EACCES', 'ENOSPC']) {
      const w = await makeWorld(kind, { wrap: (i) => faulty(i, [{ op: 'appendSynced', code }]) });
      await seed(w, FILES.audit, jsonLine(trow(hex16(1))));
      const before = await text(w);
      const e = await rejects(w.store.appender.appendKeyed([trow(hex16(2))], REPLAY));
      expect([e.code, e.detail]).toEqual(['store_io', code]);
      expect(await text(w)).toBe(before);
    }
  });

  it('部分写(写出一半后失败):文件留下撕裂尾;下一次追加先修尾,最终恰有一份新行、旧行不丢', async () => {
    const w = await makeWorld(kind, {
      wrap: (i) => faulty(i, [{ op: 'appendSynced', code: 'EIO', mode: 'partial' }]),
    });
    await seed(w, FILES.audit, jsonLine(trow(hex16(1))));
    const e = await rejects(w.store.appender.appendKeyed([trow(hex16(2))], REPLAY));
    expect([e.code, e.detail]).toEqual(['store_io', 'EIO']);
    expect(classifyAuditFile(await text(w)).kind).toBe('torn_tail');
    expect(await w.store.appender.appendKeyed([trow(hex16(2))], REPLAY)).toEqual(['appended']); // 故障只注入一次
    expect(await text(w)).toBe(jsonLine(trow(hex16(1))) + jsonLine(trow(hex16(2))));
  });

  it('fsync 失败(行已落盘却抛错)= 重试得 already,不重复(crash_d:行已落未返回)', async () => {
    const w = await makeWorld(kind, {
      wrap: (i) => faulty(i, [{ op: 'appendSynced', code: 'EIO', mode: 'after' }]),
    });
    await rejects(w.store.appender.appendKeyed([trow(hex16(2))], REPLAY));
    expect(await text(w)).toBe(jsonLine(trow(hex16(2)))); // 行在文件里
    expect(await w.store.appender.appendKeyed([trow(hex16(2))], REPLAY)).toEqual(['already']);
    expect(await text(w)).toBe(jsonLine(trow(hex16(2))));
  });

  it('撕裂尾修复时 rename 失败:抛 store_io、tmp 清理、文件仍是原样(撕裂尾)', async () => {
    const w = await makeWorld(kind, {
      wrap: (i) => faulty(i, [{ op: 'commitTmp', name: FILES.audit, code: 'EXDEV' }]),
    });
    const torn = `${jsonLine(trow(hex16(1)))}{"at":"2026`;
    await seed(w, FILES.audit, torn);
    const e = await rejects(w.store.appender.appendKeyed([trow(hex16(2))], REPLAY));
    expect([e.code, e.detail]).toEqual(['store_io', 'EXDEV']);
    expect(await text(w)).toBe(torn);
    expect(await w.tmpFiles()).toEqual([]);
  });

  it('读审计文件失败(EIO)= store_io,不当作文件不存在', async () => {
    const w = await makeWorld(kind, {
      wrap: (i) => faulty(i, [{ op: 'read', name: FILES.audit, code: 'EIO' }]),
    });
    expect((await rejects(w.store.appender.appendObservation(obsRow()))).detail).toBe('EIO');
  });

  it('rawAppend 工具自检:追加到不存在的文件即创建(夹具对照)', async () => {
    const w = await makeWorld(kind);
    await rawAppend(w, FILES.audit, 'x\n');
    expect(await text(w)).toBe('x\n');
  });
});
