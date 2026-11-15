/**
 * B1b:`Compactor` 的 P0–P4 崩溃 / 故障矩阵(内存与真文件系统同跑)。故障由 `crashFs` 注入:ENOSPC、EACCES(权限拒绝)、rename 失败(`commitTmp` 之前抛)、
 * 部分写(tmp 只写一半)、fsync 失败(tmp 已写完才抛)、rename 已落而进程随后死(`commitTmp` 之后抛)。
 * **对照世界**:同一输入不中断地跑一遍得到最终三文件字节;每个崩溃点都要求「重启(关闭注入)后重跑一次 = 与对照世界字节逐字节相同」,
 * 且重跑不重复计数(压缩文件 gen 仍为 1、`months` 不变)、不再调恢复端口、没有残留 tmp。
 */
import { describe, expect, it, vi } from 'vitest';
import { RsiAuditCompactionSchema } from '../../../src/contracts/rsi-store.js';
import { StoreError } from '../../../src/rsi/store/errors.js';
import {
  crashFs,
  emptyLedger,
  makeCWorld,
  rowOfEntry,
  seedAudit,
  seedLedger,
  snap,
  terminalRecord,
  type CWorld,
  type Crash,
  type CrashFs,
  type Snap,
} from './b1b-fixture.js';
import {
  FILES,
  ID,
  hex16,
  jsonLine,
  obsRow,
  rawAppend,
  trow,
  type FsKind,
} from './store-fixture.js';

vi.setConfig({ testTimeout: 120_000 });

const KINDS: readonly FsKind[] = ['mem', 'real'];
const W = '2026-10-31';
const RECENT = trow(hex16(9), '2026-11-10T08:00:00.000Z');
const rejects = async (p: Promise<unknown>): Promise<StoreError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected rejection');
};

interface Scenario {
  w: CWorld;
  fs: CrashFs;
  initial: Snap;
}
/** 输入:终态记录;审计 = 创建行 + 一条 10-05 观察行 + 一条 11-10 新行;账 = 一个旧键(P4 有东西可裁) */
async function build(kind: FsKind, crashes: Crash[], torn = false): Promise<Scenario> {
  const holder: { fs?: CrashFs } = {};
  const r = terminalRecord();
  const w = await makeCWorld(kind, {
    records: [r],
    wrap: (inner) => {
      holder.fs = crashFs(inner, crashes);
      return holder.fs;
    },
  });
  await seedAudit(
    w,
    [rowOfEntry(ID, r.transitions[0] as never), obsRow('2026-10-05T08:00:00.000Z'), RECENT],
    torn ? '{"at":"2026-11-1' : '',
  );
  await seedLedger(w, {
    ...emptyLedger(1),
    applied: [
      { key: 'old-key', event_at: '2026-09-02T00:00:00.000Z', batch_sha256: 'a'.repeat(64) },
    ],
  });
  return { w, fs: holder.fs as CrashFs, initial: await snap(w) };
}

/** 对照世界的最终字节 */
async function control(kind: FsKind, torn = false): Promise<Snap> {
  const c = await build(kind, [], torn);
  const res = await c.w.compactor.compact({ through: W });
  expect(res).toMatchObject({ kind: 'advanced', cleanup: { audit: 'done', ledger: 'done' } });
  return snap(c.w);
}

const gen = async (w: CWorld): Promise<number | null> => {
  const b = await w.bytes(FILES.compaction);
  return b === null ? null : RsiAuditCompactionSchema.parse(JSON.parse(b.toString('utf8'))).gen;
};

describe.each(KINDS)('P0 / P1 前:读故障与恢复提交失败(%s)', (kind) => {
  it('P1 读审计 EIO → 抛 store_io,三个文件字节不变、无 tmp;重启后与对照世界逐字节相同', async () => {
    const final = await control(kind);
    const { w, fs, initial } = await build(kind, [{ op: 'read', name: FILES.audit, code: 'EIO' }]);
    const e = await rejects(w.compactor.compact({ through: W }));
    expect([e.code, e.detail]).toEqual(['store_io', 'EIO']);
    expect(await snap(w)).toEqual(initial);
    expect(await w.tmpFiles()).toEqual([]);
    fs.disarm();
    await w.compactor.compact({ through: W });
    expect(await snap(w)).toEqual(final);
  });

  it('压缩前恢复的账提交 ENOSPC → compact_blocked{store_io}(返回,不抛),账 / 审计 / 压缩文件不变;重启后收敛', async () => {
    const final = await control(kind);
    const { w, fs, initial } = await build(kind, [
      { op: 'writeTmp', name: FILES.effects, code: 'ENOSPC' },
    ]);
    const res = await w.compactor.compact({ through: W });
    expect(res).toMatchObject({ kind: 'compact_blocked', cause: 'store_io' });
    expect(await snap(w)).toEqual(initial);
    expect(await w.tmpFiles()).toEqual([]);
    fs.disarm();
    await w.compactor.compact({ through: W });
    expect(await snap(w)).toEqual(final);
  });
});

const P2_FAULTS: readonly [string, Crash][] = [
  ['ENOSPC(tmp 写不下)', { op: 'writeTmp', name: FILES.compaction, code: 'ENOSPC' }],
  ['EACCES(权限拒绝)', { op: 'writeTmp', name: FILES.compaction, code: 'EACCES' }],
  [
    '部分写(tmp 只写一半)',
    { op: 'writeTmp', name: FILES.compaction, code: 'EIO', mode: 'partial' },
  ],
  [
    'fsync 失败(tmp 已写完才抛)',
    { op: 'writeTmp', name: FILES.compaction, code: 'EIO', mode: 'after' },
  ],
  ['rename 失败', { op: 'commitTmp', name: FILES.compaction, code: 'EXDEV' }],
];

describe.each(KINDS)('P2 提交点之前失败(%s)', (kind) => {
  it.each(P2_FAULTS)(
    '%s:抛 store_io;压缩文件不存在、审计字节不变、tmp 已清;重启后恢复不再调、与对照世界相同、gen = 1',
    async (_n, crash) => {
      const final = await control(kind);
      const { w, fs, initial } = await build(kind, [crash]);
      const e = await rejects(w.compactor.compact({ through: W }));
      expect(e.code).toBe('store_io');
      const after = await snap(w);
      expect(after.compaction).toBeNull();
      expect(after.audit).toBe(initial.audit);
      expect(await w.tmpFiles()).toEqual([]);
      expect(w.recoveryCalls).toHaveLength(1); // 恢复已提交账(既定事件的既定效果,不回滚)
      fs.disarm();
      const again = await w.compactor.compact({ through: W });
      expect(again).toMatchObject({ kind: 'advanced', cleanup: { audit: 'done', ledger: 'done' } });
      expect(w.recoveryCalls).toHaveLength(1); // 账已满足 → 不再调恢复
      expect(await snap(w)).toEqual(final);
      expect(await gen(w)).toBe(1);
    },
  );
});

describe.each(KINDS)('P2 之后、P3 之前(rename 已落进程死)(%s)', (kind) => {
  it('压缩文件已是 gen 1 而审计 / 账仍未清:重启后只续 P3 / P4,不重复计数,与对照世界逐字节相同', async () => {
    const final = await control(kind);
    const { w, fs, initial } = await build(kind, [
      { op: 'commitTmp', name: FILES.compaction, code: 'EIO', mode: 'after' },
    ]);
    const e = await rejects(w.compactor.compact({ through: W }));
    expect(e.code).toBe('store_io');
    const mid = await snap(w);
    expect(mid.compaction).toBe(final.compaction); // 提交点已过:months 已定
    expect(mid.audit).toBe(initial.audit); // 残留行还在
    fs.disarm();
    const again = await w.compactor.compact({ through: W });
    expect(again).toEqual({
      kind: 'noop',
      through: W,
      cleanup: { audit: 'done', ledger: 'done' },
    });
    expect(await snap(w)).toEqual(final);
    expect(await gen(w)).toBe(1);
  });
});

const P3_FAULTS: readonly [string, Crash][] = [
  ['ENOSPC', { op: 'writeTmp', name: FILES.audit, code: 'ENOSPC' }],
  ['EACCES(权限拒绝)', { op: 'writeTmp', name: FILES.audit, code: 'EACCES' }],
  ['部分写', { op: 'writeTmp', name: FILES.audit, code: 'EIO', mode: 'partial' }],
  ['fsync 失败', { op: 'writeTmp', name: FILES.audit, code: 'EIO', mode: 'after' }],
  ['rename 失败', { op: 'commitTmp', name: FILES.audit, code: 'EXDEV' }],
];

describe.each(KINDS)('P3 失败:提交点已过,不抛,记入 cleanup(%s)', (kind) => {
  it.each(P3_FAULTS)(
    '%s:advanced + cleanup.audit=pending(P4 照做);审计残留行原样;重启后续删且 months / gen 不变、不重算增量',
    async (_n, crash) => {
      const final = await control(kind);
      const { w, fs, initial } = await build(kind, [crash]);
      const res = await w.compactor.compact({ through: W });
      expect(res).toMatchObject({
        kind: 'advanced',
        gen: 1,
        cleanup: { audit: 'pending', ledger: 'done', cause: 'store_io' },
      });
      const mid = await snap(w);
      expect(mid.audit).toBe(initial.audit);
      expect(mid.compaction).toBe(final.compaction);
      expect(await w.tmpFiles()).toEqual([]);
      fs.disarm();
      expect(await w.compactor.compact({ through: W })).toEqual({
        kind: 'noop',
        through: W,
        cleanup: { audit: 'done', ledger: 'none' },
      });
      expect(await snap(w)).toEqual(final);
      expect(await gen(w)).toBe(1); // p3_resume_does_not_recount
    },
  );

  it('P3 rename 已落而进程随后死:审计已是干净的,重启 = 无事可做', async () => {
    const final = await control(kind);
    const { w, fs } = await build(kind, [
      { op: 'commitTmp', name: FILES.audit, code: 'EIO', mode: 'after' },
    ]);
    const res = await w.compactor.compact({ through: W });
    expect(res).toMatchObject({ kind: 'advanced', cleanup: { audit: 'pending', ledger: 'done' } });
    expect((await snap(w)).audit).toBe(final.audit);
    fs.disarm();
    expect(await w.compactor.compact({ through: W })).toMatchObject({
      kind: 'noop',
      cleanup: { audit: 'none', ledger: 'none' },
    });
    expect(await snap(w)).toEqual(final);
  });

  it('撕裂尾 + P3 失败:尾巴留着(没有被单独先修);重启后 P3 一并去掉,字节与对照世界相同', async () => {
    const final = await control(kind, true);
    const { w, fs, initial } = await build(
      kind,
      [{ op: 'commitTmp', name: FILES.audit, code: 'EXDEV' }],
      true,
    );
    const res = await w.compactor.compact({ through: W });
    expect(res).toMatchObject({ kind: 'advanced', cleanup: { audit: 'pending' } });
    expect((await snap(w)).audit).toBe(initial.audit);
    expect(initial.audit?.endsWith('{"at":"2026-11-1')).toBe(true);
    fs.disarm();
    await w.compactor.compact({ through: W });
    expect(await snap(w)).toEqual(final);
    expect(final.audit).toBe(jsonLine(RECENT));
  });
});

const P4_FAULTS: readonly [string, Crash][] = [
  ['ENOSPC', { op: 'writeTmp', name: FILES.effects, code: 'ENOSPC', skip: 1 }],
  ['EACCES(权限拒绝)', { op: 'writeTmp', name: FILES.effects, code: 'EACCES', skip: 1 }],
  ['部分写', { op: 'writeTmp', name: FILES.effects, code: 'EIO', mode: 'partial', skip: 1 }],
  ['fsync 失败', { op: 'writeTmp', name: FILES.effects, code: 'EIO', mode: 'after', skip: 1 }],
  ['rename 失败', { op: 'commitTmp', name: FILES.effects, code: 'EXDEV', skip: 1 }],
];

describe.each(KINDS)('P4 失败:记入 cleanup,惰性续做(%s)', (kind) => {
  it.each(P4_FAULTS)(
    '%s:advanced + cleanup.ledger=pending(P3 已完成);账未裁;重启后续裁,与对照世界相同',
    async (_n, crash) => {
      const final = await control(kind);
      const { w, fs } = await build(kind, [crash]);
      const res = await w.compactor.compact({ through: W });
      expect(res).toMatchObject({
        kind: 'advanced',
        cleanup: { audit: 'done', ledger: 'pending', cause: 'store_io' },
      });
      const mid = await snap(w);
      expect(mid.audit).toBe(final.audit);
      expect(mid.effects).not.toBe(final.effects); // 账里的旧键还在
      expect(await w.tmpFiles()).toEqual([]);
      fs.disarm();
      expect(await w.compactor.compact({ through: W })).toEqual({
        kind: 'noop',
        through: W,
        cleanup: { audit: 'none', ledger: 'done' },
      });
      expect(await snap(w)).toEqual(final);
      expect(await gen(w)).toBe(1);
    },
  );

  it('P4 rename 已落而进程随后死:账已裁,重启 = 无事可做', async () => {
    const final = await control(kind);
    const { w, fs } = await build(kind, [
      { op: 'commitTmp', name: FILES.effects, code: 'EIO', mode: 'after', skip: 1 },
    ]);
    const res = await w.compactor.compact({ through: W });
    expect(res).toMatchObject({ kind: 'advanced', cleanup: { audit: 'done', ledger: 'pending' } });
    expect((await snap(w)).effects).toBe(final.effects);
    fs.disarm();
    expect(await w.compactor.compact({ through: W })).toMatchObject({
      kind: 'noop',
      cleanup: { audit: 'none', ledger: 'none' },
    });
    expect(await snap(w)).toEqual(final);
  });
});

describe.each(KINDS)('崩溃重入:同一输入连续两次故障再收敛(%s)', (kind) => {
  it('P2 失败后又 P3 失败,再重启:最终与对照世界相同,压缩 gen = 1,恢复只调一次', async () => {
    const final = await control(kind);
    const { w, fs } = await build(kind, [
      { op: 'commitTmp', name: FILES.compaction, code: 'EXDEV' },
      { op: 'writeTmp', name: FILES.audit, code: 'ENOSPC' },
    ]);
    await rejects(w.compactor.compact({ through: W })); // P2 前
    expect(await gen(w)).toBeNull();
    const second = await w.compactor.compact({ through: W }); // P2 成功,P3 被注入
    expect(second).toMatchObject({ kind: 'advanced', cleanup: { audit: 'pending' } });
    fs.disarm();
    await w.compactor.compact({ through: W });
    expect(await snap(w)).toEqual(final);
    expect(await gen(w)).toBe(1);
    expect(w.recoveryCalls).toHaveLength(1);
  });

  it('W 之后的行(11-10 / 11-12)不被并入汇总、不被删除', async () => {
    const { w } = await build(kind, []);
    await rawAppend(w, FILES.audit, jsonLine(trow(hex16(0x31), '2026-11-12T00:00:00.000Z')));
    await w.compactor.compact({ through: W });
    const text = (await w.bytes(FILES.audit))?.toString('utf8') ?? '';
    expect(text).toBe(jsonLine(RECENT) + jsonLine(trow(hex16(0x31), '2026-11-12T00:00:00.000Z')));
  });
});
