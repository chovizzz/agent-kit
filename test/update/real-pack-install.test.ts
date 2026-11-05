/**
 * D-AU3 验收(docs/contracts.md §19.9.1):**真实发布产物**走完整自动更新安装流程。
 *
 * 为什么要有这条:此前 update 测试的 tarball 全是 test/update/install-world.ts 自己造的(bin 权限写死 0755),
 * 而真实 `npm pack` 出来的 `dist/cli.js` 是 0644,于是静态冒烟(曾要求 0755)在真实环境里每个版本都失败,测试却一直绿。
 *
 * 做法(全部在 KIT_TMP 里,不碰仓库的 dist/、不碰真实 HOME):
 *  1. 用仓库的 vite 配置真实构建 dist,放进一个只含 package.json / README / LICENSE 的包根;
 *  2. 按发布脚本的做法生成 integrity.json(覆盖包内除自身外的每个文件);
 *  3. 真实 `npm pack` 出 tgz;
 *  4. 假 HOME + file:// registry 夹具提供 packument / tarball / attestations(验签器按仓库既有测试的方式注入,tarball 是真的),
 *     冒烟用真实的 `smokeCandidate`(真 spawn `node <staging>/dist/cli.js --version`)。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildIntegrity } from '../../src/build/payload.js';
import { runSelf, type RunSelfResult } from '../../src/io/exec.js';
import { exists, lstat, readBytes, readText, realpath } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { smokeCandidate } from '../../src/update/launcher.js';
import { readTgz, type TarListing } from '../../src/update/tar.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { makeSandbox, type Sandbox } from '../build/helpers.js';
import {
  newWorld,
  runUpdate,
  sha256,
  sha512,
  stateOf,
  tgzOf,
  writeRegistry,
  type BuiltPkg,
  type Ent,
  type World,
} from './install-world.js';

const SAFE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawn(cmd: string, args: string[], cwd: string, env: Record<string, string>): Ran {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: SAFE_PATH, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let sb: Sandbox;
let version: string;
let realTgz: Buffer;
let realListing: TarListing;

beforeAll(async () => {
  sb = await makeSandbox('realpack-');
  const env = { HOME: sb.home, KIT_TMP: sb.dir, KIT_AUTO_UPDATE: '0' };
  const pkgRoot = path.join(sb.dir, 'pkgroot');
  const dist = path.join(pkgRoot, 'dist');
  await safe.mkdirp(sb.wctx, pkgRoot);

  // 1. 真实构建(与 build 脚本同一份 vite 配置、同一个许可证清单脚本)
  const v = spawn(
    process.execPath,
    [VITE_BIN, 'build', '--outDir', dist, '--emptyOutDir'],
    REPO_ROOT,
    env,
  );
  expect(v.stderr).not.toMatch(/error/i);
  expect(v.status).toBe(0);
  const g = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'gen-third-party-licenses.mjs'), '--dist', dist],
    REPO_ROOT,
    env,
  );
  expect(g.stderr).toBe('');
  expect(g.status).toBe(0);

  // 2. 包根:真实的 package.json(含 bin / files 字段)、README、LICENSE
  for (const f of ['package.json', 'README.md', 'LICENSE']) {
    await safe.writeFile(
      sb.wctx,
      path.join(pkgRoot, f),
      Buffer.from(await readBytes(path.join(REPO_ROOT, f))),
    );
  }
  version = (JSON.parse(await readText(path.join(pkgRoot, 'package.json'))) as { version: string })
    .version;

  const npmEnv = {
    ...env,
    npm_config_cache: path.join(sb.dir, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
  };
  // 3. integrity.json:覆盖 npm 会打进包的每个文件(不含自身),与 scripts/build-payload.mjs 同口径
  const dry = spawn('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], pkgRoot, npmEnv);
  expect(dry.status, dry.stderr).toBe(0);
  const listed = (JSON.parse(dry.stdout) as { files: { path: string }[] }[])[0]?.files ?? [];
  const entries = [];
  for (const f of listed) {
    entries.push({
      path: f.path,
      content: Buffer.from(await readBytes(path.join(pkgRoot, ...f.path.split('/')))),
    });
  }
  await safe.writeFile(
    sb.wctx,
    path.join(pkgRoot, 'integrity.json'),
    buildIntegrity(version, entries).text,
  );

  // 4. 真实 npm pack
  const packDir = path.join(sb.dir, 'packed');
  await safe.mkdirp(sb.wctx, packDir);
  const pack = spawn(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
    pkgRoot,
    npmEnv,
  );
  expect(pack.status, pack.stderr).toBe(0);
  const name = (JSON.parse(pack.stdout) as { filename: string }[])[0]?.filename;
  expect(name).toMatch(/\.tgz$/);
  realTgz = Buffer.from(await readBytes(path.join(packDir, name as string)));
  realListing = readTgz(realTgz);
}, 300_000);

/** 把(可能改过的)文件清单重新打成 tgz,并按需重算 integrity.json,包装成 registry 夹具用的 BuiltPkg */
function repack(edit: (f: { path: string; bytes: Buffer; mode: number }[]) => void): BuiltPkg {
  const files = realListing.files.map((f) => ({ path: f.path, bytes: f.bytes, mode: f.mode }));
  edit(files);
  const body = files.filter((f) => f.path !== 'integrity.json');
  const integrity = buildIntegrity(
    version,
    body.map((f) => ({ path: f.path, content: f.bytes })),
  ).text;
  const ib = Buffer.from(integrity);
  const ents: Ent[] = [{ name: 'package/', type: '5', mode: 0o755 }];
  for (const d of realListing.dirs) ents.push({ name: `package/${d}/`, type: '5', mode: 0o755 });
  for (const f of body) ents.push({ name: `package/${f.path}`, data: f.bytes, mode: f.mode });
  ents.push({ name: 'package/integrity.json', data: ib });
  const tgz = tgzOf(ents);
  return { version, tgz, sha512: sha512(tgz), files: [], integrityBytes: ib, anchor: sha256(ib) };
}

function asBuilt(): BuiltPkg {
  const ib = Buffer.from(realListing.files.find((f) => f.path === 'integrity.json')?.bytes ?? '');
  return {
    version,
    tgz: realTgz,
    sha512: sha512(realTgz),
    files: [],
    integrityBytes: ib,
    anchor: sha256(ib),
  };
}

interface SmokeCall {
  args: readonly string[];
  result: RunSelfResult;
}

/** 真实的冒烟(真 spawn),只是把 runSelf 的调用与返回记下来,供断言「确实执行了 dist/cli.js --version」 */
function recordingSmoke(): {
  smoke: (c: { home: string; stagingAbs: string; version: string }) => boolean;
  calls: SmokeCall[];
  targets: string[];
} {
  const calls: SmokeCall[] = [];
  const targets: string[] = [];
  return {
    calls,
    targets,
    smoke: (c) =>
      smokeCandidate(c, {
        runSelf: (o) => {
          const result = runSelf(o);
          calls.push({ args: o.args, result });
          if (o.target.kind === 'candidate') targets.push(o.target.stagingAbs);
          return result;
        },
      }),
  };
}

async function install(
  pkg: BuiltPkg,
): Promise<{ w: World; r: Awaited<ReturnType<typeof runUpdate>>; rec: ReturnType<typeof recordingSmoke> }> {
  const w = await newWorld();
  await writeRegistry(w, { versions: [{ pkg }], distTags: { latest: version } });
  const rec = recordingSmoke();
  const r = await runUpdate(w, ['--write', '--now'], { deps: { smoke: rec.smoke } });
  return { w, r, rec };
}

const share = (w: World): string => path.join(w.home, '.local/share/agent-kit');

async function expectInstalled(
  w: World,
  r: { code: number; out: string; err: string },
  rec: ReturnType<typeof recordingSmoke>,
  pkg: BuiltPkg,
): Promise<void> {
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(r.out).toContain(`installed ${version}`);
  // versions/<v> 与 current
  const vdir = path.join(share(w), 'versions', version);
  expect((await lstat(vdir)).isDirectory()).toBe(true);
  const cur = path.join(share(w), 'current');
  expect((await lstat(cur)).isSymbolicLink()).toBe(true);
  expect(await realpath(cur)).toBe(await realpath(vdir));
  // 冒烟真的执行了 dist/cli.js --version:一次真 spawn,退出 0,stdout 恰为版本号;跑的是 staging 里的候选
  expect(rec.calls).toHaveLength(1);
  expect(rec.calls[0]?.args).toEqual([]);
  expect(rec.calls[0]?.result).toMatchObject({ spawned: true, status: 0 });
  expect(rec.calls[0]?.result.spawned && rec.calls[0].result.stdout.trim()).toBe(version);
  expect(rec.targets[0]).toMatch(/\/staging\/st-[0-9a-f]+$/);
  // 没拉黑;状态记了版本与锚点
  const st = await stateOf(w);
  expect(st['bad_versions']).toEqual([]);
  expect(st['installed'].version).toBe(version);
  expect(st['installed'].anchor).toBe(pkg.anchor);
  expect(st['last_result']).toBe('installed');
  // 安装后的 bin 一律 0755(无论 tarball 里是几)
  expect((await lstat(path.join(vdir, 'dist/cli.js'))).mode & 0o777).toBe(0o755);
  // 装好的树可以直接运行(KIT_LAUNCHED=1:不经启动器转发,只证明产物本身能跑)
  const run = spawn(process.execPath, [path.join(cur, 'dist/cli.js'), '--version'], sb.dir, {
    HOME: sb.home,
    KIT_TMP: sb.dir,
    KIT_LAUNCHED: '1',
    KIT_AUTO_UPDATE: '0',
  });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout.trim()).toBe(version);
}

describe('真实 npm pack 产物 → 完整安装流程', () => {
  it('产物前提:真实 tarball 里 dist/cli.js 以 #! 开头;npm pack 保留构建设好的 0755', () => {
    const cli = realListing.files.find((f) => f.path === 'dist/cli.js');
    expect(cli).toBeDefined();
    expect(cli?.bytes.subarray(0, 2).toString('latin1')).toBe('#!');
    // vite 插件 agent-kit:bin-executable 把 dist/cli.js 设为 0755,npm pack 原样带进 tarball(读取器把任一可执行位归一为 0755)
    expect(cli?.mode).toBe(0o755);
    expect(realListing.files.some((f) => f.path === 'integrity.json')).toBe(true);
  });

  it('正向:真实产物安装成功(versions/<v>、current、真执行冒烟、无 bad_versions)', async () => {
    const pkg = asBuilt();
    const { w, r, rec } = await install(pkg);
    await expectInstalled(w, r, rec, pkg);
  });

  it('回归 D-AU3:真实内容但 tarball 里 bin 是 0644(0.3.0–0.3.3 的真实形态)同样装得上,装好后是 0755', async () => {
    const pkg = repack((files) => {
      for (const f of files) if (f.path === 'dist/cli.js') f.mode = 0o644;
    });
    const check = readTgz(pkg.tgz).files.find((f) => f.path === 'dist/cli.js');
    expect(check?.mode).toBe(0o644);
    const { w, r, rec } = await install(pkg);
    await expectInstalled(w, r, rec, pkg);
  });

  it('负向:bin 首两字节不是 #!(integrity 已重算,只有静态冒烟能拦)→ smoke,拉黑,current 不动', async () => {
    const pkg = repack((files) => {
      for (const f of files)
        if (f.path === 'dist/cli.js') f.bytes = Buffer.concat([Buffer.from('//'), f.bytes.subarray(2)]);
    });
    // 对照:这份被改过的 bin 其实还能跑(只是没有 shebang),所以拦它的只会是静态冒烟,而不是真执行
    const cli = readTgz(pkg.tgz).files.find((f) => f.path === 'dist/cli.js');
    expect(cli?.bytes.subarray(0, 2).toString('latin1')).toBe('//');
    const { w, r, rec } = await install(pkg);
    expect(r.code).toBe(1);
    expect(r.err).toContain('UPDATE_VERIFY_FAILED reason=smoke');
    expect(rec.calls).toHaveLength(0);
    expect((await stateOf(w))['bad_versions']).toEqual([version]);
    expect(await exists(path.join(share(w), 'current'))).toBe(false);
    expect(await exists(path.join(share(w), 'versions', version))).toBe(false);
  });
});
