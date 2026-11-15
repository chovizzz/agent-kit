/**
 * B2 命令级用例:**真命令(runAutoFamily + makeWriteHandlers)+ 真私有 git 仓库 + 假 HOME + 真存储核**(`assembleWriteAdapters`)。
 * 覆盖:veto 经新端口落账 / 消费方未接线不报完整成功 / 封存时钟下保护写(`protective_veto_lands_under_sealed_clock`,真私有仓库)/ 锁绑定端口在锁外零写入 /
 * 路由到新 sink(`veto_routed_to_new_sink`)/ PauseStatePort 保留其它键 / bump 单调 / 生产未装配 git 路径 → 锁外预读 fail-closed。
 * 锁外预读的真实适配器(A 段 git 只读)在生产里因 `.git` 收紧前不装配,所以命令级用例用「持锁读」替代 peek,单独断言未装配行为。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import { canonicalJson } from '../../../src/io/canonical-json.js';
import { existsSync, readText, realpath } from '../../../src/io/read-fs.js';
import { createExclusive, mkdirp } from '../../../src/io/safe-fs.js';
import { assembleWriteAdapters } from '../../../src/rsi/assemble-write.js';
import { runAutoFamily } from '../../../src/rsi/auto/entry.js';
import { makeWriteHandlers } from '../../../src/rsi/auto/write/index.js';
import type { WritePorts } from '../../../src/rsi/auto/write/ports.js';
import { personalRepoStore } from '../../../src/rsi/personal/candidate-repo.js';
import { commitPersonal, openPersonalRepo } from '../../../src/rsi/personal/commit.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { ID, SHA, rec } from '../personal/transition-fixture.js';
import {
  git,
  makeWorld,
  repoDeps,
  slowTests,
  withLock,
  type World,
} from '../personal/repo-helpers.js';

// 每个用例要起几十次真 git 子进程(验证机高负载时单个用例超 20s):沿用 personal 套件的慢用例口径
slowTests();

const CLOCK = new Date('2026-11-10T12:00:00.000Z');
const STATE_DOC = {
  schema_version: 1,
  confirm: null,
  projects_ack_generation: 0,
  attempt: null,
  last_tick: null,
  consecutive_failures: 3,
  breaker: null,
};

async function seed(w: World, r: PersonalLifecycleRecord): Promise<void> {
  await withLock(w, async (locks) => {
    const open = await openPersonalRepo(repoDeps(w), locks, { bootstrap: true });
    if (open.kind !== 'ready') throw new Error(`bootstrap:${JSON.stringify(open)}`);
    const res = await commitPersonal(repoDeps(w), locks, {
      kind: 'transition',
      txnId: '1'.padEnd(16, '0'),
      candidateIds: [r.id],
      upserts: [{ path: `lifecycle/${r.id}.json`, content: canonicalJson(r) }],
    });
    if (res.status !== 'committed') throw new Error(`seed:${JSON.stringify(res)}`);
  });
}

/** state 目录可能还不存在(没有任何命令取过 rsi 锁):不存在时退回未解析路径(只用于「不存在」的断言) */
const rsiDirOf = async (w: World): Promise<string> => {
  try {
    return path.join(await realpath(w.io.stateDir), 'rsi');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return path.join(w.io.stateDir, 'rsi');
    throw e;
  }
};

async function ledgerOf(
  w: World,
): Promise<{ blacklist: { candidate_id: string }[]; applied: unknown[] }> {
  return JSON.parse(await readText(path.join(await rsiDirOf(w), 'effects.json')));
}

async function recordOf(w: World): Promise<PersonalLifecycleRecord> {
  return withLock(w, async (locks) => {
    const r = await personalRepoStore(repoDeps(w), locks).read(ID);
    if (r.kind !== 'ok') throw new Error(`read:${r.kind}`);
    return r.record;
  });
}

async function adaptersOf(w: World, now: () => Date, storeClock?: () => Date) {
  return assembleWriteAdapters({
    io: w.io,
    home: w.home,
    repoPath: w.rsiRepo,
    env: { KIT_TMP: w.dir },
    now,
    ...(storeClock !== undefined ? { storeClock } : {}),
    phase: 2,
  });
}

function portsOf(w: World, a: Awaited<ReturnType<typeof adaptersOf>>, wired = false): WritePorts {
  return {
    ...a.ports,
    config: async () => ({ rsiOn: true }),
    peekRecord: async (id) =>
      withLock(w, async (locks) => personalRepoStore(repoDeps(w), locks).read(id)),
    peekRecords: async () =>
      withLock(w, async (locks) => personalRepoStore(repoDeps(w), locks).readAll()),
    outputForbidden: [],
    ...(wired ? { consumers: { ledgerRead: 'wired' as const } } : {}),
  };
}

async function run(family: 'veto' | 'auto', argv: string[], ports: WritePorts) {
  let out = '';
  let err = '';
  const ctx = {
    argv,
    overlayPath: undefined,
    explicitRoot: undefined,
    env: { KIT_REAL_HOME_OVERRIDE: '/nonexistent-home-b2' },
    cwd: '/',
    stdout: (t: string) => void (out += t),
    stderr: (t: string) => void (err += t),
    isTty: true,
    readLine: async () => undefined,
  } as RsiEarlyContext;
  const code = await runAutoFamily(family, ctx, {
    phase: 2,
    write: makeWriteHandlers(async () => ports),
  });
  return { code, out, err };
}

describe('veto 命令级(真 git + 假 HOME + 真存储核)', () => {
  it('shadow 候选:记录 rejected、黑名单经新端口落账;消费方未接线 → 退 1 consumer=unwired;对照:已接线退 0', async () => {
    const w = await makeWorld('b2-veto-');
    await seed(w, rec('shadow'));
    const a = await adaptersOf(w, () => CLOCK);
    const r = await run('veto', [ID], portsOf(w, a));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`veto: id=${ID} consumer=unwired`);
    expect((await recordOf(w)).lifecycle).toBe('rejected');
    const led = await ledgerOf(w);
    expect(led.blacklist.map((b) => b.candidate_id)).toEqual([ID]);
    expect(a.layers.records.some((x) => x.ledger === 'committed')).toBe(true);

    const w2 = await makeWorld('b2-veto-wired-');
    await seed(w2, rec('shadow'));
    const a2 = await adaptersOf(w2, () => CLOCK);
    expect((await run('veto', [ID], portsOf(w2, a2, true))).code).toBe(0);
  });

  it('protective_veto_lands_under_sealed_clock:取时落在水位线之内 → 退 3 audit_invalid + 已提交待处理信息行;记录与 HEAD 不变,E1 黑名单已落;时钟恢复后重跑幂等完成', async () => {
    const w = await makeWorld('b2-sealed-');
    await seed(w, rec('shadow'));
    const head = git(w, ['rev-parse', 'HEAD']);
    await mkdirp(w.io, w.io.stateDir, 0o700); // 先建 state,rsiDirOf 才能解析真实路径
    const dir = await rsiDirOf(w);
    await mkdirp(w.io, dir, 0o700);
    await createExclusive(
      w.io,
      path.join(dir, 'audit-compaction.json'),
      canonicalJson({ schema_version: 1, gen: 1, through: '2026-11-09', months: {} }),
      0o600,
    );
    // 存储时钟 = 11-10(水位线 11-09 合法);条目取时 = 11-08(锁外预取的旧时刻 / 时钟回拨)
    const a = await adaptersOf(
      w,
      () => new Date('2026-11-08T08:00:00.000Z'),
      () => CLOCK,
    );
    const r = await run('veto', [ID], portsOf(w, a));
    expect(r.code).toBe(3);
    expect(r.err).toContain('cause=sealed_interval');
    expect(r.err).toContain('entry=not_committed');
    expect(r.err).not.toContain('authority=');
    expect(r.err).toContain('RSI_FAIL_CLOSED reason=audit_invalid');
    expect(git(w, ['rev-parse', 'HEAD'])).toBe(head);
    expect((await recordOf(w)).lifecycle).toBe('shadow');
    expect((await ledgerOf(w)).blacklist.map((b) => b.candidate_id)).toEqual([ID]);

    const b = await adaptersOf(w, () => CLOCK);
    const again = await run('veto', [ID], portsOf(w, b));
    expect(again.code).toBe(1); // 消费方未接线
    expect((await recordOf(w)).lifecycle).toBe('rejected');
    expect((await ledgerOf(w)).blacklist).toHaveLength(1);
  });

  it('生产未装配 git 路径:锁外预读恒 invalid(不是 unknown_id),veto 退 3 且零写入', async () => {
    const w = await makeWorld('b2-nogit-');
    await seed(w, rec('shadow'));
    const head = git(w, ['rev-parse', 'HEAD']);
    const a = await adaptersOf(w, () => CLOCK);
    const r = await run('veto', [ID], { ...portsOf(w, a), peekRecord: a.ports.peekRecord });
    expect(r.code).toBe(3);
    expect(r.err).toContain('RSI_FAIL_CLOSED reason=personal_repo_invalid');
    expect(git(w, ['rev-parse', 'HEAD'])).toBe(head);
    expect(existsSync(path.join(await rsiDirOf(w), 'effects.json'))).toBe(false);
  });
});

describe('锁绑定端口与路由', () => {
  it('锁外调用 pauseState.write / marks.bump / vetoLift.lift / rebase.rewriteHead = 抛 RsiLockError internal,没有建 .state/rsi', async () => {
    const w = await makeWorld('b2-outside-');
    const a = await adaptersOf(w, () => CLOCK);
    const p = a.ports;
    const bad = { code: 'RSI_LOCK', kind: 'internal' };
    await expect(
      p.pauseState?.write({ reasons: [], diverged: false, owner_changed: false }),
    ).rejects.toMatchObject(bad);
    await expect(p.marks?.bump()).rejects.toMatchObject(bad);
    await expect(p.vetoLift?.lift(ID, SHA)).rejects.toMatchObject(bad);
    await expect(p.rebase?.rewriteHead('baseline', 'a'.repeat(40))).rejects.toMatchObject(bad);
    expect(existsSync(path.join(w.io.stateDir, 'rsi'))).toBe(false);
  });

  it('veto_routed_to_new_sink:rollbackDeps 的带键出口落到存储核的账(不是旧 deferred),seal 已接;同一次持有里存储核可取', async () => {
    const w = await makeWorld('b2-route-');
    await seed(w, rec('shadow'));
    const a = await adaptersOf(w, () => CLOCK);
    await a.locks.withLocks('rsi_personal_sync', async (held) => {
      const d = a.ports.rollbackDeps?.(held);
      expect(d?.seal).toBeDefined();
      expect(a.storeOf(held)).toBeDefined();
      expect(
        await d?.keyedEffects.applyOnce(`veto:${ID}:${SHA}`, [
          { type: 'blacklist_veto', id: ID, content_sha256: SHA },
        ]),
      ).toBe('applied');
    });
    expect((await ledgerOf(w)).blacklist.map((b) => b.candidate_id)).toEqual([ID]);
    // 缩减入口(personal_sync)没有存储核:rollbackDeps 拒绝(fail-closed)
    await a.locks.withLocks('personal_sync', async (held) => {
      expect(a.storeOf(held)).toBeUndefined();
      expect(() => a.ports.rollbackDeps?.(held)).toThrow();
    });
  });

  it('PauseStatePort:读改写保留其它键、整份过 schema;state.json 缺失时拒写(不凭空创建);不合规 = state_invalid 拒写', async () => {
    const w = await makeWorld('b2-state-');
    const a = await adaptersOf(w, () => CLOCK);
    const pause = a.ports.pauseState;
    await a.locks.withLocks('rsi_personal_sync', async () => {
      const dir = await rsiDirOf(w);
      expect(await pause?.read()).toEqual({ reasons: [], diverged: false, owner_changed: false });
      await expect(
        pause?.write({ reasons: ['user_vetoes'], diverged: false, owner_changed: false }),
      ).rejects.toMatchObject({ reason: 'state_invalid' });
      expect(existsSync(path.join(dir, 'state.json'))).toBe(false);
      await createExclusive(w.io, path.join(dir, 'state.json'), canonicalJson(STATE_DOC), 0o600);
      await pause?.write({ reasons: ['user_vetoes'], diverged: true, owner_changed: false });
      const raw = JSON.parse(await readText(path.join(dir, 'state.json')));
      expect(raw.consecutive_failures).toBe(3);
      expect(raw.auto_pause).toEqual({
        reasons: ['user_vetoes'],
        diverged: true,
        owner_changed: false,
      });
      expect((await pause?.read())?.diverged).toBe(true);
    });
  });

  it('EntryMarks.bump 单调 +1;文件不合规 = state_invalid 且不覆盖', async () => {
    const w = await makeWorld('b2-bump-');
    const a = await adaptersOf(w, () => CLOCK);
    await a.locks.withLocks('rsi_personal_sync', async () => {
      expect(await a.ports.marks?.bump()).toBe(1);
      expect(await a.ports.marks?.bump()).toBe(2);
      const f = path.join(await rsiDirOf(w), 'entry-gen.json');
      expect(JSON.parse(await readText(f))).toEqual({ schema_version: 1, gen: 2 });
    });
    const w2 = await makeWorld('b2-bump-bad-');
    const a2 = await adaptersOf(w2, () => CLOCK);
    await a2.locks.withLocks('rsi_personal_sync', async () => {
      const f = path.join(await rsiDirOf(w2), 'entry-gen.json');
      await createExclusive(w2.io, f, '{"schema_version":1,"gen":-1}', 0o600);
      await expect(a2.ports.marks?.bump()).rejects.toMatchObject({ reason: 'state_invalid' });
      expect(await readText(f)).toBe('{"schema_version":1,"gen":-1}');
    });
  });
});
