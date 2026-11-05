/**
 * D-AU3 验收(docs/contracts.md §19.9.1):**真实构建 + 真实 npm pack 的最小发布形态**走完整自动更新安装流程。
 * (完整的发布等价性由 release.yml 里对实际待发布 tgz 的发布前门禁 scripts/check-release-tgz.mjs 保证,见 test/build/release-tgz-gate.test.ts。)
 *
 * 为什么要有这条:此前 update 测试的 tarball 全是 test/update/install-world.ts 自己造的(bin 权限写死 0755),
 * 而真实 `npm pack` 出来的 `dist/cli.js` 是 0644,于是静态冒烟(曾要求 0755)在真实环境里每个版本都失败,测试却一直绿。
 *
 * 做法(全部在 KIT_TMP 里,不碰仓库的 dist/、不碰真实 HOME;构建与 pack 见 test/build/real-pack-helper.ts):
 *  1. 用仓库的 vite 配置真实构建 dist,放进一个只含 package.json / README / LICENSE 的包根;
 *  2. 按发布脚本的做法生成 integrity.json(覆盖包内除自身外的每个文件);
 *  3. 真实 `npm pack` 出 tgz;
 *  4. 假 HOME + file:// registry 夹具提供 packument / tarball / attestations(验签器按仓库既有测试的方式注入,tarball 是真的),
 *     冒烟用真实的 `smokeCandidate`(真 spawn `node <staging>/dist/cli.js --version`)。
 */
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { exists, lstat, realpath } from '../../src/io/read-fs.js';
import { smokeCandidate } from '../../src/update/launcher.js';
import { readTgz } from '../../src/update/tar.js';
import {
  asBuiltReal,
  buildRealPack,
  repackReal,
  spawnTool,
  type EditableFile,
  type RealPack,
} from '../build/real-pack-helper.js';
import {
  newWorld,
  runUpdate,
  stateOf,
  writeRegistry,
  type BuiltPkg,
  type World,
} from './install-world.js';

let real: RealPack;
let sb: RealPack['sb'];
let version: string;
let realListing: RealPack['listing'];

beforeAll(async () => {
  real = await buildRealPack('realpack-');
  sb = real.sb;
  version = real.version;
  realListing = real.listing;
}, 300_000);

const repack = (edit: (f: EditableFile[]) => void): BuiltPkg => repackReal(real, edit);
const asBuilt = (): BuiltPkg => asBuiltReal(real);
const spawn = spawnTool;

interface SmokeCall {
  stagingAbs: string;
  ok: boolean;
}

/**
 * 真实的冒烟(`smokeCandidate` 真 spawn `node <staging>/dist/cli.js --version`,退出 0 且 stdout 恰为版本号才返回 true),
 * 只是把每次调用的 staging 路径与结果记下来,供断言「冒烟确实跑了、跑的是 staging 里的候选、结果为真」。
 */
function recordingSmoke(): {
  smoke: (c: { home: string; stagingAbs: string; version: string }) => boolean;
  calls: SmokeCall[];
} {
  const calls: SmokeCall[] = [];
  return {
    calls,
    smoke: (c) => {
      const ok = smokeCandidate(c);
      calls.push({ stagingAbs: c.stagingAbs, ok });
      return ok;
    },
  };
}

async function install(pkg: BuiltPkg): Promise<{
  w: World;
  r: Awaited<ReturnType<typeof runUpdate>>;
  rec: ReturnType<typeof recordingSmoke>;
}> {
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
  expect(rec.calls[0]?.ok).toBe(true);
  expect(rec.calls[0]?.stagingAbs).toMatch(/\/staging\/st-[0-9a-f]+$/);
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
        if (f.path === 'dist/cli.js')
          f.bytes = Buffer.concat([Buffer.from('//'), f.bytes.subarray(2)]);
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
