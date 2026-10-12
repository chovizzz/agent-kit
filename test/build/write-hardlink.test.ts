import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { fullFiles, makeSandbox, resetBuildDeps, runBuild, writeRepo } from './helpers.js';

afterEach(() => {
  resetBuildDeps();
});

const REG = 'claude/home/.claude/rules/agent-kit/org.md';

/** 清理项 3:out/ 内登记文件被换成指向外部 inode 的硬链接 → build 退出 3,外部文件内容不变。 */
describe('硬链接目标(nlink>1)', () => {
  async function plant(brokenManifest: boolean) {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const victim = path.join(sb.dir, 'victim.txt');
    await safe.writeFile(sb.wctx, victim, 'VICTIM\n');
    const leaf = path.join(root, 'out', ...REG.split('/'));
    await safe.remove(sb.wctx, leaf);
    await safe.hardlink(sb.wctx, victim, leaf);
    if (brokenManifest) {
      // manifest 不可信 ⇒ 清理被跳过,写入阶段必须自己拦
      await safe.writeFile(sb.wctx, path.join(root, 'out/manifest.json'), '{bad');
    }
    return { sb, root, victim };
  }

  it('清理阶段（manifest 可信）遇到硬链接:退出 3,错误信息含「硬链接」,外部文件不变', async () => {
    const { sb, root, victim } = await plant(false);
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('硬链接');
    expect(await readText(victim)).toBe('VICTIM\n');
  });

  it('写入阶段（manifest 不可信、清理被跳过）遇到硬链接:退出 3,错误信息含「硬链接」,外部文件不变', async () => {
    const { sb, root, victim } = await plant(true);
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('硬链接');
    expect(await readText(victim)).toBe('VICTIM\n');
  });
});

describe('safe-fs 硬链接错误信息', () => {
  it('writeFile / remove / appendFile 都拒绝,信息含 nlink 值与「硬链接」,不改外部文件', async () => {
    const { makeTempDir, narrowCtx, wideCtx } = await import('../helpers/tmp.js');
    const { dir } = await makeTempDir('hl-msg-');
    const wide = wideCtx(dir);
    const inside = path.join(dir, 'allowed');
    await safe.mkdirp(wide, inside);
    await safe.writeFile(wide, path.join(dir, 'outside.txt'), 'orig');
    await safe.hardlink(wide, path.join(dir, 'outside.txt'), path.join(inside, 'h.txt'));
    const narrow = narrowCtx(dir, 'allowed');
    const target = path.join(inside, 'h.txt');
    for (const op of [
      () => safe.writeFile(narrow, target, 'pwn'),
      () => safe.appendFile(narrow, target, 'pwn'),
      () => safe.remove(narrow, target),
    ]) {
      await expect(op()).rejects.toThrow(/硬链接\(nlink=2\)/);
    }
    expect(await readText(path.join(dir, 'outside.txt'))).toBe('orig');
    // 正向对照:普通文件(nlink=1)可写
    await safe.writeFile(narrow, path.join(inside, 'plain.txt'), 'ok');
    expect(await readText(path.join(inside, 'plain.txt'))).toBe('ok');
  });
});
