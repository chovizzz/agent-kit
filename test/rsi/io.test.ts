/**
 * R20-A2 B2:rsi 专用 IoContext(docs/contracts.md §20.2 R20-2.3 / R20-2.5、§20.9 第 17、18 条)。
 * 选择发生在通用路径校验之前;经 deriveIoContext 保留 writeAudit;旧上下文的路径字段不泄漏。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIoContext, PathsError } from '../../src/io/paths.js';
import { exists, readDir } from '../../src/io/read-fs.js';
import { mkdirp, symlink, WriteDeniedError, writeFile } from '../../src/io/safe-fs.js';
import { RsiRootMismatchError, createRsiIoContext, rsiEnvOf } from '../../src/rsi/io.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { makeRsiFx } from './rsi-fixture.js';

const PATH = '/usr/bin:/bin';

describe('rsiEnvOf:剔除 KIT_STATE_DIR / KIT_WRITE_ROOTS(KIT_TMP 已设 = 测试夹具,保留)', () => {
  it('没有 KIT_TMP 时两个变量都被剔除;有 KIT_TMP 时保留;不修改调用者的对象', () => {
    const env = { KIT_STATE_DIR: '/x', KIT_WRITE_ROOTS: '/y', PATH, FOO: 'bar' };
    const out = rsiEnvOf(env);
    expect(out).toEqual({ PATH, FOO: 'bar' });
    expect(env).toEqual({ KIT_STATE_DIR: '/x', KIT_WRITE_ROOTS: '/y', PATH, FOO: 'bar' });
    expect(rsiEnvOf({ ...env, KIT_TMP: '/t' })).toEqual({ ...env, KIT_TMP: '/t' });
    expect(rsiEnvOf({ ...env, KIT_TMP: '' }).KIT_STATE_DIR).toBeUndefined();
  });
});

describe('createRsiIoContext:状态目录恒为 <repo>/.state', () => {
  it('无效的 KIT_STATE_DIR(越出仓库)让通用构造抛 PathsError,rsi 构造不受影响;旧位置没有任何写入', async () => {
    const f = await makeRsiFx('rio-invalid-');
    const env = { KIT_STATE_DIR: '/definitely/outside/the/repo', PATH };
    expect(() => createIoContext({ root: f.repo, env })).toThrow(PathsError); // 对照:通用路径校验会抛
    const before = await readDir(f.repo);
    const io = createRsiIoContext({ repo: f.repo, env });
    expect(io.repoRoot).toBe(f.repo);
    expect(io.stateDir).toBe(path.join(f.repo, '.state'));
    expect(io.outDir).toBe(path.join(f.repo, 'out'));
    expect(await readDir(f.repo)).toEqual(before); // 构造本身不建目录
    expect(await exists('/definitely/outside')).toBe(false);
  });

  it('KIT_WRITE_ROOTS 同样被忽略(没有 KIT_TMP):写入根是 rsi 仓库的 out/ 与 .state', async () => {
    const f = await makeRsiFx('rio-roots-');
    const io = createRsiIoContext({
      repo: f.repo,
      env: { KIT_WRITE_ROOTS: '/etc', PATH },
    });
    expect([...io.writeRoots].sort()).toEqual(
      [path.join(f.repo, '.state'), path.join(f.repo, 'out')].sort(),
    );
  });

  it('KIT_TMP 已设(测试夹具)时保留 KIT_STATE_DIR(在 KIT_TMP 内)', async () => {
    const f = await makeRsiFx('rio-tmp-');
    const state = path.join(f.dir, 'fixture-state');
    const io = createRsiIoContext({
      repo: f.repo,
      env: { KIT_TMP: f.dir, KIT_STATE_DIR: state, PATH },
    });
    expect(io.stateDir).toBe(state);
    expect(io.tmpDir).toBe(f.dir);
  });

  it('不注入 env 时取真实进程环境里的相关键(不是整份 env);仓库根仍取 [rsi] repo', async () => {
    const f = await makeRsiFx('rio-realenv-');
    const io = createRsiIoContext({ repo: f.repo });
    expect(io.repoRoot).toBe(f.repo);
    expect(io.stateDir === path.join(f.repo, '.state') || io.tmpDir !== undefined).toBe(true);
  });
});

describe('--root 与 [rsi] repo(R20-2.3):realpath 不同 → root_mismatch', () => {
  it('相同(含相对路径、经符号链接的写法)通过;不同或不存在 → RsiRootMismatchError(RSI_USAGE root_mismatch,退出 2)', async () => {
    const f = await makeRsiFx('rio-root-');
    const env = { PATH };
    expect(() => createRsiIoContext({ repo: f.repo, env, explicitRoot: f.repo })).not.toThrow();
    await symlink(f.fx, f.repo, path.join(f.dir, 'alias'));
    expect(() =>
      createRsiIoContext({ repo: f.repo, env, explicitRoot: path.join(f.dir, 'alias') }),
    ).not.toThrow();
    expect(() =>
      createRsiIoContext({ repo: f.repo, env, explicitRoot: 'repo', cwd: f.dir }),
    ).not.toThrow();
    for (const root of [f.dir, path.join(f.dir, 'nope'), path.join(f.repo, '..', 'other')]) {
      let err: unknown;
      try {
        createRsiIoContext({ repo: f.repo, env, explicitRoot: root });
      } catch (e) {
        err = e;
      }
      expect(err, root).toBeInstanceOf(RsiRootMismatchError);
      expect(err).toMatchObject({ code: 'RSI_USAGE', reason: 'root_mismatch', exit: 2 });
    }
  });
});

describe('经 deriveIoContext 保留 writeAudit(变异:手写 { ...base } 丢钩子 → 红)', () => {
  it('给 base 时派生:写入经派生上下文仍被审计;所有仓库相关字段取新值,旧状态目录 / 写入根不泄漏', async () => {
    const f = await makeRsiFx('rio-derive-');
    const other = await makeRsiFx('rio-derive-old-');
    const a = withWriteAudit();
    const base = createIoContext({
      root: other.repo,
      cwd: REPO_ROOT,
      env: { KIT_TMP: other.dir, PATH },
      writeAudit: a.hook,
    });
    const io = createRsiIoContext({
      repo: f.repo,
      env: { KIT_TMP: f.dir, PATH },
      base,
    });
    expect(Object.hasOwn(io, 'writeAudit')).toBe(true);
    expect(io.repoRoot).toBe(f.repo);
    expect(io.stateDir).toBe(path.join(f.repo, '.state'));
    expect(io.tmpDir).toBe(f.dir);
    expect(io.writeRoots).not.toContain(base.stateDir);
    expect(io.writeRoots.every((r) => !r.startsWith(other.dir))).toBe(true);
    a.reset();
    await mkdirp(io, path.join(io.stateDir, 'rsi'), 0o700);
    expect(a.calls.map((c) => [c.op, c.path])).toEqual([
      ['mkdirp', path.join(f.repo, '.state', 'rsi')],
    ]);
    // 旧上下文的状态目录写入被拒(不在新写入根内),且仍被审计
    a.reset();
    await expect(writeFile(io, path.join(base.stateDir, 'x'), 'x')).rejects.toBeInstanceOf(
      WriteDeniedError,
    );
    expect(a.calls).toHaveLength(1);
    expect(await exists(path.join(base.stateDir, 'x'))).toBe(false);
  });

  it('没有 base 时用 writeAudit 选项;都不给时上下文上没有 writeAudit 键', async () => {
    const f = await makeRsiFx('rio-noaudit-');
    const a = withWriteAudit();
    const audited = createRsiIoContext({ repo: f.repo, env: { PATH }, writeAudit: a.hook });
    expect(Object.hasOwn(audited, 'writeAudit')).toBe(true);
    await mkdirp(audited, path.join(audited.stateDir, 'rsi'), 0o700);
    expect(a.calls).toHaveLength(1);
    const plain = createRsiIoContext({ repo: f.repo, env: { PATH } });
    expect(Object.hasOwn(plain, 'writeAudit')).toBe(false);
    // base 没有钩子:派生结果同样没有
    const bare = createIoContext({ root: f.repo, cwd: REPO_ROOT, env: { KIT_TMP: f.dir, PATH } });
    expect(
      Object.hasOwn(
        createRsiIoContext({ repo: f.repo, env: { KIT_TMP: f.dir, PATH }, base: bare }),
        'writeAudit',
      ),
    ).toBe(false);
  });
});
