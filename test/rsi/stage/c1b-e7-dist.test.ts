/**
 * C1b 真 dist 子进程快照(v1 E7;owner 2026-11-17「合并前补齐」c 项;替代证据不收):
 * 相位 0 下,**构建产物**起的真 hook / worker 子进程,输出(退出码 / stdout / stderr)与落盘字节与改动前基线逐字节一致。
 *
 *  - 基线 = main 167c496 的源码(`git archive`)在沙箱里用 vite 真构建出的 dist;当前 = 本检出真构建出的 dist。基线对象取不到 / 构建失败 = 测试红(不跳过)。
 *  - 同一个世界、同一个绝对路径:每次运行前把整棵世界树(假 HOME / 仓库 / 状态)按快照字节还原;两份 dist 都先放进同一个绝对路径的槽位再运行(路径不会进入产物差异)。
 *  - 确定性:子进程用 `node --import` 预加载固定 `Date` 与确定性随机源(两边注入同样的东西;不靠事后规范化)。
 *  - 防空对空:基线自己连跑两次必须逐字节相同(对照);worker 必须真的写出了 state / log;换一个时钟再跑必须能被比较器报出差异(负向)。
 *  - 入口:hook 的 worker 形状 `__rsi --background`(改动点:hook-entry 装配注入)两次(第二次被节流)与 `rsi hint`。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { exists, lstat, readBytes, readDir } from '../../../src/io/read-fs.js';
import { chmod, mkdirp, remove, writeFile } from '../../../src/io/safe-fs.js';
import { REPO_ROOT, makeTempDir, wideCtx } from '../../helpers/tmp.js';
import { type TickFx, makeTickFx } from '../b5a-fixture.js';
import { NOW } from '../ro-fixture.js';

/** 改动前基线:origin/main 上 C1b 的父提交 */
const BASE_SHA = '167c496b5cfe0a27bb53a6cef4a41339ad46931a';
const T = Date.parse(NOW);
const SAFE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const PRELOAD = String.raw`
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const FIXED = Number(process.env.E7_NOW_MS);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
}
globalThis.Date = FixedDate;
const crypto = require('node:crypto');
let ctr = 0;
const fill = (n) => {
  const out = Buffer.alloc(n);
  let off = 0;
  while (off < n) {
    const h = crypto.createHash('sha256').update('e7:' + String(ctr++)).digest();
    const k = Math.min(h.length, n - off);
    h.copy(out, off, 0, k);
    off += k;
  }
  return out;
};
crypto.randomBytes = (n, cb) => {
  const b = fill(n);
  if (typeof cb === 'function') { process.nextTick(cb, null, b); return undefined; }
  return b;
};
crypto.randomUUID = () => {
  const b = fill(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
};
crypto.randomFillSync = (buf) => {
  const b = fill(buf.byteLength);
  Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).set(b);
  return buf;
};
syncBuiltinESMExports();
`;

const sh = (cmd: string, args: string[], cwd: string, timeout = 600_000): void => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { PATH: SAFE_PATH, HOME: sandbox, KIT_TMP: sandbox },
  });
  expect(r.status, `${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0);
};

interface Tree {
  desc: Record<string, string>;
  bytes: Map<string, Uint8Array>;
}

async function walk(
  root: string,
  rel = '',
  out: Tree = { desc: {}, bytes: new Map() },
): Promise<Tree> {
  let entries;
  try {
    entries = await readDir(path.join(root, rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    const abs = path.join(root, r);
    const st = await lstat(abs);
    const mode = (st.mode & 0o777).toString(8);
    if (e.isSymbolicLink) throw new Error(`E7 世界里不应出现符号链接(快照不记录链接目标):${r}`);
    else if (e.isDirectory) {
      out.desc[r] = `d ${mode}`;
      await walk(root, r, out);
    } else {
      const b = await readBytes(abs);
      out.bytes.set(r, b);
      out.desc[r] = `f ${mode} ${b.byteLength} ${createHash('sha256').update(b).digest('hex')}`;
    }
  }
  return out;
}

/** 把世界树还原成快照:多出的删掉,缺的 / 不同的按字节重写(目录本身与未变化的文件保持原样,所以仓库 / 项目的 dev:ino 不变) */
async function restore(f: TickFx, snap: Tree): Promise<void> {
  const now = await walk(f.dir);
  for (const rel of Object.keys(now.desc).sort()) {
    if (!(rel in snap.desc)) await remove(f.fx, path.join(f.dir, rel));
  }
  for (const rel of Object.keys(snap.desc).sort()) {
    const want = snap.desc[rel] as string;
    const abs = path.join(f.dir, rel);
    if (want.startsWith('d ')) {
      const mode = Number.parseInt(want.slice(2), 8);
      if (now.desc[rel] === undefined || !(now.desc[rel] as string).startsWith('d ')) {
        await remove(f.fx, abs);
        await mkdirp(f.fx, abs, mode);
      }
      if (now.desc[rel] !== want) await chmod(f.fx, abs, mode);
    } else if (want.startsWith('f ')) {
      if (now.desc[rel] !== want) {
        const mode = Number.parseInt(want.split(' ')[1] as string, 8);
        await remove(f.fx, abs);
        await writeFile(f.fx, abs, snap.bytes.get(rel) as Uint8Array, { mode });
        await chmod(f.fx, abs, mode);
      }
    }
  }
  expect(diffOf((await walk(f.dir)).desc, snap.desc), '世界已还原到初始快照').toEqual([]);
}

const diffOf = (a: Record<string, string>, b: Record<string, string>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => a[k] !== b[k])
    .sort()
    .map((k) => `${k}: ${a[k] ?? '(absent)'}  |  ${b[k] ?? '(absent)'}`);

interface Ran {
  args: string[];
  status: number | null;
  out: string;
  err: string;
}
interface Outcome {
  runs: Ran[];
  files: Record<string, string>;
}

const COMMANDS: string[][] = [
  ['__rsi', '--background'],
  ['rsi', 'hint', '--agent', 'claude'],
  ['__rsi', '--background'],
];

let sandbox = '';
let preload = '';
let slot = '';
let basePkg = '';
let curPkg = '';
let fx: TickFx;
let init: Tree;
let baseA: Outcome;
let baseB: Outcome;
let cur: Outcome;
let otherClock: Outcome;

async function runWorld(pkgRoot: string, nowMs: number): Promise<Outcome> {
  await restore(fx, init);
  // 两份 dist 都放进同一个绝对路径的槽位再运行
  sh('rm', ['-rf', slot], sandbox);
  sh('mkdir', ['-p', slot], sandbox);
  sh('cp', ['-R', `${pkgRoot}/.`, slot], sandbox);
  const runs: Ran[] = [];
  for (const args of COMMANDS) {
    const r = spawnSync(
      process.execPath,
      ['--import', preload, path.join(slot, 'dist', 'cli.js'), ...args],
      {
        cwd: fx.repo,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: SAFE_PATH,
          HOME: fx.home,
          KIT_REAL_HOME_OVERRIDE: fx.home,
          KIT_TMP: fx.env.KIT_TMP,
          E7_NOW_MS: String(nowMs),
        },
      },
    );
    runs.push({ args, status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' });
  }
  return { runs, files: (await walk(fx.dir)).desc };
}

beforeAll(async () => {
  const made = await makeTempDir('c1b-e7-');
  sandbox = made.dir;
  const sctx = wideCtx(sandbox);
  preload = path.join(sandbox, 'e7-preload.mjs');
  await writeFile(sctx, preload, PRELOAD);
  slot = path.join(sandbox, 'slot');
  // 基线:main 167c496 的源码 → 真构建
  const baseSrc = path.join(sandbox, 'base-src');
  basePkg = path.join(sandbox, 'base-pkg');
  sh('mkdir', ['-p', baseSrc, basePkg], sandbox);
  const tar = path.join(sandbox, 'base.tar');
  sh('git', ['-C', REPO_ROOT, 'archive', '--format=tar', '-o', tar, BASE_SHA], sandbox);
  sh('tar', ['-x', '-f', tar, '-C', baseSrc], sandbox);
  sh(
    'ln',
    ['-s', path.join(REPO_ROOT, 'node_modules'), path.join(baseSrc, 'node_modules')],
    sandbox,
  );
  sh('cp', [path.join(baseSrc, 'package.json'), path.join(basePkg, 'package.json')], sandbox);
  sh('node', [VITE_BIN, 'build', '--outDir', path.join(basePkg, 'dist'), '--emptyOutDir'], baseSrc);
  // 当前:本检出的源码 → 真构建
  curPkg = path.join(sandbox, 'cur-pkg');
  sh('mkdir', ['-p', curPkg], sandbox);
  sh('cp', [path.join(REPO_ROOT, 'package.json'), path.join(curPkg, 'package.json')], sandbox);
  sh(
    'node',
    [VITE_BIN, 'build', '--outDir', path.join(curPkg, 'dist'), '--emptyOutDir'],
    REPO_ROOT,
  );
  expect(await exists(path.join(basePkg, 'dist', 'cli.js'))).toBe(true);
  expect(await exists(path.join(curPkg, 'dist', 'cli.js'))).toBe(true);

  fx = await makeTickFx('c1b-e7-world-', { confirmed: true });
  init = await walk(fx.dir);
  baseA = await runWorld(basePkg, T);
  baseB = await runWorld(basePkg, T);
  cur = await runWorld(curPkg, T);
  otherClock = await runWorld(basePkg, T + 3_600_000);
}, 1_500_000);

describe('E7:相位 0 下真 dist 子进程与基线逐字节一致', () => {
  it('前提(防空对空):基线的 worker 真的跑了——退出码 0、无输出、state / log 落盘且与初始不同', () => {
    const w = baseA.runs[0] as Ran;
    expect([w.status, w.out, w.err]).toEqual([0, '', '']);
    const rsiRel = path.relative(fx.dir, fx.rsiDir);
    const logKey = `${rsiRel}/log.jsonl`;
    const stateKey = `${rsiRel}/state.json`;
    expect(baseA.files[logKey], '基线 worker 写出了日志').toBeDefined();
    expect(baseA.files[stateKey], '基线 worker 写出了 state').toBeDefined();
    expect(baseA.files[stateKey]).not.toBe(init.desc[stateKey]);
    expect(Number((baseA.files[logKey] as string).split(' ')[2]), '日志非空').toBeGreaterThan(0);
    expect(diffOf(init.desc, baseA.files).length, '世界确实被改动').toBeGreaterThan(0);
  });

  it('对照:基线连跑两次逐字节相同(预加载的固定时钟与确定性随机源让运行可重复;不成立则本测试无从比较)', () => {
    expect(baseB.runs).toEqual(baseA.runs);
    expect(diffOf(baseA.files, baseB.files)).toEqual([]);
  });

  it('当前 dist 与基线 dist:三次调用的退出码 / stdout / stderr 与整棵世界的落盘字节(文件名、权限、大小、sha256)逐字节一致', () => {
    expect(cur.runs).toEqual(baseA.runs);
    expect(diffOf(baseA.files, cur.files)).toEqual([]);
  });

  it('负向:比较器能报出差异——换一个时钟再跑,落盘字节不同', () => {
    expect(diffOf(baseA.files, otherClock.files).length).toBeGreaterThan(0);
  });
});
