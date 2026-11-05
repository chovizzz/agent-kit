/**
 * D-AU1(contracts §20.19):`src/update/installed.ts` —— 钩子与启动器共享的零网络只读视图。
 *  - `decideCurrent` 全矩阵(M6 三态、L5 的 KIT_LAUNCHED 口径、M4 短路顺序),并与 `launchCurrent` 对拍(同一判据,L:里氏替换);
 *  - `checkControlledTmp`(H2-B:只读,从不创建)、`pickWorkerTarget`、`readAutoInstall`(H3);
 *  - 从 `install.ts` 搬出的导出仍从 `install.ts` 可取(外部调用点不变),常量与 home-fs / install 的同名常量相等。
 * 文件名 `install*.test.ts` 命中 eslint 的安装器测试授权块(可引用 home-fs 常量做相等断言)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_LINK_REL } from '../../src/io/home-fs.js';
import type { RunSelfResult } from '../../src/io/exec.js';
import { lstat, readDir } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { readAutoInstall } from '../../src/update/auto-install.js';
import * as install from '../../src/update/install.js';
import { ensureControlledTmp } from '../../src/update/install.js';
import * as installed from '../../src/update/installed.js';
import { launchCurrent } from '../../src/update/launcher.js';
import { signalCode } from '../../src/update/signal-code.js';
import { emptyState, serializeUpdateState } from '../../src/update/state.js';
import { newWorld, type World } from './install-world.js';
import { SHARE, STATE_DIR, installFake, lay, link, put, putState } from './launcher-world.js';

const OWN = '0.1.0';
const ENV = { KIT_TMP: '/x', PATH: '/usr/bin:/bin' };

const decide = (
  w: World,
  o: { env?: Record<string, string>; own?: string; deps?: installed.DecideCurrentDeps } = {},
): Promise<installed.CurrentDecision> =>
  installed.decideCurrent(
    { home: w.home, env: { ...ENV, ...o.env }, own: o.own ?? OWN },
    o.deps ?? {},
  );

describe('常量与导出:搬迁后外部调用点不变', () => {
  it('current 链接 / 受控 tmp 的只读常量与 home-fs / install 的同名常量相等(不 import 写出口,靠本断言钉住)', () => {
    expect(installed.CURRENT_LINK_REL_RO).toBe(CURRENT_LINK_REL);
    expect(installed.UPDATE_TMP_REL_RO).toBe(install.UPDATE_TMP_REL);
  });
  it('install.ts 仍导出搬走的函数与常量,且是同一个对象', () => {
    expect(install.readUpdateState).toBe(installed.readUpdateState);
    expect(install.currentVersionOf).toBe(installed.currentVersionOf);
    expect(install.verifyInstalledTree).toBe(installed.verifyInstalledTree);
    expect(install.chainUnsafe).toBe(installed.chainUnsafe);
    expect(install.SHARE_REL).toBe(installed.SHARE_REL);
    expect(install.UPDATE_STATE_DIR_REL).toBe(installed.UPDATE_STATE_DIR_REL);
    expect(install.UPDATE_STATE_FILE_REL).toBe(installed.UPDATE_STATE_FILE_REL);
  });
  it('signalCode:已知信号折成 128+号,未知 / 无信号折成 129', () => {
    expect(signalCode('SIGTERM')).toBe(143);
    expect(signalCode('SIGINT')).toBe(130);
    expect(signalCode('SIGWHATEVER')).toBe(129);
    expect(signalCode(null)).toBe(129);
  });
});

describe('decideCurrent 矩阵', () => {
  it('current 有效、更高、同 major、树校验过 → launch(正向对照)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    expect(await decide(w)).toEqual({ launch: true, version: '0.2.0' });
  });

  it('L5:KIT_LAUNCHED 按 truthyEnv 口径——1 不转发;0 / 空串 / false 与未设相同(转发)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    expect(await decide(w, { env: { KIT_LAUNCHED: '1' } })).toEqual({ launch: false });
    for (const v of ['0', '', 'false']) {
      expect(await decide(w, { env: { KIT_LAUNCHED: v } }), `KIT_LAUNCHED=${v}`).toEqual({
        launch: true,
        version: '0.2.0',
      });
    }
  });

  it('M6 state 三态:absent / 没有 installed → 静默用自己(无 broken);unreadable / unsafe → broken=state', async () => {
    const absent = await newWorld();
    expect(await decide(absent)).toEqual({ launch: false });

    const noInstalled = await newWorld();
    await lay(noInstalled, '0.2.0');
    await link(noInstalled, '0.2.0');
    await put(
      noInstalled,
      path.join(noInstalled.home, STATE_DIR, 'state.json'),
      serializeUpdateState(emptyState()),
    );
    expect((await installed.readUpdateState(noInstalled.home)).kind).toBe('ok');
    expect(await decide(noInstalled)).toEqual({ launch: false });

    const garbage = await newWorld();
    await put(garbage, path.join(garbage.home, STATE_DIR, 'state.json'), '{not json');
    expect(await decide(garbage)).toEqual({ launch: false, broken: 'state' });

    const unsafe = await newWorld();
    const outside = path.join(unsafe.dir, 'elsewhere');
    await safe.mkdirp(unsafe.fx, outside);
    await safe.mkdirp(unsafe.fx, path.join(unsafe.home, '.local', 'state', 'agent-kit'));
    await safe.symlink(unsafe.fx, outside, path.join(unsafe.home, STATE_DIR));
    expect(await decide(unsafe)).toEqual({ launch: false, broken: 'state' });
  });

  it('current 缺失 → broken=current;指向版本 ≠ 安装记录 → version_mismatch', async () => {
    const w1 = await newWorld();
    await installFake(w1, '0.2.0');
    await safe.remove(w1.fx, path.join(w1.home, SHARE, 'current'));
    expect(await decide(w1)).toEqual({ launch: false, broken: 'current' });

    const w2 = await newWorld();
    await installFake(w2, '0.2.0');
    await lay(w2, '0.2.1');
    await link(w2, '0.2.1');
    expect(await decide(w2)).toEqual({ launch: false, broken: 'version_mismatch' });
  });

  it('current 链接逃逸出 versions/ → broken=current', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const out = path.join(w.dir, 'outside-versions', '0.2.0');
    await safe.mkdirp(w.fx, out);
    const l = path.join(w.home, SHARE, 'current');
    await safe.remove(w.fx, l);
    await safe.symlink(w.fx, out, l);
    expect(await decide(w)).toEqual({ launch: false, broken: 'current' });
  });

  it('锚点不符 → anchor;文件被改 / 多出文件 → tree(完整树校验在「更高同 major」时一定跑)', async () => {
    const wa = await newWorld();
    const ia = await installFake(wa, '0.2.0');
    await putState(wa, '0.2.0', 'a'.repeat(64));
    expect(ia.pkg.anchor).not.toBe('a'.repeat(64));
    expect(await decide(wa)).toEqual({ launch: false, broken: 'anchor' });

    const wt = await newWorld();
    const it1 = await installFake(wt, '0.2.0');
    await safe.writeFile(wt.fx, path.join(it1.root, 'dist', 'cli.js'), 'tampered\n', {
      mode: 0o644,
    });
    expect(await decide(wt)).toEqual({ launch: false, broken: 'tree' });

    const wx = await newWorld();
    const ix = await installFake(wx, '0.2.0');
    await safe.writeFile(wx.fx, path.join(ix.root, 'extra.js'), 'x\n', { mode: 0o644 });
    expect(await decide(wx)).toEqual({ launch: false, broken: 'tree' });
  });

  it('相同 / 更低 / 跨 major:用自己且不算损坏;own 不是合法 semver → broken=version', async () => {
    for (const [cur, own] of [
      ['0.2.0', '0.2.0'],
      ['0.2.0', '0.3.0'],
      ['0.2.0', '0.2.1'],
      ['1.0.0', '0.9.0'],
      ['0.9.0', '1.0.0'],
    ] as const) {
      const w = await newWorld();
      await installFake(w, cur);
      expect(await decide(w, { own }), `${cur} vs ${own}`).toEqual({ launch: false });
    }
    const w = await newWorld();
    await installFake(w, '0.2.0');
    expect(await decide(w, { own: 'not-a-version' })).toEqual({
      launch: false,
      broken: 'version',
    });
  });

  it('M4 短路顺序:每一步失败都不再做后面更贵的读取(记录读取器调用)', async () => {
    const mk = (): {
      calls: string[];
      deps: installed.DecideCurrentDeps;
    } => {
      const calls: string[] = [];
      return {
        calls,
        deps: {
          readState: async (h) => {
            calls.push('state');
            return installed.readUpdateState(h);
          },
          readCurrent: async (h) => {
            calls.push('current');
            return installed.currentVersionOf(h);
          },
          verifyTree: async (r, want) => {
            calls.push('tree');
            return installed.verifyInstalledTree(r, want);
          },
        },
      };
    };
    const w = await newWorld();
    await installFake(w, '0.2.0');

    let m = mk();
    await decide(w, { env: { KIT_LAUNCHED: '1' }, deps: m.deps });
    expect(m.calls, 'KIT_LAUNCHED:什么都不读').toEqual([]);

    m = mk();
    await decide(w, { own: '0.2.0', deps: m.deps });
    expect(m.calls, '版本不更高:不做树校验').toEqual(['state', 'current']);

    m = mk();
    await decide(w, { deps: m.deps });
    expect(m.calls, '更高同 major:最后才做树校验').toEqual(['state', 'current', 'tree']);

    const absent = await newWorld();
    m = mk();
    await decide(absent, { deps: m.deps });
    expect(m.calls, 'state 缺失:不读 current').toEqual(['state']);

    const wm = await newWorld();
    await installFake(wm, '0.2.0');
    await lay(wm, '0.2.1');
    await link(wm, '0.2.1');
    m = mk();
    await decide(wm, { deps: m.deps });
    expect(m.calls, '安装记录对不上:不做树校验').toEqual(['state', 'current']);
  });
});

describe('与 launchCurrent 对拍:同一判据(M6)', () => {
  it('每个世界下,launchCurrent 的结果 = decideCurrent 的映射(launch / broken / 静默)', async () => {
    const run = (): RunSelfResult => ({ spawned: true, status: 0, signal: null, stdout: '' });
    type Build = (w: World) => Promise<void>;
    const worlds: [string, Build, string?][] = [
      ['valid', async (w) => void (await installFake(w, '0.2.0'))],
      ['absent', async () => undefined],
      ['garbage', async (w) => put(w, path.join(w.home, STATE_DIR, 'state.json'), '{x')],
      [
        'noCurrent',
        async (w) => {
          await installFake(w, '0.2.0');
          await safe.remove(w.fx, path.join(w.home, SHARE, 'current'));
        },
      ],
      [
        'anchor',
        async (w) => {
          await installFake(w, '0.2.0');
          await putState(w, '0.2.0', 'b'.repeat(64));
        },
      ],
      [
        'tamper',
        async (w) => {
          const i = await installFake(w, '0.2.0');
          await safe.writeFile(w.fx, path.join(i.root, 'dist', 'cli.js'), 'z\n', { mode: 0o644 });
        },
      ],
      ['lower', async (w) => void (await installFake(w, '0.2.0')), '0.3.0'],
      ['crossMajor', async (w) => void (await installFake(w, '1.0.0')), '0.9.0'],
    ];
    for (const [name, build, own] of worlds) {
      const w = await newWorld();
      await build(w);
      const d = await decide(w, { own: own ?? OWN });
      let err = '';
      const r = await launchCurrent(
        { argv: ['x'], home: w.home, env: ENV },
        { ownVersion: own ?? OWN, runSelf: run },
        (t) => void (err += t),
      );
      if (d.launch) {
        expect(r, name).toEqual({ launched: true, code: 0 });
        expect(err, name).toBe('');
      } else if ('broken' in d) {
        expect(r, name).toEqual({ launched: false, broken: d.broken });
        expect(err, name).toBe(`UPDATE_CURRENT_BROKEN reason=${d.broken}\n`);
      } else {
        expect(r, name).toEqual({ launched: false });
        expect(err, name).toBe('');
      }
    }
  });
});

describe('checkControlledTmp(H2-B:只读,从不创建)', () => {
  const tmpRel = installed.UPDATE_TMP_REL_RO;
  it('不存在 → undefined 且不建任何目录;0700 目录 → 返回绝对路径', async () => {
    const w = await newWorld();
    expect(await installed.checkControlledTmp(w.home)).toBeUndefined();
    expect((await readDir(w.home)).map((e) => e.name)).toEqual([]);

    const abs = path.join(w.home, ...tmpRel.split('/'));
    await safe.mkdirp(w.fx, abs, 0o700);
    await safe.chmod(w.fx, abs, 0o700);
    expect(await installed.checkControlledTmp(w.home)).toBe(abs);
  });
  it('权限含 group/other 位、是文件、是符号链接、状态目录链上有链接 → undefined', async () => {
    const loose = await newWorld();
    const a1 = path.join(loose.home, ...tmpRel.split('/'));
    await safe.mkdirp(loose.fx, a1, 0o755);
    await safe.chmod(loose.fx, a1, 0o755);
    expect(await installed.checkControlledTmp(loose.home)).toBeUndefined();

    const file = await newWorld();
    const a2 = path.join(file.home, ...tmpRel.split('/'));
    await safe.mkdirp(file.fx, path.dirname(a2));
    await safe.writeFile(file.fx, a2, 'x', { mode: 0o600 });
    expect(await installed.checkControlledTmp(file.home)).toBeUndefined();

    const sym = await newWorld();
    const a3 = path.join(sym.home, ...tmpRel.split('/'));
    const real = path.join(sym.dir, 'real-tmp');
    await safe.mkdirp(sym.fx, real, 0o700);
    await safe.mkdirp(sym.fx, path.dirname(a3));
    await safe.symlink(sym.fx, real, a3);
    expect((await lstat(a3)).isSymbolicLink()).toBe(true);
    expect(await installed.checkControlledTmp(sym.home)).toBeUndefined();

    const chain = await newWorld();
    const elsewhere = path.join(chain.dir, 'elsewhere');
    await safe.mkdirp(chain.fx, path.join(elsewhere, 'tmp'), 0o700);
    await safe.mkdirp(chain.fx, path.join(chain.home, '.local', 'state', 'agent-kit'));
    await safe.symlink(chain.fx, elsewhere, path.join(chain.home, STATE_DIR));
    expect(await installed.checkControlledTmp(chain.home)).toBeUndefined();
  });
});

describe('checkControlledTmp 与 ensureControlledTmp 对同一目录状态给同判(评审 M3:避免前台认为备好了、钩子永远不调度的分叉)', () => {
  const tmpRel = installed.UPDATE_TMP_REL_RO;
  const both = async (w: World): Promise<[string | undefined, string | undefined]> => {
    const ro = await installed.checkControlledTmp(w.home);
    const rw = await ensureControlledTmp({ home: w.home, tmpDir: w.dir, env: undefined, deps: {} });
    return [ro, rw];
  };
  it('已存在且合格 / 权限过宽 / 是文件 / 是符号链接:两者结论一致(合格时路径相同)', async () => {
    const ok = await newWorld();
    const abs = path.join(ok.home, ...tmpRel.split('/'));
    await safe.mkdirp(ok.fx, abs, 0o700);
    await safe.chmod(ok.fx, abs, 0o700);
    expect(await both(ok)).toEqual([abs, abs]);

    const loose = await newWorld();
    const a1 = path.join(loose.home, ...tmpRel.split('/'));
    await safe.mkdirp(loose.fx, a1, 0o755);
    await safe.chmod(loose.fx, a1, 0o755);
    expect(await both(loose)).toEqual([undefined, undefined]);

    const file = await newWorld();
    const a2 = path.join(file.home, ...tmpRel.split('/'));
    await safe.mkdirp(file.fx, path.dirname(a2));
    await safe.writeFile(file.fx, a2, 'x', { mode: 0o600 });
    expect(await both(file)).toEqual([undefined, undefined]);

    const sym = await newWorld();
    const a3 = path.join(sym.home, ...tmpRel.split('/'));
    const real = path.join(sym.dir, 'real-tmp');
    await safe.mkdirp(sym.fx, real, 0o700);
    await safe.mkdirp(sym.fx, path.dirname(a3));
    await safe.symlink(sym.fx, real, a3);
    expect(await both(sym)).toEqual([undefined, undefined]);
  });
  it('不存在:只读版返回 undefined 且不创建;写版创建后只读版随即认可(这就是前台先备好的分工)', async () => {
    const w = await newWorld();
    expect(await installed.checkControlledTmp(w.home)).toBeUndefined();
    const abs = await ensureControlledTmp({
      home: w.home,
      tmpDir: w.dir,
      env: undefined,
      deps: {},
    });
    expect(abs).toBeDefined();
    expect(await installed.checkControlledTmp(w.home)).toBe(abs);
  });
});

describe('pickWorkerTarget:update worker 由谁来跑', () => {
  it('current 与安装记录对齐且树校验过(不要求更高)→ current;否则 self', async () => {
    const ok = await newWorld();
    await installFake(ok, '0.2.0');
    expect(
      await installed.pickWorkerTarget(ok.home, await installed.readUpdateState(ok.home)),
    ).toEqual({ kind: 'current', version: '0.2.0' });

    const anchor = await newWorld();
    await installFake(anchor, '0.2.0');
    await putState(anchor, '0.2.0', 'c'.repeat(64));
    expect(
      await installed.pickWorkerTarget(anchor.home, await installed.readUpdateState(anchor.home)),
    ).toEqual({ kind: 'self' });

    const none = await newWorld();
    expect(
      await installed.pickWorkerTarget(none.home, await installed.readUpdateState(none.home)),
    ).toEqual({ kind: 'self' });
  });
});

describe('readAutoInstall(H3:worker 与钩子调度共用)', () => {
  const cfg = async (text: string | undefined): Promise<World> => {
    const w = await newWorld();
    if (text !== undefined) {
      const dir = path.join(w.home, '.config', 'agent-kit');
      await safe.mkdirp(w.fx, dir);
      await safe.writeFile(w.fx, path.join(dir, 'config.toml'), text, { mode: 0o600 });
    }
    return w;
  };
  it('文件不存在 → 缺省 true;显式 true / false 照读', async () => {
    expect(await readAutoInstall((await cfg(undefined)).home)).toEqual({
      ok: true,
      autoInstall: true,
    });
    expect(await readAutoInstall((await cfg('[update]\nauto_install = false\n')).home)).toEqual({
      ok: true,
      autoInstall: false,
    });
    expect(await readAutoInstall((await cfg('[update]\nauto_install = true\n')).home)).toEqual({
      ok: true,
      autoInstall: true,
    });
  });
  it('fail-closed:TOML 解析失败 / schema 不合 / 配置路径是目录 → ok:false', async () => {
    expect(await readAutoInstall((await cfg('[update\n')).home)).toEqual({ ok: false });
    expect(await readAutoInstall((await cfg('[update]\nauto_install = "yes"\n')).home)).toEqual({
      ok: false,
    });
    const dir = await newWorld();
    await safe.mkdirp(dir.fx, path.join(dir.home, '.config', 'agent-kit', 'config.toml'));
    expect(await readAutoInstall(dir.home)).toEqual({ ok: false });
  });
});
