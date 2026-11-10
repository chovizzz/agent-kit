/**
 * R21-3.6 commitPersonal 的基本面(真 git):提交结果(树 / 作者 / 同步工作树 / 记录)、目标树约束(R21-3.1 禁止项)、首次无仓库、
 * 底层命令路径(不用 add / commit)。变异:树约束被放宽、作者身份改用调用者的。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists } from '../../../src/io/read-fs.js';
import { commitPersonal, TreeSpecError } from '../../../src/rsi/personal/commit.js';
import { readHead, readJournal } from '../../../src/rsi/personal/home-state.js';
import {
  BASE_FILES,
  git,
  ID1,
  makeWorld,
  NEXT_FILES,
  NOW,
  readUserFile,
  repoDeps,
  setupRepo,
  snapshot,
  spec,
  withLock,
  slowTests,
} from './repo-helpers.js';

slowTests();

describe('R21-3.6 commitPersonal', () => {
  it('提交:以 HEAD 树为底稿叠加 upsert / 显式 delete、HEAD 前进一个提交、工作树与索引同步、head.json 记录、journal 已删;被显式删除的文件从工作树消失', async () => {
    const w = await makeWorld('pc-ok-');
    const first = await setupRepo(w);
    const slim = [{ path: 'rules/only.md', content: 'only\n' }] as const;
    const r = await withLock(w, (locks) =>
      commitPersonal(
        repoDeps(w),
        locks,
        spec('2', slim, 'transition', [ID1], ['rules/base.md', `lifecycle/${ID1}.json`]),
      ),
    );
    if (r.status !== 'committed') throw new Error(JSON.stringify(r));
    expect(git(w, ['rev-parse', 'HEAD'])).toBe(r.commit);
    expect(git(w, ['rev-parse', `${r.commit}^`])).toBe(first);
    expect(git(w, ['rev-parse', `${r.commit}^{tree}`])).toBe(r.tree);
    expect(git(w, ['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('rules/only.md');
    expect(await readUserFile(w, 'rules/only.md')).toBe('only\n');
    expect(await exists(path.join(w.h.repoDir, 'rules/base.md'))).toBe(false); // 旧文件随目标树消失
    expect(git(w, ['--no-optional-locks', 'status', '--porcelain', '--ignored'])).toBe('');
    expect(await readHead(w.h)).toMatchObject({ kind: 'ok', value: { head: r.commit } });
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
  });

  it('作者与提交者是常量身份 agent-kit-rsi,时间取注入的时钟;提交信息含 kind 与 txn_id', async () => {
    const w = await makeWorld('pc-ident-');
    await setupRepo(w);
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('abc', NEXT_FILES, 'rollback')),
    );
    expect(r.status).toBe('committed');
    expect(git(w, ['log', '-1', '--format=%an|%ae|%cn|%ce|%at'])).toBe(
      `agent-kit-rsi||agent-kit-rsi||${Math.floor(NOW.getTime() / 1000)}`,
    );
    expect(git(w, ['log', '-1', '--format=%s'])).toBe('rsi: rollback abc0000000000000');
  });

  it('首次尚无仓库:返回 absent(不自动建仓、不写任何东西);建仓走 openPersonalRepo({ bootstrap: true })', async () => {
    const w = await makeWorld('pc-absent-');
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('2', BASE_FILES)),
    );
    expect(r).toEqual({ status: 'absent' });
    expect(await exists(w.h.repoDir)).toBe(false);
  });

  describe('目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样', () => {
    const bad: [string, string][] = [
      ['.gitattributes', 'rules/.gitattributes'],
      ['.gitmodules', 'rules/.gitmodules'],
      ['顶层 .gitattributes', '.gitattributes'],
      ['.git 目录里', 'rules/.git/config'],
      ['隐藏文件', 'rules/.hidden.md'],
      ['路径逃逸 ..', 'rules/../outside.md'],
      ['绝对路径', '/etc/passwd'],
      ['顶层文件', 'README.md'],
      ['不在布局内的顶层目录', 'notes/x.md'],
      ['空段', 'rules//x.md'],
      ['控制字符', 'rules/x\ny.md'],
    ];
    it.each(bad)('%s', async (_name, p) => {
      const w = await makeWorld('pc-bad-');
      await setupRepo(w);
      const before = await snapshot(w);
      await expect(
        withLock(w, (locks) =>
          commitPersonal(repoDeps(w), locks, spec('2', [{ path: p, content: 'x\n' }])),
        ),
      ).rejects.toBeInstanceOf(TreeSpecError);
      expect(await snapshot(w)).toEqual(before);
    });

    it('同一路径重复(不区分大小写)/ 文件与目录同名 / 非法 txn_id', async () => {
      const w = await makeWorld('pc-dup-');
      await setupRepo(w);
      const run = (files: { path: string; content: string }[], txn = '2') =>
        withLock(w, (locks) =>
          commitPersonal(repoDeps(w), locks, { ...spec(txn, files), txnId: txn.padEnd(16, '0') }),
        );
      await expect(
        run([
          { path: 'rules/a.md', content: '1' },
          { path: 'rules/A.md', content: '2' },
        ]),
      ).rejects.toBeInstanceOf(TreeSpecError);
      await expect(
        run([
          { path: 'rules/a', content: '1' },
          { path: 'rules/a/b.md', content: '2' },
        ]),
      ).rejects.toBeInstanceOf(TreeSpecError);
      // 完全相同的路径出现两次
      await expect(
        run([
          { path: 'rules/a.md', content: '1' },
          { path: 'rules/a.md', content: '2' },
        ]),
      ).rejects.toBeInstanceOf(TreeSpecError);
      await expect(
        commitPersonal(
          repoDeps(w),
          { personal: { assertHeld: async () => undefined } },
          { ...spec('2', BASE_FILES), txnId: 'XYZ' },
        ),
      ).rejects.toBeInstanceOf(TreeSpecError);
    });

    it('rules/A 与 rules/a:大小写不敏感的同名路径一律拒绝(大小写不敏感的卷上无法检出)', async () => {
      const w = await makeWorld('pc-case-');
      await setupRepo(w);
      const before = await snapshot(w);
      const run = (files: { path: string; content: string }[]) =>
        withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', files)));
      for (const files of [
        [
          { path: 'rules/A', content: '1' },
          { path: 'rules/a/b.md', content: '2' },
        ],
        [
          { path: 'rules/A/x.md', content: '1' },
          { path: 'rules/a/y.md', content: '2' },
        ],
        [
          { path: 'rules/a/x.md', content: '1' },
          { path: 'rules/A', content: '2' },
        ],
      ]) {
        await expect(run(files)).rejects.toBeInstanceOf(TreeSpecError);
      }
      expect(await snapshot(w)).toEqual(before);
      // 对照:同一目录下大小写相同的多个文件、不同名字的目录并存没问题
      const ok = await run([
        { path: 'rules/a/x.md', content: '1' },
        { path: 'rules/a/y.md', content: '2' },
        { path: 'rules/b/x.md', content: '3' },
      ]);
      expect(ok.status).toBe('committed');
    });

    it('正向对照:合法路径(含深层目录、点与连字符)通过,且全部是 100644', async () => {
      const w = await makeWorld('pc-good-');
      await setupRepo(w);
      const files = [
        { path: 'rules/a-b_c.v2.md', content: 'a\n' },
        { path: 'methods/m1/SKILL.md', content: 'm\n' },
        { path: 'cases/auto/cluster-1/case.yaml', content: 'c\n' },
      ] as const;
      const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', files)));
      expect(r.status).toBe('committed');
      const modes = git(w, ['ls-tree', '-r', 'HEAD'])
        .split('\n')
        .map((l) => l.slice(0, 6));
      expect(modes).toEqual(Array(5).fill('100644')); // 底稿 2 个 + 新增 3 个
      expect(modes.length).toBe(5);
    });
  });
});

describe('R21-3.1 / R21-3.6 kit 管理路径:以 HEAD 树为底稿,用户文件保留,delete 只能落在管理命名空间内', () => {
  async function userCommit(w: Awaited<ReturnType<typeof makeWorld>>, msg: string): Promise<void> {
    git(w, ['add', '-A']);
    git(w, ['commit', '-q', '-m', msg]);
  }

  it('情形①接受的用户新增文件(管理命名空间之内 rules/user.md、之外 notes/x.md)在下一次 kit 提交后原样保留(树、工作树、状态都干净)', async () => {
    const w = await makeWorld('pc-keep-');
    await setupRepo(w);
    await writeUserFile(w, 'notes/x.md', 'mine\n');
    await writeUserFile(w, 'rules/user.md', 'also mine\n');
    await userCommit(w, 'user adds files');
    const r = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('2', NEXT_FILES)),
    );
    expect(r.status).toBe('committed');
    const names = git(w, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
    expect(names).toEqual(
      expect.arrayContaining(['notes/x.md', 'rules/user.md', 'rules/new.md', 'rules/base.md']),
    );
    expect(await readUserFile(w, 'notes/x.md')).toBe('mine\n');
    expect(await readUserFile(w, 'rules/user.md')).toBe('also mine\n');
    expect(git(w, ['--no-optional-locks', 'status', '--porcelain', '--ignored'])).toBe('');
    // 再来一次(只 upsert 一个文件)仍保留
    const r2 = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('3', [{ path: 'rules/new.md', content: 'v2\n' }])),
    );
    expect(r2.status).toBe('committed');
    expect(await readUserFile(w, 'notes/x.md')).toBe('mine\n');
  });

  it('显式 delete 管理路径内的文件生效;删一个不存在的路径视为已删(幂等)', async () => {
    const w = await makeWorld('pc-del-');
    await setupRepo(w);
    const r = await withLock(w, (locks) =>
      commitPersonal(
        repoDeps(w),
        locks,
        spec('2', [], 'transition', [ID1], ['rules/base.md', 'rules/never-existed.md']),
      ),
    );
    expect(r.status).toBe('committed');
    expect(git(w, ['ls-tree', '-r', '--name-only', 'HEAD'])).toBe(`lifecycle/${ID1}.json`);
    expect(await exists(path.join(w.h.repoDir, 'rules/base.md'))).toBe(false);
  });

  it.each(['notes/x.md', 'README.md', '.git/config', 'rules/../notes/x.md', 'rules', ''])(
    '试图 delete 非管理路径或畸形路径(%s)→ TreeSpecError,什么都没动',
    async (target) => {
      const w = await makeWorld('pc-delbad-');
      await setupRepo(w);
      await writeUserFile(w, 'notes/x.md', 'mine\n');
      await userCommit(w, 'user adds');
      const before = await snapshot(w);
      await expect(
        withLock(w, (locks) =>
          commitPersonal(repoDeps(w), locks, spec('2', [], 'transition', [ID1], [target])),
        ),
      ).rejects.toBeInstanceOf(TreeSpecError);
      expect(await snapshot(w)).toEqual(before);
    },
  );
});
