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
  makeWorld,
  NEXT_FILES,
  NOW,
  readUserFile,
  repoDeps,
  setupRepo,
  snapshot,
  spec,
  withLock,
} from './repo-helpers.js';

describe('R21-3.6 commitPersonal', () => {
  it('提交:整棵目标树重建、HEAD 前进一个提交、工作树与索引同步、head.json 记录、journal 已删;被去掉的文件从工作树消失', async () => {
    const w = await makeWorld('pc-ok-');
    const first = await setupRepo(w);
    const slim = [{ path: 'rules/only.md', content: 'only\n' }] as const;
    const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', slim)));
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
    const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', BASE_FILES)));
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
      await expect(commitPersonal(repoDeps(w), { personal: { assertHeld: async () => undefined } }, { ...spec('2', BASE_FILES), txnId: 'XYZ' })).rejects.toBeInstanceOf(TreeSpecError);
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
      const modes = git(w, ['ls-tree', '-r', 'HEAD']).split('\n').map((l) => l.slice(0, 6));
      expect(modes).toEqual(['100644', '100644', '100644']);
    });
  });
});
