/**
 * R21-3.4 结构校验七项(真 git):每项一个红夹具 → `personal_repo_invalid`;正向对照:干净仓库通过。
 * 变异:放行 filter.* / include.*(见 repo-closed-git.test.ts),删掉某一项检查 → 对应夹具变绿而本文件红。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitPersonal } from '../../../src/rsi/personal/commit.js';
import { ensureEmptyDir } from '../../../src/rsi/personal/home-state.js';
import {
  checkRepoStructure,
  createClosedGit,
  type StructureResult,
} from '../../../src/rsi/personal/repo-check.js';
import { lstat, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import {
  git,
  makeWorld,
  NOW,
  repoDeps,
  setupRepo,
  spec,
  withLock,
  BASE_FILES,
  type World,
  slowTests,
} from './repo-helpers.js';

slowTests();

async function structure(w: World, uid?: number): Promise<StructureResult> {
  const closed = createClosedGit(w.h, await ensureEmptyDir(w.h), () => NOW);
  return checkRepoStructure(w.h, closed, uid === undefined ? {} : { uid });
}

async function expectInvalid(w: World, why: string): Promise<void> {
  const r = await structure(w);
  expect(r).toMatchObject({ ok: false, why });
  // 经提交原语走一遍:熔断 personal_repo_invalid,且不提交
  // 不经 git 读引用(worktree 链接之类的夹具会让 git 本身拒绝工作):松散引用文件的字节在前后必须一致
  const refFile = path.join(w.h.repoDir, '.git', 'refs', 'heads', 'rsi');
  const head = await readText(refFile);
  const c = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', BASE_FILES)));
  expect(c).toMatchObject({ status: 'invalid', why, breaker: 'personal_repo_invalid' });
  expect(await readText(refFile)).toBe(head);
}

/** 用 git 管道命令往 refs/heads/rsi 上造一个带指定条目的提交(绕过 commitPersonal 的树约束) */
function forgeCommit(w: World, entries: { mode: string; name: string; content: string }[]): void {
  const lines = entries.map((e) => {
    const blob = git(w, ['hash-object', '-w', '--no-filters', '--stdin'], { input: e.content });
    return `${e.mode} blob ${blob}\t${e.name}`;
  });
  const tree = git(w, ['mktree'], { input: `${lines.join('\n')}\n` });
  const parent = git(w, ['rev-parse', 'refs/heads/rsi']);
  const commit = git(w, ['commit-tree', tree, '-p', parent, '-m', 'forged']);
  git(w, ['update-ref', 'refs/heads/rsi', commit]);
}

describe('R21-3.4 结构校验', () => {
  it('正向对照:干净仓库通过;属主为当前 uid、权限恰为 0700', async () => {
    const w = await makeWorld('p-struct-ok-');
    await setupRepo(w);
    expect(await structure(w)).toEqual({ ok: true });
    const st = await lstat(w.h.repoDir);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('① .git 是 gitdir 文件(不是真实目录)', async () => {
    const w = await makeWorld('p-struct-gitfile-');
    await setupRepo(w);
    const moved = path.join(w.dir, 'moved-gitdir');
    await safe.rename(w.io, path.join(w.h.repoDir, '.git'), moved);
    await safe.writeFile(w.io, path.join(w.h.repoDir, '.git'), `gitdir: ${moved}\n`);
    expect(await structure(w)).toMatchObject({ ok: false, why: 'git_not_directory' });
  });

  it('① .git 是符号链接', async () => {
    const w = await makeWorld('p-struct-gitlink-');
    await setupRepo(w);
    const moved = path.join(w.dir, 'moved-gitdir');
    await safe.rename(w.io, path.join(w.h.repoDir, '.git'), moved);
    await safe.symlink(w.io, moved, path.join(w.h.repoDir, '.git'));
    expect(await structure(w)).toMatchObject({ ok: false, why: 'git_symlink' });
  });

  it('① .git 是 worktree 链接(commondir / gitdir 标记)', async () => {
    const w = await makeWorld('p-struct-wt-');
    await setupRepo(w);
    await safe.writeFile(w.io, path.join(w.h.repoDir, '.git', 'commondir'), '../other\n');
    await expectInvalid(w, 'worktree_link');
  });

  it('① 裸仓库(core.bare = true)', async () => {
    const w = await makeWorld('p-struct-bare-');
    await setupRepo(w);
    git(w, ['config', '--local', 'core.bare', 'true']);
    expect(await structure(w)).toMatchObject({ ok: false, why: 'bare' });
  });

  it('② objects/info/alternates', async () => {
    const w = await makeWorld('p-struct-alt-');
    await setupRepo(w);
    await safe.mkdirp(w.io, path.join(w.h.repoDir, '.git', 'objects', 'info'), 0o700);
    await safe.writeFile(
      w.io,
      path.join(w.h.repoDir, '.git', 'objects', 'info', 'alternates'),
      '/elsewhere/objects\n',
    );
    await expectInvalid(w, 'alternates');
  });

  it('③ config.worktree', async () => {
    const w = await makeWorld('p-struct-cwt-');
    await setupRepo(w);
    await safe.writeFile(w.io, path.join(w.h.repoDir, '.git', 'config.worktree'), '[core]\n');
    await expectInvalid(w, 'config_worktree');
  });

  it.each([
    ['include.path', '/elsewhere/extra.cfg'],
    ['filter.evil.clean', 'cat'],
    ['remote.origin.url', 'https://example.invalid/x.git'],
    ['core.hooksPath', '/elsewhere/hooks'],
    ['core.sshCommand', 'ssh -o Evil=1'],
    ['user.name', 'someone'],
  ])('④ 本地配置含非白名单键 %s', async (key, value) => {
    const w = await makeWorld('p-struct-key-');
    await setupRepo(w);
    git(w, ['config', '--local', key, value]);
    expect(await structure(w)).toMatchObject({
      ok: false,
      why: 'config_key',
      detail: key.toLowerCase(),
    });
  });

  it('⑤ 有 remote(旧式 .git/remotes/ 定义,不经 config 键)', async () => {
    const w = await makeWorld('p-struct-remote-');
    await setupRepo(w);
    await safe.mkdirp(w.io, path.join(w.h.repoDir, '.git', 'remotes'), 0o700);
    await safe.writeFile(
      w.io,
      path.join(w.h.repoDir, '.git', 'remotes', 'origin'),
      'URL: https://example.invalid/x.git\n',
    );
    await expectInvalid(w, 'remote');
  });

  it('⑥ 目录权限不是 0700', async () => {
    const w = await makeWorld('p-struct-mode-');
    await setupRepo(w);
    await safe.chmod(w.io, w.h.repoDir, 0o755);
    await expectInvalid(w, 'mode');
  });

  it('⑥ 目录属主不是当前 uid', async () => {
    const w = await makeWorld('p-struct-owner-');
    await setupRepo(w);
    const uid = process.getuid?.() ?? 0;
    expect(await structure(w, uid + 1)).toMatchObject({ ok: false, why: 'owner' });
    expect(await structure(w, uid)).toEqual({ ok: true }); // 对照:真实 uid 通过
  });

  it('⑦ 树里有 .gitattributes(任意层级)', async () => {
    const w = await makeWorld('p-struct-attr-');
    await setupRepo(w);
    forgeCommit(w, [{ mode: '100644', name: '.gitattributes', content: '* text\n' }]);
    await expectInvalid(w, 'tree_gitattributes');
  });

  it('⑦ 树里有 .gitmodules', async () => {
    const w = await makeWorld('p-struct-mod-');
    await setupRepo(w);
    forgeCommit(w, [{ mode: '100644', name: '.gitmodules', content: '' }]);
    await expectInvalid(w, 'tree_gitmodules');
  });

  it('⑦ 树里有符号链接(120000)', async () => {
    const w = await makeWorld('p-struct-sym-');
    await setupRepo(w);
    forgeCommit(w, [{ mode: '120000', name: 'link', content: '/etc/passwd' }]);
    await expectInvalid(w, 'tree_symlink');
  });

  it('⑦ 树里有可执行位(100755)', async () => {
    const w = await makeWorld('p-struct-exec-');
    await setupRepo(w);
    forgeCommit(w, [{ mode: '100755', name: 'run.sh', content: '#!/bin/sh\n' }]);
    await expectInvalid(w, 'tree_exec');
  });
});
