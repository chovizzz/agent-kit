/**
 * R20-A6:`src/rsi/pending.ts`(R20-17.1–R20-17.4a、R20-17.14a)——暂存 / 待审 / 待通知三个集合与扫描协议、`notice_full` 唯一谓词、
 * `dismissed.json` / `notice.json` 的只读读取。全部在假 HOME / KIT_TMP 内的真实目录上跑(不 mock 文件系统)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_ACCOUNT_FILE_MAX_BYTES,
  RSI_DISMISSED_MAX,
  RSI_NOTICE_MAX,
  RSI_NOTICE_READ_MAX,
} from '../../src/contracts/rsi.js';
import { mkdirp, remove, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import {
  noticeFull,
  readDismissed,
  readNotice,
  scanPending,
  stagedRuns,
  type Classify,
  type PendingScan,
} from '../../src/rsi/pending.js';
import { RsiSnapshotError } from '../../src/rsi/snapshot-read.js';
import { dismissedDoc, noticeDoc, putReport, putRsiFile, reportDoc } from './a6-fixture.js';
import { key, makeRoFx, type RoFx } from './ro-fixture.js';

const allP: Classify = () => 'P';
const entry = (
  run_id: string,
  o: { proposals?: number; keys?: string[]; tainted?: boolean } = {},
) => ({
  run_id,
  proposals: o.proposals ?? 1,
  evidence_keys: o.keys ?? [key(1)],
  tainted: o.tainted ?? false,
});

function known(s: PendingScan): Extract<PendingScan, { known: true }> {
  if (!s.known) throw new Error(`扫描未知:${s.reason}`);
  return s;
}
const ids = (rs: readonly { runId: string }[]): string[] => rs.map((r) => r.runId);

async function fx(prefix: string): Promise<RoFx> {
  return makeRoFx(prefix);
}
const input = (
  f: RoFx,
  staged: ReturnType<typeof entry>[],
  over: Partial<Parameters<typeof scanPending>[0]> = {},
) => ({
  stateDir: f.io.stateDir,
  staged,
  classify: allP,
  dismissed: new Set<string>(),
  notified: new Set<string>(),
  ...over,
});

describe('R20-17.1 暂存 run:证据非空、全部归属 P、未 tainted', () => {
  it('tainted / 证据为空 / 含 X / 含 U 的都不是暂存 run;结果按 run_id 升序', () => {
    const cls: Classify = (k) => (k === 'x' ? 'X' : k === 'u' ? 'U' : 'P');
    const got = stagedRuns(
      [
        entry('r-b'),
        entry('r-a'),
        entry('r-taint', { tainted: true }),
        entry('r-empty', { keys: [] }),
        entry('r-x', { keys: [key(1), 'x'] }),
        entry('r-u', { keys: ['u'] }),
      ],
      cls,
    );
    expect(ids(got)).toEqual(['r-a', 'r-b']);
  });
});

describe('R20-17.2 / R20-17.3 待审与待通知', () => {
  it('待审 = 暂存 ∧ report 可读且 run_id 一致 ∧ 未忽略;待通知再要求 mode=ingest 且未通知;读不了 / 不一致 / 目录缺失计入 unreadable', async () => {
    const f = await fx('a6-pend-');
    await putReport(f, 'r-ingest', 'ingest', 2);
    await putReport(f, 'r-llm', 'llm', 1);
    await putReport(f, 'r-dismissed', 'ingest', 1);
    await putReport(f, 'r-notified', 'ingest', 1);
    await putReport(
      f,
      'r-mismatch',
      'ingest',
      1,
      `${JSON.stringify(reportDoc('r-other', 'ingest', ['2026-10-24-001']))}\n`,
    );
    await putReport(f, 'r-garbage', 'ingest', 1, '{not json');
    await putReport(f, 'r-schema', 'ingest', 1, '{"run_id":"r-schema"}');
    const names = [
      'r-ingest',
      'r-llm',
      'r-dismissed',
      'r-notified',
      'r-mismatch',
      'r-garbage',
      'r-schema',
      'r-nodir',
    ];
    const staged = names.map((n) => entry(n, { proposals: n === 'r-ingest' ? 2 : 1 }));
    const s = known(
      await scanPending(
        input(f, staged, {
          dismissed: new Set(['r-dismissed']),
          notified: new Set(['r-notified']),
        }),
      ),
    );
    expect(ids(s.staged)).toEqual([...names].sort());
    expect(ids(s.pending)).toEqual(['r-ingest', 'r-llm', 'r-notified']);
    expect(ids(s.toNotify)).toEqual(['r-ingest']); // r-llm:手动 --run-llm 的结果用户已在前台看到;r-notified 已通知
    expect(s.pending.find((r) => r.runId === 'r-ingest')?.proposals).toBe(2);
    expect(s.unreadable).toBe(4); // mismatch / garbage / schema / nodir
  });

  it('notified = null(hint / dismiss 不读 notice.json):待通知恒空,待审不变', async () => {
    const f = await fx('a6-pend-null-');
    await putReport(f, 'r-1', 'ingest');
    const s = known(await scanPending(input(f, [entry('r-1')], { notified: null })));
    expect(ids(s.pending)).toEqual(['r-1']);
    expect(s.toNotify).toEqual([]);
  });

  it('归属按「当前」分类器现算:同一份磁盘数据,分类器把证据判成 X / U 后立刻不再计入', async () => {
    const f = await fx('a6-pend-attr-');
    await putReport(f, 'r-1', 'ingest');
    expect(ids(known(await scanPending(input(f, [entry('r-1')]))).pending)).toEqual(['r-1']);
    for (const cls of ['X', 'U'] as const) {
      const s = known(await scanPending(input(f, [entry('r-1')], { classify: () => cls })));
      expect(s.pending, cls).toEqual([]);
      expect(s.staged, cls).toEqual([]);
    }
  });

  it('reflect/ 不存在 = 没有 run(known、零计数),不抛', async () => {
    const f = await fx('a6-pend-noreflect-');
    const s = known(await scanPending(input(f, [])));
    expect([s.pending, s.unreadable, s.runDirs]).toEqual([[], 0, 0]);
  });

  it('runDirs 只数非点开头的真实目录(含全部 mode);点开头的临时目录不算', async () => {
    const f = await fx('a6-pend-rundirs-');
    await putReport(f, 'r-1', 'llm');
    await putReport(f, 'r-2', 'dry');
    await mkdirp(f.io, path.join(f.io.stateDir, 'reflect', '.tmp-x'), 0o755);
    const s = known(await scanPending(input(f, [])));
    expect(s.runDirs).toBe(2);
  });

  it('dirNames(notice_full 的 S)只收 run 目录:同名普通文件 / 点开头临时项不算「目录仍存在」', async () => {
    const f = await fx('a6-pend-dirnames-');
    await putReport(f, 'r-1', 'llm');
    await writeFile(f.io, path.join(f.io.stateDir, 'reflect', 'r-gone'), 'x', { mode: 0o600 });
    await mkdirp(f.io, path.join(f.io.stateDir, 'reflect', '.tmp-x'), 0o755);
    const s = known(await scanPending(input(f, [])));
    expect([...s.dirNames].sort()).toEqual(['r-1']);
  });
});

describe('R20-17.4 / R20-17.4a 读取协议与「扫描未知」', () => {
  it('恰好 1000 个子项仍然已知;1001 个 → known:false run_scan_truncated(不当作零)', async () => {
    const f = await fx('a6-pend-1001-');
    const root = path.join(f.io.stateDir, 'reflect');
    for (let i = 0; i < 1000; i++)
      await mkdirp(f.io, path.join(root, `r-${String(i).padStart(4, '0')}`), 0o755);
    expect(known(await scanPending(input(f, []))).runDirs).toBe(1000);
    await mkdirp(f.io, path.join(root, 'r-1000'), 0o755);
    const s = await scanPending(input(f, []));
    expect(s).toMatchObject({ known: false, reason: 'run_scan_truncated' });
  }, 120_000);

  it('单次扫描总读取超过 16 MiB → known:false run_scan_budget', async () => {
    const f = await fx('a6-pend-16m-');
    const names: string[] = [];
    // 每份 report 合法且 < 1 MiB(尾部补空白),17 份合计 > 16 MiB
    for (let i = 0; i < 17; i++) {
      const id = `r-big-${String(i).padStart(2, '0')}`;
      names.push(id);
      const base = JSON.stringify(reportDoc(id, 'ingest', ['2026-10-24-001']));
      await putReport(f, id, 'ingest', 1, `${base}${' '.repeat(1_000_000 - base.length)}`);
    }
    const s = await scanPending(
      input(
        f,
        names.map((n) => entry(n)),
      ),
    );
    expect(s).toMatchObject({ known: false, reason: 'run_scan_budget' });
    // 正向对照:同样的 16 份(< 16 MiB)仍然已知
    const ok = known(
      await scanPending(
        input(
          f,
          names.slice(0, 16).map((n) => entry(n)),
        ),
      ),
    );
    expect(ok.pending).toHaveLength(16);
  }, 120_000);

  it('单个 report.json 超过 1 MiB → 读不了(unreadable),不计入待审', async () => {
    const f = await fx('a6-pend-1m-');
    const base = JSON.stringify(reportDoc('r-1', 'ingest', ['2026-10-24-001']));
    await putReport(f, 'r-1', 'ingest', 1, `${base}${' '.repeat(1_048_576)}`);
    const s = known(await scanPending(input(f, [entry('r-1')])));
    expect([s.pending, s.unreadable]).toEqual([[], 1]);
  });

  it('over() 为真(提醒的预算)→ known:false run_scan_budget', async () => {
    const f = await fx('a6-pend-over-');
    await putReport(f, 'r-1', 'ingest');
    const s = await scanPending(input(f, [entry('r-1')]), { over: () => true });
    expect(s).toMatchObject({ known: false, reason: 'run_scan_budget' });
  });

  it('report.json 是符号链接 / reflect/ 本身是符号链接:前者计入 unreadable,后者 fail-closed(state_dir_unsafe)', async () => {
    const f = await fx('a6-pend-link-');
    await putReport(f, 'r-real', 'ingest');
    await mkdirp(f.io, path.join(f.io.stateDir, 'reflect', 'r-link'), 0o755);
    await symlink(
      f.io,
      path.join(f.io.stateDir, 'reflect', 'r-real', 'report.json'),
      path.join(f.io.stateDir, 'reflect', 'r-link', 'report.json'),
    );
    const s = known(await scanPending(input(f, [entry('r-real'), entry('r-link')])));
    expect(ids(s.pending)).toEqual(['r-real']);
    expect(s.unreadable).toBe(1);
    // reflect 根换成符号链接
    await remove(f.io, path.join(f.io.stateDir, 'reflect', 'r-link'));
    const other = path.join(f.io.stateDir, 'elsewhere');
    await mkdirp(f.io, other, 0o755);
    await rename(
      f.io,
      path.join(f.io.stateDir, 'reflect'),
      path.join(f.io.stateDir, 'reflect-moved'),
    );
    await symlink(f.io, other, path.join(f.io.stateDir, 'reflect'));
    await expect(scanPending(input(f, []))).rejects.toBeInstanceOf(RsiSnapshotError);
  });
});

describe('R20-17.14a notice_full 的唯一谓词', () => {
  const dirs = (n: number): Set<string> => new Set(Array.from({ length: n }, (_, i) => `r-${i}`));
  const refs = (n: number, from = 0): { runId: string; proposals: number }[] =>
    Array.from({ length: n }, (_, i) => ({ runId: `r-${from + i}`, proposals: 1 }));

  it('原文件超过 1000 条但目录仍存在的不超过 1000、且无新增 → 不是 full', () => {
    const notified = Array.from({ length: 1500 }, (_, i) => `r-${i}`);
    expect(noticeFull(notified, dirs(300), [])).toBe(false);
  });
  it('恰好 1000 条仍存在且 T 为空 → 不是 full', () => {
    const notified = Array.from({ length: 1000 }, (_, i) => `r-${i}`);
    expect(noticeFull(notified, dirs(1000), [])).toBe(false);
  });
  it('1000 条仍存在 + 1 个新增 → full;新增的就在 S 里(并集不变)→ 不是 full', () => {
    const notified = Array.from({ length: 1000 }, (_, i) => `r-${i}`);
    const all = dirs(1001);
    expect(noticeFull(notified, all, refs(1, 1000))).toBe(true);
    expect(noticeFull(notified, all, refs(1, 0))).toBe(false);
  });
  it('常量:上限 1000', () => {
    expect(RSI_NOTICE_MAX).toBe(1000);
  });
});

describe('dismissed.json / notice.json 的只读读取(R20-17.8 / R20-17.14)', () => {
  it('缺失 = absent;合法 = ok;rsiDir 为 null = absent', async () => {
    const f = await fx('a6-pend-acct-');
    await mkdirp(f.io, path.join(f.io.stateDir, 'rsi'), 0o700);
    const dir = path.join(f.io.stateDir, 'rsi');
    expect((await readDismissed(dir)).kind).toBe('absent');
    expect((await readNotice(dir)).kind).toBe('absent');
    expect((await readDismissed(null)).kind).toBe('absent');
    await putRsiFile(f, 'dismissed.json', dismissedDoc(['r-1', 'r-2']));
    await putRsiFile(f, 'notice.json', noticeDoc(['r-1'], '2026-10-24T08:00:00.000Z'));
    const d = await readDismissed(dir);
    expect([d.kind, [...d.ids]]).toEqual(['ok', ['r-1', 'r-2']]);
    const n = await readNotice(dir);
    expect(n.kind === 'ok' && n.notice.collection_started_for).toBe('2026-10-24T08:00:00.000Z');
  });

  it('损坏 = invalid:schema 不过、未升序、重复、JSON 坏、权限过宽(0644)', async () => {
    const f = await fx('a6-pend-bad-');
    const dir = path.join(f.io.stateDir, 'rsi');
    await mkdirp(f.io, dir, 0o700);
    const bad: [string, string, number][] = [
      ['schema', '{"schema_version":1,"runs":[{"run_id":"r-1"}]}', 0o600],
      [
        'unsorted',
        JSON.stringify({
          schema_version: 1,
          runs: [
            { run_id: 'r-2', at: '2026-10-24T08:00:00.000Z' },
            { run_id: 'r-1', at: '2026-10-24T08:00:00.000Z' },
          ],
        }),
        0o600,
      ],
      [
        'dup',
        JSON.stringify({
          schema_version: 1,
          runs: [
            { run_id: 'r-1', at: '2026-10-24T08:00:00.000Z' },
            { run_id: 'r-1', at: '2026-10-24T08:00:00.000Z' },
          ],
        }),
        0o600,
      ],
      ['json', '{oops', 0o600],
      ['perm', dismissedDoc(['r-1']), 0o644],
    ];
    for (const [name, text, mode] of bad) {
      await putRsiFile(f, 'dismissed.json', text, mode);
      expect((await readDismissed(dir)).kind, name).toBe('invalid');
    }
    for (const [name, text, mode] of [
      ['schema', '{"schema_version":1}', 0o600],
      ['json', 'nope', 0o600],
      ['perm', noticeDoc(['r-1']), 0o666],
    ] as const) {
      await putRsiFile(f, 'notice.json', text, mode);
      expect((await readNotice(dir)).kind, name).toBe('invalid');
    }
  });

  it('dismissed.json 超过 1000 条 = 损坏;notice.json 的读取形状放宽到 20000 条(清理后才收紧),超过 = 损坏', async () => {
    const f = await fx('a6-pend-cap-');
    const dir = path.join(f.io.stateDir, 'rsi');
    await mkdirp(f.io, dir, 0o700);
    const many = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `r-${String(i).padStart(6, '0')}`);
    await putRsiFile(f, 'dismissed.json', dismissedDoc(many(RSI_DISMISSED_MAX + 1)));
    expect((await readDismissed(dir)).kind).toBe('invalid');
    await putRsiFile(f, 'notice.json', noticeDoc(many(RSI_NOTICE_MAX + 1)));
    expect((await readNotice(dir)).kind).toBe('ok');
    await putRsiFile(f, 'notice.json', noticeDoc(many(RSI_NOTICE_READ_MAX + 1)));
    expect((await readNotice(dir)).kind).toBe('invalid');
  });

  it('写出的都读得回来:1000 条最长(64 字符)run_id 的 dismissed.json / notice.json 往返成功,且小于读取字节上限', async () => {
    const f = await fx('a6-pend-roundtrip-');
    const dir = path.join(f.io.stateDir, 'rsi');
    await mkdirp(f.io, dir, 0o700);
    const longIds = Array.from(
      { length: 1000 },
      (_, i) => `r${String(i).padStart(4, '0')}${'a'.repeat(59)}`,
    );
    expect(longIds.every((x) => x.length === 64)).toBe(true);
    const d = dismissedDoc(longIds);
    const n = noticeDoc(longIds);
    expect(Buffer.byteLength(d)).toBeLessThan(RSI_ACCOUNT_FILE_MAX_BYTES);
    expect(Buffer.byteLength(n)).toBeLessThan(RSI_ACCOUNT_FILE_MAX_BYTES);
    await writeFile(f.io, path.join(dir, 'dismissed.json'), d, { mode: 0o600 });
    await putRsiFile(f, 'notice.json', n);
    expect((await readDismissed(dir)).kind).toBe('ok');
    expect((await readNotice(dir)).kind).toBe('ok');
  });
});
