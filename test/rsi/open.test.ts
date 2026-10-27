/**
 * R20-A2 B3a:`openRsiIo`(契约 R20-2.5、§20.9 第 17、18 条):off 不建上下文;on 才建;`--root` 不符 → usage;平台不支持 → fail-closed;
 * 创建不建目录、不拿锁、不恢复快照。
 */
import { describe, expect, it } from 'vitest';
import type { IoContext } from '../../src/io/paths.js';
import { openRsiIo, type OpenRsiIoDeps } from '../../src/rsi/services/open.js';
import { RsiFailClosedError, type RsiEarlyContext } from '../../src/rsi/types.js';
import { treeOf } from './rsi-fixture.js';
import { makeRoFx, type RoFx } from './ro-fixture.js';
import { createRsiIoContext } from '../../src/rsi/io.js';
import { chmod, remove, writeFile } from '../../src/io/safe-fs.js';

function early(f: RoFx, over: Partial<RsiEarlyContext> = {}): RsiEarlyContext {
  return {
    argv: [],
    overlayPath: undefined,
    explicitRoot: undefined,
    env: f.env,
    cwd: f.dir,
    stdout: () => {},
    stderr: () => {},
    ...over,
  };
}

/** 记录 createContext 调用次数的探针(转发给真实实现) */
function spy(): { deps: OpenRsiIoDeps; calls: () => number } {
  let n = 0;
  return {
    deps: {
      createContext: (o) => {
        n++;
        return createRsiIoContext(o);
      },
    },
    calls: () => n,
  };
}

describe('openRsiIo', () => {
  it('配置 off(absent / no_section / disabled / cfg_schema / cfg_perm / repo_invalid)→ off,createContext 零调用,零写入', async () => {
    const cases: [string, (f: RoFx) => Promise<void>, string][] = [
      ['absent', (f) => remove(f.fx, f.cfgFile), 'absent'],
      [
        'no_section',
        (f) => writeFile(f.fx, f.cfgFile, '[x]\na = 1\n', { mode: 0o600 }),
        'no_section',
      ],
      [
        'disabled',
        (f) => writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 }),
        'disabled',
      ],
      [
        'cfg_schema',
        (f) =>
          writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = true\nagents = ["kimi"]\n', { mode: 0o600 }),
        'cfg_schema',
      ],
      ['cfg_perm', (f) => chmod(f.fx, f.cfgFile, 0o666), 'cfg_perm'],
      [
        'repo_invalid',
        (f) =>
          writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = true\nrepo = "/nonexistent/x"\n', {
            mode: 0o600,
          }),
        'repo_invalid',
      ],
    ];
    for (const [name, mutate, reason] of cases) {
      const f = await makeRoFx(`open-off-${name}-`);
      await mutate(f);
      const before = await treeOf(f.dir);
      const s = spy();
      const r = await openRsiIo(early(f), s.deps);
      expect(r, name).toEqual({ kind: 'off', reason });
      expect(s.calls(), name).toBe(0);
      expect(await treeOf(f.dir)).toEqual(before);
    }
  });

  it('配置 on → ready:状态目录 = <[rsi] repo>/.state,config 透传;只建对象,不建任何目录、不建 rsi/', async () => {
    const f = await makeRoFx('open-on-');
    const before = await treeOf(f.dir);
    const s = spy();
    const r = await openRsiIo(early(f), s.deps);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(s.calls()).toBe(1);
    expect(r.ctx.io.stateDir).toBe(`${f.repo}/.state`);
    expect(r.ctx.io.repoRoot).toBe(f.repo);
    expect(r.ctx.config.repo).toBe(f.repo);
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('--root 与 [rsi] repo 的 realpath 不同 → usage / root_mismatch(退出 2);相同(含相对写法)→ ready', async () => {
    const f = await makeRoFx('open-root-');
    const before = await treeOf(f.dir);
    const bad = await openRsiIo(early(f, { explicitRoot: f.dir }));
    expect(bad).toEqual({ kind: 'usage', code: 'RSI_USAGE', reason: 'root_mismatch', exit: 2 });
    expect((await openRsiIo(early(f, { explicitRoot: f.repo }))).kind).toBe('ready');
    expect((await openRsiIo(early(f, { explicitRoot: 'repo' }))).kind).toBe('ready'); // 相对 cwd(= dir)
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('选择先于通用路径校验:对通用路径无效的 KIT_STATE_DIR / KIT_WRITE_ROOTS 不影响 ready(未设 KIT_TMP 时被剔除)', async () => {
    const f = await makeRoFx('open-env-');
    const env = { KIT_REAL_HOME_OVERRIDE: f.home, PATH: '/usr/bin:/bin' };
    const r = await openRsiIo(
      early(f, { env: { ...env, KIT_STATE_DIR: '/etc/not-in-repo', KIT_WRITE_ROOTS: 'relative' } }),
    );
    expect(r.kind).toBe('ready');
    // 对照:设了 KIT_TMP(测试夹具)时保留,于是同样的无效值让上下文构造失败 → fail-closed state_dir_unsafe
    await expect(
      openRsiIo(early(f, { env: { ...f.env, KIT_STATE_DIR: '/etc/not-in-repo' } })),
    ).rejects.toMatchObject({ reason: 'state_dir_unsafe' });
  });

  it('平台不支持句柄级安全读(D8):on → 抛 RsiFailClosedError(state_dir_unsafe),createContext 零调用;off 不受影响', async () => {
    const f = await makeRoFx('open-platform-');
    const s = spy();
    await expect(
      openRsiIo(early(f), { ...s.deps, platformSupported: () => false }),
    ).rejects.toBeInstanceOf(RsiFailClosedError);
    expect(s.calls()).toBe(0);
    await writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 });
    expect(await openRsiIo(early(f), { platformSupported: () => false })).toEqual({
      kind: 'off',
      reason: 'disabled',
    });
  });

  it('派生的上下文继承写审计钩子(deriveIoContext 路径):钩子来自 early.writeAudit', async () => {
    const f = await makeRoFx('open-audit-');
    const calls: string[] = [];
    const r = await openRsiIo(early(f, { writeAudit: (op) => void calls.push(op) }));
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    const io: IoContext = r.ctx.io;
    expect(typeof io.writeAudit).toBe('function');
    io.writeAudit?.('probe', '/x');
    expect(calls).toEqual(['probe']);
  });
});
