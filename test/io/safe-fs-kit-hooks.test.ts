/**
 * A5 验收评审采纳(§20.15-11 第 3 条):kit-hooks 三个目标与 `hooks/` 私有状态子树归 `hooks-fs.ts` 独占,
 * 普通写出口 safe-fs 即使写入根恰好覆盖它们(KIT_TMP / KIT_STATE_DIR 指进 HOME 下)也必须拒绝。
 * 用临时目录当假 HOME(KIT_REAL_HOME_OVERRIDE),不碰真实 HOME。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exists } from '../../src/io/read-fs.js';
import { createIoContext } from '../../src/io/paths.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, REPO_ROOT, wideCtx } from '../helpers/tmp.js';

// 断言具体拒绝原因:别的闸(如 KIT_TMP 是 HOME 上级)先拦下会让这些用例空跑
const KIT_HOOKS_DENY = /kit 钩子保留路径/;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup(rootRel: string) {
  const { dir } = await makeTempDir('safefs-kithooks-');
  const home = path.join(dir, 'home');
  await safe.mkdirp(wideCtx(dir), path.join(home, '.local/state/agent-kit/hooks/txn'));
  await safe.mkdirp(wideCtx(dir), path.join(home, '.claude'));
  vi.stubEnv('KIT_REAL_HOME_OVERRIDE', home);
  const root = path.join(home, rootRel);
  const ctx = createIoContext({
    cwd: REPO_ROOT,
    // 攻击形状:KIT_TMP 本身就落在 HOME 之内(HOME 的子目录被允许当 KIT_TMP)
    env: { KIT_TMP: root, KIT_WRITE_ROOTS: root, PATH: '/usr/bin:/bin' },
  });
  return { home, ctx };
}

describe('safe-fs:kit 钩子保留路径一律拒绝', () => {
  it('写入根覆盖 hooks/ 私有子树时,写 / 建独占文件 / 建目录都被拒且无产物', async () => {
    const { home, ctx } = await setup('.local/state/agent-kit');
    const ledger = path.join(home, '.local/state/agent-kit/hooks/ledger.json');
    await expect(safe.writeFile(ctx, ledger, '{}')).rejects.toThrow(KIT_HOOKS_DENY);
    const stop = path.join(home, '.local/state/agent-kit/hooks/rsi/STOP');
    await expect(safe.mkdirp(ctx, path.dirname(stop))).rejects.toThrow(KIT_HOOKS_DENY);
    await expect(safe.createExclusive(ctx, stop, '', 0o600)).rejects.toThrow(KIT_HOOKS_DENY);
    expect(await exists(ledger)).toBe(false);
    expect(await exists(path.dirname(stop))).toBe(false);
  });

  it('大小写别名 HOOKS/ 同样被拒', async () => {
    const { home, ctx } = await setup('.local/state/agent-kit');
    const alias = path.join(home, '.local/state/agent-kit/HOOKS/ledger.json');
    await expect(safe.writeFile(ctx, alias, '{}')).rejects.toThrow(KIT_HOOKS_DENY);
  });

  it('递归删除 / rename 保留子树的祖先被拒,子树仍在', async () => {
    const { home, ctx } = await setup('.local');
    const kitDir = path.join(home, '.local/state/agent-kit');
    await expect(safe.remove(ctx, kitDir)).rejects.toThrow(KIT_HOOKS_DENY);
    await expect(
      safe.rename(ctx, path.join(home, '.local/state'), path.join(home, '.local/moved')),
    ).rejects.toThrow(KIT_HOOKS_DENY);
    expect(await exists(path.join(kitDir, 'hooks/txn'))).toBe(true);
  });

  it('kit-hooks 目标文件(~/.claude/settings.json)被拒', async () => {
    const { home, ctx } = await setup('.claude');
    const target = path.join(home, '.claude/settings.json');
    await expect(safe.writeFile(ctx, target, '{}')).rejects.toThrow(KIT_HOOKS_DENY);
    expect(await exists(target)).toBe(false);
  });

  it('正向对照:同一写入根下的非保留路径照常可写', async () => {
    const { home, ctx } = await setup('.local/state/agent-kit');
    const ok = path.join(home, '.local/state/agent-kit/other.txt');
    await safe.writeFile(ctx, ok, 'x');
    expect(await exists(ok)).toBe(true);
  });
});
