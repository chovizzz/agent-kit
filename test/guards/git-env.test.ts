import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { createGuardGit } from '../../src/guards/index.js';
import { createIoContext } from '../../src/io/paths.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** PATH 里只放一个假 git,把它收到的 GIT_NO_LAZY_FETCH 写进文件,用来钉死共享入口给子进程的环境。 */
async function envSeenByGit(extra?: Record<string, string>): Promise<string> {
  const { ctx: cleanupCtx, dir } = await makeTempDir('guard-git-env-');
  cleanups.push(() => safe.remove(cleanupCtx, dir));
  const ctx0 = wideCtx(dir);
  const bin = path.join(dir, 'bin');
  const out = path.join(dir, 'seen.txt');
  await safe.mkdirp(ctx0, bin);
  await safe.writeFile(
    ctx0,
    path.join(bin, 'git'),
    `#!/bin/sh\nprintf '%s' "\${GIT_NO_LAZY_FETCH-UNSET}" > '${out}'\nexit 1\n`,
  );
  await safe.chmod(ctx0, path.join(bin, 'git'), 0o755);
  const ctx = createIoContext({ cwd: dir, root: dir, env: { KIT_TMP: dir, PATH: bin } });
  createGuardGit(ctx, dir, extra).resolveCommit('HEAD');
  return readText(out);
}

describe('createGuardGit 的子进程环境(K6)', () => {
  it('默认带 GIT_NO_LAZY_FETCH=1(部分克隆下守卫不得偷偷联网补对象)', async () => {
    expect(await envSeenByGit()).toBe('1');
  });

  it('调用方 extraEnv 仍可覆盖(测试 harness 的约定不变)', async () => {
    expect(await envSeenByGit({ GIT_NO_LAZY_FETCH: '0' })).toBe('0');
  });
});
