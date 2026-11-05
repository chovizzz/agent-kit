/**
 * 真实构建 + 真实 `npm pack` 的测试支撑(D-AU3,docs/contracts.md §19.9.1)。
 * 两处使用:test/update/install-real-pack.test.ts(完整安装流程)与 test/build/release-tgz-gate.test.ts(发布前门禁脚本)。
 *
 * 性质:这是「真实构建 + 真实 npm pack 的最小发布形态」——包根只含真实的 package.json / README / LICENSE、真实 vite 构建的 dist、
 * 按发布脚本口径生成的 integrity.json;**不含** payload/(build-payload 会写仓库根,测试不碰)。完整的发布等价性由 release.yml 里对
 * 实际待发布 tgz 的发布前门禁(scripts/check-release-tgz.mjs)保证,不由本支撑保证。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { expect } from 'vitest';
import { buildIntegrity } from '../../src/build/payload.js';
import { readBytes, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { readTgz, type TarListing } from '../../src/update/tar.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { sha256, sha512, tgzOf, type BuiltPkg, type Ent } from '../update/install-world.js';
import { makeSandbox, type Sandbox } from './helpers.js';

const SAFE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const TSC_BIN = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function spawnTool(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Ran {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: SAFE_PATH, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 发布前门禁脚本从 tsc 构建期产物(node_modules/.cache/agent-kit-tsc)取安装器实现;没有就在这里构建一次(与 bundle-artifact 同一条命令) */
export function ensureTscOut(sb: Sandbox): void {
  const t = spawnTool(process.execPath, [TSC_BIN, '-p', 'tsconfig.build.json'], REPO_ROOT, {
    HOME: sb.home,
  });
  expect(t.status, t.stdout + t.stderr).toBe(0);
}

export interface RealPack {
  sb: Sandbox;
  version: string;
  tgz: Buffer;
  listing: TarListing;
  /** 真实 tgz 落盘位置(给脚本用) */
  tgzPath: string;
}

export async function buildRealPack(prefix: string): Promise<RealPack> {
  const sb = await makeSandbox(prefix);
  const env = { HOME: sb.home, KIT_TMP: sb.dir, KIT_AUTO_UPDATE: '0' };
  const pkgRoot = path.join(sb.dir, 'pkgroot');
  const dist = path.join(pkgRoot, 'dist');
  await safe.mkdirp(sb.wctx, pkgRoot);

  // 1. 真实构建(与 build 脚本同一份 vite 配置、同一个许可证清单脚本)
  const v = spawnTool(
    process.execPath,
    [VITE_BIN, 'build', '--outDir', dist, '--emptyOutDir'],
    REPO_ROOT,
    env,
  );
  expect(v.stderr).not.toMatch(/error/i);
  expect(v.status).toBe(0);
  const g = spawnTool(
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
  const version = (
    JSON.parse(await readText(path.join(pkgRoot, 'package.json'))) as { version: string }
  ).version;

  const npmEnv = {
    ...env,
    npm_config_cache: path.join(sb.dir, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
  };
  // 3. integrity.json:覆盖 npm 会打进包的每个文件(不含自身),与 scripts/build-payload.mjs 同口径
  const dry = spawnTool(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    pkgRoot,
    npmEnv,
  );
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
  const pack = spawnTool(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
    pkgRoot,
    npmEnv,
  );
  expect(pack.status, pack.stderr).toBe(0);
  const name = (JSON.parse(pack.stdout) as { filename: string }[])[0]?.filename;
  expect(name).toMatch(/\.tgz$/);
  const tgzPath = path.join(packDir, name as string);
  const tgz = Buffer.from(await readBytes(tgzPath));
  return { sb, version, tgz, listing: readTgz(tgz), tgzPath };
}

export interface EditableFile {
  path: string;
  bytes: Buffer;
  mode: number;
}

/** 把(可能改过的)真实文件清单重新打成 tgz 并重算 integrity.json,包装成 registry 夹具用的 BuiltPkg(`tgz` 即新包) */
export function repackReal(real: RealPack, edit: (f: EditableFile[]) => void): BuiltPkg {
  const files = real.listing.files.map((f) => ({ path: f.path, bytes: f.bytes, mode: f.mode }));
  edit(files);
  const body = files.filter((f) => f.path !== 'integrity.json');
  const ib = Buffer.from(
    buildIntegrity(
      real.version,
      body.map((f) => ({ path: f.path, content: f.bytes })),
    ).text,
  );
  const ents: Ent[] = [{ name: 'package/', type: '5', mode: 0o755 }];
  for (const d of real.listing.dirs) ents.push({ name: `package/${d}/`, type: '5', mode: 0o755 });
  for (const f of body) ents.push({ name: `package/${f.path}`, data: f.bytes, mode: f.mode });
  ents.push({ name: 'package/integrity.json', data: ib });
  const tgz = tgzOf(ents);
  return {
    version: real.version,
    tgz,
    sha512: sha512(tgz),
    files: [],
    integrityBytes: ib,
    anchor: sha256(ib),
  };
}

export function asBuiltReal(real: RealPack): BuiltPkg {
  const ib = Buffer.from(real.listing.files.find((f) => f.path === 'integrity.json')?.bytes ?? '');
  return {
    version: real.version,
    tgz: real.tgz,
    sha512: sha512(real.tgz),
    files: [],
    integrityBytes: ib,
    anchor: sha256(ib),
  };
}
