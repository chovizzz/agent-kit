import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIoContext } from '../../src/io/paths.js';
import { existsSync, realpath } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { REPO_ROOT, makeTempDir, wideCtx } from '../helpers/tmp.js';

const OUT_MSG = /不得位于 out\/ 之下/;

/** 清理项 2:KIT_STATE_DIR / KIT_TMP 不得位于(或等于)out/ 之下;按解析后的真实路径判断。 */
async function repoIn(prefix: string) {
  const { dir } = await makeTempDir(prefix);
  const w = wideCtx(dir);
  const root = path.join(dir, 'repo');
  await safe.mkdirp(w, path.join(root, 'out'));
  const mk = (env: Record<string, string>, over: { root?: string } = {}) =>
    createIoContext({
      cwd: REPO_ROOT,
      root: over.root ?? root,
      env: { PATH: '/usr/bin:/bin', ...env },
    });
  return { dir, w, root, mk };
}

describe('KIT_STATE_DIR / KIT_TMP 不得在 out/ 之下', () => {
  it('字面路径:等于 out、在 out 之下 → PathsError(状态与临时目录一律拒)', async () => {
    const { root, mk } = await repoIn('pg-lit-');
    for (const bad of ['out', 'out/state', 'out/a/b']) {
      expect(() => mk({ KIT_STATE_DIR: bad }), `state ${bad}`).toThrow(OUT_MSG);
      expect(() => mk({ KIT_STATE_DIR: path.join(root, bad) }), `state abs ${bad}`).toThrow(
        OUT_MSG,
      );
    }
    for (const bad of ['out', 'out/tmp']) {
      expect(() => mk({ KIT_TMP: path.join(root, bad) }), `tmp ${bad}`).toThrow(OUT_MSG);
    }
  });

  it('大小写变体(OUT/x)也拒,避免大小写不敏感文件系统绕过', async () => {
    const { mk } = await repoIn('pg-case-');
    expect(() => mk({ KIT_STATE_DIR: 'OUT/x' })).toThrow(OUT_MSG);
  });

  it('同一目录的另一种写法也拒:Unicode NFD 路径 / macOS firmlink(按文件身份判断)', async () => {
    const { dir, w, mk } = await repoIn('pg-alias-');
    const accented = path.join(dir, 'caf\u00e9-repo');
    await safe.mkdirp(w, path.join(accented, 'out'));
    const nfd = path.join(dir, 'cafe\u0301-repo');
    if (existsSync(nfd)) {
      // 文件系统把两种写法视为同一目录(APFS 规范化)
      expect(() => mk({ KIT_TMP: path.join(nfd, 'out', 'x') }, { root: accented })).toThrow(
        OUT_MSG,
      );
    }
    const firm = path.join('/System/Volumes/Data', await realpath(accented), 'out', 'x');
    if (existsSync(path.dirname(firm))) {
      expect(() => mk({ KIT_TMP: firm }, { root: accented })).toThrow(OUT_MSG);
    }
  });

  it('正向对照:.state、out2、out-x、仓库外的 KIT_TMP 照常接受(不是前缀误伤)', async () => {
    const { dir, root, mk } = await repoIn('pg-ok-');
    expect(mk({}).stateDir).toBe(path.join(root, '.state'));
    for (const ok of ['out2', 'out-x', 'outer/state', '.state/x']) {
      expect(mk({ KIT_STATE_DIR: ok }).stateDir, ok).toBe(path.join(root, ok));
    }
    expect(mk({ KIT_TMP: path.join(dir, 'scratch') }).tmpDir).toBe(path.join(dir, 'scratch'));
  });

  it('out 本身是符号链接:state 落在链接目标之下也要拒(按真实路径)', async () => {
    const { dir, w, root, mk } = await repoIn('pg-outlink-');
    const real = path.join(dir, 'real-out');
    await safe.mkdirp(w, real);
    await safe.remove(w, path.join(root, 'out'));
    await safe.symlink(w, real, path.join(root, 'out'));
    // state 在仓库内、字面上不在 out/ 下,但经另一个仓库内链接指进 real-out
    await safe.symlink(w, real, path.join(root, 'alias-state'));
    expect(() => mk({ KIT_STATE_DIR: 'alias-state/s' })).toThrow(OUT_MSG);
    // KIT_TMP 直接指向 real-out(out 的真实位置)
    expect(() => mk({ KIT_TMP: real })).toThrow(OUT_MSG);
    expect(() => mk({ KIT_TMP: path.join(real, 'sub') })).toThrow(OUT_MSG);
  });

  it('state/tmp 经链接指进 out/:拒绝(链接在中间段 / 在 out 里 / 悬空)', async () => {
    const { dir, w, root, mk } = await repoIn('pg-midlink-');
    await safe.symlink(w, path.join(root, 'out'), path.join(root, 'jump'));
    expect(() => mk({ KIT_STATE_DIR: 'jump' })).toThrow(OUT_MSG);
    expect(() => mk({ KIT_STATE_DIR: 'jump/deep/er' })).toThrow(OUT_MSG);
    await safe.symlink(w, path.join(root, 'out'), path.join(dir, 'tmp-jump'));
    expect(() => mk({ KIT_TMP: path.join(dir, 'tmp-jump', 'x') })).toThrow(OUT_MSG);
    // 悬空链接:无法解析真实位置,拒绝(fail-closed)
    await safe.symlink(w, path.join(dir, 'nowhere'), path.join(root, 'dangling'));
    expect(() => mk({ KIT_STATE_DIR: 'dangling/s' })).toThrow(/悬空/);
  });

  it('仓库根的上级是符号链接:经真实路径写出的 out 同样拒', async () => {
    const { dir, w, root, mk } = await repoIn('pg-parentlink-');
    const via = path.join(dir, 'via');
    await safe.symlink(w, path.dirname(root), via); // via -> dir
    const viaRoot = path.join(via, 'repo');
    // 用链接路径当仓库根,state 用真实路径写进 out(反过来也测)
    expect(() => mk({ KIT_STATE_DIR: path.join(viaRoot, 'out', 's') }, { root })).toThrow(OUT_MSG);
    expect(() => mk({ KIT_STATE_DIR: path.join(root, 'out', 's') }, { root: viaRoot })).toThrow(
      OUT_MSG,
    );
    // 正向对照
    expect(mk({ KIT_STATE_DIR: '.state' }, { root: viaRoot }).stateDir).toBe(
      path.join(viaRoot, '.state'),
    );
    expect(await realpath(viaRoot)).toBe(root);
  });

  it('out/ 尚不存在也按「最深已存在祖先 + 剩余段」判断', async () => {
    const { w, root, mk } = await repoIn('pg-noout-');
    await safe.remove(w, path.join(root, 'out'));
    expect(() => mk({ KIT_STATE_DIR: 'out/s' })).toThrow(OUT_MSG);
    expect(mk({ KIT_STATE_DIR: 's' }).stateDir).toBe(path.join(root, 's'));
  });
});
