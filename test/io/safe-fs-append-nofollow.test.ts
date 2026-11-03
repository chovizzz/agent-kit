/**
 * A6 订正 #1 评审 M1:`appendFile(..., { noFollow: true })` 以 `O_NOFOLLOW|O_APPEND` 打开,末级是符号链接 → 抛出、链接目标不变;
 * 普通文件照常追加(含不存在时按 mode 创建);缺省(不传 noFollow)保持原有「跟随」行为,不影响既有调用方。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBytes, lstat } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, narrowCtx, wideCtx } from '../helpers/tmp.js';

const text = async (p: string): Promise<string> => Buffer.from(await readBytes(p)).toString('utf8');

describe('safe-fs appendFile noFollow', () => {
  it('末级是符号链接 → 拒绝(ELOOP),链接目标逐字节不变;正向对照:缺省行为跟随链接写入目标', async () => {
    const { dir } = await makeTempDir('safefs-append-nf-');
    const ctx = wideCtx(dir);
    const target = path.join(dir, 'state.json');
    const link = path.join(dir, 'log.jsonl');
    await safe.writeFile(ctx, target, '{"keep":1}\n', { mode: 0o600 });
    await safe.symlink(ctx, target, link);
    await expect(
      safe.appendFile(ctx, link, 'line\n', { mode: 0o600, noFollow: true }),
    ).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await text(target)).toBe('{"keep":1}\n');
    // 对照:不带 noFollow 时同一个链接会被跟随(说明上面的拒绝来自 noFollow,而不是别的闸)
    await safe.appendFile(ctx, link, 'line\n', { mode: 0o600 });
    expect(await text(target)).toBe('{"keep":1}\nline\n');
  });

  it('普通文件:追加到末尾;不存在时按 mode 创建为 0600', async () => {
    const { dir } = await makeTempDir('safefs-append-nf-ok-');
    const ctx = wideCtx(dir);
    const f = path.join(dir, 'log.jsonl');
    await safe.appendFile(ctx, f, 'a\n', { mode: 0o600, noFollow: true });
    await safe.appendFile(ctx, f, 'b\n', { mode: 0o600, noFollow: true });
    expect(await text(f)).toBe('a\nb\n');
    expect((await lstat(f)).mode & 0o777).toBe(0o600);
  });

  it('写入根之外的目标照样被 assertWritable 拒绝(noFollow 不绕过根闸)', async () => {
    const { dir } = await makeTempDir('safefs-append-nf-root-');
    await safe.mkdirp(wideCtx(dir), path.join(dir, 'inner'));
    const narrow = narrowCtx(dir, 'inner');
    await expect(
      safe.appendFile(narrow, path.join(dir, 'outside.log'), 'x\n', { noFollow: true }),
    ).rejects.toThrow(/写入被拒绝/);
    // 正向对照:同一上下文写根内照常成功
    await safe.appendFile(narrow, path.join(dir, 'inner', 'ok.log'), 'x\n', { noFollow: true });
    expect(await text(path.join(dir, 'inner', 'ok.log'))).toBe('x\n');
  });
});
