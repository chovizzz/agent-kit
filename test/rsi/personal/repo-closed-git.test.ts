/**
 * R21-3.6 封闭 git 配置(真 git,不 mock):全局钩子、本地过滤器、include 链、core.hooksPath、工作树里的用户未提交改动,
 * 各「配置被屏蔽 / 钩子不执行 / 用户改动被保留」。每个夹具都带一条**活性对照**:同一份配置交给普通 git(不经封闭配置)时钩子 / 过滤器确实会执行,
 * 否则「不执行」可能只是夹具没生效(空转)。变异:去掉 core.hooksPath 覆盖、放行 filter.*、放行 include.*、改回 read-tree --reset。
 */
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exists, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import { commitPersonal } from '../../../src/rsi/personal/commit.js';
import { ensureEmptyDir } from '../../../src/rsi/personal/home-state.js';
import { createClosedGit } from '../../../src/rsi/personal/repo-check.js';
import { homeSnapshot } from '../../signals/helpers.js';
import {
  BASE_FILES,
  git,
  gitRaw,
  readUserFile,
  repoDeps,
  setupRepo,
  spec,
  withLock,
  writeUserFile,
  makeWorld,
  NOW,
  type World,
  slowTests,
} from './repo-helpers.js';

slowTests();

afterEach(() => {
  vi.unstubAllEnvs();
});

let before = '';
beforeAll(async () => {
  before = await homeSnapshot();
});
afterAll(async () => {
  // 变异(让守卫失效)演练时也不得写真实 HOME:顶层条目名单前后一致
  expect(await homeSnapshot()).toBe(before);
});

const NEXT = [...BASE_FILES, { path: 'rules/new.md', content: 'new rule\n' }] as const;

async function installHook(w: World, hooksDir: string, marker: string): Promise<void> {
  await safe.mkdirp(w.io, hooksDir, 0o700);
  const hook = path.join(hooksDir, 'reference-transaction');
  await safe.writeFile(w.io, hook, `#!/bin/sh\necho "$@" >> '${marker}'\n`, { mode: 0o755 });
  await safe.chmod(w.io, hook, 0o755);
}

describe('R21-3.6 封闭 git 配置', () => {
  it('R21-3.6 用户全局钩子(~/.gitconfig 的 core.hooksPath)不执行', async () => {
    const w = await makeWorld('p-glob-');
    const head = await setupRepo(w);
    const hooks = path.join(w.dir, 'global-hooks');
    const marker = path.join(w.dir, 'marker-global');
    await installHook(w, hooks, marker);
    const gitconfig = path.join(w.home, '.gitconfig');
    await safe.writeFile(
      w.io,
      gitconfig,
      `[core]\n\thooksPath = ${hooks}\n[user]\n\tname = evil\n`,
    );

    // 活性对照:普通 git 读到这份全局配置时,钩子确实执行
    git(w, ['update-ref', 'refs/heads/ctrl', head], { env: { GIT_CONFIG_GLOBAL: gitconfig } });
    expect(await exists(marker), '对照:钩子应该跑').toBe(true);
    git(w, ['update-ref', '-d', 'refs/heads/ctrl']);
    await safe.remove(w.io, marker);

    const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', NEXT)));
    expect(r.status).toBe('committed');
    expect(await exists(marker), '封闭配置下全局钩子不得执行').toBe(false);
    // 作者与提交者是常量身份,不读用户全局配置里的 user.name
    expect(git(w, ['log', '-1', '--format=%an|%ae|%cn|%ce'])).toBe('agent-kit-rsi||agent-kit-rsi|');
  });

  it('R21-3.6 仓库自带的 .git/hooks 钩子不执行(core.hooksPath 被覆盖为空目录)', async () => {
    const w = await makeWorld('p-hook-');
    const head = await setupRepo(w);
    const marker = path.join(w.dir, 'marker-local');
    await installHook(w, path.join(w.h.repoDir, '.git', 'hooks'), marker);

    git(w, ['update-ref', 'refs/heads/ctrl', head]); // 对照:不封闭则执行
    expect(await exists(marker), '对照:钩子应该跑').toBe(true);
    git(w, ['update-ref', '-d', 'refs/heads/ctrl']);
    await safe.remove(w.io, marker);

    const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', NEXT)));
    expect(r.status).toBe('committed');
    expect(await exists(marker), '本地钩子不得执行').toBe(false);
  });

  it('R21-3.6 本地配置里的 core.hooksPath 被结构校验拒绝(personal_repo_invalid),钩子不执行', async () => {
    const w = await makeWorld('p-hpcfg-');
    const head = await setupRepo(w);
    const hooks = path.join(w.dir, 'cfg-hooks');
    const marker = path.join(w.dir, 'marker-cfg');
    await installHook(w, hooks, marker);
    git(w, ['config', '--local', 'core.hooksPath', hooks]);

    git(w, ['update-ref', 'refs/heads/ctrl', head]);
    expect(await exists(marker), '对照:钩子应该跑').toBe(true);
    git(w, ['update-ref', '-d', 'refs/heads/ctrl']);
    await safe.remove(w.io, marker);

    const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', NEXT)));
    expect(r).toMatchObject({ status: 'invalid', breaker: 'personal_repo_invalid' });
    expect(await exists(marker)).toBe(false);
  });

  /** 过滤器靠 .git/info/attributes 挂到全部文件上;clean / smudge 都写同一个标记 */
  async function plantFilter(w: World, cfgFile: 'local' | { include: string }): Promise<string> {
    const marker = path.join(w.dir, 'marker-filter');
    const driver = (): void => {
      for (const [k, v] of [
        ['filter.evil.clean', `sh -c "touch '${marker}'; cat"`],
        ['filter.evil.smudge', `sh -c "touch '${marker}'; cat"`],
      ] as const) {
        if (cfgFile === 'local') git(w, ['config', '--local', k, v]);
        else git(w, ['config', '--file', cfgFile.include, k, v]);
      }
    };
    if (cfgFile !== 'local') {
      await safe.writeFile(w.io, cfgFile.include, '');
      git(w, ['config', '--local', 'include.path', cfgFile.include]);
    }
    driver();
    await safe.mkdirp(w.io, path.join(w.h.repoDir, '.git', 'info'), 0o700);
    await safe.writeFile(
      w.io,
      path.join(w.h.repoDir, '.git', 'info', 'attributes'),
      '* filter=evil\n',
    );
    return marker;
  }

  it('本地过滤器 filter.*:被结构校验拒绝,clean / smudge 都不执行', async () => {
    const w = await makeWorld('p-filter-');
    await setupRepo(w);
    const marker = await plantFilter(w, 'local');

    // 活性对照:普通 git 按属性跑 clean 过滤器
    git(w, ['hash-object', '--path=rules/base.md', '--stdin'], { input: 'x\n' });
    expect(await exists(marker), '对照:过滤器应该跑').toBe(true);
    await safe.remove(w.io, marker);

    const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', NEXT)));
    expect(r).toMatchObject({
      status: 'invalid',
      why: 'config_key',
      breaker: 'personal_repo_invalid',
    });
    expect(await exists(marker), '过滤器不得执行').toBe(false);
  });

  it('include 链(include.path 指向带过滤器的文件):被结构校验拒绝,过滤器不执行', async () => {
    const w = await makeWorld('p-include-');
    await setupRepo(w);
    const marker = await plantFilter(w, { include: path.join(w.dir, 'extra.cfg') });

    git(w, ['hash-object', '--path=rules/base.md', '--stdin'], { input: 'x\n' });
    expect(await exists(marker), '对照:include 进来的过滤器应该跑').toBe(true);
    await safe.remove(w.io, marker);

    const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', NEXT)));
    expect(r).toMatchObject({
      status: 'invalid',
      why: 'config_key',
      breaker: 'personal_repo_invalid',
    });
    expect(await exists(marker), 'include 链里的过滤器不得执行').toBe(false);
  });

  it('R21-3.6 工作树里与目标冲突的用户未提交改动:git 拒绝覆盖,改动保留,按 personal_repo_diverged 处理(不是 read-tree --reset)', async () => {
    const w = await makeWorld('p-conflict-');
    await setupRepo(w);
    const files = [{ path: 'rules/base.md', content: 'base rule v2\n' }, BASE_FILES[1]] as const;
    const r = await withLock(w, (locks) =>
      commitPersonal(
        repoDeps(w, {
          onStep: async (s) => {
            // 在 update-ref 之后、工作树同步之前,用户改了一个目标也要改的文件
            if (s === 'before:read-tree') await writeUserFile(w, 'rules/base.md', 'USER EDIT\n');
          },
        }),
        locks,
        spec('2', files),
      ),
    );
    expect(r).toMatchObject({ status: 'deferred', reason: 'personal_repo_diverged' });
    expect(await readUserFile(w, 'rules/base.md')).toBe('USER EDIT\n');
    // journal 仍在(R21-3.6a):下一次恢复同样判 diverged,不动用户改动
    expect(await exists(path.join(w.h.stateDir, 'commit-journal.json'))).toBe(true);
    const again = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('3', files)),
    );
    expect(again).toMatchObject({ status: 'deferred', reason: 'personal_repo_diverged' });
    expect(await readUserFile(w, 'rules/base.md')).toBe('USER EDIT\n');
  });

  it('工作树里与目标无关的用户未提交改动:两树合并保留它,提交照常完成(--reset 会抹掉它)', async () => {
    const w = await makeWorld('p-unrelated-');
    await setupRepo(w);
    const r = await withLock(w, (locks) =>
      commitPersonal(
        repoDeps(w, {
          onStep: async (s) => {
            if (s === 'before:read-tree') await writeUserFile(w, 'rules/base.md', 'USER EDIT\n');
          },
        }),
        locks,
        spec('2', NEXT),
      ),
    );
    expect(r.status).toBe('committed');
    expect(await readUserFile(w, 'rules/base.md')).toBe('USER EDIT\n');
    expect(await readUserFile(w, 'rules/new.md')).toBe('new rule\n');
    expect(git(w, ['show', 'HEAD:rules/base.md'])).toBe('base rule');
  });

  it('继承环境里的 GIT_*(GIT_NAMESPACE / GIT_OBJECT_DIRECTORY / GIT_CONFIG_COUNT 等)不进入封闭执行', async () => {
    const w = await makeWorld('p-env-');
    await setupRepo(w);
    const hooks = path.join(w.dir, 'env-hooks');
    const marker = path.join(w.dir, 'marker-env');
    await installHook(w, hooks, marker);
    vi.stubEnv('GIT_NAMESPACE', 'evil');
    vi.stubEnv('GIT_OBJECT_DIRECTORY', path.join(w.dir, 'nowhere'));
    vi.stubEnv('GIT_COMMON_DIR', path.join(w.dir, 'nowhere-common'));
    vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', path.join(w.dir, 'nowhere-alt'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath');
    vi.stubEnv('GIT_CONFIG_VALUE_0', hooks);
    vi.stubEnv('GIT_CONFIG_PARAMETERS', `'core.hooksPath'='${hooks}'`);
    const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', NEXT)));
    if (r.status !== 'committed') throw new Error(JSON.stringify(r));
    expect(await exists(marker)).toBe(false);
    vi.unstubAllEnvs();
    expect(git(w, ['rev-parse', 'refs/heads/rsi'])).toBe(r.commit);
    expect(await exists(path.join(w.dir, 'nowhere'))).toBe(false); // 对象没有写到继承来的对象目录
  });

  it('R21-3.6 封闭执行不读替换对象(GIT_NO_REPLACE_OBJECTS):refs/replace 对它不生效', async () => {
    const w = await makeWorld('p-replace-');
    await setupRepo(w);
    const a = git(w, ['hash-object', '-w', '--stdin'], { input: 'A\n' });
    const b = git(w, ['hash-object', '-w', '--stdin'], { input: 'B\n' });
    git(w, ['replace', a, b]);
    expect(git(w, ['cat-file', '-p', a])).toBe('B'); // 对照:普通 git 看到的是被替换后的内容
    const closed = createClosedGit(w.h, await ensureEmptyDir(w.h), () => NOW);
    expect(closed.run(['cat-file', '-p', a]).stdout).toBe('A\n');
  });

  it('R21-3.6 提交内容原样入库(--no-filters;不做换行转换),相同输入得到相同树', async () => {
    const w = await makeWorld('p-bytes-');
    await setupRepo(w);
    const crlf = { path: 'rules/crlf.md', content: 'a\r\nb\r\n' };
    const files = [...BASE_FILES, crlf] as const;
    const r = await withLock(w, (locks) => commitPersonal(repoDeps(w), locks, spec('2', files)));
    if (r.status !== 'committed') throw new Error(JSON.stringify(r));
    expect(await readText(path.join(w.h.repoDir, 'rules/crlf.md'))).toBe('a\r\nb\r\n');
    expect(gitRaw(w, ['cat-file', 'blob', 'HEAD:rules/crlf.md']).stdout).toBe('a\r\nb\r\n');
    const again = await withLock(w, (locks) =>
      commitPersonal(repoDeps(w), locks, spec('3', files)),
    );
    if (again.status !== 'committed') throw new Error(JSON.stringify(again));
    expect(again.tree).toBe(r.tree); // 内容寻址:同一份文件集合 → 同一棵树
  });
});
