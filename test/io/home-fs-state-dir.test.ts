/**
 * S10-a:home-fs 的 tightenKitStateDir 直测(链接 / 非目录 / 他人所有 / 缺失)。
 * 全在 KIT_TMP 内的假 HOME;sync 命令层在链接场景下更早 fail-closed,覆盖不到 home-fs 自身的这层防线。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hfs from '../../src/io/home-fs.js';
import { lstat } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';

const STATE = '.local/state/agent-kit';
const modeOf = async (abs: string): Promise<number> => (await lstat(abs)).mode & 0o777;

async function setup(prefix: string) {
  const { dir } = await makeTempDir(prefix);
  const fx = wideCtx(dir);
  const home = path.join(dir, 'home');
  await safe.mkdirp(fx, home);
  const tmpDir = path.join(dir, 'ht');
  await safe.mkdirp(fx, tmpDir);
  const ctx = hfs.createHomeFsContext({ home, planScope: [], tmpDir });
  return { dir, fx, home, ctx };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tightenKitStateDir', () => {
  it('agent-kit 本身是符号链接 -> skipped_unsafe,链接目标权限不变', async () => {
    const { dir, fx, home, ctx } = await setup('td-link-');
    const target = path.join(dir, 'elsewhere');
    await safe.mkdirp(fx, target, 0o755);
    await safe.chmod(fx, target, 0o755);
    await safe.mkdirp(fx, path.join(home, '.local/state'));
    await safe.symlink(fx, target, path.join(home, STATE));
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'skipped_unsafe' });
    expect(await modeOf(target)).toBe(0o755);
  });

  it('上级 .local/state 是符号链接 -> skipped_unsafe,不改链接目标内的 agent-kit', async () => {
    const { dir, fx, home, ctx } = await setup('td-plink-');
    const inner = path.join(dir, 'realstate/agent-kit');
    await safe.mkdirp(fx, inner, 0o755);
    await safe.chmod(fx, inner, 0o755);
    await safe.mkdirp(fx, path.join(home, '.local'));
    await safe.symlink(fx, path.join(dir, 'realstate'), path.join(home, '.local/state'));
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'skipped_unsafe' });
    expect(await modeOf(inner)).toBe(0o755);
  });

  it('agent-kit 是普通文件 -> skipped_unsafe,文件权限不变', async () => {
    const { fx, home, ctx } = await setup('td-file-');
    await safe.mkdirp(fx, path.join(home, '.local/state'));
    await safe.writeFile(fx, path.join(home, STATE), 'x');
    await safe.chmod(fx, path.join(home, STATE), 0o644);
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'skipped_unsafe' });
    expect(await modeOf(path.join(home, STATE))).toBe(0o644);
  });

  it('他人所有 -> skipped_foreign_owner,权限不变', async () => {
    const { fx, home, ctx } = await setup('td-foreign-');
    const d = path.join(home, STATE);
    await safe.mkdirp(fx, d, 0o755);
    await safe.chmod(fx, d, 0o755);
    const uid = process.getuid?.() ?? 0;
    // 非 root 造不出他人所有的目录:只在此处替换 getuid,用后立即还原
    // eslint-disable-next-line no-restricted-syntax
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    const r = await hfs.tightenKitStateDir(ctx, true);
    vi.restoreAllMocks();
    expect(r).toEqual({ result: 'skipped_foreign_owner' });
    expect(await modeOf(d)).toBe(0o755);
  });

  it('不存在 -> absent;已 0700 -> ok;宽权限 + apply=false -> 只报不改;apply=true 才改', async () => {
    const { fx, home, ctx } = await setup('td-basic-');
    const d = path.join(home, STATE);
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'absent' });
    await safe.mkdirp(fx, d, 0o700);
    await safe.chmod(fx, d, 0o700);
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'ok' });
    await safe.chmod(fx, d, 0o775);
    expect(await hfs.tightenKitStateDir(ctx, false)).toEqual({
      result: 'tightened',
      applied: false,
      from: 0o775,
    });
    expect(await modeOf(d)).toBe(0o775);
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({
      result: 'tightened',
      applied: true,
      from: 0o775,
    });
    expect(await modeOf(d)).toBe(0o700);
  });
});
