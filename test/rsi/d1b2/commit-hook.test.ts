/**
 * D1b-2:`TreeSpec.beforeRefUpdate` 钩子与 `CommitResult.denied`(真 git、真 journal;设计稿 §7、I8)。
 * 契约:钩子在**最后一次 `assertLocks` 之后、`update-ref` 之前**调用,返回后再复核一次锁;只认 `BeforeRefUpdateDenied` 为拒绝
 * (→ `denied`,引用不动,自己写下的 journal 在所有权核对后删除);其它错误(含 `RsiLockError`)原样传播,不删 journal、不改引用。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import {
  BeforeRefUpdateDenied,
  commitPersonal,
  type PersonalLocks,
} from '../../../src/rsi/personal/commit.js';
import { EMPTY_TREE } from '../../../src/rsi/personal/commit-journal.js';
import { readJournal, writeJournal } from '../../../src/rsi/personal/home-state.js';
import {
  git,
  makeWorld,
  NEXT_FILES,
  repoDeps,
  setupRepo,
  slowTests,
  snapshot,
  spec,
  withLock,
  type World,
} from '../personal/repo-helpers.js';

slowTests();

/** 可丢的假锁:`lost.value = true` 之后 `assertHeld` 抛 `lock_lost`(与真锁同一契约) */
function lossyLocks(): { locks: PersonalLocks; lost: { value: boolean }; checks: { n: number } } {
  const lost = { value: false };
  const checks = { n: 0 };
  return {
    lost,
    checks,
    locks: {
      personal: {
        assertHeld: async () => {
          checks.n++;
          if (lost.value) throw new RsiLockError('lock_lost');
        },
      },
    },
  };
}

const refOf = (w: World): string => git(w, ['rev-parse', 'refs/heads/rsi']);

describe('beforeRefUpdate:拒绝', () => {
  it('before_ref_update_denied_ref_unchanged_journal_removed:钩子拒绝 → denied{code};引用 / 索引 / 工作树 / journal 全部回到提交前;钩子在 objects_written 阶段、引用仍为旧值时被调用', async () => {
    const w = await makeWorld('d1b2-hook-deny-');
    await setupRepo(w);
    const before = await snapshot(w);
    const seen: { phase: string | null; ref: string }[] = [];
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          const j = await readJournal(w.h);
          seen.push({ phase: j.kind === 'ok' ? j.value.phase : null, ref: refOf(w) });
          throw new BeforeRefUpdateDenied('paused');
        },
      }),
    );
    expect(r).toEqual({ status: 'denied', code: 'paused' });
    expect(seen).toEqual([{ phase: 'objects_written', ref: refOf(w) }]);
    expect(await snapshot(w)).toEqual(before);
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
  });

  it('denied 之后同一仓库可以正常再提交(没有残留 journal 挡路)', async () => {
    const w = await makeWorld('d1b2-hook-deny-then-ok-');
    await setupRepo(w);
    const denied = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          throw new BeforeRefUpdateDenied('x');
        },
      }),
    );
    expect(denied.status).toBe('denied');
    const ok = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('3', NEXT_FILES)),
    );
    expect(ok.status).toBe('committed');
  });

  it('before_ref_update_denied_foreign_journal_untouched:钩子期间 journal 被换成别的事务 → denied,但不删别人的 journal', async () => {
    const w = await makeWorld('d1b2-hook-foreign-');
    await setupRepo(w);
    let foreign = '';
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          const j = await readJournal(w.h);
          if (j.kind !== 'ok') throw new Error('journal 应在');
          foreign = 'f'.repeat(16);
          await writeJournal(w.h, { ...j.value, txn_id: foreign });
          throw new BeforeRefUpdateDenied('x');
        },
      }),
    );
    expect(r.status).toBe('denied');
    const after = await readJournal(w.h);
    expect(after.kind === 'ok' ? after.value.txn_id : null).toBe(foreign);
  });

  it('before_ref_update_denied_same_txn_different_content_untouched:txn_id 相同但内容(target_tree)不同 → 不删(只比 txn_id 不够)', async () => {
    const w = await makeWorld('d1b2-hook-samecontent-');
    await setupRepo(w);
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          const j = await readJournal(w.h);
          if (j.kind !== 'ok') throw new Error('journal 应在');
          await writeJournal(w.h, { ...j.value, target_tree: EMPTY_TREE });
          throw new BeforeRefUpdateDenied('x');
        },
      }),
    );
    expect(r.status).toBe('denied');
    const after = await readJournal(w.h);
    expect(after.kind === 'ok' ? after.value.target_tree : null).toBe(EMPTY_TREE);
  });
});

describe('beforeRefUpdate:其它错误一律传播(不当成拒绝)', () => {
  it('before_ref_update_lock_lost_propagates_no_cleanup:钩子抛 RsiLockError / 未知错误 → 原样传播;journal 留在 objects_written;引用不变', async () => {
    for (const err of [new RsiLockError('lock_lost'), new Error('boom')]) {
      const w = await makeWorld('d1b2-hook-throw-');
      await setupRepo(w);
      const ref0 = refOf(w);
      await expect(
        withLock(w, (locks) =>
          commitPersonal(repoDeps(w), locks, {
            ...spec('2', NEXT_FILES),
            beforeRefUpdate: async () => {
              throw err;
            },
          }),
        ),
      ).rejects.toBe(err);
      expect(refOf(w)).toBe(ref0);
      const j = await readJournal(w.h);
      expect(j.kind === 'ok' ? j.value.phase : null).toBe('objects_written');
    }
  });

  it('伪造的「拒绝」(普通 Error 带 code 字段)不是拒绝:只认 BeforeRefUpdateDenied 实例', async () => {
    const w = await makeWorld('d1b2-hook-fake-deny-');
    await setupRepo(w);
    const fake = Object.assign(new Error('denied'), { code: 'paused' });
    await expect(
      withLock(w, (locks) =>
        commitPersonal(repoDeps(w), locks, {
          ...spec('2', NEXT_FILES),
          beforeRefUpdate: async () => {
            throw fake;
          },
        }),
      ),
    ).rejects.toBe(fake);
  });
});

describe('beforeRefUpdate:位置与锁复核', () => {
  it('顺序:before:update-ref 步骤点 → 钩子 → update-ref(after:update-ref);钩子恰好调用一次', async () => {
    const w = await makeWorld('d1b2-hook-order-');
    await setupRepo(w);
    const events: string[] = [];
    const r = await withLock(w, (locks) =>
      commitPersonal(
        repoDeps(w, {
          onStep: (s) => {
            if (s === 'before:update-ref' || s === 'after:update-ref') events.push(`step:${s}`);
          },
        }),
        locks,
        {
          ...spec('2', NEXT_FILES),
          beforeRefUpdate: async () => {
            events.push('hook');
          },
        },
      ),
    );
    expect(r.status).toBe('committed');
    expect(events).toEqual(['step:before:update-ref', 'hook', 'step:after:update-ref']);
  });

  it('hook_before_last_assertlocks:钩子之前丢锁 → 抛 lock_lost,钩子不被调用,引用不变', async () => {
    const w = await makeWorld('d1b2-hook-prelock-');
    await setupRepo(w);
    const ref0 = refOf(w);
    const { locks, lost } = lossyLocks();
    let called = 0;
    await expect(
      commitPersonal(
        repoDeps(w, {
          onStep: (s) => {
            if (s === 'before:update-ref') lost.value = true;
          },
        }),
        locks,
        {
          ...spec('2', NEXT_FILES),
          beforeRefUpdate: async () => {
            called++;
          },
        },
      ),
    ).rejects.toBeInstanceOf(RsiLockError);
    expect(called).toBe(0);
    expect(refOf(w)).toBe(ref0);
  });

  it('hook_without_post_assertlocks:钩子(现读)期间丢锁、钩子正常返回 → 抛 lock_lost,引用不变(钩子之后到 update-ref 之间不得丢锁)', async () => {
    const w = await makeWorld('d1b2-hook-postlock-');
    await setupRepo(w);
    const ref0 = refOf(w);
    const { locks, lost } = lossyLocks();
    await expect(
      commitPersonal(repoDeps(w), locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          lost.value = true;
        },
      }),
    ).rejects.toBeInstanceOf(RsiLockError);
    expect(refOf(w)).toBe(ref0);
  });

  it('拒绝后清理 journal 之前先复核锁:钩子丢锁并拒绝 → 传播 lock_lost,journal 不动(留给下次恢复)', async () => {
    const w = await makeWorld('d1b2-hook-denylock-');
    await setupRepo(w);
    const { locks, lost } = lossyLocks();
    await expect(
      commitPersonal(repoDeps(w), locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          lost.value = true;
          throw new BeforeRefUpdateDenied('x');
        },
      }),
    ).rejects.toBeInstanceOf(RsiLockError);
    const j = await readJournal(w.h);
    expect(j.kind === 'ok' ? j.value.phase : null).toBe('objects_written');
  });

  it('denied_cleanup_skips_remove_lock_check:清理在「读盘并核对所有权」之后、删除之前再复核一次锁:清理阶段恰有两次锁断言;第二次丢锁 → 传播 lock_lost,journal 不动', async () => {
    // 钩子拒绝之后才开始计数(armed):清理阶段的 assertHeld 调用次数 + 在第 N 次丢锁
    async function run(failAt: number): Promise<{ n: number; err: unknown; w: World }> {
      const w = await makeWorld('d1b2-hook-removelock-');
      await setupRepo(w);
      const st = { armed: false, n: 0 };
      const locks: PersonalLocks = {
        personal: {
          assertHeld: async () => {
            if (!st.armed) return;
            st.n++;
            if (st.n >= failAt) throw new RsiLockError('lock_lost');
          },
        },
      };
      let err: unknown = null;
      try {
        await commitPersonal(repoDeps(w), locks, {
          ...spec('2', NEXT_FILES),
          beforeRefUpdate: async () => {
            st.armed = true;
            throw new BeforeRefUpdateDenied('x');
          },
        });
      } catch (e) {
        err = e;
      }
      return { n: st.n, err, w };
    }
    const dry = await run(Number.POSITIVE_INFINITY);
    expect(dry.err).toBeNull();
    expect(dry.n).toBe(2); // 读盘之前一次 + 删除之前一次
    const lostAtRemove = await run(2);
    expect(lostAtRemove.err).toBeInstanceOf(RsiLockError);
    const j = await readJournal(lostAtRemove.w.h);
    expect(j.kind === 'ok' ? j.value.phase : null).toBe('objects_written');
  });

  it('不带钩子的调用方行为不变(加法):同一提交 committed,钩子字段缺省', async () => {
    const w = await makeWorld('d1b2-hook-absent-');
    await setupRepo(w);
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('2', NEXT_FILES)),
    );
    expect(r.status).toBe('committed');
  });
});
