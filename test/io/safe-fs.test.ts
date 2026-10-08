import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { createIoContext, getRealHome } from '../../src/io/paths.js';
import * as safe from '../../src/io/safe-fs.js';
import { WriteDeniedError } from '../../src/io/safe-fs.js';
import { baseCtx, makeTempDir, narrowCtx, REPO_ROOT, wideCtx } from '../helpers/tmp.js';

describe('safe-fs:写入根内成功(正向对照)', () => {
  it('在 KIT_TMP/allowed 内写、追加、建目录、复制、改名、删除', async () => {
    const { dir } = await makeTempDir('safefs-ok-');
    const ctx = narrowCtx(dir, 'allowed');
    const a = path.join(dir, 'allowed');
    await safe.mkdirp(ctx, a);
    await safe.writeFile(ctx, path.join(a, 'x.txt'), 'hello', { mode: 0o600 });
    await safe.appendFile(ctx, path.join(a, 'x.txt'), ' world');
    expect(await readText(path.join(a, 'x.txt'))).toBe('hello world');
    await safe.copyFile(ctx, path.join(a, 'x.txt'), path.join(a, 'y.txt'));
    await safe.rename(ctx, path.join(a, 'y.txt'), path.join(a, 'z.txt'));
    expect(await readText(path.join(a, 'z.txt'))).toBe('hello world');
    await safe.remove(ctx, path.join(a, 'z.txt'));
    expect(await exists(path.join(a, 'z.txt'))).toBe(false);
  });

  it('相对路径按 repoRoot 解析:默认 ctx 允许写 <repo>/out/…', () => {
    const ctx = baseCtx();
    expect(safe.assertWritable(ctx, 'out/tmp/x.txt')).toBe(
      path.join(ctx.repoRoot, 'out/tmp/x.txt'),
    );
  });
});

describe('safe-fs:根外写入一律抛 WriteDeniedError', () => {
  it('写「HOME」下任意路径被拒,且文件确实没有产生', async () => {
    // 用临时目录当假 HOME(KIT_REAL_HOME_OVERRIDE),而不是真实 HOME:
    // 万一这条断言所保护的校验被改坏,测试本身也不会往真实 HOME 里写东西。
    const { dir } = await makeTempDir('safefs-home-');
    const fakeHome = path.join(dir, 'fakehome');
    await safe.mkdirp(wideCtx(dir), fakeHome);
    expect(getRealHome({ KIT_REAL_HOME_OVERRIDE: fakeHome })).toBe(fakeHome);
    const ctx = narrowCtx(dir, 'allowed');
    const target = path.join(fakeHome, '.agent-kit-test-must-not-exist');
    await expect(safe.writeFile(ctx, target, 'x')).rejects.toBeInstanceOf(WriteDeniedError);
    expect(await exists(target)).toBe(false);
  });

  it('同级目录、`..` 逃逸、写根本身、删根本身都被拒', async () => {
    const { dir } = await makeTempDir('safefs-deny-');
    const ctx = narrowCtx(dir, 'allowed');
    const a = path.join(dir, 'allowed');
    await safe.mkdirp(wideCtx(dir), a);
    await expect(safe.writeFile(ctx, path.join(dir, 'outside.txt'), 'x')).rejects.toBeInstanceOf(
      WriteDeniedError,
    );
    await expect(
      safe.writeFile(ctx, path.join(a, '..', 'outside.txt'), 'x'),
    ).rejects.toBeInstanceOf(WriteDeniedError);
    await expect(safe.writeFile(ctx, a, 'x')).rejects.toBeInstanceOf(WriteDeniedError);
    await expect(safe.remove(ctx, a)).rejects.toBeInstanceOf(WriteDeniedError);
    expect(await exists(path.join(dir, 'outside.txt'))).toBe(false);
  });

  it('经 symlink 逃出根的写入被拒(包括目标尚不存在的子路径)', async () => {
    const { dir } = await makeTempDir('safefs-link-');
    const wide = wideCtx(dir);
    const a = path.join(dir, 'allowed');
    const outside = path.join(dir, 'outside');
    await safe.mkdirp(wide, a);
    await safe.mkdirp(wide, outside);
    await safe.symlink(wide, outside, path.join(a, 'link'));
    const narrow = narrowCtx(dir, 'allowed');
    await expect(safe.writeFile(narrow, path.join(a, 'link', 'x.txt'), 'x')).rejects.toBeInstanceOf(
      WriteDeniedError,
    );
    await expect(
      safe.writeFile(narrow, path.join(a, 'link', 'deep', 'x.txt'), 'x'),
    ).rejects.toBeInstanceOf(WriteDeniedError);
    expect(await exists(path.join(outside, 'x.txt'))).toBe(false);
    // 对照:同一个 symlink,用够宽的 ctx 写就成功,证明拒绝的原因确实是「根外」
    await safe.writeFile(wide, path.join(a, 'link', 'x.txt'), 'x');
    expect(await readText(path.join(outside, 'x.txt'))).toBe('x');
  });

  it('硬链接(nlink>1)目标被拒', async () => {
    const { dir } = await makeTempDir('safefs-hard-');
    const wide = wideCtx(dir);
    const a = path.join(dir, 'allowed');
    await safe.mkdirp(wide, a);
    await safe.writeFile(wide, path.join(dir, 'outside.txt'), 'orig');
    await safe.hardlink(wide, path.join(dir, 'outside.txt'), path.join(a, 'h.txt'));
    const narrow = narrowCtx(dir, 'allowed');
    await expect(safe.writeFile(narrow, path.join(a, 'h.txt'), 'pwn')).rejects.toBeInstanceOf(
      WriteDeniedError,
    );
    expect(await readText(path.join(dir, 'outside.txt'))).toBe('orig');
  });

  it('symlink → 硬链接别名同样被拒(nlink 检查作用于解析后的真实路径)', async () => {
    const { dir } = await makeTempDir('safefs-linkhard-');
    const wide = wideCtx(dir);
    const a = path.join(dir, 'allowed');
    await safe.mkdirp(wide, a);
    await safe.writeFile(wide, path.join(dir, 'outside.txt'), 'orig');
    await safe.symlink(wide, path.join(a, 'alias'), path.join(a, 'link')); // 先建链接(此时 alias 尚不存在)
    await safe.hardlink(wide, path.join(dir, 'outside.txt'), path.join(a, 'alias'));
    const narrow = narrowCtx(dir, 'allowed');
    await expect(safe.writeFile(narrow, path.join(a, 'link'), 'pwn')).rejects.toBeInstanceOf(
      WriteDeniedError,
    );
    expect(await readText(path.join(dir, 'outside.txt'))).toBe('orig');
  });

  it('copyFile 的来源不能在仓库与写入根之外', async () => {
    const { dir } = await makeTempDir('safefs-copysrc-');
    const wide = wideCtx(dir);
    await safe.mkdirp(wide, path.join(dir, 'allowed'));
    await safe.mkdirp(wide, path.join(dir, 'secret'));
    await safe.writeFile(wide, path.join(dir, 'secret', 'key'), 'top-secret');
    // 让 repoRoot 也收到 dir/allowed:这样 dir/secret 既不在仓库内也不在写入根内,
    // 与临时目录恰好落在 <repo>/.state/test-tmp 下无关
    const narrow = createIoContext({
      cwd: REPO_ROOT,
      root: path.join(dir, 'allowed'),
      env: { KIT_TMP: dir, KIT_WRITE_ROOTS: path.join(dir, 'allowed'), PATH: '/usr/bin:/bin' },
    });
    const dest = path.join(dir, 'allowed', 'stolen');
    await expect(
      safe.copyFile(narrow, path.join(dir, 'secret', 'key'), dest),
    ).rejects.toBeInstanceOf(WriteDeniedError);
    expect(await exists(dest)).toBe(false);
  });

  it('悬空 symlink 被拒', async () => {
    const { dir } = await makeTempDir('safefs-dangling-');
    const wide = wideCtx(dir);
    const a = path.join(dir, 'allowed');
    await safe.mkdirp(wide, a);
    await safe.symlink(wide, path.join(a, 'nowhere'), path.join(a, 'dangling'));
    await expect(safe.writeFile(wide, path.join(a, 'dangling'), 'x')).rejects.toBeInstanceOf(
      WriteDeniedError,
    );
  });
});
