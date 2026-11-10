/**
 * W0-5 自动建仓与 bootstrap 状态机(真 git):首次证明(全部 lstat 为 ENOENT)、四个 phase 的崩溃恢复、不一致 → personal_repo_invalid。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, lstat, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import { openPersonalRepo, type StepHook } from '../../../src/rsi/personal/commit.js';
import { EMPTY_TREE } from '../../../src/rsi/personal/commit-journal.js';
import {
  ensureEmptyDir,
  probeFirstTime,
  readHead,
  readJournal,
} from '../../../src/rsi/personal/home-state.js';
import { checkRepoStructure, createClosedGit } from '../../../src/rsi/personal/repo-check.js';
import {
  crashAt,
  git,
  gitRaw,
  InjectedCrash,
  makeWorld,
  NOW,
  repoDeps,
  withLock,
  type World,
  slowTests,
} from './repo-helpers.js';

slowTests();

const boot = (w: World, onStep?: StepHook) =>
  withLock(w, (locks) =>
    openPersonalRepo(repoDeps(w, onStep === undefined ? {} : { onStep }), locks, {
      bootstrap: true,
    }),
  );

describe('W0-5 首次建仓证明', () => {
  it('全部约定路径都不存在 → first;不要求建仓时返回 absent 且什么都没建', async () => {
    const w = await makeWorld('p-b-first-');
    await withLock(w, async (locks) => {
      expect(await probeFirstTime(w.h)).toBe('first');
      expect(await openPersonalRepo(repoDeps(w), locks)).toEqual({ kind: 'absent' });
    });
    expect(await exists(w.h.repoDir)).toBe(false);
    expect(await exists(path.join(w.h.stateDir, 'head.json'))).toBe(false);
  });

  it.each([
    ['personal 目录', (w: World) => safe.mkdirp(w.io, w.h.repoDir, 0o700)],
    ['personal/.git', (w: World) => safe.mkdirp(w.io, path.join(w.h.repoDir, '.git'), 0o700)],
    ['head.json', (w: World) => safe.writeFile(w.io, path.join(w.h.stateDir, 'head.json'), '{}')],
    [
      'commit-journal.json',
      (w: World) => safe.writeFile(w.io, path.join(w.h.stateDir, 'commit-journal.json'), '{}'),
    ],
    ['txn/', (w: World) => safe.mkdirp(w.io, path.join(w.h.stateDir, 'txn'), 0o700)],
    [
      'revocations.jsonl',
      (w: World) => safe.writeFile(w.io, path.join(w.h.stateDir, 'revocations.jsonl'), ''),
    ],
    [
      '悬空符号链接(head.json)',
      (w: World) =>
        safe.symlink(w.io, path.join(w.dir, 'nowhere'), path.join(w.h.stateDir, 'head.json')),
    ],
  ])('任一约定路径存在(%s)→ 不是首次', async (_name, plant) => {
    const w = await makeWorld('p-b-notfirst-');
    await safe.mkdirp(w.io, w.h.stateDir, 0o700);
    await plant(w);
    expect(await probeFirstTime(w.h)).toBe('not_first');
  });

  it('lstat 报 ENOENT 以外的错误(rsi-personal 被一个普通文件占位 → ENOTDIR)→ 不是首次', async () => {
    const w = await makeWorld('p-b-enotdir-');
    await safe.mkdirp(w.io, path.dirname(w.h.stateDir), 0o700);
    await safe.writeFile(w.io, w.h.stateDir, 'i am a file');
    expect(await probeFirstTime(w.h)).toBe('not_first');
  });

  it('不是首次又没有仓库(例如 personal 是个空壳目录):不建仓,按 personal_repo_invalid 处理', async () => {
    const w = await makeWorld('p-b-shell-');
    await safe.mkdirp(w.io, w.h.stateDir, 0o700);
    await safe.mkdirp(w.io, w.h.repoDir, 0o700); // 仅目录,没有 .git
    const o = await boot(w);
    expect(o).toMatchObject({ kind: 'invalid', breaker: 'personal_repo_invalid' });
    expect(await exists(path.join(w.h.repoDir, '.git'))).toBe(false); // 没有在别人的目录里 git init
  });
});

describe('W0-5 bootstrap 成功路径', () => {
  it('建仓:0700 目录、分支 rsi 上一个空树根提交、无远端、head.json 已记录、journal 已删', async () => {
    const w = await makeWorld('p-b-ok-');
    const o = await boot(w);
    if (o.kind !== 'ready') throw new Error(JSON.stringify(o));
    expect((await lstat(w.h.repoDir)).mode & 0o777).toBe(0o700);
    expect(git(w, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/rsi');
    expect(git(w, ['rev-parse', 'refs/heads/rsi'])).toBe(o.head);
    expect(git(w, ['rev-parse', 'refs/heads/rsi^{tree}'])).toBe(EMPTY_TREE);
    expect(gitRaw(w, ['rev-parse', '--verify', '-q', 'refs/heads/rsi^']).status).not.toBe(0); // 根提交
    expect(git(w, ['remote'])).toBe('');
    expect(await readHead(w.h)).toMatchObject({
      kind: 'ok',
      value: { head: o.head, owner_repo_fp: w.ownerFp },
    });
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
    // 建出来的仓库自己通过 R21-3.4
    const closed = createClosedGit(w.h, await ensureEmptyDir(w.h), () => NOW);
    expect(await checkRepoStructure(w.h, closed)).toEqual({ ok: true });
    // 再打开一次:不再建仓,同一个 HEAD
    expect(await boot(w)).toMatchObject({ kind: 'ready', head: o.head });
  });
});

describe('W0-5 bootstrap 崩溃恢复(四个 phase 之间各注入一次)', () => {
  it.each([
    'journal:planned',
    'journal:initialized',
    'journal:committed',
    'journal:recorded',
    'after:head',
  ])('崩溃于 %s → 下一次持锁者续做,得到完整一致的仓库', async (step) => {
    const w = await makeWorld('p-b-crash-');
    await expect(boot(w, crashAt(step))).rejects.toBeInstanceOf(InjectedCrash);
    const j = await readJournal(w.h);
    if (step === 'after:head') {
      // head.json 已写、journal 未删:恢复只差删 journal
      expect(await readHead(w.h)).toMatchObject({ kind: 'ok' });
    } else {
      expect(j.kind).toBe('ok'); // 还在途
      expect(await readHead(w.h)).toEqual({ kind: 'absent' }); // head.json 只在 recorded 之后写
    }
    const o = await boot(w);
    if (o.kind !== 'ready') throw new Error(`${step}: ${JSON.stringify(o)}`);
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
    expect(await readHead(w.h)).toMatchObject({ kind: 'ok', value: { head: o.head } });
    expect(git(w, ['rev-parse', 'refs/heads/rsi'])).toBe(o.head);
    expect(git(w, ['rev-parse', 'refs/heads/rsi^{tree}'])).toBe(EMPTY_TREE);
    expect(git(w, ['--no-optional-locks', 'status', '--porcelain', '--ignored'])).toBe('');
  });

  it('planned 且目录不存在(崩溃在建目录之前)→ 丢弃 journal,按首次重新建仓', async () => {
    const w = await makeWorld('p-b-planned-');
    await expect(boot(w, crashAt('journal:planned'))).rejects.toBeInstanceOf(InjectedCrash);
    expect(await exists(w.h.repoDir)).toBe(false);
    const o = await boot(w);
    expect(o.kind).toBe('ready');
  });

  it('committed 之后引用被改成别的值 → personal_repo_invalid,保留 journal', async () => {
    const w = await makeWorld('p-b-tamper-');
    await expect(boot(w, crashAt('journal:committed'))).rejects.toBeInstanceOf(InjectedCrash);
    const other = git(w, ['commit-tree', EMPTY_TREE, '-m', 'someone else']);
    git(w, ['update-ref', 'refs/heads/rsi', other]);
    const o = await boot(w);
    expect(o).toMatchObject({ kind: 'invalid', why: 'bootstrap_inconsistent' });
    expect(await exists(path.join(w.h.stateDir, 'commit-journal.json'))).toBe(true);
    expect(await readText(path.join(w.h.stateDir, 'commit-journal.json'))).toContain('"committed"');
  });
});
