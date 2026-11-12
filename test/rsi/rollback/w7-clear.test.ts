/**
 * R21-9.5 缩减入口 `rsi auto clear [--write]`:真 HOME、真私有仓库(真 git)、真 home-fs / 锁。验收 ①–④ 与分叉 / 属主变化。
 * 缩减入口只拿 personal/lock → sync 锁,仓库 `.state` 一律不访问(假 `.state` 目录不存在 = 没有被创建)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PersonalLifecycleRecordSchema,
  type PersonalLifecycleRecord,
} from '../../../src/contracts/rsi-personal.js';
import { canonicalJson } from '../../../src/io/canonical-json.js';
import { exists, readDir, readText } from '../../../src/io/read-fs.js';
import { acquireRsiLock } from '../../../src/rsi/lock.js';
import {
  reconcileBarrier,
  reconcileCaches,
  grantCanary,
} from '../../../src/rsi/canary/canary-writer.js';
import { decideCanary } from '../../../src/rsi/canary/canary-decide.js';
import { writeRsiFileAtomic } from '../../../src/rsi/canary/atomic-write.js';
import { CANARY_FILES } from '../../../src/rsi/canary/files.js';
import { readLedger } from '../../../src/rsi/canary/ledger.js';
import { makePermitPort } from '../../../src/rsi/canary/permit-read.js';
import { rsiDir } from '../../../src/rsi/rsi-dir.js';
import { personalRepoStore } from '../../../src/rsi/personal/candidate-repo.js';
import type { RepoRead } from '../../../src/rsi/personal/candidate-ports.js';
import { rsiAutoClear, type ClearDeps } from '../../../src/rsi/personal/clear.js';
import {
  commitPersonal,
  openPersonalRepo,
  readRecordedPersonalFiles,
  TreeSpecError,
} from '../../../src/rsi/personal/commit.js';
import { acquirePersonalLock } from '../../../src/rsi/personal/personal-lock.js';
import {
  homeRevocationReader,
  homeRevocationWriter,
  homeTxnStore,
  v1PayloadSync,
} from '../../../src/rsi/personal/rollback-ports.js';
import { personalRepoRemoval, recordedOwnerFp } from '../../../src/rsi/personal/rollback-repo.js';
import { readRevocations } from '../../../src/rsi/personal/home-state.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { MemStore } from '../personal/w3-fixture.js';
import { rec, ID, SHA } from '../personal/transition-fixture.js';
import {
  git,
  makeWorld,
  NOW,
  repoDeps,
  slowTests,
  spec,
  withLock,
  writeUserFile,
  type World,
} from '../personal/repo-helpers.js';
import { BODY, POLICY, T0, adm, admitted, canaryDoc } from '../canary/w5-fixture.js';
import { V1A, V1B } from './w7-fixture.js';

slowTests();

const RULE = `rules/${ID}.md`;

/** 建仓并提交:候选的权威记录 + 原子文件 + 一份无关的 rules/base.md */
async function setup(w: World, record: PersonalLifecycleRecord): Promise<void> {
  const r = await withLock(w, async (locks) => {
    const open = await openPersonalRepo(repoDeps(w), locks, { bootstrap: true });
    if (open.kind !== 'ready') throw new Error('bootstrap');
    return commitPersonal(
      repoDeps(w),
      locks,
      spec('1', [
        { path: 'rules/base.md', content: 'base\n' },
        { path: RULE, content: 'candidate rule\n' },
        {
          path: `lifecycle/${ID}.json`,
          content: canonicalJson(PersonalLifecycleRecordSchema.parse(record)),
        },
      ]),
    );
  });
  if (r.status !== 'committed') throw new Error(`setup: ${JSON.stringify(r)}`);
}

const shadowRec = (): PersonalLifecycleRecord => rec('shadow');
const canaryRec = (): PersonalLifecycleRecord =>
  rec('canary', { deploy: { claude: 'injected', pi: 'none', codex: 'none' } });

interface Run {
  report: Awaited<ReturnType<typeof rsiAutoClear>>;
  syncOrder: string[];
}

/** 持真 personal/lock 跑一次 clear;repo 依赖用 head.json 记录的 owner_repo_fp(缩减入口不依赖 `[rsi] repo`) */
async function runClear(
  w: World,
  o: { phase: number; write: boolean; recorded?: boolean; onStep?: (s: string) => void },
): Promise<Run> {
  return withLock(w, async (locks, handle) => {
    const fp = (await recordedOwnerFp(w.h)) ?? w.ownerFp;
    const deps = repoDeps(w, { ownerRepoFp: fp });
    const syncOrder: string[] = [];
    const d: ClearDeps = {
      store: personalRepoStore(deps, locks),
      revocations: homeRevocationReader(w.h),
      locks,
      txns: homeTxnStore(w.h),
      revoker: homeRevocationWriter(w.h, () => handle.assertHeld()),
      repo: personalRepoRemoval(deps, locks),
      payload: v1PayloadSync(o.phase),
      now: () => NOW,
      phase: o.phase,
      syncLock: {
        withLock: async (fn) => {
          syncOrder.push('sync');
          return fn();
        },
      },
      ...(o.onStep !== undefined ? { onStep: o.onStep } : {}),
      ...(o.recorded === true
        ? {
            recordedRecords: async (): Promise<RepoRead<PersonalLifecycleRecord[]>> => {
              const r = await readRecordedPersonalFiles(deps, locks, ['lifecycle']);
              if (r.status !== 'ok') return { kind: 'invalid', why: r.status };
              return {
                kind: 'ok',
                head: r.head,
                value: r.files.map((f) =>
                  PersonalLifecycleRecordSchema.parse(JSON.parse(f.content)),
                ),
              };
            },
          }
        : {}),
    };
    return { report: await rsiAutoClear(d, { write: o.write }), syncOrder };
  });
}

const headRecord = (w: World): PersonalLifecycleRecord =>
  PersonalLifecycleRecordSchema.parse(JSON.parse(git(w, ['show', `HEAD:lifecycle/${ID}.json`])));
const headFiles = (w: World): string[] =>
  git(w, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');

describe('R21-9.5 验收②:仓库 `.state` 不访问,clear 仍退出 0 完成', () => {
  it('shadow 候选:凭据 by=clear,私有仓库提交终态 cleared 并删原子文件;没有创建任何仓库 .state / rsi 目录,[rsi] repo 目录仍为空', async () => {
    const w = await makeWorld('w7-clear-');
    await setup(w, shadowRec());
    const { report, syncOrder } = await runClear(w, { phase: V1A, write: true });
    expect(report.unavailable).toBeNull();
    expect(report.candidates).toEqual([{ id: ID, lifecycle: 'shadow' }]);
    expect(report.outcomes.map((o) => o.status)).toEqual(['complete']);
    expect(report.pendingReconcile).toEqual([ID]);
    expect(syncOrder).toEqual(['sync']);
    const rv = await readRevocations(w.h);
    expect(rv).toMatchObject({
      kind: 'ok',
      value: [
        { candidate_id: ID, content_sha256: SHA, by: 'clear', reason: 'cleared', identity12: null },
      ],
    });
    const rcd = headRecord(w);
    expect(rcd.lifecycle).toBe('rejected');
    expect(rcd.terminal_reason).toBe('cleared');
    expect(headFiles(w)).toContain('rules/base.md');
    expect(headFiles(w)).not.toContain(RULE);
    expect(await exists(path.join(w.dir, 'state'))).toBe(false); // 仓库 .state(KIT_STATE_DIR)没有被创建
    expect(await readDir(w.rsiRepo)).toHaveLength(0);
    expect(await readDir(path.join(w.h.stateDir, 'txn'))).toHaveLength(0); // journal 已删
  });

  it('canary 候选(V1b):走四段,记录 rolled_back / cleared、deploy 清空;终态效果记待对账(不访问 .state)', async () => {
    const w = await makeWorld('w7-clear-c-');
    await setup(w, canaryRec());
    const { report } = await runClear(w, { phase: V1B, write: true });
    expect(report.outcomes).toEqual([
      { status: 'complete', txn: expect.any(String), effects: 'deferred' },
    ]);
    const rcd = headRecord(w);
    expect(rcd.lifecycle).toBe('rolled_back');
    expect(rcd.terminal_reason).toBe('cleared');
    expect(rcd.deploy).toEqual({ claude: 'none', pi: 'none', codex: 'none' });
    expect(headFiles(w)).not.toContain(RULE);
  });

  it('干跑(无 --write):只列清单,零写入(无凭据、无 journal、HEAD 与记录不变)', async () => {
    const w = await makeWorld('w7-clear-dry-');
    await setup(w, shadowRec());
    const head = git(w, ['rev-parse', 'HEAD']);
    const { report } = await runClear(w, { phase: V1A, write: false });
    expect(report.candidates).toEqual([{ id: ID, lifecycle: 'shadow' }]);
    expect(report.outcomes).toEqual([]);
    expect(report.pendingReconcile).toEqual([]);
    expect(await readRevocations(w.h)).toEqual({ kind: 'absent' });
    expect(await exists(path.join(w.h.stateDir, 'txn'))).toBe(false);
    expect(git(w, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('能力闸:相位早于 V1a(cmd_auto_clear)→ phase_not_available,不写任何东西', async () => {
    const w = await makeWorld('w7-clear-phase-');
    await setup(w, shadowRec());
    const { report } = await runClear(w, { phase: 0, write: true });
    expect(report.unavailable).toBe('phase_not_available');
    expect(await readRevocations(w.h)).toEqual({ kind: 'absent' });
  });
});

describe('R21-9.3a 人工分叉 / 属主变化下的撤销', () => {
  it('工作树被用户改动(diverged):凭据照样落盘;私有仓库不提交、不动引用 / 索引 / 工作树(不 reset 用户改动);journal 保留;分叉解除后续做完成', async () => {
    const w = await makeWorld('w7-clear-div-');
    await setup(w, shadowRec());
    const head = git(w, ['rev-parse', 'HEAD']);
    await writeUserFile(w, 'rules/base.md', 'user edit\n');
    const first = await runClear(w, { phase: V1A, write: true, recorded: true });
    expect(first.report.unavailable).toBeNull();
    expect(first.report.outcomes[0]).toMatchObject({ status: 'incomplete' });
    expect(await readRevocations(w.h)).toMatchObject({ kind: 'ok', value: [{ by: 'clear' }] });
    expect(git(w, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readText(path.join(w.h.repoDir, 'rules/base.md'))).toBe('user edit\n');
    expect(await readDir(path.join(w.h.stateDir, 'txn'))).toHaveLength(1);
    // 分叉解除(用户还原改动)
    git(w, ['checkout', '--', 'rules/base.md']);
    const second = await runClear(w, { phase: V1A, write: true, recorded: true });
    expect(second.report.outcomes.map((o) => o.status)).toEqual(['complete']);
    expect(headRecord(w).terminal_reason).toBe('cleared');
    expect((await readRevocations(w.h)) as { value: unknown[] }).toMatchObject({
      value: [expect.anything()],
    }); // 不重复
  });

  it('diverged 且没有只读读取端口:候选枚举不到 → unavailable(fail-closed),不写凭据', async () => {
    const w = await makeWorld('w7-clear-div2-');
    await setup(w, shadowRec());
    await writeUserFile(w, 'rules/base.md', 'user edit\n');
    const { report } = await runClear(w, { phase: V1A, write: true });
    expect(report.unavailable).toBe('repo_unreadable:recorded_read_not_wired');
    expect(await readRevocations(w.h)).toEqual({ kind: 'absent' });
  });

  it('[rsi] repo 换了(指纹不同):普通读取是 deferred(personal_owner_changed),缩减入口用 head.json 记录的指纹照常完成', async () => {
    const w = await makeWorld('w7-clear-owner-');
    await setup(w, shadowRec());
    const other = 'f'.repeat(16);
    const control = await withLock(w, (locks) =>
      personalRepoStore(repoDeps(w, { ownerRepoFp: other }), locks).readAll(),
    );
    expect(control).toMatchObject({ kind: 'deferred', reason: 'personal_owner_changed' });
    const { report } = await runClear(w, { phase: V1A, write: true });
    expect(report.outcomes.map((o) => o.status)).toEqual(['complete']);
    expect(headRecord(w).lifecycle).toBe('rejected');
  });
});

describe('R21-9.5 验收③:并发 clear 与旧 worker 经 personal/lock 串行,被清候选没有任何授予写入', () => {
  it('持锁方在时 clear 拿不到 personal/lock(locked),不写;释放后 clear 完成,之后 grantCanary 被凭据拒绝(revoked)', async () => {
    const w = await makeWorld('w7-clear-lock-');
    await setup(w, canaryRec());
    const worker = await acquirePersonalLock(w.h);
    await expect(acquirePersonalLock(w.h)).rejects.toBeInstanceOf(RsiLockError); // 同进程不重入(跨进程为 locked)
    expect(await readRevocations(w.h)).toEqual({ kind: 'absent' });
    await worker.release();
    await runClear(w, { phase: V1B, write: true });
    // 旧快照里的 worker 现在想授予:持锁重读凭据 → 拒绝
    const store = new MemStore();
    store.put(canaryRec());
    const cw = await rsiDir(w.io);
    const grant = await grantCanary(
      {
        io: w.io,
        rsiDir: cw,
        locks: {
          rsi: { assertHeld: async () => undefined },
          personal: { assertHeld: async () => undefined },
        },
        revocations: homeRevocationReader(w.h),
        store,
        bodyOf: async () => BODY,
      },
      {
        candidate_id: ID,
        content_sha256: SHA,
        p_by_agent: { claude: 0.5 },
        agents_inject: ['claude'],
        background_fp: '1'.repeat(16),
        background_fp_ex: '2'.repeat(16),
        policy_fp: POLICY,
      },
    );
    expect(grant).toEqual({ kind: 'refused', reason: 'revoked' });
    expect(await exists(path.join(cw, CANARY_FILES.canary))).toBe(false);
  });
});

describe('R21-9.5 验收①④:对账(原仓库恢复、配置重新启用后)', () => {
  it('①clear 不碰 .state:canary.json 原样残留;hint 对被清候选为 excluded(revoked);worker 首次运行补 stop 行并删缓存,屏障放行;④再对账一次分组账只多一条 stop', async () => {
    const w = await makeWorld('w7-clear-recon-');
    await setup(w, canaryRec());
    const rsi = await rsiDir(w.io);
    const hold = { assertHeld: async () => undefined };
    await writeRsiFileAtomic(w.io, rsi, CANARY_FILES.canary, canonicalJson(canaryDoc()), [hold]);
    await writeRsiFileAtomic(w.io, rsi, CANARY_FILES.admission, canonicalJson(adm(admitted())), [
      hold,
    ]);
    const before = await readText(path.join(rsi, CANARY_FILES.canary));

    await runClear(w, { phase: V1B, write: true });
    expect(await readText(path.join(rsi, CANARY_FILES.canary))).toBe(before); // clear 没碰仓库 .state
    expect(await readLedger(rsi)).toEqual({ kind: 'absent' });

    // 原仓库恢复 + 重新启用:下一次 hint 对该候选 excluded(凭据优先于缓存),不会注入
    const decision = await decideCanary({
      agent: 'claude',
      autoLoopEffective: true,
      phase: V1B,
      policyFp: POLICY,
      shapeVersion: 'claude-1',
      agentVersion: '2.1.0',
      nowMs: T0,
      port: makePermitPort(rsi, w.home),
    });
    expect(decision).toMatchObject({ kind: 'excluded', row: 4, reason: 'revoked' });

    // worker 首次运行:先对账
    const lines = await withLock(w, async () => {
      const r = await readRevocations(w.h);
      return r.kind === 'ok' ? r.value : [];
    });
    expect(lines).toHaveLength(1);
    const records = await withLock(w, async (locks) => {
      const all = await personalRepoStore(repoDeps(w), locks).readAll();
      return all.kind === 'ok' ? all.value : [];
    });
    const rsiLock = await acquireRsiLock(w.io);
    try {
      const d = { io: w.io, rsiDir: rsi, locks: { rsi: rsiLock } };
      expect((await reconcileBarrier(d, lines, records)).ok).toBe(false);
      await reconcileCaches(d, lines, new Date(NOW));
      expect(await exists(path.join(rsi, CANARY_FILES.canary))).toBe(false);
      expect((await reconcileBarrier(d, lines, records)).ok).toBe(true);
      await reconcileCaches(d, lines, new Date(NOW)); // ④ 再对账:不重复
    } finally {
      await rsiLock.release();
    }
    const ledger = await readLedger(rsi);
    expect(ledger.kind).toBe('ok');
    const stops = ledger.kind === 'ok' ? ledger.lines.filter((l) => l.kind === 'stop') : [];
    expect(stops).toHaveLength(1);
  });
});

describe('R21-3.3 锁序:clear 在 personal/lock 之内再取 sync 锁,从不取 rsi/lock', () => {
  it('sync 锁取不到(抛 locked)→ 不写任何东西', async () => {
    const w = await makeWorld('w7-clear-sync-');
    await setup(w, shadowRec());
    await expect(
      withLock(w, async (locks, handle) => {
        const deps = repoDeps(w);
        const d: ClearDeps = {
          store: personalRepoStore(deps, locks),
          revocations: homeRevocationReader(w.h),
          locks,
          txns: homeTxnStore(w.h),
          revoker: homeRevocationWriter(w.h, () => handle.assertHeld()),
          repo: personalRepoRemoval(deps, locks),
          payload: v1PayloadSync(V1A),
          now: () => NOW,
          phase: V1A,
          syncLock: {
            withLock: async () => {
              throw new RsiLockError('locked');
            },
          },
        };
        return rsiAutoClear(d, { write: true });
      }),
    ).rejects.toMatchObject({ kind: 'locked' });
    expect(await readRevocations(w.h)).toEqual({ kind: 'absent' });
  });
});

describe('崩溃续做(真 git):clear 在第三段中途崩溃,缩减入口自己可重试', () => {
  it('journal 在、记录已终态:再跑一次 clear 先续做在途 journal(不依赖 worker)→ 完成,journal 删除,凭据一行;干跑能看到在途 journal', async () => {
    const w = await makeWorld('w7-clear-crash-');
    await setup(w, shadowRec());
    class Boom extends Error {}
    await expect(
      runClear(w, {
        phase: V1A,
        write: true,
        onStep: (s) => {
          if (s === 'after:record_event') throw new Boom('crash');
        },
      }),
    ).rejects.toBeInstanceOf(Boom);
    expect(await readDir(path.join(w.h.stateDir, 'txn'))).toHaveLength(1);
    // 记录已是终态(第三段的记录提交在崩溃点之前),文件还没删
    expect(headRecord(w).lifecycle).toBe('rejected');
    expect(headFiles(w)).toContain(RULE);
    const dry = await runClear(w, { phase: V1A, write: false });
    expect(dry.report.inFlight).toHaveLength(1);
    expect(dry.report.candidates).toEqual([]);
    const again = await runClear(w, { phase: V1A, write: true });
    expect(again.report.outcomes.map((o) => o.status)).toEqual(['complete']);
    expect(await readDir(path.join(w.h.stateDir, 'txn'))).toHaveLength(0);
    expect(headFiles(w)).not.toContain(RULE);
    expect((await readRevocations(w.h)) as { value: unknown[] }).toMatchObject({
      value: [expect.anything()],
    });
  });
});

describe('第三段删除范围(W0-15):只删 target_paths,且只限 kit 管理命名空间、不得删 lifecycle/', () => {
  it('target_path 指向 lifecycle/ 或管理命名空间之外 → TreeSpecError,仓库不动', async () => {
    const w = await makeWorld('w7-clear-scope-');
    await setup(w, shadowRec());
    const head = git(w, ['rev-parse', 'HEAD']);
    await withLock(w, async (locks) => {
      const rm = personalRepoRemoval(repoDeps(w), locks);
      await expect(
        rm.remove({ id: ID, content_sha256: SHA, target_paths: [`lifecycle/${ID}.json`] }, 'clear'),
      ).rejects.toBeInstanceOf(TreeSpecError);
      await expect(
        rm.remove({ id: ID, content_sha256: SHA, target_paths: ['notes/x.md'] }, 'clear'),
      ).rejects.toBeInstanceOf(TreeSpecError);
    });
    expect(git(w, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('目标路径已不在 HEAD(崩溃重做)→ already,不产生新提交;用户在同目录新增的文件原样保留', async () => {
    const w = await makeWorld('w7-clear-already-');
    await setup(w, shadowRec());
    const res = await withLock(w, async (locks) => {
      const rm = personalRepoRemoval(repoDeps(w), locks);
      const c = { id: ID, content_sha256: SHA, target_paths: [RULE] };
      const a = await rm.remove(c, 'clear');
      const head = git(w, ['rev-parse', 'HEAD']);
      const b = await rm.remove(c, 'clear');
      return { a, b, same: git(w, ['rev-parse', 'HEAD']) === head };
    });
    expect(res).toEqual({ a: { status: 'committed' }, b: { status: 'already' }, same: true });
    expect(headFiles(w)).toContain('rules/base.md');
  });
});
