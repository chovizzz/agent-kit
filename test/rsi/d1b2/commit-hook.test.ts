/**
 * D1b-2:`TreeSpec.beforeRefUpdate` 钩子与 `CommitResult.denied`(真 git、真 journal;设计稿 §7、I8)。
 * 契约:钩子在**最后一次 `assertLocks` 之后、`update-ref` 之前**调用,返回后再复核一次锁;只认 `BeforeRefUpdateDenied` 为拒绝
 * (→ `denied`,引用不动,自己写下的 journal 在所有权核对后删除);其它错误(含 `RsiLockError`)原样传播,不删 journal、不改引用。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, lstat, readDir, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import type { PersonalCommitJournal } from '../../../src/contracts/rsi-personal.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import {
  BeforeRefUpdateDenied,
  commitPersonal,
  inspectPersonalRepo,
  openPersonalRepo,
  type PersonalLocks,
  type StepHook,
} from '../../../src/rsi/personal/commit.js';
import { EMPTY_TREE } from '../../../src/rsi/personal/commit-journal.js';
import {
  PERSONAL_STATE_FILES,
  isTombstoneName,
  personalHome,
  type PersonalHome,
  readJournal,
  removeJournal,
  statePath,
  writeJournal,
} from '../../../src/rsi/personal/home-state.js';
import {
  crashAt,
  git,
  InjectedCrash,
  makeWorld,
  NEXT_FILES,
  READ_OPTS,
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

  it('before_ref_update_denied_foreign_journal_untouched:钩子期间 journal 被换成别的事务 → 不是普通 denied(invalid / journal_not_mine,保留现场),也不删别人的 journal', async () => {
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
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_not_mine' });
    const after = await readJournal(w.h);
    expect(after.kind === 'ok' ? after.value.txn_id : null).toBe(foreign);
  });

  it('before_ref_update_denied_same_txn_different_content_untouched:txn_id 相同但内容(target_tree)不同 → 不删且不当普通 denied(只比 txn_id 不够)', async () => {
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
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_not_mine' });
    const after = await readJournal(w.h);
    expect(after.kind === 'ok' ? after.value.target_tree : null).toBe(EMPTY_TREE);
  });

  it('denied_cleanup_journal_gone_not_plain_denied:钩子期间 journal 被删(无法确认是本次事务)→ invalid / journal_absent,不是普通 denied;引用不动', async () => {
    const w = await makeWorld('d1b2-hook-gone-');
    await setupRepo(w);
    const old = refOf(w);
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          await removeJournal(w.h);
          throw new BeforeRefUpdateDenied('x');
        },
      }),
    );
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_absent' });
    expect(refOf(w)).toBe(old);
  });

  it('denied_cleanup_ref_moved_not_plain_denied:钩子期间 refs/heads/rsi 被别人推进 → deferred / personal_repo_diverged,不是普通 denied;自己的 journal 与第三方引用都保留', async () => {
    const w = await makeWorld('d1b2-hook-refmoved-');
    await setupRepo(w);
    let moved = '';
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          const old = refOf(w);
          moved = git(w, ['commit-tree', `${old}^{tree}`, '-p', old, '-m', 'third']);
          git(w, ['update-ref', 'refs/heads/rsi', moved, old]);
          throw new BeforeRefUpdateDenied('x');
        },
      }),
    );
    expect(r).toMatchObject({
      status: 'deferred',
      reason: 'personal_repo_diverged',
      why: 'ref_moved_after_denied',
    });
    expect(refOf(w)).toBe(moved);
    const j = await readJournal(w.h);
    expect(j.kind === 'ok' ? j.value.phase : null).toBe('objects_written');
    // 重新打开仓库(下一次提交):保留的 journal 按既有恢复规则判定——引用是第三个值 → personal_repo_diverged,不改引用
    const again = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('3', NEXT_FILES)),
    );
    expect(again).toMatchObject({ status: 'deferred', reason: 'personal_repo_diverged' });
    expect(refOf(w)).toBe(moved);
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

  it('denied_cleanup_final_check_after_last_lock:最后一次锁复核**期间**引用被别人推进 → 不返回普通 denied(deferred / ref_moved_after_denied);journal 与第三方引用都保留(最终核对在最后一次锁复核之后)', async () => {
    const w = await makeWorld('d1b2-hook-finalref-');
    await setupRepo(w);
    let moved = '';
    const st = { armed: false, n: 0 };
    const locks: PersonalLocks = {
      personal: {
        assertHeld: async () => {
          if (!st.armed) return;
          st.n++;
          // 清理阶段第 2 次断言 = 删除之前的最后一次锁复核:此刻(await 之内)引用被推进
          if (st.n === 2) {
            const old = refOf(w);
            moved = git(w, ['commit-tree', `${old}^{tree}`, '-p', old, '-m', 'third']);
            git(w, ['update-ref', 'refs/heads/rsi', moved, old]);
          }
        },
      },
    };
    const r = await commitPersonal(repoDeps(w), locks, {
      ...spec('2', NEXT_FILES),
      beforeRefUpdate: async () => {
        st.armed = true;
        throw new BeforeRefUpdateDenied('x');
      },
    });
    expect(r).toMatchObject({
      status: 'deferred',
      reason: 'personal_repo_diverged',
      why: 'ref_moved_after_denied',
    });
    expect(st.n).toBeGreaterThanOrEqual(2);
    expect(refOf(w)).toBe(moved);
    const j = await readJournal(w.h);
    expect(j.kind === 'ok' ? j.value.phase : null).toBe('objects_written');
  });

  it('denied_cleanup_final_check_journal_gone:最后一次锁复核期间 journal 被删 → invalid / journal_absent,不是普通 denied;引用不动', async () => {
    const w = await makeWorld('d1b2-hook-finaljournal-');
    await setupRepo(w);
    const old = refOf(w);
    const st = { armed: false, n: 0 };
    const locks: PersonalLocks = {
      personal: {
        assertHeld: async () => {
          if (!st.armed) return;
          st.n++;
          if (st.n === 2) await removeJournal(w.h);
        },
      },
    };
    const r = await commitPersonal(repoDeps(w), locks, {
      ...spec('2', NEXT_FILES),
      beforeRefUpdate: async () => {
        st.armed = true;
        throw new BeforeRefUpdateDenied('x');
      },
    });
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_absent' });
    expect(refOf(w)).toBe(old);
  });

  it('denied_cleanup_final_check_journal_replaced:最后一次锁复核期间 journal 被换成别的事务的 → invalid / journal_not_mine,第三方 journal 原样保留(不删)', async () => {
    const w = await makeWorld('d1b2-hook-finalreplaced-');
    await setupRepo(w);
    const foreign = 'e'.repeat(16);
    const st = { armed: false, n: 0 };
    const locks: PersonalLocks = {
      personal: {
        assertHeld: async () => {
          if (!st.armed) return;
          st.n++;
          if (st.n === 2) {
            const j = await readJournal(w.h);
            if (j.kind !== 'ok') throw new Error('journal 应在');
            await writeJournal(w.h, { ...j.value, txn_id: foreign });
          }
        },
      },
    };
    const r = await commitPersonal(repoDeps(w), locks, {
      ...spec('2', NEXT_FILES),
      beforeRefUpdate: async () => {
        st.armed = true;
        throw new BeforeRefUpdateDenied('x');
      },
    });
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_not_mine' });
    const after = await readJournal(w.h);
    expect(after.kind === 'ok' ? after.value.txn_id : null).toBe(foreign);
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

/**
 * R3:拒绝后清理 journal 的「先原子改名到墓碑 → 对墓碑核对 → unlink 墓碑」协议。
 * 注入点(`onStep`):`discard:after-rename`(改名之后、核对墓碑之前)、`discard:before-unlink`(核对之后、unlink 之前);「改名之前」= 第 2 次锁断言(上面已有用例)。
 */
type HomeFsStage = Parameters<NonNullable<PersonalHome['onStage']>>[0];

describe('beforeRefUpdate:拒绝后清理的改名协议', () => {
  /** 墓碑名是随机的:在注入点上从状态目录里找出实际名字(恰好一个) */
  const findTomb = async (w: World): Promise<string> => {
    const names = (await readDir(w.h.stateDir)).map((e) => e.name).filter(isTombstoneName);
    if (names.length !== 1) throw new Error(`应恰有一个墓碑:${JSON.stringify(names)}`);
    return statePath(w.h, names[0] as string);
  };
  const leftovers = async (w: World): Promise<string[]> =>
    (await readDir(w.h.stateDir))
      .map((e) => e.name)
      .filter((n) => n.startsWith(PERSONAL_STATE_FILES.journal));
  const journalTxn = async (w: World): Promise<string | null> => {
    const j = await readJournal(w.h);
    return j.kind === 'ok' ? j.value.txn_id : null;
  };

  /** 钩子拒绝后跑清理;`at` 步骤上执行 `act`(此刻原路径上是什么由步骤决定) */
  async function run(
    prefix: string,
    at: 'discard:after-rename' | 'discard:before-unlink',
    act: (w: World, base: PersonalCommitJournal) => Promise<void>,
  ): Promise<{ w: World; r: Awaited<ReturnType<typeof commitPersonal>>; txn: string }> {
    const w = await makeWorld(prefix);
    await setupRepo(w);
    let base: PersonalCommitJournal | null = null;
    const deps = repoDeps(w, {
      onStep: async (step) => {
        if (step === at && base !== null) await act(w, base);
      },
    });
    const r = await withLock(w, (locks) =>
      commitPersonal(deps, locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          const j = await readJournal(w.h);
          if (j.kind !== 'ok') throw new Error('journal 应在');
          base = j.value;
          throw new BeforeRefUpdateDenied('x');
        },
      }),
    );
    if (base === null) throw new Error('钩子未被调用');
    return { w, r, txn: (base as PersonalCommitJournal).txn_id };
  }
  const foreignA = 'a'.repeat(16);
  const foreignB = 'b'.repeat(16);
  const advance = (w: World): string => {
    const old = refOf(w);
    const moved = git(w, ['commit-tree', `${old}^{tree}`, '-p', old, '-m', 'third']);
    git(w, ['update-ref', 'refs/heads/rsi', moved, old]);
    return moved;
  };

  it('denied_cleanup_rename_then_verify_ok:无人干扰 → denied;改名与删除之后原名与墓碑都不在', async () => {
    const { w, r } = await run('d1b2-aside-clean-', 'discard:after-rename', async () => undefined);
    expect(r).toEqual({ status: 'denied', code: 'x' });
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
    expect(await leftovers(w)).toEqual([]);
  });

  it('denied_cleanup_new_journal_after_rename_survives:改名之后原路径上换上别的事务的 journal → 我们删的只是墓碑,第三方 journal 原样保留(denied),无墓碑残留', async () => {
    const { w, r } = await run('d1b2-aside-newj-', 'discard:after-rename', async (w2, base) => {
      await writeJournal(w2.h, { ...base, txn_id: foreignA });
    });
    expect(r).toEqual({ status: 'denied', code: 'x' });
    expect(await journalTxn(w)).toBe(foreignA);
    expect(await leftovers(w)).toEqual([PERSONAL_STATE_FILES.journal]);
  });

  it('denied_cleanup_tombstone_replaced_not_mine:改名之后核对期间墓碑被换成别的事务的内容 → invalid / journal_not_mine;第三方内容改回原名,不删', async () => {
    const { w, r } = await run('d1b2-aside-tomb-', 'discard:after-rename', async (w2, base) => {
      await writeJournal(w2.h, { ...base, txn_id: foreignA });
      await safe.rename(w2.io, statePath(w2.h, PERSONAL_STATE_FILES.journal), await findTomb(w2));
    });
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_not_mine' });
    expect(await journalTxn(w)).toBe(foreignA);
    expect(await leftovers(w)).toEqual([PERSONAL_STATE_FILES.journal]);
  });

  it('denied_cleanup_restore_never_clobbers:墓碑不符且原名已被占 → invalid / journal_not_mine;原名上的内容与墓碑都原样保留(改回不覆盖)', async () => {
    const { w, r } = await run('d1b2-aside-occ-', 'discard:after-rename', async (w2, base) => {
      await writeJournal(w2.h, { ...base, txn_id: foreignB });
      await safe.rename(w2.io, statePath(w2.h, PERSONAL_STATE_FILES.journal), await findTomb(w2));
      await writeJournal(w2.h, { ...base, txn_id: foreignA });
    });
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_not_mine' });
    expect(await journalTxn(w)).toBe(foreignA);
    const tomb = JSON.parse(await readText(await findTomb(w))) as { txn_id: string };
    expect(tomb.txn_id).toBe(foreignB);
  });

  it('denied_cleanup_ref_moved_during_verify:改名之后核对期间 ref 被外部推进 → deferred / ref_moved_after_denied;自己的 journal 改回原名(现场保留),第三方引用不动,无墓碑', async () => {
    let moved = '';
    const { w, r, txn } = await run('d1b2-aside-refmv-', 'discard:after-rename', async (w2) => {
      moved = advance(w2);
    });
    expect(r).toMatchObject({
      status: 'deferred',
      reason: 'personal_repo_diverged',
      why: 'ref_moved_after_denied',
    });
    expect(refOf(w)).toBe(moved);
    expect(await journalTxn(w)).toBe(txn);
    expect(await leftovers(w)).toEqual([PERSONAL_STATE_FILES.journal]);
  });

  it('denied_cleanup_new_journal_before_unlink_survives:核对之后、unlink 之前原路径上换上别的事务的 journal → 只删墓碑,第三方 journal 保留(denied)', async () => {
    const { w, r } = await run('d1b2-unlink-newj-', 'discard:before-unlink', async (w2, base) => {
      await writeJournal(w2.h, { ...base, txn_id: foreignA });
    });
    expect(r).toEqual({ status: 'denied', code: 'x' });
    expect(await journalTxn(w)).toBe(foreignA);
    expect(await leftovers(w)).toEqual([PERSONAL_STATE_FILES.journal]);
  });

  it('denied_cleanup_ref_moved_before_unlink:核对之后、unlink 之前 ref 被外部推进 → 删除完成后再读 ref → deferred / ref_moved_after_denied(不是普通 denied);已删的自己的 journal 不回滚,第三方引用不动', async () => {
    let moved = '';
    const { w, r } = await run('d1b2-unlink-refmv-', 'discard:before-unlink', async (w2) => {
      moved = advance(w2);
    });
    expect(r).toMatchObject({
      status: 'deferred',
      reason: 'personal_repo_diverged',
      why: 'ref_moved_after_denied',
    });
    expect(refOf(w)).toBe(moved);
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
    expect(await leftovers(w)).toEqual([]);
  });

  // ---- R5:随机墓碑名 / 不覆盖移入 / fd 绑定的核对与删除 / 半完成态收尾 / 回滚所有权 ----

  type Wired = {
    onStage?: (s: HomeFsStage) => void | Promise<void>;
    onStep?: StepHook;
    tombstoneHex?: () => string;
  };
  /** 钩子拒绝后跑清理;`wire` 给出注入点(经 `personalHome` 的 onStage / tombstoneHex 与 deps.onStep),`pre` 在提交前布置现场 */
  async function runDeny(
    prefix: string,
    wire: (w: World, base: () => PersonalCommitJournal) => Wired,
    pre: (w: World) => Promise<void> = async () => undefined,
  ): Promise<{
    w: World;
    r: Awaited<ReturnType<typeof commitPersonal>>;
    base: PersonalCommitJournal;
  }> {
    const w = await makeWorld(prefix);
    await setupRepo(w);
    await pre(w);
    let base: PersonalCommitJournal | null = null;
    const o = wire(w, () => {
      if (base === null) throw new Error('钩子尚未被调用');
      return base;
    });
    const h2 = personalHome(w.io, w.home, {
      ...(o.onStage !== undefined ? { onStage: o.onStage } : {}),
      ...(o.tombstoneHex !== undefined ? { tombstoneHex: o.tombstoneHex } : {}),
    });
    const deps = repoDeps(w, { h: h2, ...(o.onStep !== undefined ? { onStep: o.onStep } : {}) });
    const r = await withLock(w, (locks) =>
      commitPersonal(deps, locks, {
        ...spec('2', NEXT_FILES),
        beforeRefUpdate: async () => {
          const j = await readJournal(w.h);
          if (j.kind !== 'ok') throw new Error('journal 应在');
          base = j.value;
          throw new BeforeRefUpdateDenied('x');
        },
      }),
    );
    if (base === null) throw new Error('钩子未被调用');
    return { w, r, base };
  }
  const FIXED = 'c'.repeat(32);
  const fixedHex = (): string => FIXED;
  const fixedTomb = (w: World): string =>
    statePath(w.h, `${PERSONAL_STATE_FILES.journal}.denied-${FIXED}`);
  const journalPath = (w: World): string => statePath(w.h, PERSONAL_STATE_FILES.journal);
  const failOnceAt = (stage: HomeFsStage, nth: number, act: () => Promise<void>) => {
    let n = 0;
    return async (s: HomeFsStage): Promise<void> => {
      if (s !== stage) return;
      n++;
      if (n === nth) await act();
    };
  };

  it('denied_cleanup_tombstone_name_random:墓碑名 = 固定前缀 + 32 位随机十六进制,不含 txn_id、两次清理不同(不可从 journal 内容推导)', async () => {
    const names: string[] = [];
    const txns: string[] = [];
    for (const prefix of ['d1b2-tname-1-', 'd1b2-tname-2-']) {
      const { r, base } = await runDeny(prefix, (w) => ({
        onStep: async (step) => {
          if (step === 'discard:after-rename') names.push(path.basename(await findTomb(w)));
        },
      }));
      expect(r).toEqual({ status: 'denied', code: 'x' });
      txns.push(base.txn_id);
    }
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    for (const n of names) expect(n).toMatch(/^commit-journal\.json\.denied-[0-9a-f]{32}$/);
    for (const n of names) for (const t of txns) expect(n).not.toContain(t);
  });

  it('denied_cleanup_tombstone_occupied_not_overwritten:墓碑名已被占用 → 不覆盖、不动现场,invalid / journal_tombstone_occupied(不是普通 denied);原名上自己的 journal 与占位文件原样保留', async () => {
    const { w, r, base } = await runDeny(
      'd1b2-tocc-',
      () => ({ tombstoneHex: fixedHex }),
      async (w2) => {
        await safe.writeFile(w2.io, fixedTomb(w2), 'FOREIGN', { mode: 0o600 });
      },
    );
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_tombstone_occupied' });
    expect(await readText(fixedTomb(w))).toBe('FOREIGN');
    expect(await journalTxn(w)).toBe(base.txn_id);
  });

  it('denied_cleanup_unlink_bound_to_verified_object:核对通过之后、unlink 之前墓碑被换成别的文件 → 不 unlink 换上者(invalid / journal_tombstone_replaced);换上的文件原样保留', async () => {
    const { w, r } = await runDeny('d1b2-tswap-', (w2) => ({
      tombstoneHex: fixedHex,
      onStage: failOnceAt('pre-unlink-verified', 1, async () => {
        await safe.writeFile(w2.io, `${fixedTomb(w2)}.swap`, 'FOREIGN', { mode: 0o600 });
        await safe.rename(w2.io, `${fixedTomb(w2)}.swap`, fixedTomb(w2));
      }),
    }));
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_tombstone_replaced' });
    expect(await readText(fixedTomb(w))).toBe('FOREIGN');
  });

  it('denied_cleanup_nlink_zero_confirmed:unlink 之后核对过的对象仍有别的名字(nlink≠0)→ invalid / journal_tombstone_not_removed,不是普通 denied', async () => {
    const { w, r, base } = await runDeny('d1b2-tnlink-', (w2) => ({
      tombstoneHex: fixedHex,
      onStage: failOnceAt('pre-unlink-verified', 1, async () => {
        await safe.hardlink(w2.io, fixedTomb(w2), `${fixedTomb(w2)}.extra`);
      }),
    }));
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_tombstone_not_removed' });
    const kept = JSON.parse(await readText(`${fixedTomb(w)}.extra`)) as { txn_id: string };
    expect(kept.txn_id).toBe(base.txn_id);
  });

  it('denied_cleanup_move_source_swapped_not_unlinked:移入墓碑时 link 之后原名被换成别的事务的 journal → 不删换上者(denied;墓碑里是自己的 journal,核对后删除)', async () => {
    const { w, r } = await runDeny('d1b2-msrc-', (w2, base) => ({
      onStage: failOnceAt('post-link', 1, async () => {
        await safe.remove(w2.io, journalPath(w2));
        await writeJournal(w2.h, { ...base(), txn_id: foreignA });
      }),
    }));
    expect(r).toEqual({ status: 'denied', code: 'x' });
    expect(await journalTxn(w)).toBe(foreignA);
    expect(await leftovers(w)).toEqual([PERSONAL_STATE_FILES.journal]);
  });

  it('denied_cleanup_crash_after_link_move_aside_recovers:移入墓碑的 link 之后崩溃(原名与墓碑同 inode、nlink=2)→ 普通读取 fail-closed;重启(openPersonalRepo 持锁)自动收尾后恢复正常,原名 nlink=1、无墓碑', async () => {
    const { w, r } = await runDeny('d1b2-crash-mv-', () => ({
      tombstoneHex: fixedHex,
      onStage: failOnceAt('post-link', 1, async () => {
        throw new InjectedCrash('post-link');
      }),
    }));
    // 崩溃被清理流程按 journal_rename_failed 吞下;盘上就是崩溃快照
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_rename_failed' });
    expect((await lstat(journalPath(w))).nlink).toBe(2);
    expect((await lstat(fixedTomb(w))).nlink).toBe(2);
    expect(await readJournal(w.h)).toEqual({ kind: 'invalid', why: 'unsafe' });
    // 只读检视不收尾:遇半完成态 = invalid,两个名字都不动
    expect(await inspectPersonalRepo(repoDeps(w))).toMatchObject({
      kind: 'invalid',
      why: 'journal_unsafe',
    });
    expect((await lstat(journalPath(w))).nlink).toBe(2);
    expect((await lstat(fixedTomb(w))).nlink).toBe(2);
    const re = await withLock(w, (locks) => openPersonalRepo(repoDeps(w), locks, READ_OPTS));
    expect(re.kind).toBe('ready');
    expect(await leftovers(w)).toEqual([]);
  });

  it('denied_cleanup_crash_after_link_restore_recovers:改回原名的 link 之后崩溃(核对中 ref 被推进、要改回)→ 重启自动收尾:journal 在原名下(nlink=1)、无墓碑;恢复把推进过的 ref 判为 diverged(deferred),不是 invalid', async () => {
    let moved = '';
    const { w, r, base } = await runDeny('d1b2-crash-rs-', (w2) => ({
      tombstoneHex: fixedHex,
      onStep: async (step) => {
        if (step === 'discard:after-rename') moved = advance(w2);
      },
      onStage: failOnceAt('post-link', 2, async () => {
        throw new InjectedCrash('post-link');
      }),
    }));
    expect(r).toMatchObject({ status: 'deferred', why: 'ref_moved_after_denied' });
    expect((await lstat(journalPath(w))).nlink).toBe(2);
    expect(await exists(fixedTomb(w))).toBe(true);
    const re = await withLock(w, (locks) => openPersonalRepo(repoDeps(w), locks, READ_OPTS));
    expect(re).toMatchObject({ kind: 'deferred', reason: 'personal_repo_diverged' });
    expect(await journalTxn(w)).toBe(base.txn_id);
    expect((await lstat(journalPath(w))).nlink).toBe(1);
    expect(await exists(fixedTomb(w))).toBe(false);
    expect(refOf(w)).toBe(moved);
  });

  it('denied_cleanup_restore_rollback_requires_own_link:改回时 unlink(墓碑) 失败,且原名在此期间被换成别的事务的 journal → 回滚不删它(invalid / journal_not_mine);换上的 journal 与墓碑都保留', async () => {
    const { w, r, base } = await runDeny('d1b2-rb-', (w2, mine) => ({
      tombstoneHex: fixedHex,
      onStep: async (step) => {
        if (step === 'discard:after-rename') advance(w2); // 迫使走改回分支
      },
      onStage: failOnceAt('pre-unlink-source', 2, async () => {
        await safe.remove(w2.io, journalPath(w2)); // 我们刚建的原名链接被拿走
        await writeJournal(w2.h, { ...mine(), txn_id: foreignA });
        throw new Error('unlink failed');
      }),
    }));
    expect(r).toMatchObject({ status: 'invalid', why: 'journal_not_mine' });
    expect(await journalTxn(w)).toBe(foreignA);
    const tomb = JSON.parse(await readText(fixedTomb(w))) as { txn_id: string };
    expect(tomb.txn_id).toBe(base.txn_id);
  });

  /** 崩在 update-ref 之前,留下一个 objects_written 的 journal(ref 未动) */
  async function pendingJournalWorld(prefix: string): Promise<World> {
    const w = await makeWorld(prefix);
    await setupRepo(w);
    await expect(
      withLock(w, (locks) =>
        commitPersonal(
          repoDeps(w, { onStep: crashAt('before:update-ref') }),
          locks,
          spec('2', NEXT_FILES),
        ),
      ),
    ).rejects.toBeInstanceOf(InjectedCrash);
    expect((await readJournal(w.h)).kind).toBe('ok');
    return w;
  }
  const openAgain = (w: World) =>
    withLock(w, (locks) => openPersonalRepo(repoDeps(w), locks, READ_OPTS));

  it('half_state_settle_ignores_orphan_tombstones:孤立墓碑(另一个 inode、nlink=1)与待恢复的 journal 并存 → 不被收尾、不被删,也不触发熔断(恢复照常丢弃自己的 journal)', async () => {
    const w = await pendingJournalWorld('d1b2-orphan-');
    const orphan = fixedTomb(w);
    await safe.writeFile(w.io, orphan, 'ORPHAN', { mode: 0o600 });
    const re = await openAgain(w);
    expect(re.kind).toBe('ready');
    expect(await readText(orphan)).toBe('ORPHAN');
  });

  it('half_state_settle_requires_tombstone_name:journal 与「非墓碑名」文件互为硬链接 → 不自动修复,仍 invalid / journal_unsafe(两个名字都保留)', async () => {
    const w = await pendingJournalWorld('d1b2-nontomb-');
    const other = statePath(w.h, `${PERSONAL_STATE_FILES.journal}.keep`);
    await safe.hardlink(w.io, journalPath(w), other);
    const re = await openAgain(w);
    expect(re).toMatchObject({ kind: 'invalid', why: 'journal_unsafe' });
    expect((await lstat(journalPath(w))).nlink).toBe(2);
    expect(await exists(other)).toBe(true);
  });

  it('half_state_settle_requires_nlink_two:journal 同时是两个墓碑名的硬链接(nlink=3,不是确定的半完成态)→ 不收尾,invalid / journal_unsafe', async () => {
    const w = await pendingJournalWorld('d1b2-nlink3-');
    const t1 = fixedTomb(w);
    const t2 = statePath(w.h, `${PERSONAL_STATE_FILES.journal}.denied-${'d'.repeat(32)}`);
    await safe.hardlink(w.io, journalPath(w), t1);
    await safe.hardlink(w.io, journalPath(w), t2);
    const re = await openAgain(w);
    expect(re).toMatchObject({ kind: 'invalid', why: 'journal_unsafe' });
    expect((await lstat(journalPath(w))).nlink).toBe(3);
  });
});
