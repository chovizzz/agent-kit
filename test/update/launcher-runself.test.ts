import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXEC_ALLOWLIST, RUN_SELF_ENV_KEYS, runSelf, useEnvProxyFlag } from '../../src/io/exec.js';
import * as safe from '../../src/io/safe-fs.js';
import { newWorld, realHomeSnapshot } from './install-world.js';
import { SHARE, installFake, lay, link, markers, put } from './launcher-world.js';

const BASE_ENV = { PATH: '/usr/bin:/bin' };

describe('runSelf:路径解析与 realpath 校验', () => {
  it('只跑 current 解析出的版本目录里的 dist/cli.js;调用方不能指定脚本路径(正向对照)', async () => {
    const before = await realHomeSnapshot();
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const r = runSelf({
      home: w.home,
      target: { kind: 'current' },
      args: ['x', 'y'],
      env: { ...BASE_ENV, KIT_TMP: w.dir },
    });
    expect(r).toMatchObject({ spawned: true, status: 7 });
    const m = await markers(w);
    expect(m[0]?.argv).toEqual(['x', 'y']);
    expect(await realHomeSnapshot()).toEqual(before);
  });

  it('current 不是符号链接 / 逃逸 versions / 悬空 → 拒绝,不 spawn', async () => {
    const w = await newWorld();
    const a = await lay(w, '0.2.0');
    const l = path.join(w.home, SHARE, 'current');
    // 真实目录而不是链接
    await safe.mkdirp(w.fx, l);
    expect(runSelf({ home: w.home, target: { kind: 'current' }, args: [], env: {} })).toEqual({
      spawned: false,
      reason: 'current_not_link',
    });
    await safe.remove(w.fx, path.join(l)).catch(() => undefined);
    // 指向 versions 之外
    const w2 = await newWorld();
    const out = path.join(w2.dir, 'out');
    await put(w2, path.join(out, 'dist/cli.js'), '#!/usr/bin/env node\n', 0o755);
    await safe.mkdirp(w2.fx, path.join(w2.home, SHARE, 'versions'));
    await safe.symlink(w2.fx, out, path.join(w2.home, SHARE, 'current'));
    expect(runSelf({ home: w2.home, target: { kind: 'current' }, args: [], env: {} })).toEqual({
      spawned: false,
      reason: 'current_escape',
    });
    // 悬空
    const w3 = await newWorld();
    await safe.mkdirp(w3.fx, path.join(w3.home, SHARE, 'versions'));
    await safe.symlink(w3.fx, 'versions/9.9.9', path.join(w3.home, SHARE, 'current'));
    expect(
      runSelf({ home: w3.home, target: { kind: 'current' }, args: [], env: {} }),
    ).toMatchObject({
      spawned: false,
    });
    void a;
  });

  it('目录名不是 semver、或不是 versions 的直接子目录 → 拒绝', async () => {
    const w = await newWorld();
    const sub = path.join(w.home, SHARE, 'versions', 'not-semver');
    await put(w, path.join(sub, 'dist/cli.js'), '#!/usr/bin/env node\n', 0o755);
    await safe.symlink(w.fx, 'versions/not-semver', path.join(w.home, SHARE, 'current'));
    expect(runSelf({ home: w.home, target: { kind: 'current' }, args: [], env: {} })).toEqual({
      spawned: false,
      reason: 'current_escape',
    });
    const w2 = await newWorld();
    const deep = path.join(w2.home, SHARE, 'versions', '0.2.0', 'nested', '0.3.0');
    await put(w2, path.join(deep, 'dist/cli.js'), '#!/usr/bin/env node\n', 0o755);
    await safe.symlink(w2.fx, 'versions/0.2.0/nested/0.3.0', path.join(w2.home, SHARE, 'current'));
    expect(runSelf({ home: w2.home, target: { kind: 'current' }, args: [], env: {} })).toEqual({
      spawned: false,
      reason: 'current_escape',
    });
  });

  it('target.version 与 current 解析出的目录名不一致 → 拒绝(验证 A 执行 B 的缝)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    await lay(w, '0.3.0');
    await link(w, '0.3.0'); // 启动器验的是 0.2.0,这时 current 被切走
    const r = runSelf({
      home: w.home,
      target: { kind: 'current', version: '0.2.0' },
      args: [],
      env: { KIT_TMP: w.dir },
    });
    expect(r).toEqual({ spawned: false, reason: 'version_mismatch' });
    expect(await markers(w)).toHaveLength(0);
    // 对照:版本一致则放行
    expect(
      runSelf({
        home: w.home,
        target: { kind: 'current', version: '0.3.0' },
        args: [],
        env: { KIT_TMP: w.dir },
      }),
    ).toMatchObject({ spawned: true });
  });

  it('dist/cli.js 是符号链接,或 dist 目录是链接 → 拒绝', async () => {
    const w = await newWorld();
    const a = await installFake(w, '0.2.0');
    await safe.remove(w.fx, path.join(a.root, 'dist/cli.js'));
    await safe.symlink(w.fx, 'main.js', path.join(a.root, 'dist/cli.js'));
    expect(runSelf({ home: w.home, target: { kind: 'current' }, args: [], env: {} })).toEqual({
      spawned: false,
      reason: 'entry_invalid',
    });
  });

  it('dist 目录本身是符号链接(cli.js 在链接目标里)→ 拒绝;对照:普通 dist 目录放行', async () => {
    const w = await newWorld();
    const a = await installFake(w, '0.2.0');
    expect(
      runSelf({ home: w.home, target: { kind: 'current' }, args: [], env: { KIT_TMP: w.dir } }),
    ).toMatchObject({ spawned: true });
    await safe.rename(w.fx, path.join(a.root, 'dist'), path.join(a.root, 'distreal'));
    await safe.symlink(w.fx, 'distreal', path.join(a.root, 'dist'));
    expect(runSelf({ home: w.home, target: { kind: 'current' }, args: [], env: {} })).toEqual({
      spawned: false,
      reason: 'entry_invalid',
    });
  });

  it('home 必须是绝对路径', () => {
    expect(() => runSelf({ home: 'rel/home', target: { kind: 'current' }, args: [] })).toThrow();
  });
});

describe('runSelf:冒烟候选(candidate)', () => {
  async function stage(w: Awaited<ReturnType<typeof newWorld>>, name: string): Promise<string> {
    const inst = await lay(w, '0.2.0', `#!/usr/bin/env node\nprocess.stdout.write('0.2.0');\n`);
    const stg = path.join(w.home, SHARE, 'staging', name);
    await safe.mkdirp(w.fx, path.dirname(stg));
    await safe.rename(w.fx, inst.root, stg);
    return stg;
  }

  it('只接受 staging/st-<hex> 的直接子目录;参数固定 --version(调用方的 args 被忽略)', async () => {
    const w = await newWorld();
    const stg = await stage(w, 'st-0a1b2c');
    const r = runSelf({
      home: w.home,
      target: { kind: 'candidate', stagingAbs: stg },
      args: ['rm', '-rf'],
      env: {},
    });
    expect(r).toMatchObject({ spawned: true, status: 0, stdout: '0.2.0' });
    for (const name of ['evil', 'st-xyz', 'st-0a1b2c/..']) {
      const w2 = await newWorld();
      const s2 = await stage(w2, name.replace('/..', ''));
      const target = name.endsWith('/..') ? path.join(s2, '..') : s2;
      expect(
        runSelf({
          home: w2.home,
          target: { kind: 'candidate', stagingAbs: target },
          args: [],
          env: {},
        }),
      ).toEqual({ spawned: false, reason: 'candidate_invalid' });
    }
  });

  it('staging 之外的目录(例如 versions/<v>)当候选 → 拒绝', async () => {
    const w = await newWorld();
    const a = await installFake(w, '0.2.0');
    expect(
      runSelf({
        home: w.home,
        target: { kind: 'candidate', stagingAbs: a.root },
        args: [],
        env: {},
      }),
    ).toMatchObject({ spawned: false });
  });

  it('超时:候选死循环 → 被杀,status=null,不挂住调用方', async () => {
    const w = await newWorld();
    const inst = await lay(w, '0.2.0', `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`);
    const stg = path.join(w.home, SHARE, 'staging', 'st-aaaaaa');
    await safe.mkdirp(w.fx, path.dirname(stg));
    await safe.rename(w.fx, inst.root, stg);
    const r = runSelf({
      home: w.home,
      target: { kind: 'candidate', stagingAbs: stg },
      args: [],
      env: {},
      timeoutMs: 300,
    });
    expect(r).toMatchObject({ spawned: true, status: null });
  });
});

describe('runSelf:环境', () => {
  it('只传具名白名单键;HOME 强制为 home;KIT_LAUNCHED 强制 1;NODE_OPTIONS / 未知键 / 父进程 HOME 不传', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    runSelf({
      home: w.home,
      target: { kind: 'current' },
      args: [],
      env: {
        ...BASE_ENV,
        KIT_TMP: w.dir,
        HOME: '/tmp/someone-else',
        NODE_OPTIONS: '--require /tmp/evil.js',
        NODE_PATH: '/tmp/evil',
        SECRET_TOKEN: 'x',
        KIT_LAUNCHED: '0',
        KIT_UNKNOWN_FLAG: '1',
        LC_ALL: 'C',
        GIT_DIR: '/x',
        KIT_AUTO_UPDATE: '0',
        HTTPS_PROXY: 'http://127.0.0.1:9',
      },
    });
    const env = (await markers(w))[0]?.env as Record<string, string>;
    expect(env['HOME']).toBe(w.home);
    expect(env['KIT_LAUNCHED']).toBe('1');
    expect(env['PATH']).toBe(BASE_ENV.PATH);
    expect(env['KIT_TMP']).toBe(w.dir);
    expect(env['LC_ALL']).toBe('C');
    expect(env['GIT_DIR']).toBe('/x');
    expect(env['KIT_AUTO_UPDATE']).toBe('0');
    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:9');
    for (const bad of ['NODE_OPTIONS', 'NODE_PATH', 'SECRET_TOKEN', 'KIT_UNKNOWN_FLAG']) {
      expect(env[bad]).toBeUndefined();
    }
    const keys = Object.keys(env).filter((k) => !k.startsWith('__CF'));
    for (const k of keys) {
      expect([...RUN_SELF_ENV_KEYS, 'HOME', 'KIT_LAUNCHED']).toContain(
        k.match(/^(LC_|GIT_)/) ? 'HOME' : k,
      );
    }
  });

  it('受控 tmpDir 覆盖 env 里的 TMPDIR;不给则透传', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const ctl = path.join(w.dir, 'ctl-tmp');
    runSelf({
      home: w.home,
      target: { kind: 'current' },
      args: [],
      env: { KIT_TMP: w.dir, TMPDIR: '/u/tmp' },
      tmpDir: ctl,
    });
    runSelf({
      home: w.home,
      target: { kind: 'current' },
      args: [],
      env: { KIT_TMP: w.dir, TMPDIR: '/u/tmp' },
    });
    const ms = await markers(w);
    expect(ms.map((m) => m.env['TMPDIR']).sort()).toEqual([ctl, '/u/tmp'].sort());
  });

  it('不继承父进程 execArgv(--require / --inspect 之类注入不过去)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    runSelf({ home: w.home, target: { kind: 'current' }, args: [], env: { KIT_TMP: w.dir } });
    expect((await markers(w))[0]?.execArgv).toEqual([]);
  });

  it('后台模式:立即返回 spawned,子进程自行跑完', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const r = runSelf({
      home: w.home,
      target: { kind: 'current' },
      args: ['__update', '--background'],
      env: { KIT_TMP: w.dir },
      background: true,
    });
    expect(r).toEqual({ spawned: true, status: null, signal: null, stdout: '' });
    for (let i = 0; i < 100 && (await markers(w)).length === 0; i++) {
      await new Promise((res) => setTimeout(res, 50));
    }
    expect((await markers(w))[0]?.argv).toEqual(['__update', '--background']);
  });

  it('EXEC_ALLOWLIST 仍恰为 [git]', () => {
    expect(EXEC_ALLOWLIST).toEqual(['git']);
  });
});

describe('useEnvProxyFlag:代理环境下只在 Node >= 24.5 才加,不硬传', () => {
  const P = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
  it('支持的 Node + 有代理 → 加', () => {
    expect(useEnvProxyFlag(P, '24.5.0')).toEqual(['--use-env-proxy']);
    expect(useEnvProxyFlag(P, '25.2.1')).toEqual(['--use-env-proxy']);
    expect(useEnvProxyFlag({ http_proxy: 'http://x' }, '26.0.0')).toEqual(['--use-env-proxy']);
    expect(useEnvProxyFlag({ NODE_USE_ENV_PROXY: '1' }, '24.5.0')).toEqual(['--use-env-proxy']);
  });
  it('旧 Node 不传;没有代理不传;NODE_USE_ENV_PROXY=0 不传', () => {
    expect(useEnvProxyFlag(P, '24.4.9')).toEqual([]);
    expect(useEnvProxyFlag(P, '22.13.0')).toEqual([]);
    expect(useEnvProxyFlag({}, '25.2.1')).toEqual([]);
    expect(useEnvProxyFlag({ HTTPS_PROXY: '' }, '25.2.1')).toEqual([]);
    expect(useEnvProxyFlag({ ...P, NODE_USE_ENV_PROXY: '0' }, '25.2.1')).toEqual([]);
    expect(useEnvProxyFlag(P, 'garbage')).toEqual([]);
  });
  it('runSelf 把它放在入口脚本之前(execArgv),子进程能看到;按本机 Node 的真实版本判断', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    runSelf({ home: w.home, target: { kind: 'current' }, args: [], env: { KIT_TMP: w.dir, ...P } });
    const ms = await markers(w);
    expect(ms[0]?.execArgv).toEqual(useEnvProxyFlag(P, process.versions.node));
  });
});
