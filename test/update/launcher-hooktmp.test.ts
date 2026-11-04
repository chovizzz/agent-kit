/**
 * D-AU2 / 评审 H2-B:`ensureHookTmp`(launcher.ts)——钩子路径不能自己建受控 TMPDIR,只用 pi 的用户要靠前台命令把它备好。
 * 文件名 `launcher*.test.ts` 命中 eslint 的启动器测试授权块。真实产物端到端(前台 `--version` 之后 poke 恰好调度一次)见 `test/rsi/hook-forward-dist.test.ts`。
 *  - gate 开(`KIT_AUTO_UPDATE` 未关、非 CI、非 `KIT_LAUNCHED`)且 tmp 不存在 → 创建,0700,属主是自己,`checkControlledTmp` 随即认可;
 *  - 已存在且合格 → 零写入(目录树前后一致);
 *  - 关闭 / CI / 已被启动 → 不创建(HOME 保持为空);
 *  - 不要求 TTY(`rsi hooks --install` 等一次性前台命令也应备好)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lstat } from '../../src/io/read-fs.js';
import { mkdirp, symlink } from '../../src/io/safe-fs.js';
import { ensureHookTmp } from '../../src/update/launcher.js';
import { checkControlledTmp } from '../../src/update/installed.js';
import { treeOf } from '../rsi/rsi-fixture.js';
import { newWorld, type World } from './install-world.js';
import { STATE_DIR } from './launcher-world.js';

const envOf = (w: World, extra: Record<string, string> = {}): Record<string, string> => ({
  KIT_TMP: w.dir,
  PATH: '/usr/bin:/bin',
  ...extra,
});
const tmpAbs = (w: World): string => path.join(w.home, ...STATE_DIR.split('/'), 'tmp');

describe('ensureHookTmp', () => {
  it('gate 开、tmp 不存在 → 创建 0700 的受控 tmp,只读检查随即认可', async () => {
    const w = await newWorld();
    expect(await checkControlledTmp(w.home)).toBeUndefined();
    expect(await ensureHookTmp({ home: w.home, env: envOf(w) })).toBe(true);
    const st = await lstat(tmpAbs(w));
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect(await checkControlledTmp(w.home)).toBe(tmpAbs(w));
  });

  it('已存在且合格 → 再调一次零写入(目录树前后一致)', async () => {
    const w = await newWorld();
    await ensureHookTmp({ home: w.home, env: envOf(w) });
    const before = await treeOf(w.home);
    expect(await ensureHookTmp({ home: w.home, env: envOf(w) })).toBe(true);
    expect(await treeOf(w.home)).toEqual(before);
  });

  it('KIT_AUTO_UPDATE 关 / CI / KIT_LAUNCHED=1 → 不创建(HOME 保持为空);KIT_LAUNCHED=0 视为未设,照常创建', async () => {
    for (const extra of [
      { KIT_AUTO_UPDATE: '0' },
      { KIT_AUTO_UPDATE: 'false' },
      { CI: 'true' },
      { GITHUB_ACTIONS: 'true' },
      { KIT_LAUNCHED: '1' },
    ]) {
      const w = await newWorld();
      expect(
        await ensureHookTmp({ home: w.home, env: envOf(w, extra) }),
        JSON.stringify(extra),
      ).toBe(false);
      expect(await treeOf(w.home), JSON.stringify(extra)).toEqual([]);
    }
    const w = await newWorld();
    expect(await ensureHookTmp({ home: w.home, env: envOf(w, { KIT_LAUNCHED: '0' }) })).toBe(true);
  });

  it('状态目录链上有符号链接 → 不创建、返回 false(与 ensureControlledTmp 同判)', async () => {
    const w = await newWorld();
    const outside = path.join(w.dir, 'elsewhere');
    await mkdirp(w.fx, outside);
    await mkdirp(w.fx, path.join(w.home, '.local', 'state', 'agent-kit'));
    await symlink(w.fx, outside, path.join(w.home, STATE_DIR));
    expect(await ensureHookTmp({ home: w.home, env: envOf(w) })).toBe(false);
    expect(await treeOf(outside)).toEqual([]);
  });
});
