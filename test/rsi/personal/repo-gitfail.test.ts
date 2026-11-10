/**
 * 读取失败 ≠ 不存在:`revParse` / `gitOut` 三态(存在 / 确认不存在 / 读取失败),读取失败抛错或按 invalid 处理,不得当成「不存在」继续。
 * 失败用真实手段注入:PATH 里没有 git(启动失败)、损坏的 .git/HEAD(退出码 128)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIoContext } from '../../../src/io/paths.js';
import * as safe from '../../../src/io/safe-fs.js';
import { openPersonalRepo } from '../../../src/rsi/personal/commit.js';
import { ensureEmptyDir, personalHome } from '../../../src/rsi/personal/home-state.js';
import {
  checkRepoStructure,
  classifyRepo,
  createClosedGit,
  gitOut,
  PersonalGitError,
  revParse,
} from '../../../src/rsi/personal/repo-check.js';
import { REPO_ROOT } from '../../helpers/tmp.js';
import { makeWorld, NOW, repoDeps, setupRepo, slowTests, withLock } from './repo-helpers.js';

slowTests();

describe('git 读取三态', () => {
  it('对照(正常 git):存在 → sha;确认不存在 → null(rev-parse 退 1 / symbolic-ref 的 detached)', async () => {
    const w = await makeWorld('p-gf-ok-');
    const head = await setupRepo(w);
    const closed = createClosedGit(w.h, await ensureEmptyDir(w.h), () => NOW);
    expect(revParse(closed, 'refs/heads/rsi')).toBe(head);
    expect(revParse(closed, 'refs/heads/nope')).toBeNull();
    expect(gitOut(closed, ['symbolic-ref', '-q', 'HEAD'], { readOnly: true })).toBe(
      'refs/heads/rsi',
    );
  });

  it('git 启动失败(PATH 里没有 git)→ revParse / gitOut 抛 PersonalGitError,不当成「不存在」', async () => {
    const w = await makeWorld('p-gf-nogit-');
    await setupRepo(w);
    const io2 = createIoContext({
      cwd: REPO_ROOT,
      env: { KIT_TMP: w.dir, KIT_STATE_DIR: path.join(w.dir, 'state'), PATH: '/nonexistent-bin' },
    });
    const h2 = personalHome(io2, w.home);
    const closed = createClosedGit(h2, await ensureEmptyDir(w.h), () => NOW);
    expect(() => revParse(closed, 'refs/heads/rsi')).toThrow(PersonalGitError);
    expect(() => gitOut(closed, ['symbolic-ref', '-q', 'HEAD'])).toThrow(PersonalGitError);
    await expect(
      classifyRepo(
        closed,
        { schema_version: 1, head: 'a'.repeat(40), owner_repo_fp: w.ownerFp },
        w.ownerFp,
      ),
    ).rejects.toBeInstanceOf(PersonalGitError);
    // 结构校验同样不通过(读取失败按不合格处理)
    expect(await checkRepoStructure(h2, closed)).toMatchObject({ ok: false });
  });

  it('退出码 128(.git/HEAD 损坏)→ 打开仓库得到 invalid,不是 ready / absent / deferred', async () => {
    const w = await makeWorld('p-gf-corrupt-');
    await setupRepo(w);
    await safe.writeFile(w.io, path.join(w.h.repoDir, '.git', 'HEAD'), 'garbage\n');
    const o = await withLock(w, (locks) => openPersonalRepo(repoDeps(w), locks));
    expect(o).toMatchObject({ kind: 'invalid', breaker: 'personal_repo_invalid' });
  });
});
