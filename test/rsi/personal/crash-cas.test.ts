/**
 * R21-3.6 `update-ref refs/heads/rsi <新> <旧>`(带期望旧值的原子比较交换):并发的第二个提交者得到比较交换失败(负向),
 * 没有任何引用 / 索引 / 工作树被它改动;对照:无并发时同一流程提交成功。变异:update-ref 不带期望旧值。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists } from '../../../src/io/read-fs.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { commitPersonal, openPersonalRepo } from '../../../src/rsi/personal/commit.js';
import { readHead, readJournal } from '../../../src/rsi/personal/home-state.js';
import {
  BASE_FILES,
  FAKE_LOCKS,
  git,
  makeWorld,
  NEXT_FILES,
  repoDeps,
  setupRepo,
  snapshot,
  spec,
  withLock,
  slowTests,
} from './repo-helpers.js';

slowTests();

const B_FILES = [...BASE_FILES, { path: 'rules/b.md', content: 'from B\n' }] as const;

describe('R21-3.6 update-ref 带期望旧值', () => {
  it('R21-3.6 对照:无并发 → committed', async () => {
    const w = await makeWorld('p-cas-ctrl-');
    await setupRepo(w);
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('2', NEXT_FILES)),
    );
    expect(r.status).toBe('committed');
  });

  it('R21-3.6 并发的第二个提交者(在 A 的 update-ref 之前先完成了一次提交)→ A 得到 cas_failed,B 的结果完好', async () => {
    const w = await makeWorld('p-cas-b-');
    const first = await setupRepo(w);
    const box: { b?: Awaited<ReturnType<typeof commitPersonal>> } = {};
    const a = await withLock(w, (locks) =>
      commitPersonal(
        repoDeps(w, {
          onStep: async (s) => {
            if (s !== 'before:update-ref') return;
            // 另一个提交者(同进程模拟):它读到 A 的在途 journal、观测为「提交未生效」而丢弃,然后自己完成整个提交
            box.b = await commitPersonal(repoDeps(w), FAKE_LOCKS, spec('3', B_FILES));
          },
        }),
        locks,
        spec('2', NEXT_FILES),
      ),
    );
    const b = box.b;
    if (b?.status !== 'committed') throw new Error(`B 应该提交成功:${JSON.stringify(b)}`);
    expect(a).toMatchObject({ status: 'cas_failed', expected: first, actual: b.commit });
    // A 没有改任何东西:HEAD 是 B 的提交,工作树只有 B 的文件
    expect(git(w, ['rev-parse', 'refs/heads/rsi'])).toBe(b.commit);
    expect(await exists(path.join(w.h.repoDir, 'rules/b.md'))).toBe(true);
    expect(await exists(path.join(w.h.repoDir, 'rules/new.md'))).toBe(false);
    expect(git(w, ['--no-optional-locks', 'status', '--porcelain', '--ignored'])).toBe('');
    expect(await readHead(w.h)).toMatchObject({ kind: 'ok', value: { head: b.commit } });
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
  });

  it('引用被第三方挪走(不经 kit)→ A 得到 cas_failed;journal 保留,下一次恢复判 diverged,不动引用', async () => {
    const w = await makeWorld('p-cas-3rd-');
    const first = await setupRepo(w);
    const a = await withLock(w, (locks) =>
      commitPersonal(
        repoDeps(w, {
          onStep: (s) => {
            if (s !== 'before:update-ref') return;
            const other = git(w, [
              'commit-tree',
              git(w, ['rev-parse', `${first}^{tree}`]),
              '-p',
              first,
              '-m',
              'x',
            ]);
            git(w, ['update-ref', 'refs/heads/rsi', other, first]);
          },
        }),
        locks,
        spec('2', NEXT_FILES),
      ),
    );
    expect(a).toMatchObject({ status: 'cas_failed', expected: first });
    const before = await snapshot(w);
    expect(before.journal).not.toBeNull();
    const o = await withLock(w, (locks) => openPersonalRepo(repoDeps(w), locks));
    expect(o).toMatchObject({ kind: 'deferred', reason: 'personal_repo_diverged' });
    expect(await snapshot(w)).toEqual(before);
  });
});

describe('R20-5.5 lock_lost:提交点前复核锁,丢锁立即停止、不再写', () => {
  it('update-ref 之前锁丢了 → 抛 lock_lost,引用 / 工作树没动;下一次恢复把未生效的提交丢弃', async () => {
    const w = await makeWorld('p-lost-');
    const first = await setupRepo(w);
    const state = { lost: false };
    const locks = {
      personal: {
        assertHeld: async (): Promise<void> => {
          if (state.lost) throw new RsiLockError('lock_lost');
        },
      },
    };
    await expect(
      commitPersonal(
        repoDeps(w, {
          onStep: (s) => {
            if (s === 'before:update-ref') state.lost = true;
          },
        }),
        locks,
        spec('2', NEXT_FILES),
      ),
    ).rejects.toMatchObject({ kind: 'lock_lost' });
    expect(git(w, ['rev-parse', 'refs/heads/rsi'])).toBe(first); // 引用没动
    expect(await exists(path.join(w.h.repoDir, 'rules/new.md'))).toBe(false);
    const o = await withLock(w, (l) => openPersonalRepo(repoDeps(w), l));
    expect(o).toMatchObject({ kind: 'ready', head: first });
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
  });

  it('开始时就丢锁 → 什么都不写(不建 journal)', async () => {
    const w = await makeWorld('p-lost0-');
    await setupRepo(w);
    const locks = {
      personal: {
        assertHeld: async (): Promise<void> => {
          throw new RsiLockError('lock_lost');
        },
      },
    };
    await expect(commitPersonal(repoDeps(w), locks, spec('2', NEXT_FILES))).rejects.toMatchObject({
      kind: 'lock_lost',
    });
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
  });
});
