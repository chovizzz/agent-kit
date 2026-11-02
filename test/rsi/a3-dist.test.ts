/**
 * R20-A3:真实发布产物(vite 构建的 `dist/cli.js`)子进程验收(契约 R20-1.2a、R20-1.9、R20-3.2.1、§20.8.2 A3 行;A3 方案 v2 R5 / R8)。
 *
 * 在 KIT_TMP 里自己构建一份产物(不依赖仓库里已有的 dist/),以 `node --import <preload>` 运行。preload 由本测试在沙箱里**生成**(源码是字符串):
 *  - 记录全部会写盘的 fs 调用(promises / 回调 / 同步三套,`open` 只记带写标志的)→ `A3_WRITE_LOG`;
 *  - 记录 child_process 的每次调用与子进程 pid → `A3_SPAWN_LOG`;
 *  - 记录每个被加载的 ESM 文件 → `A3_LOAD_LOG`(断言钩子路径加载的代码里没有启动器 / net / llm-exec / reflect 后端)。
 * 四组合(`current` 损坏 + 存在待提示的自动同步记录)× TTY(python3 pty 真伪终端)/ 非 TTY,对 off 与 STOP 两种配置(都不设 KIT_AUTO_RSI):
 * poke / hint 的 stdout、stderr 为空、零写入(写日志 + HOME / 仓库目录树)、不 spawn;正向对照:同一世界里非钩子命令确实打出启动器的提示。
 * 端到端:armed + 到期的 poke 真的经 runSelf 起 worker;按 pid 等它退出(超时即杀并判失败),再核对 worker 的结果。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KIT_VERSION } from '../../src/contracts/meta.js';
import { exists, readText, realpathSync } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { makeSandbox, type Sandbox } from '../build/helpers.js';
import { newWorld } from '../update/install-world.js';
import { installFake, putState } from '../update/launcher-world.js';
import { treeOf } from './rsi-fixture.js';

const [VMAJ, VMIN, VPATCH] = KIT_VERSION.split('.').map((x) => Number.parseInt(x, 10)) as [
  number,
  number,
  number,
];
const NEWER_SAME_MAJOR = `${VMAJ}.${VMIN}.${VPATCH + 1}`;
const SAFE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const PRELOAD = String.raw`
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as mod from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const cp = require('node:child_process');
const origAppend = fs.appendFileSync;
const W = process.env.A3_WRITE_LOG, L = process.env.A3_LOAD_LOG, S = process.env.A3_SPAWN_LOG;
const log = (f, line) => { if (f) { try { origAppend.call(fs, f, line + '\n'); } catch {} } };
const C = fs.constants;
const writes = (fl) => typeof fl === 'string' ? /[wax+]/.test(fl)
  : typeof fl === 'number' ? (fl & (C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_APPEND | C.O_TRUNC)) !== 0 : false;
const own = new Set([W, L, S].filter(Boolean));
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
if (typeof mod.registerHooks === 'function') {
  mod.registerHooks({ load(url, ctx, next) { if (url.startsWith('file:')) log(L, url); return next(url, ctx); } });
}
`;

/** 伪终端驱动:python3 `pty.spawn` 在 macOS 上子进程退出后会挂住,改用 openpty + subprocess,轮询子进程并把主端读空 */
const PTY_RUN = String.raw`
import os, select, subprocess, sys, time
m, s = os.openpty()
p = subprocess.Popen(sys.argv[1:], stdin=s, stdout=s, stderr=s, close_fds=True, start_new_session=True)
os.close(s)
out = b""
deadline = time.time() + 15
def drain():
    global out
    while True:
        r, _, _ = select.select([m], [], [], 0.05)
        if not r: return
        try:
            c = os.read(m, 65536)
        except OSError:
            return
        if not c: return
        out += c
while p.poll() is None:
    drain()
    if time.time() > deadline:
        p.kill(); p.wait(); sys.stdout.buffer.write(out); sys.exit(124)
drain()
sys.stdout.buffer.write(out)
sys.exit(p.returncode)
`;

/** 钩子路径加载的代码里不得出现这些模块(rolldown 不压缩,保留 `//#region <源路径>`) */
const FORBIDDEN_REGIONS = [
  'src/update/launcher.ts',
  'src/update/install.ts',
  'src/io/net.ts',
  'src/io/llm-exec.ts',
  'src/reflect/backends/',
  'src/cli.ts',
];

let sb: Sandbox;
let pkg: string;
let preload: string;
let ptyRun: string;

beforeAll(async () => {
  sb = await makeSandbox('a3-dist-');
  pkg = path.join(sb.dir, 'pkg');
  await safe.mkdirp(sb.wctx, pkg);
  // runSelf 的 self 目标 = 「本模块所在包」的 dist/cli.js(向上找 package.json):产物要带一份 package.json
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
  preload = path.join(sb.dir, 'a3-preload.mjs');
  await safe.writeFile(sb.wctx, preload, PRELOAD);
  ptyRun = path.join(sb.dir, 'a3-pty.py');
  await safe.writeFile(sb.wctx, ptyRun, PTY_RUN);
}, 300_000);

interface Logs {
  write: string;
  load: string;
  spawn: string;
}

interface W {
  home: string;
  repo: string;
  dir: string;
  env: Record<string, string>;
  logs: Logs;
  fx: Sandbox['wctx'];
}

/** 假 HOME:`current` 损坏(锚点不符)+ 一条待提示的「自动同步被拒」记录;`[rsi]` 按 kind 配 */
async function world(kind: 'off' | 'stop' | 'armed'): Promise<W> {
  const w = await newWorld();
  // 已安装版本 = 本包版本的 patch + 1:启动器只在「更高且同 major」时才去跑 current(从而发现它损坏);相同 / 更低 / 跨 major 都不碰 current
  const inst = await installFake(w, NEWER_SAME_MAJOR);
  expect(inst.pkg.anchor).not.toBe('a'.repeat(64));
  await putState(w, NEWER_SAME_MAJOR, 'a'.repeat(64), (s) => ({
    ...s,
    last_auto_sync: {
      at: '2026-10-14T12:00:00.000Z',
      outcome: 'declined',
      reasons: ['drifted'],
      add: 0,
      update: 0,
      remove: 0,
    },
  }));
  const repo = path.join(w.dir, 'repo');
  await safe.mkdirp(w.fx, repo, 0o755);
  await safe.chmod(w.fx, repo, 0o755);
  await safe.writeFile(w.fx, path.join(repo, 'kit.toml'), '[kit]\n', { mode: 0o644 });
  const cfgDir = path.join(w.home, '.config', 'agent-kit');
  await safe.mkdirp(w.fx, cfgDir, 0o755);
  await safe.chmod(w.fx, path.join(w.home, '.config'), 0o755);
  await safe.chmod(w.fx, cfgDir, 0o755);
  const realRepo = realpathSync(repo);
  const cfg =
    kind === 'off' ? '[update]\n' : `[rsi]\nenabled = true\nrepo = ${JSON.stringify(realRepo)}\n`;
  await safe.writeFile(w.fx, path.join(cfgDir, 'config.toml'), cfg, { mode: 0o600 });
  await safe.chmod(w.fx, path.join(cfgDir, 'config.toml'), 0o600);
  if (kind === 'stop') {
    const rsi = path.join(repo, '.state', 'rsi');
    await safe.mkdirp(w.fx, rsi, 0o700);
    await safe.chmod(w.fx, rsi, 0o700);
    await safe.writeFile(
      w.fx,
      path.join(rsi, 'STOP'),
      '{"at":"2026-10-24T00:00:00.000Z","by":"user"}',
      { mode: 0o600 },
    );
  }
  // KIT_TMP 必须与 HOME / 仓库互不为祖先(否则 rsi 的上下文按 state_dir_unsafe 拒绝,钩子会因为错误的原因空操作)
  const tmp = path.join(w.dir, 'tmp');
  await safe.mkdirp(w.fx, tmp, 0o700);
  await safe.chmod(w.fx, tmp, 0o700);
  const logs: Logs = {
    write: path.join(w.dir, 'writes.log'),
    load: path.join(w.dir, 'loads.log'),
    spawn: path.join(w.dir, 'spawns.log'),
  };
  const env = {
    PATH: SAFE_PATH,
    HOME: w.home,
    KIT_REAL_HOME_OVERRIDE: w.home,
    KIT_TMP: tmp,
    // 离线:任何经启动器的路径(正向对照、变异「入口改回经启动器」)若调度 update worker,也只连本地假 registry,不出网
    KIT_UPDATE_REGISTRY: `file://${w.reg}`,
    A3_WRITE_LOG: logs.write,
    A3_LOAD_LOG: logs.load,
    A3_SPAWN_LOG: logs.spawn,
  };
  return { home: w.home, repo: realRepo, dir: w.dir, env, logs, fx: w.fx };
}

const read = async (p: string): Promise<string> => ((await exists(p)) ? readText(p) : '');
const reset = async (w: W): Promise<void> => {
  for (const p of Object.values(w.logs)) await safe.remove(w.fx, p);
};

interface Ran {
  status: number | null;
  out: string;
  err: string;
  ms: number;
}

/** 非 TTY:stdin 是永不关闭的管道;超时(默认 5s)即杀并返回 status=null */
function runPiped(w: W, args: string[], timeoutMs = 5000, withPreload = true): Promise<Ran> {
  const t0 = Date.now();
  const pre = withPreload ? ['--import', preload] : [];
  const child = spawn(process.execPath, [...pre, path.join(pkg, 'dist', 'cli.js'), ...args], {
    cwd: w.repo,
    env: w.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: signal === null ? code : null, out, err, ms: Date.now() - t0 });
    });
  });
}

/** TTY:python3 openpty 起一个真伪终端(stdin / stdout / stderr 都是它);输出合并在 out */
function runTty(w: W, args: string[]): Ran {
  const t0 = Date.now();
  const r = spawnSync(
    'python3',
    // -B:不写字节码缓存(macOS 系统 python 否则往 $HOME/Library/Caches 写);-I:隔离模式,不读用户 site / PYTHON* 环境
    [
      '-B',
      '-I',
      ptyRun,
      process.execPath,
      '--import',
      preload,
      path.join(pkg, 'dist', 'cli.js'),
      ...args,
    ],
    { cwd: w.repo, env: w.env, encoding: 'utf8', timeout: 30_000 },
  );
  return {
    status: r.status,
    out: (r.stdout ?? '').replace(/\r\n/g, '\n'),
    err: r.stderr ?? '',
    ms: Date.now() - t0,
  };
}

async function loadedForbidden(w: W): Promise<string[]> {
  const hits: string[] = [];
  for (const url of (await read(w.logs.load)).split('\n').filter((l) => l !== '')) {
    const file = new URL(url).pathname;
    if (!file.startsWith(pkg)) continue;
    const text = await read(file);
    for (const r of FORBIDDEN_REGIONS)
      if (text.includes(`//#region ${r}`)) hits.push(`${path.basename(file)}:${r}`);
  }
  return hits;
}

const HOOKS: string[][] = [
  ['rsi', 'poke', '--agent', 'claude'],
  ['rsi', 'hint', '--agent', 'claude'],
];

describe('R20-1.2a 四组合 × off / STOP:钩子不经启动器、不输出、零写入、不 spawn', () => {
  for (const kind of ['off', 'stop'] as const) {
    for (const tty of [false, true]) {
      it(`${kind} × ${tty ? 'TTY' : '非 TTY'}`, async () => {
        const w = await world(kind);
        for (const args of HOOKS) {
          await reset(w);
          const before = [await treeOf(w.home), await treeOf(w.repo)];
          const r = tty ? runTty(w, args) : await runPiped(w, args);
          expect(r.status, args.join(' ')).toBe(0);
          expect(r.out, args.join(' ')).toBe('');
          expect(r.err, args.join(' ')).toBe('');
          expect(await read(w.logs.write), args.join(' ')).toBe('');
          expect(await read(w.logs.spawn), args.join(' ')).toBe('');
          expect([await treeOf(w.home), await treeOf(w.repo)]).toEqual(before);
          expect(await read(w.logs.load), 'preload 的加载记录在工作(正向前提)').toContain(
            '/dist/cli.js',
          );
          expect(await loadedForbidden(w), args.join(' ')).toEqual([]);
        }
        // 正向对照:同一世界里非钩子命令经启动器,确实打出 current 损坏的提示(TTY 下另有自动同步提示),并加载了启动器
        // KIT_AUTO_UPDATE=0:不让启动器调度 update worker(否则 TTY 下会起一个无人等待的 `__update --background`);提示照样打出
        await reset(w);
        const cw: W = { ...w, env: { ...w.env, KIT_AUTO_UPDATE: '0' } };
        const c = tty ? runTty(cw, ['rsi', 'status']) : await runPiped(cw, ['rsi', 'status']);
        expect(c.out + c.err).toContain('UPDATE_CURRENT_BROKEN');
        if (tty) expect(c.out).toContain('AUTO_SYNC_DECLINED');
        expect(await read(w.logs.spawn), '正向对照不起任何子进程').toBe('');
        expect((await loadedForbidden(w)).some((h) => h.endsWith('src/update/launcher.ts'))).toBe(
          true,
        );
      }, 60_000);
    }
  }
});

describe('R20-1.9 / R20-3.2.1 不读 stdin:stdin 永不关闭时 2s 内退出', () => {
  it('poke、hint、worker(STOP 世界:不会起真 worker,不留孤儿进程)', async () => {
    const w = await world('stop');
    for (const args of [...HOOKS, ['__rsi', '--background']]) {
      const r = await runPiped(w, args, 4000, false); // 计时不带 preload(它给每次模块加载记日志)
      expect(r.status, args.join(' ')).toBe(0);
      expect(r.ms, args.join(' ')).toBeLessThan(2000);
    }
  }, 60_000);
  it('钩子参数带 --help / --version / 全局选项:仍不进启动器、无输出(__rsi 退 2)', async () => {
    const w = await world('off');
    for (const [args, code] of [
      [['rsi', 'poke', '--agent', 'claude', '--help'], 0],
      [['--version', 'rsi', 'hint', '--agent', 'claude'], 0],
      [['--root', '/tmp', 'rsi', 'poke', '--agent', 'claude'], 0],
      [['__rsi', '--background', '--help'], 2],
    ] as [string[], number][]) {
      await reset(w);
      const r = await runPiped(w, args);
      expect(r, args.join(' ')).toMatchObject({ status: code, out: '', err: '' });
      expect(await loadedForbidden(w), args.join(' ')).toEqual([]);
      expect(await read(w.logs.write), args.join(' ')).toBe('');
    }
  }, 60_000);
});

describe('端到端:armed + 到期 → poke 真的起 worker,worker 完成一次 armed 列举', () => {
  it('spawn 一次(参数 __rsi --background、cwd = [rsi] repo);按 pid 等 worker 退出;state.json 记 last_tick(trigger=poke)', async () => {
    const w = await world('armed');
    await reset(w);
    const r = await runPiped(w, ['rsi', 'poke', '--agent', 'claude']);
    expect(r).toMatchObject({ status: 0, out: '', err: '' });
    const spawns = (await read(w.logs.spawn))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { fn: string; args: string[]; pid: number | null });
    expect(spawns).toHaveLength(1);
    const s = spawns[0] as { fn: string; args: string[]; pid: number | null };
    expect(s.fn).toBe('spawn');
    expect(s.args.slice(-2)).toEqual(['__rsi', '--background']);
    expect(typeof s.pid).toBe('number');
    const pid = s.pid as number;
    const t0 = Date.now();
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    };
    while (alive() && Date.now() - t0 < 30_000) await new Promise((res) => setTimeout(res, 100));
    if (alive()) {
      process.kill(pid, 'SIGKILL');
      throw new Error('worker 30s 内没有退出');
    }
    const state = JSON.parse(await readText(path.join(w.repo, '.state', 'rsi', 'state.json'))) as {
      last_tick: { trigger: string; outcome: string } | null;
      attempt: unknown;
    };
    expect(state.last_tick).toMatchObject({ trigger: 'poke', outcome: 'ok' });
    expect(state.attempt).toBeNull();
    const log = (await readText(path.join(w.repo, '.state', 'rsi', 'log.jsonl')))
      .trim()
      .split('\n');
    expect(log.map((l) => (JSON.parse(l) as { action: string }).action)).toEqual([
      'spawned',
      'completed',
    ]);
    expect(await exists(path.join(w.repo, '.state', 'rsi', 'lock'))).toBe(false);
    // 同一窗口再 poke:已预留 → 不 spawn
    await reset(w);
    await runPiped(w, ['rsi', 'poke', '--agent', 'claude']);
    expect(await read(w.logs.spawn)).toBe('');
  }, 90_000);
});
