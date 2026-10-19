import { describe, expect, it } from 'vitest';
import { COMMANDS, helpText, main } from '../../src/cli.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { newWorld, realHomeSnapshot } from '../update/install-world.js';

describe('内部入口 __update(后台 worker)', () => {
  it('不在命令注册表里、不进 --help', () => {
    expect(COMMANDS.map((c) => c.name)).not.toContain('__update');
    expect(helpText()).not.toContain('__update');
  });

  it('只接受 --background 这一个精确形状:其它形状退出 2 且什么都不写、不碰 HOME', async () => {
    // 注意:不能把 --background 的正常路径放在这里跑——main 会按真实 HOME 解析,worker 会往真实 HOME 写日志。
    // 正常路径(假 HOME)由 test/update/worker.test.ts 覆盖。
    const before = await realHomeSnapshot();
    const w = await newWorld();
    const out: string[] = [];
    const run = (argv: string[]) =>
      main(argv, {
        env: { ...w.env, KIT_AUTO_UPDATE: '0' },
        cwd: REPO_ROOT,
        stdout: (t) => void out.push(t),
        stderr: (t) => void out.push(t),
      });
    expect(await run(['__update'])).toBe(2);
    expect(await run(['__update', '--write'])).toBe(2);
    expect(await run(['__update', '--background', '--now'])).toBe(2);
    expect(out).toEqual([]);
    expect(await realHomeSnapshot()).toEqual(before);
  });

  it('对照:未知的内部风格命令仍是未知命令(退出 2)', async () => {
    const w = await newWorld();
    const out: string[] = [];
    const code = await main(['__other', '--background'], {
      env: w.env,
      cwd: REPO_ROOT,
      stdout: (t) => void out.push(t),
      stderr: (t) => void out.push(t),
    });
    expect(code).toBe(2);
    expect(out.join('')).toContain('未知命令');
  });
});
