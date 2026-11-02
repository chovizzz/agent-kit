/**
 * R20-A3:钩子入口(R20-1.2a / R20-1.9 / R20-3.9.1;A3 订正:根入口识别并加载零网络 `hook-entry`,`src/cli.ts` 对 `__rsi` 动态转交)。
 * 进程内:形状与退出码;任何形状都不输出。真实 `dist/cli.js` 子进程四组合见 `a3-dist.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { readText } from '../../src/io/read-fs.js';
import { hookShapeOf, runHookEntry } from '../../src/rsi/hook-entry.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import * as path from 'node:path';
import { makeTickFx } from './b5a-fixture.js';
import { treeOf } from './rsi-fixture.js';

const OFF_ENV = { KIT_AUTO_RSI: '0', PATH: '/usr/bin:/bin' };

describe('runHookEntry:退出码与零输出', () => {
  it('__rsi 只接受精确的 --background;其它(含全局选项、help、多余参数)退 2', async () => {
    expect(await runHookEntry(['__rsi', '--background'], { env: OFF_ENV })).toBe(0);
    for (const argv of [
      ['__rsi'],
      ['__rsi', '--background', '--x'],
      ['__rsi', '--help'],
      ['--root', '/tmp', '__rsi', '--background'],
      ['--help', '__rsi', '--background'],
      ['__rsi', '--background=1'],
    ]) {
      expect(await runHookEntry(argv, { env: OFF_ENV }), argv.join(' ')).toBe(2);
    }
  });
  it('poke / hint:任何参数(含全局选项、--help、--version)都退 0', async () => {
    for (const argv of [
      ['rsi', 'poke'],
      ['rsi', 'poke', '--agent', 'claude', '--help'],
      ['--version', 'rsi', 'hint', '--agent', 'claude'],
      ['--root', '/x', 'rsi', 'poke', '--agent', 'claude'],
      ['rsi', 'hint', '--', '--agent', 'claude'],
    ]) {
      expect(await runHookEntry(argv, { env: OFF_ENV }), argv.join(' ')).toBe(0);
    }
  });
  it('带全局选项的钩子调用:即使配置可用也不做任何事(不把 --root / --overlay 交给 rsi)', async () => {
    const f = await makeTickFx('a3-entry-global-');
    const before = await treeOf(f.io.stateDir);
    expect(
      await runHookEntry(['--root', f.repo, 'rsi', 'poke', '--agent', 'claude'], { env: f.env }),
    ).toBe(0);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });
});

describe('src/cli.ts main():__rsi 动态转交到 hook-entry(进程内调用与根入口一致)', () => {
  it('精确形状退 0、无输出;全局选项 / 多余参数退 2、无输出', async () => {
    const run = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
      let out = '';
      let err = '';
      const code = await main(argv, {
        env: OFF_ENV,
        stdout: (t) => (out += t),
        stderr: (t) => (err += t),
      });
      return { code, out, err };
    };
    expect(await run(['__rsi', '--background'])).toEqual({ code: 0, out: '', err: '' });
    expect(await run(['--root', '/tmp', '__rsi', '--background'])).toEqual({
      code: 2,
      out: '',
      err: '',
    });
    expect(await run(['__rsi', 'x'])).toEqual({ code: 2, out: '', err: '' });
  });
});

describe('根入口 cli.ts 的内联判定与 hookShapeOf 同口径(源码对拍)', () => {
  it('cli.ts 在 import 启动器之前判形状,命中则只加载 hook-entry', async () => {
    const src = await readText(path.join(REPO_ROOT, 'cli.ts'));
    const hookAt = src.indexOf("import('./src/rsi/hook-entry.js')");
    const launcherAt = src.indexOf("import('./src/update/launcher.js')");
    expect(hookAt).toBeGreaterThan(0);
    expect(launcherAt).toBeGreaterThan(hookAt);
    expect(src).toContain("argv[i] === '__rsi'");
    expect(src).toContain("argv[i + 1] === 'poke' || argv[i + 1] === 'hint'");
    expect(Buffer.byteLength(src)).toBeLessThanOrEqual(8 * 1024);
  });
  it('hookShapeOf 对同一批输入的判定', () => {
    const yes = [
      ['rsi', 'poke'],
      ['rsi', 'hint', '--agent', 'pi'],
      ['__rsi'],
      ['-x', '--overlay', '/o', 'rsi', 'poke'],
    ];
    const no = [['rsi'], ['rsi', 'tick'], ['--root'], ['poke'], ['--root', 'rsi', 'poke']];
    for (const a of yes) expect(hookShapeOf(a), a.join(' ')).toBeDefined();
    for (const a of no) expect(hookShapeOf(a), a.join(' ')).toBeUndefined();
  });
});
