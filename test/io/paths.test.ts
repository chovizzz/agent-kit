import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIoContext, getRealHome, PathsError } from '../../src/io/paths.js';
import { REPO_ROOT } from '../helpers/tmp.js';

const REPO = REPO_ROOT;
const mk = (env: Record<string, string>, opts: { root?: string; cwd?: string } = {}) =>
  createIoContext({ cwd: opts.cwd ?? REPO, ...(opts.root ? { root: opts.root } : {}), env });

describe('paths:默认值', () => {
  it('从子目录向上找 kit.toml 定位仓库根', () => {
    const ctx = mk({}, { cwd: path.join(REPO, 'src', 'io') });
    expect(ctx.repoRoot).toBe(REPO);
  });

  it('默认写入根 = out/、.state/(以及设了才有的 KIT_TMP)', () => {
    expect(mk({}).writeRoots).toEqual([path.join(REPO, 'out'), path.join(REPO, '.state')]);
    const tmp = path.join(REPO, '.state', 'x');
    expect(mk({ KIT_TMP: tmp }).writeRoots).toEqual([
      path.join(REPO, 'out'),
      path.join(REPO, '.state'),
      tmp,
    ]);
  });

  it('--root 覆盖:相对路径按 cwd 解析', () => {
    expect(mk({}, { root: 'src' }).repoRoot).toBe(path.join(REPO, 'src'));
  });

  it('KIT_REAL_HOME_OVERRIDE 让检测器自检不碰真 HOME', () => {
    expect(getRealHome({ KIT_REAL_HOME_OVERRIDE: '/tmp/fake-home' })).toBe('/tmp/fake-home');
  });
});

describe('paths:KIT_WRITE_ROOTS 只能收窄', () => {
  const inState = path.join(REPO, '.state', 'narrow');
  it('收窄到默认根之内:接受', () => {
    expect(mk({ KIT_WRITE_ROOTS: inState }).writeRoots).toEqual([inState]);
    const two = [path.join(REPO, 'out', 'a'), inState].join(path.delimiter);
    expect(mk({ KIT_WRITE_ROOTS: two }).writeRoots).toHaveLength(2);
  });

  it('越界、HOME、HOME 的上级、文件系统根、相对路径:全部抛错', () => {
    const home = getRealHome();
    for (const bad of [
      home,
      path.dirname(home),
      '/',
      path.join(home, 'elsewhere'),
      path.join(REPO, 'src'),
      'relative/path',
    ]) {
      expect(() => mk({ KIT_WRITE_ROOTS: bad }), bad).toThrow(PathsError);
    }
  });

  it('KIT_TMP 不得是 HOME 或其上级;KIT_STATE_DIR 必须在仓库或 KIT_TMP 内', () => {
    const home = getRealHome();
    expect(() => mk({ KIT_TMP: home })).toThrow(PathsError);
    expect(() => mk({ KIT_TMP: path.dirname(home) })).toThrow(PathsError);
    expect(() => mk({ KIT_STATE_DIR: path.join(home, '.local', 'state', 'x') })).toThrow(
      PathsError,
    );
    expect(mk({ KIT_STATE_DIR: 'custom-state' }).stateDir).toBe(path.join(REPO, 'custom-state'));
  });
});
