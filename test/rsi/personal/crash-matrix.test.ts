/**
 * R21-3.6a 崩溃矩阵(真 git):
 *  ① 五个 phase 之间(`journal:<phase>` 步骤点)各注入一次崩溃,另加相邻的「步骤做完、journal 未写」与「head.json 已写、journal 未删」等步骤点;
 *     恢复后 HEAD / 索引 / 工作树 / head.json 一致,且**不出现** personal_repo_diverged;
 *  ② 在崩溃窗口里分别 ①改工作树文件 ②切到指向同一提交的另一分支 ③detached HEAD ④只改索引 ⑤加未跟踪文件:
 *     恢复后用户的改动都保留、状态为 personal_repo_diverged、journal 仍在(引用 / 索引 / 工作树 / journal 字节与恢复前逐项相同)。
 * 变异:恢复时只看 head.json、只允许一种组合继续、head.json 先于 recorded 写。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists } from '../../../src/io/read-fs.js';
import { commitPersonal, openPersonalRepo } from '../../../src/rsi/personal/commit.js';
import { readHead, readJournal } from '../../../src/rsi/personal/home-state.js';
import {
  BASE_FILES,
  crashAt,
  git,
  gitRaw,
  InjectedCrash,
  makeWorld,
  NEXT_FILES,
  readUserFile,
  repoDeps,
  setupRepo,
  snapshot,
  spec,
  withLock,
  writeUserFile,
  type World,
  slowTests,
} from './repo-helpers.js';

slowTests();

/** [步骤点, 崩溃后 `ref` 是否已指向新提交] */
const STEPS: [string, 'old' | 'new'][] = [
  ['journal:planned', 'old'],
  ['journal:objects_written', 'old'],
  ['before:update-ref', 'old'],
  ['after:update-ref', 'new'], // 引用已更新,journal 还停在 objects_written
  ['journal:ref_updated', 'new'],
  ['before:read-tree', 'new'],
  ['after:read-tree', 'new'], // 工作树已同步,journal 还停在 ref_updated
  ['journal:worktree_synced', 'new'],
  ['journal:recorded', 'new'],
  ['after:head', 'new'], // head.json 已写,journal 未删
  ['after:journal_removed', 'new'],
];

const commitNext = (w: World, step: string) =>
  withLock(w, (locks) =>
    commitPersonal(repoDeps(w, { onStep: crashAt(step) }), locks, spec('2', NEXT_FILES)),
  );

describe('R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃', () => {
  it.each(STEPS)('崩溃于 %s → 恢复后一致、不出现 personal_repo_diverged', async (step, refSide) => {
    const w = await makeWorld('p-crash-');
    const first = await setupRepo(w);
    await expect(commitNext(w, step)).rejects.toBeInstanceOf(InjectedCrash);

    const refNow = git(w, ['rev-parse', 'refs/heads/rsi']);
    expect(refNow === first).toBe(refSide === 'old');
    // head.json 只在 journal 到达 recorded 之后写:崩溃在 recorded 之前,它仍是旧值
    const recBefore = await readHead(w.h);
    const headJsonAfterRecorded = step === 'after:head' || step === 'after:journal_removed';
    expect(recBefore).toMatchObject({
      kind: 'ok',
      value: { head: headJsonAfterRecorded ? refNow : first },
    });

    const o = await withLock(w, (locks) => openPersonalRepo(repoDeps(w), locks));
    expect(o, step).toMatchObject({ kind: 'ready' }); // 绝不是 deferred / personal_repo_diverged
    const expected = refSide === 'old' ? first : refNow;
    if (o.kind !== 'ready') throw new Error('unreachable');
    expect(o.head).toBe(expected);
    // HEAD / 索引 / 工作树 / head.json 一致
    expect(git(w, ['rev-parse', 'HEAD'])).toBe(expected);
    expect(gitRaw(w, ['diff-index', '--cached', '--quiet', 'HEAD', '--']).status).toBe(0);
    expect(git(w, ['--no-optional-locks', 'status', '--porcelain', '--ignored'])).toBe('');
    expect(await readHead(w.h)).toMatchObject({ kind: 'ok', value: { head: expected } });
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
    expect(await exists(path.join(w.h.repoDir, 'rules/new.md'))).toBe(refSide === 'new');
    if (refSide === 'new') expect(await readUserFile(w, 'rules/base.md')).toBe('base rule v2\n');

    // 恢复后可继续提交(未生效的提交由调用方从头重做)
    const again = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('3', NEXT_FILES)),
    );
    expect(again.status).toBe('committed');
  });
});

type Mod = [string, (w: World) => Promise<void>];
const MODS: Mod[] = [
  ['① 改工作树文件', (w) => writeUserFile(w, 'rules/base.md', 'USER EDIT\n')],
  [
    '② 切到指向同一提交的另一分支',
    async (w) => {
      git(w, ['branch', 'other', 'refs/heads/rsi']);
      git(w, ['symbolic-ref', 'HEAD', 'refs/heads/other']);
    },
  ],
  [
    '③ detached HEAD',
    async (w) => {
      git(w, ['update-ref', '--no-deref', 'HEAD', git(w, ['rev-parse', 'refs/heads/rsi'])]);
    },
  ],
  [
    '④ 只改索引',
    async (w) => {
      const blob = git(w, ['hash-object', '-w', '--stdin'], { input: 'staged only\n' });
      git(w, ['update-index', '--cacheinfo', `100644,${blob},rules/base.md`]);
    },
  ],
  ['⑤ 加未跟踪文件', (w) => writeUserFile(w, 'scratch.txt', 'untracked\n')],
];

/** 三个「窗口」:引用未更新 / 引用已更新工作树未同步 / 只差记录 */
const WINDOWS = [
  'journal:objects_written',
  'journal:ref_updated',
  'journal:worktree_synced',
] as const;

describe('R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在', () => {
  for (const win of WINDOWS) {
    it.each(MODS)(`窗口 ${win}:%s`, async (_name, mod) => {
      const w = await makeWorld('p-window-');
      await setupRepo(w);
      await expect(commitNext(w, win)).rejects.toBeInstanceOf(InjectedCrash);
      await mod(w);
      const before = await snapshot(w);
      expect(before.journal).not.toBeNull();

      const o = await withLock(w, (locks) => openPersonalRepo(repoDeps(w), locks));
      expect(o).toMatchObject({ kind: 'deferred', reason: 'personal_repo_diverged' });
      // 恢复什么都没改:引用、索引、工作树、未跟踪文件、journal 字节逐项相同
      expect(await snapshot(w)).toEqual(before);
      // 再来一次(含 commitPersonal)结论不变,同样不动用户改动
      const c = await withLock(w, (locks) =>
        commitPersonal(repoDeps(w), locks, spec('9', BASE_FILES)),
      );
      expect(c).toMatchObject({ status: 'deferred', reason: 'personal_repo_diverged' });
      expect(await snapshot(w)).toEqual(before);
    });
  }

  it('对照:没有用户改动时同样三个窗口都能恢复(见上一组),用户改动才是 diverged 的原因', async () => {
    const w = await makeWorld('p-window-ctrl-');
    await setupRepo(w);
    await expect(commitNext(w, 'journal:ref_updated')).rejects.toBeInstanceOf(InjectedCrash);
    const o = await withLock(w, (locks) => openPersonalRepo(repoDeps(w), locks));
    expect(o.kind).toBe('ready');
  });
});

describe('恢复先于 R21-3.5 判定,且不借机改归属', () => {
  it('崩溃在 recorded 之后、head.json 之前,换了 [rsi] repo 再来:恢复沿用 head.json 原有的 owner_repo_fp,随后判 personal_owner_changed', async () => {
    const w = await makeWorld('p-crash-owner-');
    await setupRepo(w);
    await expect(commitNext(w, 'journal:recorded')).rejects.toBeInstanceOf(InjectedCrash);
    const refNow = git(w, ['rev-parse', 'refs/heads/rsi']);
    const other = 'e'.repeat(16);
    const o = await withLock(w, (locks) =>
      openPersonalRepo(repoDeps(w, { ownerRepoFp: other }), locks),
    );
    expect(o).toMatchObject({ kind: 'deferred', reason: 'personal_owner_changed' });
    // 未完成的提交已按观测值补齐(head.json 推进到新提交,journal 已删),归属字段没有被悄悄改成新仓库
    expect(await readHead(w.h)).toMatchObject({
      kind: 'ok',
      value: { head: refNow, owner_repo_fp: w.ownerFp },
    });
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
  });
});
