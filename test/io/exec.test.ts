import { describe, expect, it } from 'vitest';
import { ExecDeniedError, runSync } from '../../src/io/exec.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';

// 用 git 自己的 shell alias 打印子进程环境(git 起的 sh,不是我们起的)
const PRINT_ENV = ['-c', 'alias.printenv=!env', 'printenv'] as const;

describe('exec:白名单与环境', () => {
  it('git 可执行,且子进程默认不继承 HOME,只有 PATH', async () => {
    const { dir } = await makeTempDir('exec-env-');
    const ctx = wideCtx(dir);
    const r = runSync(ctx, 'git', PRINT_ENV);
    expect(r.spawnError).toBeUndefined();
    expect(r.status).toBe(0);
    const keys = r.stdout
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => l.split('=')[0]);
    expect(keys).toContain('PATH');
    expect(keys).not.toContain('HOME');
    expect(keys).not.toContain('XDG_CONFIG_HOME');
  });

  it('显式传入的 HOME(在 KIT_TMP 内)与 GIT_* 可以到达子进程', async () => {
    const { dir } = await makeTempDir('exec-home-');
    const ctx = wideCtx(dir);
    const r = runSync(ctx, 'git', PRINT_ENV, {
      env: { HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(r.stdout).toContain(`HOME=${dir}`);
    expect(r.stdout).toContain('GIT_CONFIG_NOSYSTEM=1');
  });

  it('白名单外的二进制、白名单外的环境变量、指向 KIT_TMP 之外的 HOME 都被拒', async () => {
    const { dir } = await makeTempDir('exec-deny-');
    const ctx = wideCtx(dir);
    expect(() => runSync(ctx, 'node', ['-e', '1'])).toThrow(ExecDeniedError);
    expect(() => runSync(ctx, 'sh', ['-c', 'true'])).toThrow(ExecDeniedError);
    expect(() => runSync(ctx, 'git', ['--version'], { env: { SECRET_TOKEN: 'x' } })).toThrow(
      ExecDeniedError,
    );
    expect(() => runSync(ctx, 'git', ['--version'], { env: { HOME: '/' } })).toThrow(
      ExecDeniedError,
    );
  });
});
