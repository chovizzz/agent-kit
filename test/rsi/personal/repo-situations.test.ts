/**
 * R21-3.5 HEAD 与工作树判定:情形①–④各一例,情形①「记录..HEAD 只新增文件」的边界(改 / 删自动产出、动 lifecycle/** → ②)。
 * 真 git。②/④ 下 `commitPersonal` 返回 `deferred`,**不触碰任何引用、索引与工作树**(R21-9.3a;用快照逐项比较)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitPersonal, openPersonalRepo } from '../../../src/rsi/personal/commit.js';
import { readHead, writeHead } from '../../../src/rsi/personal/home-state.js';
import * as safe from '../../../src/io/safe-fs.js';
import {
  BASE_FILES,
  git,
  ID1,
  makeWorld,
  NEXT_FILES,
  repoDeps,
  setupRepo,
  snapshot,
  spec,
  withLock,
  writeUserFile,
  type World,
} from './repo-helpers.js';

const open = (w: World, over: Parameters<typeof repoDeps>[1] = {}) =>
  withLock(w, (locks) => openPersonalRepo(repoDeps(w, over), locks));

async function userCommit(w: World, msg: string): Promise<string> {
  git(w, ['add', '-A']);
  git(w, ['commit', '-q', '-m', msg]);
  return git(w, ['rev-parse', 'HEAD']);
}

/** ② 的统一断言:判 diverged、commitPersonal 返回 deferred,且引用 / 索引 / 工作树 / journal 一个字节都没动 */
async function expectDiverged(w: World, why: string): Promise<void> {
  const before = await snapshot(w);
  const o = await open(w);
  expect(o).toMatchObject({ kind: 'deferred', reason: 'personal_repo_diverged', why });
  const c = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('9', NEXT_FILES)));
  expect(c).toMatchObject({ status: 'deferred', reason: 'personal_repo_diverged', why });
  expect(await snapshot(w)).toEqual(before);
}

describe('R21-3.5 情形①:接受并更新记录', () => {
  it('HEAD = 记录(无人动过):ready,记录不变', async () => {
    const w = await makeWorld('p-s1-same-');
    const head = await setupRepo(w);
    const o = await open(w);
    expect(o).toMatchObject({ kind: 'ready', head });
    const rec = await readHead(w.h);
    expect(rec).toMatchObject({ kind: 'ok', value: { head } });
  });

  it('用户在 rsi 分支上只新增了文件(不在 lifecycle/ 下):接受并把记录推进到新 HEAD', async () => {
    const w = await makeWorld('p-s1-add-');
    await setupRepo(w);
    await writeUserFile(w, 'rules/user-added.md', 'mine\n');
    const next = await userCommit(w, 'user adds files');
    const o = await open(w);
    expect(o).toMatchObject({ kind: 'ready', head: next });
    expect(await readHead(w.h)).toMatchObject({ kind: 'ok', value: { head: next } });
    // 之后 commitPersonal 可以继续(基于新的 HEAD);目标树由调用方给全(用户新增的文件要保留就必须写进目标树)
    const withUser = [...BASE_FILES, { path: 'rules/user-added.md', content: 'mine\n' }] as const;
    const c = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', withUser)));
    expect(c.status).toBe('committed');
  });
});

describe('R21-3.5 情形①的边界:记录..HEAD 改 / 删了自动产出,或触碰 lifecycle/** → ②', () => {
  it('改了 rules/ 下的自动产出文件', async () => {
    const w = await makeWorld('p-s2-mod-');
    await setupRepo(w);
    await writeUserFile(w, 'rules/base.md', 'tampered\n');
    await userCommit(w, 'edit auto output');
    await expectDiverged(w, 'auto_output_changed');
  });

  it('删了自动产出文件', async () => {
    const w = await makeWorld('p-s2-del-');
    await setupRepo(w);
    git(w, ['rm', '-q', 'rules/base.md']);
    await userCommit(w, 'delete auto output');
    await expectDiverged(w, 'auto_output_changed');
  });

  it('改了 lifecycle/<id>.json', async () => {
    const w = await makeWorld('p-s2-life-');
    await setupRepo(w);
    await writeUserFile(w, `lifecycle/${ID1}.json`, '{"id":"ra_aaaaaaaaaaaa","hacked":true}\n');
    await userCommit(w, 'edit lifecycle');
    await expectDiverged(w, 'auto_output_changed');
  });

  it('在 lifecycle/ 下新增文件(即使只是新增也算触碰 lifecycle/**)', async () => {
    const w = await makeWorld('p-s2-lifeadd-');
    await setupRepo(w);
    await writeUserFile(w, 'lifecycle/ra_cccccccccccc.json', '{}\n');
    await userCommit(w, 'add lifecycle file');
    await expectDiverged(w, 'auto_output_changed');
  });
});

describe('R21-3.5 情形②:personal_repo_diverged(暂停新增生效,不碰仓库)', () => {
  it('分支不是 rsi', async () => {
    const w = await makeWorld('p-s2-branch-');
    await setupRepo(w);
    git(w, ['checkout', '-q', '-b', 'other']);
    await expectDiverged(w, 'branch_not_rsi');
  });

  it('detached HEAD', async () => {
    const w = await makeWorld('p-s2-detached-');
    await setupRepo(w);
    git(w, ['checkout', '-q', '--detach']);
    await expectDiverged(w, 'branch_not_rsi');
  });

  it('有 stash', async () => {
    const w = await makeWorld('p-s2-stash-');
    await setupRepo(w);
    await writeUserFile(w, 'rules/base.md', 'wip\n');
    git(w, ['stash', 'push', '-q']);
    await expectDiverged(w, 'stash');
  });

  it('工作树不干净(已跟踪文件被改)', async () => {
    const w = await makeWorld('p-s2-dirty-');
    await setupRepo(w);
    await writeUserFile(w, 'rules/base.md', 'wip\n');
    await expectDiverged(w, 'worktree_dirty');
  });

  it('工作树不干净(未跟踪文件)', async () => {
    const w = await makeWorld('p-s2-untracked-');
    await setupRepo(w);
    await writeUserFile(w, 'scratch.txt', 'x\n');
    await expectDiverged(w, 'worktree_dirty');
  });

  it('HEAD 是记录的祖先(用户把分支退回去了)', async () => {
    const w = await makeWorld('p-s2-behind-');
    const first = await setupRepo(w);
    const c = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', NEXT_FILES)));
    expect(c.status).toBe('committed');
    git(w, ['reset', '-q', '--hard', first]);
    await expectDiverged(w, 'head_not_descendant');
  });

  it('历史分叉(用户在旧提交上另起提交,记录提交不是 HEAD 的祖先)', async () => {
    const w = await makeWorld('p-s2-fork-');
    const first = await setupRepo(w);
    const c = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', NEXT_FILES)));
    expect(c.status).toBe('committed');
    git(w, ['reset', '-q', '--hard', first]);
    await writeUserFile(w, 'rules/fork.md', 'fork\n');
    await userCommit(w, 'fork');
    await expectDiverged(w, 'head_not_descendant');
  });
});

describe('R21-3.5 情形③:personal_repo_invalid(熔断)', () => {
  it('记录提交不存在', async () => {
    const w = await makeWorld('p-s3-missing-');
    await setupRepo(w);
    await writeHead(w.h, { schema_version: 1, head: 'd'.repeat(40), owner_repo_fp: w.ownerFp });
    expect(await open(w)).toMatchObject({
      kind: 'invalid',
      why: 'record_missing',
      breaker: 'personal_repo_invalid',
    });
  });

  it('head.json 不存在(非首次:仓库已在)', async () => {
    const w = await makeWorld('p-s3-nohead-');
    await setupRepo(w);
    await safe.remove(w.io, path.join(w.h.stateDir, 'head.json'));
    expect(await open(w)).toMatchObject({
      kind: 'invalid',
      why: 'record_missing',
      breaker: 'personal_repo_invalid',
    });
  });

  it('历史无共同祖先(rsi 被指到一个无关的根提交)', async () => {
    const w = await makeWorld('p-s3-root-');
    await setupRepo(w);
    const root = git(w, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'unrelated']);
    git(w, ['update-ref', 'refs/heads/rsi', root]);
    expect(await open(w)).toMatchObject({
      kind: 'invalid',
      why: 'no_common_ancestor',
      breaker: 'personal_repo_invalid',
    });
  });
});

describe('R21-3.5 情形④:personal_owner_changed', () => {
  it('owner_repo_fp 与当前 [rsi] repo 不同:deferred,不碰仓库;相同则 ready(对照)', async () => {
    const w = await makeWorld('p-s4-');
    const head = await setupRepo(w);
    const before = await snapshot(w);
    const other = 'f'.repeat(16);
    expect(await open(w, { ownerRepoFp: other })).toMatchObject({
      kind: 'deferred',
      reason: 'personal_owner_changed',
    });
    const c = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w, { ownerRepoFp: other }), locks, spec('9', NEXT_FILES)),
    );
    expect(c).toMatchObject({ status: 'deferred', reason: 'personal_owner_changed' });
    expect(await snapshot(w)).toEqual(before);
    expect(await open(w)).toMatchObject({ kind: 'ready', head }); // 对照:同一仓库、当前归属 → 通过
  });
});
