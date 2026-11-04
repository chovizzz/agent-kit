/**
 * D-AU2(contracts §20.19)迁移缺口:存量纯 pi 用户 `npm i -g` 升级后从没跑过前台命令 → 没有 update/tmp → poke 永远静默不调度。
 * doctor D01 增加事实 `hook_update_tmp`(ok | missing | not_applicable);配置了 `[rsi]`、自动更新未关、受控 tmp 缺失 → warn
 * `hook_update_tmp_missing` 并给一行提示。注意:doctor 本身经启动器,跑完后 `ensureHookTmp` 会把 tmp 建好,
 * 所以同一次运行里 D01 先报 missing、再跑一次就 ok(单测里直接调命令层,不经启动器,故不受影响)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as safe from '../../src/io/safe-fs.js';
import { checkD01 } from '../../src/doctor/checks.js';
import { checkOf, newWorld, type World } from './world.js';

const RSI_CFG = '[rsi]\nenabled = true\n';

async function cfg(w: World, text: string): Promise<void> {
  const dir = path.join(w.home, '.config', 'agent-kit');
  await safe.mkdirp(w.io, dir);
  await safe.writeFile(w.io, path.join(dir, 'config.toml'), text, { mode: 0o600 });
}
async function tmp(w: World, mode = 0o700): Promise<void> {
  const abs = path.join(w.home, '.local', 'state', 'agent-kit', 'update', 'tmp');
  await safe.mkdirp(w.io, abs, mode);
  await safe.chmod(w.io, abs, mode);
}
const d01 = async (w: World, env: Record<string, string> = {}) =>
  (await checkOf(w, 'D01', { deps: { nodeVersion: '22.4.0' }, env })).check;

describe('D01 hook_update_tmp', () => {
  it('正:[rsi] 已配置、自动更新未关、tmp 缺失 → warn hook_update_tmp_missing,事实 missing,给一行提示', async () => {
    const w = await newWorld('d01-hook-missing-');
    await cfg(w, RSI_CFG);
    const c = await d01(w);
    expect(c).toMatchObject({ status: 'warn', result: 'hook_update_tmp_missing' });
    expect(c.facts['hook_update_tmp']).toBe('missing');
    expect(JSON.stringify(c)).toContain('agent-kit --version');
  });

  it('tmp 已备好 → ok,事实 ok', async () => {
    const w = await newWorld('d01-hook-ok-');
    await cfg(w, RSI_CFG);
    await tmp(w);
    const c = await d01(w);
    expect(c).toMatchObject({ status: 'ok', result: 'ok' });
    expect(c.facts['hook_update_tmp']).toBe('ok');
  });

  it('负:tmp 权限过宽也算 missing(钩子同样不调度)', async () => {
    const w = await newWorld('d01-hook-loose-');
    await cfg(w, RSI_CFG);
    await tmp(w, 0o755);
    expect(await d01(w)).toMatchObject({ status: 'warn', result: 'hook_update_tmp_missing' });
  });

  it('负:没有 [rsi] 配置 / 没有配置文件 → 不报(钩子不会调度,tmp 用不上)', async () => {
    const none = await newWorld('d01-hook-nocfg-');
    const a = await d01(none);
    expect(a).toMatchObject({ status: 'ok' });
    expect(a.facts['hook_update_tmp']).toBe('not_applicable');
    const upd = await newWorld('d01-hook-upd-');
    await cfg(upd, '[update]\nauto_install = true\n');
    expect(await d01(upd)).toMatchObject({ status: 'ok' });
  });

  it('负:自动更新被关(KIT_AUTO_UPDATE=0 / CI / auto_install=false)→ 不报', async () => {
    for (const env of [{ KIT_AUTO_UPDATE: '0' }, { CI: 'true' }]) {
      const w = await newWorld('d01-hook-off-');
      await cfg(w, RSI_CFG);
      expect(await d01(w, env), JSON.stringify(env)).toMatchObject({ status: 'ok' });
    }
    const w = await newWorld('d01-hook-cfgoff-');
    await cfg(w, `[update]\nauto_install = false\n${RSI_CFG}`);
    expect(await d01(w)).toMatchObject({ status: 'ok' });
  });

  it('纯函数:缺省(不给 hookUpdateTmp)按 not_applicable;launcher_broken 优先于 hook 提示', () => {
    const base = {
      nodeVersion: '22.4.0',
      bootstrapVersion: '0.3.1',
      currentLink: 'absent' as const,
      installedVersion: undefined,
      launched: false,
    };
    expect(checkD01(base).status).toBe('ok');
    expect(checkD01({ ...base, hookUpdateTmp: 'missing' })).toMatchObject({
      status: 'warn',
      result: 'hook_update_tmp_missing',
    });
    expect(checkD01({ ...base, currentLink: 'other', hookUpdateTmp: 'missing' }).result).toBe(
      'launcher_broken',
    );
  });
});
