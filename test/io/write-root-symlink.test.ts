/**
 * cleanup3 第 1 条:KIT_WRITE_ROOTS / 状态目录经符号链接逃出允许范围。
 * 校验时与每次写入时都按 realpath(含最长已存在前缀)判定;链接事后改指向同样被拒。
 * 全部在仓库外的临时目录里做,并断言真实 HOME 前后无变化。
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIoContext, PathsError } from '../../src/io/paths.js';
import { exists, existsSync, readText, realpath } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { homeSnapshot } from '../signals/helpers.js';
import { REPO_ROOT, makeTempDir, wideCtx } from '../helpers/tmp.js';

let homeBefore = '';
beforeAll(async () => {
  homeBefore = await homeSnapshot();
});
afterAll(async () => {
  expect(await homeSnapshot()).toBe(homeBefore);
});

const ESC = /逃出|不在 out\/|符号链接|悬空/;

async function setup(prefix: string) {
  const { dir } = await makeTempDir(prefix);
  const w = wideCtx(dir);
  const repo = path.join(dir, 'repo');
  await safe.mkdirp(w, path.join(repo, 'src'));
  await safe.mkdirp(w, path.join(repo, '.state', 'sub'));
  await safe.mkdirp(w, path.join(repo, 'out'));
  await safe.mkdirp(w, path.join(dir, 'outside'));
  const mk = (env: Record<string, string>, over: { root?: string } = {}) =>
    createIoContext({
      cwd: REPO_ROOT,
      root: over.root ?? repo,
      env: { PATH: '/usr/bin:/bin', ...env },
    });
  return { dir, w, repo, mk };
}

describe('KIT_WRITE_ROOTS 经符号链接绕过收窄', () => {
  it('链接在末段:.state/up -> .. ,KIT_WRITE_ROOTS=.state/up 被拒(PathsError)', async () => {
    const { w, repo, mk } = await setup('wr-end-');
    await safe.symlink(w, repo, path.join(repo, '.state', 'up'));
    const env = { KIT_WRITE_ROOTS: path.join(repo, '.state', 'up') };
    expect(() => mk(env)).toThrow(PathsError);
    expect(() => mk(env)).toThrow(ESC);
  });

  it('链接在中间一段:.state/up/src 实为 <repo>/src,被拒', async () => {
    const { w, repo, mk } = await setup('wr-mid-');
    await safe.symlink(w, repo, path.join(repo, '.state', 'up'));
    expect(() => mk({ KIT_WRITE_ROOTS: path.join(repo, '.state', 'up', 'src') })).toThrow(ESC);
    // 目标尚不存在的剩余段:.state/up/src/not-yet/deeper 同样按最长已存在前缀解析
    expect(() =>
      mk({ KIT_WRITE_ROOTS: path.join(repo, '.state', 'up', 'src', 'not-yet', 'deeper') }),
    ).toThrow(ESC);
  });

  it('链接指向仓库外:.state/out-link -> ../../outside,被拒', async () => {
    const { w, dir, repo, mk } = await setup('wr-outside-');
    await safe.symlink(w, path.join(dir, 'outside'), path.join(repo, '.state', 'o'));
    expect(() => mk({ KIT_WRITE_ROOTS: path.join(repo, '.state', 'o') })).toThrow(ESC);
  });

  it('悬空链接 → 拒(无法判断落点,fail-closed)', async () => {
    const { w, dir, repo, mk } = await setup('wr-dangle-');
    await safe.symlink(w, path.join(dir, 'nope'), path.join(repo, '.state', 'd'));
    expect(() => mk({ KIT_WRITE_ROOTS: path.join(repo, '.state', 'd') })).toThrow(PathsError);
  });

  it('正向对照:普通子目录、仓库内且在 state 之内的链接、尚不存在的子路径照常接受', async () => {
    const { w, repo, mk } = await setup('wr-ok-');
    await safe.symlink(w, path.join(repo, '.state', 'sub'), path.join(repo, '.state', 'in'));
    const ctx = mk({
      KIT_WRITE_ROOTS: [
        path.join(repo, '.state', 'sub'),
        path.join(repo, '.state', 'in'),
        path.join(repo, '.state', 'later', 'x'),
        path.join(repo, 'out'),
      ].join(path.delimiter),
    });
    expect(ctx.writeRoots).toHaveLength(4);
    await safe.writeFile(ctx, path.join(repo, '.state', 'in', 'f.txt'), 'ok');
    expect(await readText(path.join(repo, '.state', 'sub', 'f.txt'))).toBe('ok');
  });
});

describe('链接事后改指向:每次写入重新 realpath', () => {
  it('写入根原本是普通目录,事后换成指向仓库的链接 → 写入被拒,仓库内无新文件', async () => {
    const { w, repo, mk } = await setup('wr-late-');
    const root = path.join(repo, '.state', 'ok');
    const ctx = mk({ KIT_WRITE_ROOTS: root });
    await safe.mkdirp(ctx, root);
    await safe.writeFile(ctx, path.join(root, 'a.txt'), 'before');
    await safe.remove(w, root);
    await safe.symlink(w, repo, root);
    await expect(safe.writeFile(ctx, path.join(root, 'src', 'evil.txt'), 'x')).rejects.toThrow(
      safe.WriteDeniedError,
    );
    await expect(safe.writeFile(ctx, path.join(root, 'evil2.txt'), 'x')).rejects.toThrow(
      safe.WriteDeniedError,
    );
    expect(await exists(path.join(repo, 'src', 'evil.txt'))).toBe(false);
    expect(await exists(path.join(repo, 'evil2.txt'))).toBe(false);
  });

  it('默认根:状态目录事后被换成指向仓库外的链接 → 写入被拒', async () => {
    const { w, dir, repo, mk } = await setup('wr-state-late-');
    const ctx = mk({});
    await safe.writeFile(ctx, path.join(repo, '.state', 'sub', 'a.txt'), 'before');
    await safe.remove(w, path.join(repo, '.state'));
    await safe.symlink(w, path.join(dir, 'outside'), path.join(repo, '.state'));
    await expect(safe.writeFile(ctx, path.join(repo, '.state', 'x.txt'), 'x')).rejects.toThrow(
      safe.WriteDeniedError,
    );
    expect(await exists(path.join(dir, 'outside', 'x.txt'))).toBe(false);
  });

  it('创建时状态目录就是指向仓库外的链接 → createIoContext 拒(PathsError)', async () => {
    const { w, dir, repo, mk } = await setup('wr-state-link-');
    await safe.remove(w, path.join(repo, '.state'));
    await safe.symlink(w, path.join(dir, 'outside'), path.join(repo, '.state'));
    expect(() => mk({})).toThrow(PathsError);
  });

  it('out/ 是指向仓库外的链接 → 同样拒', async () => {
    const { w, dir, repo, mk } = await setup('wr-out-link-');
    await safe.remove(w, path.join(repo, 'out'));
    await safe.symlink(w, path.join(dir, 'outside'), path.join(repo, 'out'));
    expect(() => mk({})).toThrow(PathsError);
  });
});

describe('同一目录的另一种写法(大小写 / NFD / firmlink)', () => {
  it('firmlink 形式的逃逸路径照拒;firmlink 形式的合法根照收', async () => {
    const { w, repo, mk } = await setup('wr-firm-');
    await safe.symlink(w, repo, path.join(repo, '.state', 'up'));
    const realRepo = await realpath(repo);
    const firm = path.join('/System/Volumes/Data', realRepo);
    if (!existsSync(firm)) return; // 非 macOS firmlink 布局
    expect(() => mk({ KIT_WRITE_ROOTS: path.join(firm, '.state', 'up', 'src') })).toThrow(
      PathsError,
    );
    expect(() => mk({ KIT_WRITE_ROOTS: path.join(firm, '.state', 'up') })).toThrow(PathsError);
  });

  it('大小写变体的逃逸路径(.STATE/UP/src)在大小写不敏感卷上照拒', async () => {
    const { w, repo, mk } = await setup('wr-case-');
    await safe.symlink(w, repo, path.join(repo, '.state', 'up'));
    const variant = path.join(repo, '.STATE', 'UP', 'src');
    if (!existsSync(variant)) return; // 区分大小写的卷:该写法本来就不存在
    expect(() => mk({ KIT_WRITE_ROOTS: variant })).toThrow(PathsError);
  });

  it('合法根经「另一种写法」的链接指进 state:仓库目录名大小写变体按身份认出(不误拒)', async () => {
    const { w, dir, repo, mk } = await setup('wr-alias-ok-');
    const upper = path.join(dir, 'REPO');
    if (existsSync(upper)) {
      await safe.symlink(w, path.join(upper, '.state', 'sub'), path.join(repo, '.state', 'ci'));
      const ctx = mk({ KIT_WRITE_ROOTS: path.join(repo, '.state', 'ci') });
      await safe.writeFile(ctx, path.join(repo, '.state', 'ci', 'f.txt'), 'ok');
    }
  });

  it('NFD 形式的仓库路径下,逃逸路径照拒', async () => {
    const { w, dir, mk } = await setup('wr-nfd-');
    const accented = path.join(dir, 'café-repo');
    await safe.mkdirp(w, path.join(accented, '.state'));
    await safe.mkdirp(w, path.join(accented, 'src'));
    await safe.symlink(w, accented, path.join(accented, '.state', 'up'));
    const nfd = path.join(dir, 'café-repo');
    if (!existsSync(nfd)) return; // 文件系统不把两种写法视为同一目录
    expect(() =>
      mk({ KIT_WRITE_ROOTS: path.join(nfd, '.state', 'up', 'src') }, { root: accented }),
    ).toThrow(PathsError);
  });
});

describe('safe-fs 相邻缺口(opus 咨询提出)', () => {
  it('mkdtemp 的 prefix 不得带路径分隔符或 ..(否则跳出已校验的 parent)', async () => {
    const { dir, mk, repo } = await setup('wr-mkdtemp-');
    const ctx = mk({});
    const parent = path.join(repo, '.state', 'sub');
    for (const bad of ['../../outside/x-', 'a/b-', 'a\\b-', '..x']) {
      await expect(safe.mkdtemp(ctx, parent, bad), bad).rejects.toThrow(safe.WriteDeniedError);
    }
    expect(await exists(path.join(dir, 'outside', 'x-'))).toBe(false);
    // 正向对照
    const made = await safe.mkdtemp(ctx, parent, 'good-');
    expect(path.dirname(made)).toBe(await realpath(parent));
  });

  it('copyFile 的来源是硬链接(nlink>1)→ 拒', async () => {
    const { w, repo, mk } = await setup('wr-copy-hl-');
    const ctx = mk({});
    const src = path.join(repo, 'src', 'a.txt');
    await safe.writeFile(w, src, 'data');
    await safe.copyFile(ctx, src, path.join(repo, '.state', 'sub', 'ok.txt')); // 正向对照
    await safe.hardlink(w, src, path.join(repo, 'src', 'alias.txt'));
    await expect(
      safe.copyFile(ctx, src, path.join(repo, '.state', 'sub', 'bad.txt')),
    ).rejects.toThrow(/硬链接/);
  });
});

describe('opus 对抗评审补测:out/state 链到仓库内别处、KIT_TMP 链到 HOME', () => {
  it('out -> src(仓库内其它目录)→ 创建时拒', async () => {
    const { w, repo, mk } = await setup('wr-out-src-');
    await safe.remove(w, path.join(repo, 'out'));
    await safe.symlink(w, path.join(repo, 'src'), path.join(repo, 'out'));
    expect(() => mk({})).toThrow(PathsError);
  });

  it('.state 事后换成指向仓库根的链接 → 写入被拒,仓库根无新文件', async () => {
    const { w, repo, mk } = await setup('wr-state-repo-');
    const ctx = mk({});
    await safe.remove(w, path.join(repo, '.state'));
    await safe.symlink(w, repo, path.join(repo, '.state'));
    await expect(safe.writeFile(ctx, path.join(repo, '.state', 'kit.toml'), 'x')).rejects.toThrow(
      safe.WriteDeniedError,
    );
    expect(await exists(path.join(repo, 'kit.toml'))).toBe(false);
  });

  it('out 事后换成指向仓库根的链接 → 写入被拒', async () => {
    const { w, repo, mk } = await setup('wr-out-late-');
    const ctx = mk({});
    await safe.remove(w, path.join(repo, 'out'));
    await safe.symlink(w, repo, path.join(repo, 'out'));
    await expect(safe.writeFile(ctx, path.join(repo, 'out', 'k.txt'), 'x')).rejects.toThrow(
      safe.WriteDeniedError,
    );
  });

  it('KIT_TMP 是指向(假)HOME 的链接 → 拒;指向其上级也拒', async () => {
    const { w, dir, repo, mk } = await setup('wr-tmp-home-');
    const home = path.join(dir, 'fakehome', 'u');
    await safe.mkdirp(w, home);
    const lnk = path.join(dir, 'tmp-link');
    await safe.symlink(w, home, lnk);
    const up = path.join(dir, 'tmp-up');
    await safe.symlink(w, path.join(dir, 'fakehome'), up);
    for (const t of [lnk, up]) {
      expect(() => mk({ KIT_TMP: t, KIT_REAL_HOME_OVERRIDE: home }), t).toThrow(PathsError);
    }
    // 正向对照:指向 HOME 之外的目录照常
    const ok = path.join(dir, 'tmp-ok');
    await safe.symlink(w, path.join(dir, 'outside'), ok);
    expect(mk({ KIT_TMP: ok, KIT_REAL_HOME_OVERRIDE: home }).tmpDir).toBe(ok);
    void repo;
  });
});
