/**
 * R20-A0:safe-fs `createExclusive`(contracts §20.9 第 4 条;锁与去重 / 预留标记的基础)。
 * 判据:O_EXCL(已存在不覆盖)、O_NOFOLLOW(符号链接不跟随)、writeRoots 守卫、显式 mode、写失败不留半个文件。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, lstat, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { WriteDeniedError } from '../../src/io/safe-fs.js';
import { makeTempDir, narrowCtx, wideCtx } from '../helpers/tmp.js';

describe('R20-A0 §20.9#4 createExclusive', () => {
  it('不存在 → 创建并写入,权限恰为给定 mode(不受 umask 放宽)', async () => {
    const { dir } = await makeTempDir('excl-ok-');
    const ctx = narrowCtx(dir, 'a');
    const a = path.join(dir, 'a');
    await safe.mkdirp(ctx, a);
    await safe.createExclusive(ctx, path.join(a, 'lock'), 'pid=1\n', 0o600);
    expect(await readText(path.join(a, 'lock'))).toBe('pid=1\n');
    expect((await lstat(path.join(a, 'lock'))).mode & 0o777).toBe(0o600);
    await safe.createExclusive(ctx, path.join(a, 'bytes'), new Uint8Array([1, 2, 3]), 0o640);
    expect((await lstat(path.join(a, 'bytes'))).mode & 0o777).toBe(0o640);
  });

  it('已存在 → EEXIST,且原内容、原权限不变(不是覆盖写)', async () => {
    const { dir } = await makeTempDir('excl-exist-');
    const ctx = narrowCtx(dir, 'a');
    const a = path.join(dir, 'a');
    await safe.mkdirp(ctx, a);
    const f = path.join(a, 'lock');
    await safe.createExclusive(ctx, f, 'first', 0o600);
    await expect(safe.createExclusive(ctx, f, 'second', 0o644)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readText(f)).toBe('first');
    expect((await lstat(f)).mode & 0o777).toBe(0o600);
    // 同样不覆盖已存在的空文件
    const g = path.join(a, 'empty');
    await safe.writeFile(ctx, g, '', { mode: 0o600 });
    await expect(safe.createExclusive(ctx, g, 'x', 0o600)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readText(g)).toBe('');
  });

  it('目标是指向根内已有文件的符号链接 → 失败且不写穿链接(O_NOFOLLOW)', async () => {
    const { dir } = await makeTempDir('excl-link-');
    const wide = wideCtx(dir);
    const a = path.join(dir, 'a');
    await safe.mkdirp(wide, a);
    await safe.writeFile(wide, path.join(a, 'real'), 'keep', { mode: 0o600 });
    await safe.symlink(wide, path.join(a, 'real'), path.join(a, 'link'));
    await expect(
      safe.createExclusive(narrowCtx(dir, 'a'), path.join(a, 'link'), 'evil', 0o600),
    ).rejects.toBeDefined();
    expect(await readText(path.join(a, 'real'))).toBe('keep');
    expect((await lstat(path.join(a, 'link'))).isSymbolicLink()).toBe(true);
  });

  it('悬空符号链接 → 被拒,不在链接指向处造出文件', async () => {
    const { dir } = await makeTempDir('excl-dangling-');
    const wide = wideCtx(dir);
    const a = path.join(dir, 'a');
    await safe.mkdirp(wide, a);
    await safe.symlink(wide, path.join(a, 'ghost'), path.join(a, 'link'));
    await expect(
      safe.createExclusive(narrowCtx(dir, 'a'), path.join(a, 'link'), 'x', 0o600),
    ).rejects.toBeInstanceOf(WriteDeniedError);
    expect(await exists(path.join(a, 'ghost'))).toBe(false);
  });

  it('根外 / .. 逃逸 / 写根本身 → WriteDeniedError,文件没有产生', async () => {
    const { dir } = await makeTempDir('excl-deny-');
    const ctx = narrowCtx(dir, 'a');
    const a = path.join(dir, 'a');
    await safe.mkdirp(wideCtx(dir), a);
    for (const target of [
      path.join(dir, 'outside'),
      path.join(a, '..', 'outside'),
      a,
    ]) {
      await expect(safe.createExclusive(ctx, target, 'x', 0o600), target).rejects.toBeInstanceOf(
        WriteDeniedError,
      );
    }
    expect(await exists(path.join(dir, 'outside'))).toBe(false);
  });

  it('父目录不存在 → ENOENT(不隐式建目录)', async () => {
    const { dir } = await makeTempDir('excl-noparent-');
    const ctx = narrowCtx(dir, 'a');
    await expect(
      safe.createExclusive(ctx, path.join(dir, 'a', 'nope', 'lock'), 'x', 0o600),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await exists(path.join(dir, 'a', 'nope'))).toBe(false);
  });

  it('并发 8 路争同一个名字:恰好一个成功,其余 EEXIST,内容是赢家的', async () => {
    const { dir } = await makeTempDir('excl-race-');
    const ctx = narrowCtx(dir, 'a');
    const a = path.join(dir, 'a');
    await safe.mkdirp(ctx, a);
    const f = path.join(a, 'lock');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => safe.createExclusive(ctx, f, `owner-${i}`, 0o600)),
    );
    const ok = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as { code?: string }).code).toBe('EEXIST');
    }
    expect(await readText(f)).toBe(`owner-${ok[0]}`);
  });
});
