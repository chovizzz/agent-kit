import { describe, expect, it } from 'vitest';
import { createGuardGit } from '../../src/guards/index.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { TestRepo } from '../helpers/make-repo.js';
import { afterEach } from 'vitest';

const repos: TestRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.dispose()));
});

describe('GuardGit.listFiles / fileHistory(L2 新增)', () => {
  it('listFiles:只列目录内的普通文件(含子目录),不列符号链接;目录不存在返回 []', async () => {
    const repo = await makeTestRepo();
    repos.push(repo);
    const oid = await repo.commit({
      'attest/a/x.json': '{}\n',
      'attest/a/sub/y.json': '{}\n',
      'attest/a/link.json': { link: 'x.json' },
      'attest/b/z.json': '{}\n',
      'attestx/w.json': '{}\n',
    });
    const git = createGuardGit(repo.io, repo.dir, repo.gitEnv);
    expect(git.listFiles(oid, 'attest/a')).toEqual(['attest/a/sub/y.json', 'attest/a/x.json']);
    expect(git.listFiles(oid, 'attest/nope')).toEqual([]);
    expect(git.listFiles(oid, 'attest')).toHaveLength(3); // 不会把 attestx/ 当成前缀
  });

  it('fileHistory:新→旧,只含改动过该路径的提交', async () => {
    const repo = await makeTestRepo();
    repos.push(repo);
    const c1 = await repo.commit({ 'f.txt': '1\n' });
    await repo.commit({ 'g.txt': 'x\n' });
    const c3 = await repo.commit({ 'f.txt': '2\n' });
    const git = createGuardGit(repo.io, repo.dir, repo.gitEnv);
    const h = git.fileHistory(c3, 'f.txt');
    expect(h.map((x) => x.commit)).toEqual([c3, c1]);
    expect(h[0]?.date).toBe('2026-10-08');
    expect(git.fileHistory(c3, 'nope.txt')).toEqual([]);
  });
});
