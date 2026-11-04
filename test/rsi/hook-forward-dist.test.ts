/**
 * D-AU1 / D-AU2(contracts §20.19):真实发布产物(vite 构建的 `dist/cli.js`)子进程验收——钩子转发到 `current`、poke 顺带调度 update worker。
 * 与 `a3-dist.test.ts` 同一套办法:KIT_TMP 里自己构建一份产物,以 `node --import <preload>` 运行,preload 记录 fs 写调用与 child_process 调用。
 * 假 HOME 里铺一份「已安装」状态(`current` 软链 + `versions/<v>/` + `state.json`),其 `dist/cli.js` 是一个会写标记文件、向 stdout 打印 `FROM_CURRENT …`、
 * 并以 7 退出的桩——于是「钩子输出来自 current」「子进程码被丢弃(poke / hint 恒 0)」「`__rsi` 透传子进程码」「worker 的 argv / TMPDIR」都能直接断言。
 *  - a 有效 current(更高、同 major、树校验过)→ 三种钩子都转发(argv 原样、环境白名单内的 HOME / KIT_TMP / KIT_REAL_HOME_OVERRIDE 正确、KIT_LAUNCHED=1);
 *  - b current 损坏四种(锚点不符 / 文件被改 / 版本不符 / 链接逃逸)→ 静默用自己:stdout / stderr 空、没有标记、零写入;
 *  - c 相同 / 更低 / 跨 major、无状态 → 不转发;d KIT_LAUNCHED=1 不转发、`0` 视为未设;
 *  - e 调度:due + 受控 tmp 合格 → 恰好一次 `__update --background`(目标 current、TMPDIR = 受控目录),且钩子自身零写入;
 *    tmp 缺失 / 过宽、KIT_AUTO_UPDATE=0、auto_install=false、未到期、rsi off、hint、`__rsi` → 不调度。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KIT_VERSION } from '../../src/contracts/meta.js';
import { exists, lstat, readDir, readText, realpathSync } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { makeSandbox, type Sandbox } from '../build/helpers.js';
import { newWorld } from '../update/install-world.js';
import { SHARE, STATE_DIR, installFake, lay, link, putState } from '../update/launcher-world.js';

const [VMAJ, VMIN, VPATCH] = KIT_VERSION.split('.').map((x) => Number.parseInt(x, 10)) as [
  number,
  number,
  number,
];
const HIGHER = `${VMAJ}.${VMIN}.${VPATCH + 1}`;
const HIGHER2 = `${VMAJ}.${VMIN}.${VPATCH + 2}`;
const LOWER = VPATCH > 0 ? `${VMAJ}.${VMIN}.${VPATCH - 1}` : `${VMAJ}.${VMIN - 1}.9`;
const NEXT_MAJOR = `${VMAJ + 1}.0.0`;
const SAFE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const PRELOAD = String.raw`
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const cp = require('node:child_process');
const origAppend = fs.appendFileSync;
const W = process.env.AU_WRITE_LOG, S = process.env.AU_SPAWN_LOG;
const log = (f, line) => { if (f) { try { origAppend.call(fs, f, line + '\n'); } catch {} } };
const C = fs.constants;
const writes = (fl) => typeof fl === 'string' ? /[wax+]/.test(fl)
  : typeof fl === 'number' ? (fl & (C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_APPEND | C.O_TRUNC)) !== 0 : false;
const own = new Set([W, S].filter(Boolean));
const wrap = (obj, name, pred) => {
  const o = obj[name];
  if (typeof o !== 'function') return;
  obj[name] = function (...a) {
    if (!own.has(String(a[0])) && (!pred || pred(a))) log(W, name + ' ' + String(a[0]));
    return o.apply(this, a);
  };
};
for (const n of ['writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'rmdir', 'unlink', 'symlink', 'link', 'chmod', 'lchmod', 'copyFile', 'truncate', 'utimes', 'cp', 'mkdtemp']) {
  wrap(fs.promises, n); wrap(fs, n); wrap(fs, n + 'Sync');
}
wrap(fs.promises, 'open', (a) => writes(a[1]));
wrap(fs, 'open', (a) => writes(a[1]));
wrap(fs, 'openSync', (a) => writes(a[1]));
wrap(fs, 'createWriteStream');
for (const n of ['spawn', 'fork', 'execFile', 'exec', 'spawnSync', 'execFileSync', 'execSync']) {
  const o = cp[n];
  cp[n] = function (...a) {
    const r = o.apply(this, a);
    log(S, JSON.stringify({ fn: n, cmd: String(a[0]), args: Array.isArray(a[1]) ? a[1].map(String) : [], pid: r && typeof r.pid === 'number' ? r.pid : null }));
    return r;
  };
}
syncBuiltinESMExports();
`;

/** `current` 里的桩:写标记、打印可辨标记、退 7 */
const STUB_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const e = process.env;
fs.writeFileSync(e.KIT_TMP + '/marker-' + process.pid + '.json', JSON.stringify({
  argv: process.argv.slice(2),
  env: { HOME: e.HOME, KIT_LAUNCHED: e.KIT_LAUNCHED, KIT_TMP: e.KIT_TMP, TMPDIR: e.TMPDIR, KIT_REAL_HOME_OVERRIDE: e.KIT_REAL_HOME_OVERRIDE, KIT_STATE_DIR: e.KIT_STATE_DIR },
}));
process.stdout.write('FROM_CURRENT ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(7);
`;

let sb: Sandbox;
let pkg: string;
let preload: string;

beforeAll(async () => {
  sb = await makeSandbox('au-dist-');
  pkg = path.join(sb.dir, 'pkg');
  await safe.mkdirp(sb.wctx, pkg);
  await safe.copyFile(
    sb.wctx,
    path.join(REPO_ROOT, 'package.json'),
    path.join(pkg, 'package.json'),
  );
  const v = spawnSync(
    process.execPath,
    [VITE_BIN, 'build', '--outDir', path.join(pkg, 'dist'), '--emptyOutDir'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 240_000,
      env: { PATH: SAFE_PATH, HOME: sb.home, KIT_TMP: sb.dir },
    },
  );
  expect(v.status, v.stderr).toBe(0);
  preload = path.join(sb.dir, 'au-preload.mjs');
  await safe.writeFile(sb.wctx, preload, PRELOAD);
}, 300_000);

interface Logs {
  write: string;
  spawn: string;
}

interface W {
  home: string;
  repo: string;
  dir: string;
  tmp: string;
  env: Record<string, string>;
  logs: Logs;
  fx: Sandbox['wctx'];
}

interface Opts {
  /** 已安装版本(null = 没有任何安装状态) */
  installed?: string | null;
  /** 让 current 损坏的方式 */
  breakIt?: 'anchor' | 'tamper' | 'version' | 'escape';
  rsi?: 'off' | 'stop';
  /** 受控 tmp:合格 / 过宽 / 没有 */
  tmpDir?: 'ok' | 'loose' | 'none';
  /** state.last_check_at:很久以前(缺省) / 刚刚 */
  lastCheck?: 'old' | 'recent';
  /** 追加到 `[update]` 的内容(如 `auto_install = false`) */
  updateCfg?: string;
}

async function world(o: Opts = {}): Promise<W> {
  const w = await newWorld();
  const installed = o.installed === undefined ? HIGHER : o.installed;
  if (installed !== null) {
    const inst = await installFake(w, installed, STUB_CLI);
    const last = o.lastCheck === 'recent' ? new Date().toISOString() : '2026-10-14T12:00:00.000Z';
    await putState(w, installed, inst.pkg.anchor, (s) => ({ ...s, last_check_at: last }));
    if (o.breakIt === 'anchor') await putState(w, installed, 'a'.repeat(64));
    if (o.breakIt === 'tamper') {
      await safe.writeFile(w.fx, path.join(inst.root, 'dist', 'cli.js'), 'tampered\n', {
        mode: 0o644,
      });
    }
    if (o.breakIt === 'version') {
      await lay(w, HIGHER2, STUB_CLI);
      await link(w, HIGHER2);
    }
    if (o.breakIt === 'escape') {
      const out = path.join(w.dir, 'outside', installed);
      await safe.mkdirp(w.fx, out);
      const l = path.join(w.home, SHARE, 'current');
      await safe.remove(w.fx, l);
      await safe.symlink(w.fx, out, l);
    }
  }
  const repo = path.join(w.dir, 'repo');
  await safe.mkdirp(w.fx, repo, 0o755);
  await safe.chmod(w.fx, repo, 0o755);
  await safe.writeFile(w.fx, path.join(repo, 'kit.toml'), '[kit]\n', { mode: 0o644 });
  const cfgDir = path.join(w.home, '.config', 'agent-kit');
  await safe.mkdirp(w.fx, cfgDir, 0o755);
  await safe.chmod(w.fx, path.join(w.home, '.config'), 0o755);
  await safe.chmod(w.fx, cfgDir, 0o755);
  const realRepo = realpathSync(repo);
  const rsi = o.rsi ?? 'off';
  const cfg =
    `[update]\n${o.updateCfg ?? ''}\n` +
    (rsi === 'off' ? '' : `[rsi]\nenabled = true\nrepo = ${JSON.stringify(realRepo)}\n`);
  await safe.writeFile(w.fx, path.join(cfgDir, 'config.toml'), cfg, { mode: 0o600 });
  await safe.chmod(w.fx, path.join(cfgDir, 'config.toml'), 0o600);
  if (rsi === 'stop') {
    const d = path.join(repo, '.state', 'rsi');
    await safe.mkdirp(w.fx, d, 0o700);
    await safe.chmod(w.fx, d, 0o700);
    await safe.writeFile(
      w.fx,
      path.join(d, 'STOP'),
      '{"at":"2026-10-24T00:00:00.000Z","by":"user"}',
      {
        mode: 0o600,
      },
    );
  }
  // 受控 tmp(update worker 的 TMPDIR):钩子只读检查它,从不创建
  const tmpMode = o.tmpDir === 'loose' ? 0o755 : 0o700;
  if (o.tmpDir !== 'none') {
    const t = path.join(w.home, STATE_DIR, 'tmp');
    await safe.mkdirp(w.fx, t, tmpMode);
    await safe.chmod(w.fx, t, tmpMode);
  }
  // KIT_TMP 与 HOME / 仓库互不为祖先;桩把标记写在这里
  const tmp = path.join(w.dir, 'tmp');
  await safe.mkdirp(w.fx, tmp, 0o700);
  await safe.chmod(w.fx, tmp, 0o700);
  const logs: Logs = {
    write: path.join(w.dir, 'writes.log'),
    spawn: path.join(w.dir, 'spawns.log'),
  };
  const env = {
    PATH: SAFE_PATH,
    HOME: w.home,
    KIT_REAL_HOME_OVERRIDE: w.home,
    KIT_TMP: tmp,
    KIT_UPDATE_REGISTRY: `file://${w.reg}`,
    AU_WRITE_LOG: logs.write,
    AU_SPAWN_LOG: logs.spawn,
  };
  return { home: w.home, repo: realRepo, dir: w.dir, tmp, env, logs, fx: w.fx };
}

const read = async (p: string): Promise<string> => ((await exists(p)) ? readText(p) : '');
const reset = async (w: W): Promise<void> => {
  for (const p of Object.values(w.logs)) await safe.remove(w.fx, p);
  for (const m of await markerFiles(w)) await safe.remove(w.fx, m);
};

interface Ran {
  status: number | null;
  out: string;
  err: string;
}

function run(w: W, args: string[], env: Record<string, string> = {}): Promise<Ran> {
  const child = spawn(
    process.execPath,
    ['--import', preload, path.join(pkg, 'dist', 'cli.js'), ...args],
    {
      cwd: w.repo,
      env: { ...w.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: signal === null ? code : null, out, err });
    });
  });
}

async function markerFiles(w: W): Promise<string[]> {
  try {
    return (await readDir(w.tmp))
      .filter((e) => e.name.startsWith('marker-'))
      .map((e) => path.join(w.tmp, e.name));
  } catch {
    return [];
  }
}

interface Marker {
  argv: string[];
  env: Record<string, string | undefined>;
}

async function markers(w: W): Promise<Marker[]> {
  const out: Marker[] = [];
  for (const f of await markerFiles(w)) out.push(JSON.parse(await readText(f)) as Marker);
  return out;
}

/** 等到至少 n 个标记(后台 worker 起得慢);超时返回当前已有的 */
async function waitMarkers(w: W, n: number, ms = 10_000): Promise<Marker[]> {
  const t0 = Date.now();
  let m = await markers(w);
  while (m.length < n && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 100));
    m = await markers(w);
  }
  return m;
}

const spawns = async (w: W): Promise<{ fn: string; args: string[] }[]> =>
  (await read(w.logs.spawn))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { fn: string; args: string[] });

const POKE = ['rsi', 'poke', '--agent', 'claude'];
const HINT = ['rsi', 'hint', '--agent', 'claude'];
const WORKER = ['__rsi', '--background'];

describe('a 有效 current:钩子转发', () => {
  it('hint:stdout 来自 current、退出码恒 0(子进程的 7 被丢弃)、argv 原样、环境(HOME / KIT_TMP / KIT_REAL_HOME_OVERRIDE / KIT_STATE_DIR)正确、KIT_LAUNCHED=1', async () => {
    const w = await world();
    const stateDir = path.join(w.dir, 'kit-state');
    const r = await run(w, HINT, { KIT_STATE_DIR: stateDir });
    expect(r).toEqual({ status: 0, out: `FROM_CURRENT ${HINT.join(' ')}\n`, err: '' });
    const m = await markers(w);
    expect(m).toHaveLength(1);
    expect(m[0]?.argv).toEqual(HINT);
    expect(m[0]?.env).toMatchObject({
      HOME: w.home,
      KIT_LAUNCHED: '1',
      KIT_TMP: w.env['KIT_TMP'],
      KIT_REAL_HOME_OVERRIDE: w.home,
      KIT_STATE_DIR: stateDir,
    });
    // 只有一次同步子进程(转发);父进程不起任何后台 worker、零写入
    const s = await spawns(w);
    expect(s.map((x) => x.fn)).toEqual(['spawnSync']);
    expect(await read(w.logs.write)).toBe('');
  }, 60_000);

  it('poke:转发(恒 0),父进程不再调度 update worker', async () => {
    const w = await world();
    const r = await run(w, POKE);
    expect(r).toEqual({ status: 0, out: `FROM_CURRENT ${POKE.join(' ')}\n`, err: '' });
    expect((await markers(w))[0]?.argv).toEqual(POKE);
    expect((await spawns(w)).map((x) => x.fn)).toEqual(['spawnSync']);
  }, 60_000);

  it('`__rsi --background`:转发且透传子进程退出码(7)', async () => {
    const w = await world();
    const r = await run(w, WORKER);
    expect(r).toEqual({ status: 7, out: `FROM_CURRENT ${WORKER.join(' ')}\n`, err: '' });
    expect((await markers(w))[0]?.argv).toEqual(WORKER);
  }, 60_000);
});

describe('b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入)', () => {
  for (const how of ['anchor', 'tamper', 'version', 'escape'] as const) {
    it(`${how}`, async () => {
      const w = await world({ breakIt: how });
      for (const args of [POKE, HINT, WORKER]) {
        await reset(w);
        const r = await run(w, args);
        expect(r, `${how} ${args.join(' ')}`).toEqual({ status: 0, out: '', err: '' });
        expect(await markers(w), `${how} ${args.join(' ')}`).toEqual([]);
        expect(await spawns(w), `${how} ${args.join(' ')}`).toEqual([]);
        expect(await read(w.logs.write), `${how} ${args.join(' ')}`).toBe('');
      }
      // 正向对照:同一个世界不损坏时确实会转发(见 a)
    }, 90_000);
  }
});

describe('c 不转发:相同 / 更低 / 跨 major / 没有安装状态', () => {
  for (const [name, inst] of [
    ['相同', KIT_VERSION],
    ['更低', LOWER],
    ['跨 major(更高)', NEXT_MAJOR],
    ['没有任何安装状态', null],
  ] as const) {
    it(
      name,
      async () => {
        const w = await world({ installed: inst });
        for (const args of [POKE, HINT, WORKER]) {
          await reset(w);
          const r = await run(w, args);
          expect(r, `${name} ${args.join(' ')}`).toEqual({ status: 0, out: '', err: '' });
          expect(await markers(w), `${name} ${args.join(' ')}`).toEqual([]);
          expect(await read(w.logs.write), `${name} ${args.join(' ')}`).toBe('');
        }
      },
      90_000,
    );
  }
});

describe('d KIT_LAUNCHED', () => {
  it('=1 不转发(防递归);=0 视为未设,照常转发', async () => {
    const w = await world();
    const a = await run(w, HINT, { KIT_LAUNCHED: '1' });
    expect(a).toEqual({ status: 0, out: '', err: '' });
    expect(await markers(w)).toEqual([]);
    const b = await run(w, HINT, { KIT_LAUNCHED: '0' });
    expect(b.out).toBe(`FROM_CURRENT ${HINT.join(' ')}\n`);
    expect(await markers(w)).toHaveLength(1);
  }, 60_000);
});

describe('f 前台命令备好受控 tmp(H2-B):只用 pi 的用户装钩子那一次之后,poke 才调度得起来', () => {
  it('全新假 HOME 没有 tmp:poke 不调度;先跑一条非 TTY 前台命令(--version)→ tmp 被建出(0700);同一世界再 poke → 恰好一次 __update --background', async () => {
    const w = await world({ installed: KIT_VERSION, rsi: 'stop', tmpDir: 'none' });
    const tmpAbs = path.join(w.home, STATE_DIR, 'tmp');
    expect((await run(w, POKE)).status).toBe(0);
    expect(await spawns(w)).toEqual([]);
    expect(await exists(tmpAbs)).toBe(false);

    await reset(w);
    const fg = await run(w, ['--version']);
    expect(fg.status).toBe(0);
    expect(fg.out).toContain(KIT_VERSION);
    expect(await exists(tmpAbs)).toBe(true);
    expect(((await lstat(tmpAbs)).mode & 0o777).toString(8)).toBe('700');

    await reset(w);
    expect(await run(w, POKE)).toEqual({ status: 0, out: '', err: '' });
    const s = await spawns(w);
    expect(s).toHaveLength(1);
    expect(s[0]?.args.slice(-2)).toEqual(['__update', '--background']);
    expect(await read(w.logs.write)).toBe('');
    expect(await waitMarkers(w, 1)).toHaveLength(1);
  }, 90_000);

  it('KIT_AUTO_UPDATE=0 的前台命令不建 tmp(之后 poke 也不调度)', async () => {
    const w = await world({ installed: KIT_VERSION, rsi: 'stop', tmpDir: 'none' });
    const tmpAbs = path.join(w.home, STATE_DIR, 'tmp');
    expect((await run(w, ['--version'], { KIT_AUTO_UPDATE: '0' })).status).toBe(0);
    expect(await exists(tmpAbs)).toBe(false);
    expect(await run(w, POKE)).toEqual({ status: 0, out: '', err: '' });
    expect(await spawns(w)).toEqual([]);
  }, 60_000);
});

describe('e poke 顺带调度 update worker', () => {
  it('due + 受控 tmp 合格(STOP 世界,rsi 侧无动作):恰好一次 __update --background,目标 current、TMPDIR = 受控目录;钩子进程自身零写入、无输出', async () => {
    const w = await world({ installed: KIT_VERSION, rsi: 'stop' });
    const r = await run(w, POKE);
    expect(r).toEqual({ status: 0, out: '', err: '' });
    const s = await spawns(w);
    expect(s).toHaveLength(1);
    expect(s[0]?.fn).toBe('spawn');
    expect(s[0]?.args.slice(-2)).toEqual(['__update', '--background']);
    // 只断言钩子进程自身(preload 只挂在它上面)零写入;被拉起的 worker 的后续写入不在断言范围——这里 worker 是 current 里的桩(只写标记、退 0),
    // 且本世界的 registry 是空的 file:// 目录,即使跑真 worker 也会早退。
    expect(await read(w.logs.write)).toBe('');
    const m = await waitMarkers(w, 1);
    expect(m).toHaveLength(1);
    expect(m[0]?.argv).toEqual(['__update', '--background']);
    expect(m[0]?.env).toMatchObject({
      HOME: w.home,
      KIT_LAUNCHED: '1',
      TMPDIR: path.join(w.home, STATE_DIR, 'tmp'),
    });
  }, 60_000);

  const NEG: [string, Opts, string[], Record<string, string>?][] = [
    ['受控 tmp 不存在', { installed: KIT_VERSION, rsi: 'stop', tmpDir: 'none' }, POKE],
    ['受控 tmp 权限过宽', { installed: KIT_VERSION, rsi: 'stop', tmpDir: 'loose' }, POKE],
    ['KIT_AUTO_UPDATE=0', { installed: KIT_VERSION, rsi: 'stop' }, POKE, { KIT_AUTO_UPDATE: '0' }],
    [
      'auto_install=false',
      { installed: KIT_VERSION, rsi: 'stop', updateCfg: 'auto_install = false' },
      POKE,
    ],
    ['未到期(上次检查刚刚)', { installed: KIT_VERSION, rsi: 'stop', lastCheck: 'recent' }, POKE],
    ['rsi off', { installed: KIT_VERSION, rsi: 'off' }, POKE],
    ['hint 永不调度', { installed: KIT_VERSION, rsi: 'stop' }, HINT],
    ['`__rsi --background` 永不调度', { installed: KIT_VERSION, rsi: 'stop' }, WORKER],
  ];
  for (const [name, opts, args, env] of NEG) {
    it(`不调度:${name}`, async () => {
      const w = await world(opts);
      const r = await run(w, args, env ?? {});
      expect(r).toEqual({ status: 0, out: '', err: '' });
      expect(await spawns(w)).toEqual([]);
      expect(await read(w.logs.write)).toBe('');
      expect(await markers(w)).toEqual([]);
    }, 60_000);
  }
});
