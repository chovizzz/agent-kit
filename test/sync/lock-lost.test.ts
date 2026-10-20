/**
 * S7c-B:sync 事务的每个提交点前复核仍持锁(陈旧锁回收竞态里锁被别人夺走时,不得继续写)。
 * 正向对照:同一世界不夺锁则正常写完。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SYNC_LOCK_PARTIAL_GRACE_MS,
  applyPlan,
  type ApplyEnv,
  type LockHandle,
} from '../../src/sync/apply.js';
import type { SyncPlan } from '../../src/sync/types.js';
import { readDir, realpath } from '../../src/io/read-fs.js';
import { SKILL, isState, newWorld, stdFixture, treeOf, type World } from './world.js';

const LOCK = '.local/state/agent-kit/sync/lock';
const thief = JSON.stringify({
  pid: process.pid,
  started_at: '2026-10-14T12:00:00.000Z',
  nonce: 'ffffffffffffffff',
});

describe('sync:提交点前复核锁所有权', () => {
  it('journal 写完后锁被夺走:不写任何受管文件,退出 4 SYNC_LOCKED,别人的锁不被删;对照:不夺锁则写完', async () => {
    const ok = await newWorld('lock-lost-ok-');
    await ok.setPayload(stdFixture());
    expect((await ok.run(['--write'])).code).toBe(0);
    expect(await ok.has(SKILL)).toBe(true);

    const w = await newWorld('lock-lost-');
    await w.setPayload(stdFixture());
    const r = await w.run(['--write'], {
      deps: {
        inject: async (p) => {
          if (p === 'journal-written') await w.put(LOCK, thief, 0o600);
        },
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe('SYNC_NOT_RUN reason=SYNC_LOCKED\n');
    expect(await w.has(SKILL)).toBe(false);
    expect(await w.read(LOCK)).toBe(thief);
  });

  it('写第一个文件之后锁被夺走:不继续写后面的文件与登记表', async () => {
    const w = await newWorld('lock-lost-mid-');
    await w.setPayload(stdFixture());
    let first = true;
    const r = await w.run(['--write'], {
      deps: {
        inject: async (p) => {
          if (p.startsWith('after-write:') && first) {
            first = false;
            await w.put(LOCK, thief, 0o600);
          }
        },
      },
    });
    expect(r.code).toBe(4);
    expect(await w.has('.local/state/agent-kit/sync/ledger.json')).toBe(false);
  });
});

const SYNC_DIR = '.local/state/agent-kit/sync';
const LEDGER_PATH = `${SYNC_DIR}/ledger.json`;
const CRASH_MID = 'after-write:.claude/rules/agent-kit/org.md';

const residual = async (w: World): Promise<string[]> => {
  try {
    return (await readDir(path.join(w.home, `${SYNC_DIR}/txn`))).map((e) =>
      e.name.replace(/\.json$/, ''),
    );
  } catch {
    return [];
  }
};
/** 受管文件视图(排除状态目录) */
const managed = async (w: World): Promise<string[]> =>
  [...(await treeOf(w.home, isState)).files].map(([k, v]) => `${k} ${v}`).sort();

/** 先装到一半崩溃(留下残留事务) */
async function crashed(label: string): Promise<{ w: World; id: string }> {
  const w = await newWorld(label);
  await w.setPayload(stdFixture());
  await w.run(['--write'], {
    deps: {
      inject: (p) => {
        if (p === CRASH_MID) throw new Error('EIO injected');
      },
    },
  });
  const [id] = await residual(w);
  expect(id).toBeDefined();
  return { w, id: id as string };
}

describe('sync:--rollback / --resume / 仅登记表写入同样在写出口前复核锁(K6)', () => {
  it('--resume:写第一个待写文件前锁被夺走 → 退出 4,不写文件也不写登记表;别人的锁不被删', async () => {
    const { w } = await crashed('lock-lost-resume-');
    const before = await managed(w);
    const r = await w.run(['--write', '--resume'], {
      deps: {
        inject: async (p) => {
          if (p.startsWith('before-write:')) await w.put(LOCK, thief, 0o600);
        },
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe('SYNC_NOT_RUN reason=SYNC_LOCKED\n');
    expect(await managed(w)).toEqual(before);
    expect(await w.has(LEDGER_PATH)).toBe(false);
    expect(await w.read(LOCK)).toBe(thief);
    // 正向对照:不夺锁则同一世界 --resume 写完
    const ok = await crashed('lock-lost-resume-ok-');
    expect((await ok.w.run(['--write', '--resume'])).code).toBe(0);
    expect(await ok.w.has(LEDGER_PATH)).toBe(true);
  });

  it('--rollback:回滚事务的 journal 写完后锁被夺走 → 退出 4,不还原任何文件', async () => {
    const { w, id } = await crashed('lock-lost-rollback-');
    const before = await managed(w);
    const r = await w.run(['--write', '--rollback', id], {
      deps: {
        inject: async (p) => {
          if (p === 'journal-written') await w.put(LOCK, thief, 0o600);
        },
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe('SYNC_NOT_RUN reason=SYNC_LOCKED\n');
    expect(await managed(w)).toEqual(before);
    expect(await w.read(LOCK)).toBe(thief);
    // 正向对照
    const ok = await crashed('lock-lost-rollback-ok-');
    expect((await ok.w.run(['--write', '--rollback', ok.id])).code).toBe(0);
    expect(await managed(ok.w)).not.toEqual(before);
  });

  it('applyPlan 仅改登记表(无事务)的路径:写前复核;锁丢了就不动登记表(对照:锁仍持有则删除)', async () => {
    const w = await newWorld('lock-lost-ledger-only-');
    await w.put(LEDGER_PATH, '{"placeholder":true}\n', 0o600);
    const env: ApplyEnv = {
      home: w.home,
      homeReal: await realpath(w.home),
      tmpDir: w.dir,
      env: w.env,
      deps: {},
    };
    const plan = {
      status: 'ok',
      ops: [],
      ledger: { action: 'delete', next: null },
    } as unknown as SyncPlan;
    const input = (lock: LockHandle) => ({
      action: 'adopt' as const,
      plan,
      payload: null,
      snapshot: { snapshot: { entries: {} }, texts: new Map(), modes: new Map() } as never,
      ledgerRead: { state: 'absent' } as never,
      txnId: 'txn-20261020T000000Z-abcdef',
      lock,
    });
    const lost: LockHandle = {
      assertHeld: () => Promise.reject(new Error('SYNC_LOCKED lost')),
      release: () => Promise.resolve(),
    };
    await expect(applyPlan(env, input(lost))).rejects.toThrow('SYNC_LOCKED');
    expect(await w.has(LEDGER_PATH)).toBe(true);
    const held: LockHandle = {
      assertHeld: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    await applyPlan(env, input(held));
    expect(await w.has(LEDGER_PATH)).toBe(false);
  });
});

describe('sync 锁:空锁文件(O_EXCL 创建与写入之间的窗口)的陈旧判定(K6 补测)', () => {
  it('空文件且创建不满宽限期:按被持有(SYNC_LOCKED,不回收);超过宽限期:当陈旧锁回收后正常写完', async () => {
    const w = await newWorld('lock-empty-grace-');
    await w.setPayload(stdFixture());
    await w.put(LOCK, '', 0o600);
    const young = await w.run(['--write']);
    expect(young.code).toBe(4);
    expect(young.err).toBe('SYNC_NOT_RUN reason=SYNC_LOCKED\n');
    expect(await w.has(SKILL)).toBe(false);
    expect(await w.read(LOCK)).toBe(''); // 没被回收

    const aged = await w.run(['--write'], {
      deps: { now: () => new Date(Date.now() + SYNC_LOCK_PARTIAL_GRACE_MS + 5_000) },
    });
    expect(aged.code).toBe(0);
    expect(await w.has(SKILL)).toBe(true);
    expect(await w.has(LOCK)).toBe(false); // 用完释放
  });
});

describe('sync:收尾阶段(journal 删除 / 备份修剪)同样复核锁(K6 评审补)', () => {
  it('登记表写完、删 journal 之前锁被夺走:不删 journal、不修剪备份(残留事务可 --resume 收尾);对照:不夺锁则 journal 被删', async () => {
    const w = await newWorld('lock-lost-late-');
    await w.setPayload(stdFixture());
    const r = await w.run(['--write'], {
      deps: {
        inject: async (p) => {
          if (p === 'before-journal-delete') await w.put(LOCK, thief, 0o600);
        },
      },
    });
    expect(r.code).toBe(4);
    expect(await residual(w)).toHaveLength(1); // journal 还在
    expect(await w.read(LOCK)).toBe(thief);

    const ok = await newWorld('lock-lost-late-ok-');
    await ok.setPayload(stdFixture());
    expect((await ok.run(['--write'])).code).toBe(0);
    expect(await residual(ok)).toEqual([]);
  });

  it('journal 写完后锁被夺走:不建任何备份(备份目录不存在);对照:不夺锁则备份目录存在', async () => {
    const backups = `${SYNC_DIR}/backups`;
    const w = await newWorld('lock-lost-nobackup-');
    await w.setPayload(stdFixture());
    await w.run(['--write'], {
      deps: {
        inject: async (p) => {
          if (p === 'journal-written') await w.put(LOCK, thief, 0o600);
        },
      },
    });
    expect(await w.has(backups)).toBe(false);
    const ok = await newWorld('lock-lost-nobackup-ok-');
    await ok.setPayload(stdFixture());
    await ok.run(['--write']);
    expect(await ok.has(backups)).toBe(true);
  });
});
