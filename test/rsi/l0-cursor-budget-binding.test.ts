/**
 * R20-A2 B4b:cursor 状态机(epoch / 剪除 / 淘汰)、预算、运行绑定与检查点的纯函数判据。
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_FULL_SCAN_INTERVAL_MS,
  type RsiAgentId,
  type RsiCursor,
} from '../../src/contracts/rsi.js';
import { planBudget, resolveLimits } from '../../src/rsi/l0/budget.js';
import {
  compareBinding,
  createCheckpoint,
  sameBinding,
  type BindingObservation,
} from '../../src/rsi/l0/binding.js';
import { buildNextCursor, isUnchanged, planEpoch, planFullScan } from '../../src/rsi/l0/cursor.js';
import type { Enumeration, FileOutcome, RunBinding, SessionFile } from '../../src/rsi/l0/types.js';

const FP = 'f'.repeat(64);
const FP2 = 'e'.repeat(64);
const SALT = 'ab'.repeat(32);
const T0 = '2026-10-24T08:00:00.000Z';
const ms = (iso: string): number => Date.parse(iso);

const file = (n: number, agent: RsiAgentId = 'claude', size = 10): SessionFile => ({
  agent,
  path: `/h/${agent}/${n}.jsonl`,
  size,
  mtimeMs: 1000 + n,
  dev: 1,
  ino: 100 + n,
});
const enumOf = (files: SessionFile[], over: Partial<Enumeration> = {}): Enumeration => ({
  files,
  roots: { claude: { status: 'ok' }, codex: { status: 'absent' }, pi: { status: 'absent' } },
  entriesSeen: files.length,
  complete: true,
  skipped: { notRegular: 0 },
  limitsHit: new Set(),
  ...over,
});
const cursorOf = (
  over: Partial<RsiCursor['full_scan']> = {},
  files: RsiCursor['files'] = {},
  fp = FP,
): RsiCursor => ({
  schema_version: 1,
  fingerprint: fp,
  full_scan: { epoch: 1, started_at: T0, done: false, last_completed_at: null, ...over },
  files,
});
const outcomeOf = (f: SessionFile, ref: string): FileOutcome => ({
  file: f,
  sessionRef: ref,
  status: 'ok',
  projectKey: null,
  projectRoot: null,
  complete: true,
});

describe('planEpoch', () => {
  it('无 cursor → epoch 1、进行中', () => {
    expect(planEpoch(null, FP, T0)).toMatchObject({
      epoch: 1,
      done: false,
      reopened: true,
      fingerprintMatch: null,
      startedAt: T0,
    });
  });
  it('进行中且指纹不变 → 原 epoch;指纹变 → epoch+1(扫描中途也重开)', () => {
    const c = cursorOf({ epoch: 3 });
    expect(planEpoch(c, FP, T0)).toMatchObject({
      epoch: 3,
      reopened: false,
      fingerprintMatch: true,
    });
    expect(planEpoch(c, FP2, T0)).toMatchObject({
      epoch: 4,
      done: false,
      reopened: true,
      fingerprintMatch: false,
    });
  });
  it('已完成:6 天 23 小时不重开;满 7 天重开;时钟往回走重开;缺 last_completed_at 重开', () => {
    const done = (last: string | null): RsiCursor =>
      cursorOf({ epoch: 2, done: true, last_completed_at: last });
    const last = '2026-10-01T00:00:00.000Z';
    const justBefore = new Date(ms(last) + RSI_FULL_SCAN_INTERVAL_MS - 1).toISOString();
    const exact = new Date(ms(last) + RSI_FULL_SCAN_INTERVAL_MS).toISOString();
    expect(planEpoch(done(last), FP, justBefore)).toMatchObject({
      epoch: 2,
      done: true,
      reopened: false,
    });
    expect(planEpoch(done(last), FP, exact)).toMatchObject({
      epoch: 3,
      done: false,
      reopened: true,
    });
    expect(planEpoch(done(last), FP, '2026-09-30T00:00:00.000Z')).toMatchObject({ epoch: 3 });
    expect(planEpoch(done(null), FP, T0)).toMatchObject({ epoch: 3 });
    // 指纹变化也重开,并保留旧的 last_completed_at
    expect(planEpoch(done(last), FP2, justBefore)).toMatchObject({
      epoch: 3,
      lastCompletedAt: last,
    });
  });
});

describe('isUnchanged / planFullScan', () => {
  it('size、mtime、dev、ino、agent 与 epoch 任一不同都算改动', () => {
    const f = file(1);
    const e = {
      agent: f.agent,
      size: f.size,
      mtime_ms: f.mtimeMs,
      dev: f.dev,
      ino: f.ino,
      project_key: null,
      epoch: 2,
      status: 'ok' as const,
    };
    expect(isUnchanged(e, f, 2)).toBe(true); // 正向前提
    expect(isUnchanged(e, f, 3)).toBe(false);
    expect(isUnchanged({ ...e, size: 11 }, f, 2)).toBe(false);
    expect(isUnchanged({ ...e, mtime_ms: 1 }, f, 2)).toBe(false);
    expect(isUnchanged({ ...e, dev: 9 }, f, 2)).toBe(false);
    expect(isUnchanged({ ...e, ino: 9 }, f, 2)).toBe(false);
    expect(isUnchanged({ ...e, agent: 'pi' }, f, 2)).toBe(false);
    expect(isUnchanged(undefined, f, 2)).toBe(false);
  });
  it('只有 epoch 落后的文件进入 changed,顺序保持', () => {
    const fs = [file(1), file(2), file(3)];
    const plan0 = planFullScan({ enumeration: enumOf(fs), prev: null, epoch: 1, salt: SALT });
    expect(plan0.changed.map((f) => f.ino)).toEqual([101, 102, 103]);
    const refs = [...plan0.refs.values()];
    const mk = (epoch: number): RsiCursor['files'] =>
      Object.fromEntries(
        fs.map((f, i) => [
          refs[i] as string,
          {
            agent: f.agent,
            size: f.size,
            mtime_ms: f.mtimeMs,
            dev: f.dev,
            ino: f.ino,
            project_key: null,
            epoch: i === 1 ? epoch - 1 : epoch,
            status: 'ok' as const,
          },
        ]),
      );
    const plan1 = planFullScan({
      enumeration: enumOf(fs),
      prev: cursorOf({ epoch: 5 }, mk(5)),
      epoch: 5,
      salt: SALT,
    });
    expect(plan1.unchanged).toBe(2);
    expect(plan1.changed.map((f) => f.ino)).toEqual([102]);
  });
});

describe('buildNextCursor', () => {
  const refFor = (i: number): string => `s_${i.toString(16).padStart(16, '0')}`;
  const mkEntry = (f: SessionFile, epoch: number): RsiCursor['files'][string] => ({
    agent: f.agent,
    size: f.size,
    mtime_ms: f.mtimeMs,
    dev: f.dev,
    ino: f.ino,
    project_key: null,
    epoch,
    status: 'ok',
  });

  it('读过的文件盖当前 epoch;全部列举到的文件都到当前 epoch 且列举完整 → done + last_completed_at', () => {
    const fs = [file(1), file(2)];
    const refs = new Set([refFor(1), refFor(2)]);
    const epoch = planEpoch(null, FP, T0);
    const part = buildNextCursor({
      prev: null,
      epoch,
      fingerprint: FP,
      nowIso: T0,
      enumeration: enumOf(fs),
      enumeratedRefs: refs,
      outcomes: [outcomeOf(fs[0] as SessionFile, refFor(1))],
    });
    expect(part.full_scan).toMatchObject({ epoch: 1, done: false, last_completed_at: null });
    const full = buildNextCursor({
      prev: part,
      epoch: planEpoch(part, FP, T0),
      fingerprint: FP,
      nowIso: '2026-10-24T09:00:00.000Z',
      enumeration: enumOf(fs),
      enumeratedRefs: refs,
      outcomes: [outcomeOf(fs[1] as SessionFile, refFor(2))],
    });
    expect(full.full_scan).toMatchObject({
      done: true,
      last_completed_at: '2026-10-24T09:00:00.000Z',
    });
    expect(full.files[refFor(1)]?.epoch).toBe(1);
  });

  it('列举不完整时 done 永远不到,也不剪除', () => {
    const fs = [file(1)];
    const stale = { [refFor(9)]: mkEntry(file(9), 1) };
    const out = buildNextCursor({
      prev: cursorOf({}, stale),
      epoch: planEpoch(cursorOf({}, stale), FP, T0),
      fingerprint: FP,
      nowIso: T0,
      enumeration: enumOf(fs, { complete: false }),
      enumeratedRefs: new Set([refFor(1)]),
      outcomes: [outcomeOf(fs[0] as SessionFile, refFor(1))],
    });
    expect(out.full_scan.done).toBe(false);
    expect(Object.keys(out.files).sort()).toEqual([refFor(1), refFor(9)]);
  });

  it('完整时只剪除 root 为 ok 的 agent 的、本次没列举到的条目;absent 的 agent 条目保留', () => {
    const gone = file(2);
    const other = file(3, 'codex');
    const prev = cursorOf({}, { [refFor(2)]: mkEntry(gone, 1), [refFor(3)]: mkEntry(other, 1) });
    const out = buildNextCursor({
      prev,
      epoch: planEpoch(prev, FP, T0),
      fingerprint: FP,
      nowIso: T0,
      enumeration: enumOf([file(1)]),
      enumeratedRefs: new Set([refFor(1)]),
      outcomes: [outcomeOf(file(1), refFor(1))],
    });
    expect(Object.keys(out.files).sort()).toEqual([refFor(1), refFor(3)]);
  });

  it('淘汰顺序:epoch 升序 → mtime 升序 → session_ref 字节序(D8)', () => {
    const mk = (n: number, epoch: number, mtime: number): [string, RsiCursor['files'][string]] => [
      refFor(n),
      { ...mkEntry(file(n), epoch), mtime_ms: mtime },
    ];
    const prev = cursorOf(
      { epoch: 3 },
      Object.fromEntries([
        mk(1, 3, 50), // 保留:epoch 最新
        mk(2, 1, 90), // 保留:epoch 最老里 mtime 最大
        mk(3, 1, 10), // 第一个淘汰(epoch 最老、mtime 最小、ref 最小)
        mk(4, 1, 10), // 第二个淘汰(与 3 同 epoch 同 mtime,ref 字节序在后)
        mk(5, 2, 1), // 保留
      ]),
    );
    const out = buildNextCursor({
      prev,
      epoch: planEpoch(prev, FP, T0),
      fingerprint: FP,
      nowIso: T0,
      enumeration: enumOf([], { complete: false }),
      enumeratedRefs: new Set(),
      outcomes: [],
      maxEntries: 3,
    });
    expect(Object.keys(out.files).sort()).toEqual([refFor(1), refFor(2), refFor(5)]);
    // 正向前提:不超限时一个都不淘汰
    const none = buildNextCursor({
      prev,
      epoch: planEpoch(prev, FP, T0),
      fingerprint: FP,
      nowIso: T0,
      enumeration: enumOf([], { complete: false }),
      enumeratedRefs: new Set(),
      outcomes: [],
      maxEntries: 5,
    });
    expect(Object.keys(none.files)).toHaveLength(5);
  });

  it('done 状态且未重开:保持 done 与 last_completed_at,不回退', () => {
    const prev = cursorOf({ epoch: 2, done: true, last_completed_at: T0 });
    const out = buildNextCursor({
      prev,
      epoch: planEpoch(prev, FP, '2026-10-25T00:00:00.000Z'),
      fingerprint: FP,
      nowIso: '2026-10-25T00:00:00.000Z',
      enumeration: enumOf([file(1)]),
      enumeratedRefs: new Set([refFor(1)]),
      outcomes: [],
    });
    expect(out.full_scan).toMatchObject({ epoch: 2, done: true, last_completed_at: T0 });
  });
});

describe('planBudget', () => {
  const limits = resolveLimits({ maxFiles: 2, maxFileBytes: 100 });
  it('超 lstat 上限的不读也不占名额;超过文件名额的延后并报 RSI_LIMIT_FILES', () => {
    const p = planBudget(
      [file(1, 'claude', 50), file(2, 'claude', 500), file(3, 'claude', 60), file(4), file(5)],
      limits,
    );
    expect(p.toRead.map((f) => f.ino)).toEqual([101, 103]);
    expect(p.tooLarge.map((f) => f.ino)).toEqual([102]);
    expect(p.deferred).toBe(2);
    expect(p.plannedBytes).toBe(110);
    expect([...p.limitsHit].sort()).toEqual(['RSI_FILE_TOO_LARGE', 'RSI_LIMIT_FILES']);
  });
  it('名额刚好够时不报 limit', () => {
    const p = planBudget([file(1), file(2)], limits);
    expect(p.limitsHit.size).toBe(0);
    expect(p.deferred).toBe(0);
  });
});

describe('binding / checkpoint', () => {
  const bind: RunBinding = {
    repoSha256: 'a'.repeat(64),
    repoDevIno: { dev: 1, ino: 2 },
    policyFp: 'b'.repeat(64),
    agents: ['claude', 'pi'],
    confirmedAt: T0,
  };
  const obs = (over: Partial<BindingObservation> = {}): BindingObservation => ({
    stopPresent: false,
    collectBlocked: false,
    current: bind,
    ...over,
  });
  it('一致 → continue(正向前提);STOP > 停止采集 > 绑定变化', () => {
    expect(compareBinding(bind, obs())).toEqual({ kind: 'continue' });
    expect(compareBinding(bind, obs({ stopPresent: true, collectBlocked: true }))).toEqual({
      kind: 'abort',
      outcome: 'stopped',
    });
    expect(compareBinding(bind, obs({ collectBlocked: true, current: null }))).toEqual({
      kind: 'abort',
      outcome: 'skipped_collect_blocked',
    });
    expect(compareBinding(bind, obs({ current: null }))).toEqual({
      kind: 'abort',
      outcome: 'skipped_binding_changed',
    });
  });
  it('每个绑定字段变化都被发现(含收紧排除 = policyFp 变)', () => {
    const variants: RunBinding[] = [
      { ...bind, repoSha256: 'c'.repeat(64) },
      { ...bind, repoDevIno: { dev: 9, ino: 2 } },
      { ...bind, repoDevIno: { dev: 1, ino: 9 } },
      { ...bind, policyFp: 'd'.repeat(64) },
      { ...bind, agents: ['claude'] },
      { ...bind, confirmedAt: '2026-10-25T00:00:00.000Z' },
    ];
    expect(sameBinding(bind, { ...bind })).toBe(true);
    for (const v of variants) {
      expect(sameBinding(bind, v)).toBe(false);
      expect(compareBinding(bind, obs({ current: v }))).toEqual({
        kind: 'abort',
        outcome: 'skipped_binding_changed',
      });
    }
  });
  it('墙钟:file / lines 到点返回 time_limit,commit 永不返回;abort 优先于 time_limit', async () => {
    let now = 0;
    let cur = obs();
    const cp = createCheckpoint({
      nowMs: () => now,
      startedAtMs: 0,
      maxMs: 100,
      binding: bind,
      observe: async () => cur,
    });
    expect(await cp('file')).toEqual({ kind: 'continue' }); // 正向前提
    now = 100;
    expect(await cp('file')).toEqual({ kind: 'time_limit' });
    expect(await cp('lines')).toEqual({ kind: 'time_limit' });
    expect(await cp('commit')).toEqual({ kind: 'continue' });
    cur = obs({ stopPresent: true });
    expect(await cp('lines')).toEqual({ kind: 'abort', outcome: 'stopped' });
    expect(await cp('commit')).toEqual({ kind: 'abort', outcome: 'stopped' });
  });
});
